import crypto from 'crypto';
import type {
  CreateWatchRoomInput,
  CreateWatchRoomResult,
  JoinWatchRoomInput,
  UpdateWatchRoomPreferences,
  WatchRoomCommand,
  WatchRoomHostReport,
  WatchRoomHostReportResult,
  WatchRoomParticipant,
  WatchRoomPreferences,
  WatchRoomRole,
  WatchRoomSnapshot,
  WatchRoomTimeline
} from './contracts';
import { WatchRoomError } from './contracts';

const DEFAULT_MAX_PARTICIPANTS = 10;
const DEFAULT_MAX_ROOMS_PER_HOST = 3;
const DEFAULT_ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_EMPTY_ROOM_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RECONNECT_GRACE_MS = 30 * 1000;
const ROOM_ID_BYTES = 18;
const INVITE_TOKEN_BYTES = 32;
const ROOM_ID_ATTEMPTS = 8;

interface InternalTimeline {
  paused: boolean;
  anchorPositionSeconds: number;
  anchorServerTimeMs: number;
  revision: number;
}

interface InternalParticipant {
  userId: string;
  role: WatchRoomRole;
  connected: boolean;
  hasConnected: boolean;
  joinedAtMs: number;
  lastSeenAtMs: number;
  disconnectedAtMs: number | null;
  preferences: WatchRoomPreferences;
}

interface InternalRoom {
  id: string;
  inviteHash: Buffer;
  createdByUserId: string;
  hostUserId: string;
  mediaId: string;
  durationSeconds: number;
  createdAtMs: number;
  absoluteExpiresAtMs: number;
  emptySinceMs: number | null;
  timeline: InternalTimeline;
  participants: Map<string, InternalParticipant>;
}

export interface WatchRoomServiceOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  maxParticipants?: number;
  maxRoomsPerHost?: number;
  roomTtlMs?: number;
  emptyRoomTtlMs?: number;
  reconnectGraceMs?: number;
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WatchRoomError('INVALID_INPUT', `${label} is required`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WatchRoomError('INVALID_INPUT', `${label} must be a positive integer`);
  }
  return value;
}

function requireFinitePosition(value: number, duration: number, label = 'positionSeconds'): number {
  if (!Number.isFinite(value) || value < 0 || value > duration) {
    throw new WatchRoomError(
      'INVALID_INPUT',
      `${label} must be finite and between 0 and the media duration`
    );
  }
  return value;
}

function requireTrackIndex(value: number | null, label: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new WatchRoomError('INVALID_INPUT', `${label} must be a non-negative integer or null`);
  }
  return value;
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.randomBytes(size);
}

function hashInvite(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function inviteMatches(expectedHash: Buffer, token: string): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return false;
  const actualHash = hashInvite(token);
  return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
}

/**
 * Process-local Watch Together state. It intentionally performs no database
 * writes: room state expires, while each client continues to persist its own
 * watch progress through the existing per-user progress endpoint.
 */
export class WatchRoomService {
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly nowProvider: () => number;
  private readonly randomBytesProvider: (size: number) => Uint8Array;
  private readonly maxParticipants: number;
  private readonly maxRoomsPerHost: number;
  private readonly roomTtlMs: number;
  private readonly emptyRoomTtlMs: number;
  private readonly reconnectGraceMs: number;

  constructor(options: WatchRoomServiceOptions = {}) {
    this.nowProvider = options.now ?? Date.now;
    this.randomBytesProvider = options.randomBytes ?? defaultRandomBytes;
    this.maxParticipants = requirePositiveInteger(
      options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      'maxParticipants'
    );
    this.maxRoomsPerHost = requirePositiveInteger(
      options.maxRoomsPerHost ?? DEFAULT_MAX_ROOMS_PER_HOST,
      'maxRoomsPerHost'
    );
    this.roomTtlMs = requirePositiveInteger(options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS, 'roomTtlMs');
    this.emptyRoomTtlMs = requirePositiveInteger(
      options.emptyRoomTtlMs ?? DEFAULT_EMPTY_ROOM_TTL_MS,
      'emptyRoomTtlMs'
    );
    this.reconnectGraceMs = requirePositiveInteger(
      options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
      'reconnectGraceMs'
    );
  }

  createRoom(input: CreateWatchRoomInput): CreateWatchRoomResult {
    const now = this.now();
    this.maintainAll(now);

    const hostUserId = requireNonEmptyString(input.hostUserId, 'hostUserId');
    const mediaId = requireNonEmptyString(input.mediaId, 'mediaId');
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new WatchRoomError('INVALID_INPUT', 'durationSeconds must be finite and greater than zero');
    }
    const positionSeconds = requireFinitePosition(
      input.positionSeconds ?? 0,
      input.durationSeconds
    );

    const ownedRoomCount = [...this.rooms.values()]
      .filter((room) => room.createdByUserId === hostUserId).length;
    if (ownedRoomCount >= this.maxRoomsPerHost) {
      throw new WatchRoomError('ROOM_LIMIT_REACHED', 'The host has reached the active room limit');
    }

    const roomId = this.allocateRoomId();
    const inviteToken = this.randomToken(INVITE_TOKEN_BYTES);
    const host = this.newParticipant(hostUserId, 'host', now);
    const room: InternalRoom = {
      id: roomId,
      inviteHash: hashInvite(inviteToken),
      createdByUserId: hostUserId,
      hostUserId,
      mediaId,
      durationSeconds: input.durationSeconds,
      createdAtMs: now,
      absoluteExpiresAtMs: now + this.roomTtlMs,
      // REST creation establishes membership, not a live realtime connection.
      emptySinceMs: now,
      timeline: {
        paused: true,
        anchorPositionSeconds: positionSeconds,
        anchorServerTimeMs: now,
        revision: 0
      },
      participants: new Map([[hostUserId, host]])
    };
    this.rooms.set(roomId, room);

    return {
      roomId,
      inviteToken,
      snapshot: this.snapshot(room, host, now)
    };
  }

  joinRoom(input: JoinWatchRoomInput): WatchRoomSnapshot {
    const now = this.now();
    const room = this.requireRoom(input.roomId, now);
    const userId = requireNonEmptyString(input.userId, 'userId');
    if (!inviteMatches(room.inviteHash, input.inviteToken)) {
      throw new WatchRoomError('INVALID_INVITE', 'The room invitation is invalid');
    }

    let participant = room.participants.get(userId);
    if (!participant) {
      if (room.participants.size >= this.maxParticipants) {
        throw new WatchRoomError('ROOM_FULL', 'The room participant limit has been reached');
      }
      participant = this.newParticipant(userId, 'member', now);
      room.participants.set(userId, participant);
    } else {
      participant.lastSeenAtMs = now;
    }
    return this.snapshot(room, participant, now);
  }

  getMemberSnapshot(roomId: string, userId: string): WatchRoomSnapshot {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireParticipant(room, userId);
    return this.snapshot(room, participant, now);
  }

  /**
   * Returns the media identity needed for an authorization check before a
   * caller is admitted. Routers must not expose this value until their scoped
   * media resolver has approved the requesting principal.
   */
  getRoomMediaId(roomId: string): string {
    return this.requireRoom(roomId, this.now()).mediaId;
  }

  /** Marks an authenticated room member as having an active realtime connection. */
  connectMember(roomId: string, userId: string): WatchRoomSnapshot {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireParticipant(room, userId);
    participant.connected = true;
    participant.hasConnected = true;
    participant.disconnectedAtMs = null;
    participant.lastSeenAtMs = now;
    room.emptySinceMs = null;
    return this.snapshot(room, participant, now);
  }

  disconnectMember(roomId: string, userId: string): void {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireParticipant(room, userId);
    if (!participant.connected) return;
    participant.connected = false;
    participant.disconnectedAtMs = now;
    participant.lastSeenAtMs = now;
    if (![...room.participants.values()].some((candidate) => candidate.connected)) {
      room.emptySinceMs = now;
    }
  }

  applyCommand(roomId: string, userId: string, command: WatchRoomCommand): WatchRoomTimeline {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireHost(room, userId);
    const position = requireFinitePosition(command.positionSeconds, room.durationSeconds);
    if (command.action !== 'play' && command.action !== 'pause' && command.action !== 'seek') {
      throw new WatchRoomError('INVALID_INPUT', 'Unsupported room command');
    }

    room.timeline.anchorPositionSeconds = position;
    room.timeline.anchorServerTimeMs = now;
    if (command.action === 'play') room.timeline.paused = false;
    if (command.action === 'pause') room.timeline.paused = true;
    room.timeline.revision += 1;
    participant.lastSeenAtMs = now;
    return this.projectTimeline(room, now);
  }

  applyHostReport(
    roomId: string,
    userId: string,
    report: WatchRoomHostReport
  ): WatchRoomHostReportResult {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireHost(room, userId);
    if (!Number.isSafeInteger(report.revision) || report.revision < 0) {
      throw new WatchRoomError('INVALID_INPUT', 'revision must be a non-negative integer');
    }
    const position = requireFinitePosition(report.positionSeconds, room.durationSeconds);
    if (typeof report.paused !== 'boolean') {
      throw new WatchRoomError('INVALID_INPUT', 'paused must be a boolean');
    }

    participant.lastSeenAtMs = now;
    if (report.revision !== room.timeline.revision) {
      return { accepted: false, timeline: this.projectTimeline(room, now) };
    }

    room.timeline.anchorPositionSeconds = position;
    room.timeline.anchorServerTimeMs = now;
    room.timeline.paused = report.paused;
    return { accepted: true, timeline: this.projectTimeline(room, now) };
  }

  updatePreferences(
    roomId: string,
    userId: string,
    update: UpdateWatchRoomPreferences
  ): WatchRoomSnapshot {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireParticipant(room, userId);
    if (update.audioTrackIndex !== undefined) {
      participant.preferences.audioTrackIndex = requireTrackIndex(
        update.audioTrackIndex,
        'audioTrackIndex'
      );
    }
    if (update.subtitleTrackIndex !== undefined) {
      participant.preferences.subtitleTrackIndex = requireTrackIndex(
        update.subtitleTrackIndex,
        'subtitleTrackIndex'
      );
    }
    participant.lastSeenAtMs = now;
    return this.snapshot(room, participant, now);
  }

  leaveRoom(roomId: string, userId: string): void {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    const participant = this.requireParticipant(room, userId);
    room.participants.delete(userId);

    if (room.participants.size === 0) {
      this.rooms.delete(room.id);
      return;
    }
    if (participant.role === 'host') this.promoteNextHost(room, true);
    if (![...room.participants.values()].some((candidate) => candidate.connected)) {
      room.emptySinceMs ??= now;
    }
  }

  closeRoom(roomId: string, userId: string): void {
    const now = this.now();
    const room = this.requireRoom(roomId, now);
    this.requireHost(room, userId);
    this.rooms.delete(room.id);
  }

  /** Runs promotion and expiration maintenance and returns removed room IDs. */
  cleanupExpired(): string[] {
    return this.maintainAll(this.now());
  }

  get size(): number {
    return this.rooms.size;
  }

  private now(): number {
    const now = this.nowProvider();
    if (!Number.isFinite(now)) {
      throw new WatchRoomError('INVALID_INPUT', 'The room clock returned a non-finite value');
    }
    return now;
  }

  private randomToken(size: number): string {
    const bytes = this.randomBytesProvider(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw new WatchRoomError('INVALID_INPUT', `The room RNG must return exactly ${size} bytes`);
    }
    return Buffer.from(bytes).toString('base64url');
  }

  private allocateRoomId(): string {
    for (let attempt = 0; attempt < ROOM_ID_ATTEMPTS; attempt += 1) {
      const roomId = `room_${this.randomToken(ROOM_ID_BYTES)}`;
      if (!this.rooms.has(roomId)) return roomId;
    }
    throw new Error('Unable to allocate a unique watch room identifier');
  }

  private newParticipant(userId: string, role: WatchRoomRole, now: number): InternalParticipant {
    return {
      userId,
      role,
      connected: false,
      hasConnected: false,
      joinedAtMs: now,
      lastSeenAtMs: now,
      disconnectedAtMs: null,
      preferences: { audioTrackIndex: null, subtitleTrackIndex: null }
    };
  }

  private requireRoom(roomId: string, now: number): InternalRoom {
    requireNonEmptyString(roomId, 'roomId');
    this.maintainAll(now);
    const room = this.rooms.get(roomId);
    if (!room) throw new WatchRoomError('ROOM_NOT_FOUND', 'Watch room not found');
    return room;
  }

  private requireParticipant(room: InternalRoom, userId: string): InternalParticipant {
    requireNonEmptyString(userId, 'userId');
    const participant = room.participants.get(userId);
    if (!participant) throw new WatchRoomError('NOT_MEMBER', 'The user is not a room member');
    return participant;
  }

  private requireHost(room: InternalRoom, userId: string): InternalParticipant {
    const participant = this.requireParticipant(room, userId);
    if (participant.role !== 'host' || room.hostUserId !== userId) {
      throw new WatchRoomError('HOST_ONLY', 'Only the room host may perform this action');
    }
    return participant;
  }

  private projectTimeline(room: InternalRoom, now: number): WatchRoomTimeline {
    const elapsedSeconds = room.timeline.paused
      ? 0
      : Math.max(0, now - room.timeline.anchorServerTimeMs) / 1000;
    return {
      mediaId: room.mediaId,
      durationSeconds: room.durationSeconds,
      positionSeconds: Math.min(
        room.durationSeconds,
        Math.max(0, room.timeline.anchorPositionSeconds + elapsedSeconds)
      ),
      paused: room.timeline.paused,
      revision: room.timeline.revision,
      serverTimeMs: now
    };
  }

  private snapshot(
    room: InternalRoom,
    self: InternalParticipant,
    now: number
  ): WatchRoomSnapshot {
    const participants = [...room.participants.values()]
      .sort((left, right) => left.joinedAtMs - right.joinedAtMs || left.userId.localeCompare(right.userId))
      .map((participant) => this.publicParticipant(participant));
    return {
      roomId: room.id,
      hostUserId: room.hostUserId,
      mediaId: room.mediaId,
      createdAtMs: room.createdAtMs,
      expiresAtMs: this.effectiveExpiresAt(room),
      timeline: this.projectTimeline(room, now),
      participants,
      self: {
        ...this.publicParticipant(self),
        preferences: { ...self.preferences }
      }
    };
  }

  private publicParticipant(participant: InternalParticipant): WatchRoomParticipant {
    return {
      userId: participant.userId,
      role: participant.role,
      connected: participant.connected,
      joinedAtMs: participant.joinedAtMs,
      lastSeenAtMs: participant.lastSeenAtMs
    };
  }

  private effectiveExpiresAt(room: InternalRoom): number {
    if (room.emptySinceMs === null) return room.absoluteExpiresAtMs;
    return Math.min(room.absoluteExpiresAtMs, room.emptySinceMs + this.emptyRoomTtlMs);
  }

  private promoteNextHost(room: InternalRoom, includeDisconnected: boolean): boolean {
    const candidates = [...room.participants.values()]
      .filter((participant) => participant.userId !== room.hostUserId)
      .filter((participant) => includeDisconnected || participant.connected)
      .sort((left, right) => {
        if (left.connected !== right.connected) return left.connected ? -1 : 1;
        return left.joinedAtMs - right.joinedAtMs || left.userId.localeCompare(right.userId);
      });
    const nextHost = candidates[0];
    if (!nextHost) return false;

    const previousHost = room.participants.get(room.hostUserId);
    if (previousHost) previousHost.role = 'member';
    nextHost.role = 'host';
    room.hostUserId = nextHost.userId;
    return true;
  }

  private maintainAll(now: number): string[] {
    const removed: string[] = [];
    for (const room of this.rooms.values()) {
      if (now >= this.effectiveExpiresAt(room)) {
        this.rooms.delete(room.id);
        removed.push(room.id);
        continue;
      }

      const host = room.participants.get(room.hostUserId);
      if (
        host?.hasConnected && !host.connected && host.disconnectedAtMs !== null &&
        now - host.disconnectedAtMs >= this.reconnectGraceMs
      ) {
        this.promoteNextHost(room, false);
      }
    }
    return removed;
  }
}
