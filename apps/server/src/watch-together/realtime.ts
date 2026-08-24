import type {
  WatchRoomClientMessage,
  WatchRoomServerMessage,
  WatchRoomSnapshot,
  WatchRoomTimelineCause
} from './contracts';
import { WatchRoomError } from './contracts';
import { WatchRoomService } from './room-service';

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 30;
const DEFAULT_SYNC_INTERVAL_MS = 2_000;

export interface WatchRoomRealtimePeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Connection {
  roomId: string;
  userId: string;
  peer: WatchRoomRealtimePeer;
  windowStartedAtMs: number;
  messagesInWindow: number;
}

export interface WatchRoomRealtimeOptions {
  now?: () => number;
  maxMessageBytes?: number;
  rateWindowMs?: number;
  maxMessagesPerWindow?: number;
  syncIntervalMs?: number;
}

function asPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function byteLength(value: string | ArrayBufferLike): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
}

function receivedText(value: string | ArrayBufferLike): string | null {
  if (typeof value === 'string') return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class WatchRoomRealtimeHub {
  private readonly connections = new Map<string, Map<string, Connection>>();
  private readonly nowProvider: () => number;
  private readonly maxMessageBytes: number;
  private readonly rateWindowMs: number;
  private readonly maxMessagesPerWindow: number;
  private readonly syncIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly service: WatchRoomService,
    options: WatchRoomRealtimeOptions = {}
  ) {
    this.nowProvider = options.now ?? Date.now;
    this.maxMessageBytes = asPositiveInteger(
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      'maxMessageBytes'
    );
    this.rateWindowMs = asPositiveInteger(
      options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
      'rateWindowMs'
    );
    this.maxMessagesPerWindow = asPositiveInteger(
      options.maxMessagesPerWindow ?? DEFAULT_MAX_MESSAGES_PER_WINDOW,
      'maxMessagesPerWindow'
    );
    this.syncIntervalMs = asPositiveInteger(
      options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
      'syncIntervalMs'
    );
  }

  start(): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), this.syncIntervalMs);
      this.timer.unref?.();
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  connect(roomId: string, userId: string, peer: WatchRoomRealtimePeer): void {
    const existing = this.connections.get(roomId)?.get(userId);
    if (existing) {
      existing.peer.close(4001, 'Replaced by a newer connection');
      this.connections.get(roomId)?.delete(userId);
    }

    const snapshot = this.service.connectMember(roomId, userId);
    const roomConnections = this.connections.get(roomId) ?? new Map<string, Connection>();
    roomConnections.set(userId, {
      roomId,
      userId,
      peer,
      windowStartedAtMs: this.now(),
      messagesInWindow: 0
    });
    this.connections.set(roomId, roomConnections);
    this.send(peer, { type: 'snapshot', room: snapshot });
    this.broadcastPresence(roomId, snapshot);
  }

  disconnect(roomId: string, userId: string, peer: WatchRoomRealtimePeer): void {
    const roomConnections = this.connections.get(roomId);
    const connection = roomConnections?.get(userId);
    if (!connection || connection.peer !== peer) return;
    roomConnections!.delete(userId);
    if (roomConnections!.size === 0) this.connections.delete(roomId);

    try {
      this.service.disconnectMember(roomId, userId);
      const observer = this.firstConnection(roomId);
      if (observer) {
        this.broadcastPresence(roomId, this.service.getMemberSnapshot(roomId, observer.userId));
      }
    } catch (error) {
      if (!(error instanceof WatchRoomError) || error.code !== 'ROOM_NOT_FOUND') throw error;
    }
  }

  /** Detaches a socket after the REST layer has already removed its member. */
  evictMember(roomId: string, userId: string): void {
    const roomConnections = this.connections.get(roomId);
    const connection = roomConnections?.get(userId);
    if (connection) {
      roomConnections!.delete(userId);
      connection.peer.close(4000, 'Left watch room');
    }
    if (roomConnections?.size === 0) this.connections.delete(roomId);
    const observer = this.firstConnection(roomId);
    if (observer) {
      try {
        this.broadcastPresence(roomId, this.service.getMemberSnapshot(roomId, observer.userId));
      } catch (error) {
        if (!(error instanceof WatchRoomError) || error.code !== 'ROOM_NOT_FOUND') throw error;
      }
    }
  }

  closeConnections(roomId: string, reason = 'Watch room closed'): void {
    const roomConnections = this.connections.get(roomId);
    if (!roomConnections) return;
    this.connections.delete(roomId);
    for (const connection of roomConnections.values()) connection.peer.close(4004, reason);
  }

  receive(
    roomId: string,
    userId: string,
    peer: WatchRoomRealtimePeer,
    raw: string | ArrayBufferLike
  ): void {
    const connection = this.connections.get(roomId)?.get(userId);
    if (!connection || connection.peer !== peer) {
      peer.close(4003, 'Room connection is no longer active');
      return;
    }
    if (byteLength(raw) > this.maxMessageBytes) {
      peer.close(1009, 'Message too large');
      return;
    }
    if (!this.consumeRate(connection)) {
      peer.close(1008, 'Message rate exceeded');
      return;
    }

    const text = receivedText(raw);
    let message: unknown;
    try {
      message = text === null ? null : JSON.parse(text);
    } catch {
      message = null;
    }
    if (!isObject(message) || typeof message.type !== 'string') {
      this.error(peer, 'INVALID_MESSAGE', 'A valid JSON message is required');
      return;
    }

    try {
      this.dispatch(connection, message as unknown as WatchRoomClientMessage);
    } catch (error) {
      if (!(error instanceof WatchRoomError)) throw error;
      this.error(
        peer,
        error.code,
        error.message,
        typeof message.requestId === 'string' ? message.requestId : undefined
      );
    }
  }

  /** Performs expiration, role promotion, presence and periodic timeline sync. */
  sweep(): void {
    for (const roomId of this.service.cleanupExpired()) {
      const expired = this.connections.get(roomId);
      if (!expired) continue;
      for (const connection of expired.values()) {
        connection.peer.close(4004, 'Watch room expired');
      }
      this.connections.delete(roomId);
    }

    for (const [roomId, roomConnections] of this.connections) {
      const observer = roomConnections.values().next().value as Connection | undefined;
      if (!observer) continue;
      try {
        const snapshot = this.service.getMemberSnapshot(roomId, observer.userId);
        this.broadcast(roomId, {
          type: 'timeline',
          timeline: snapshot.timeline,
          cause: 'periodic'
        });
        this.broadcastPresence(roomId, snapshot);
      } catch (error) {
        if (!(error instanceof WatchRoomError) || error.code !== 'ROOM_NOT_FOUND') throw error;
        this.closeConnections(roomId);
      }
    }
  }

  private dispatch(connection: Connection, message: WatchRoomClientMessage): void {
    switch (message.type) {
      case 'command': {
        const timeline = this.service.applyCommand(
          connection.roomId,
          connection.userId,
          { action: message.action, positionSeconds: message.positionSeconds }
        );
        this.broadcast(connection.roomId, {
          type: 'timeline',
          timeline,
          cause: message.action as WatchRoomTimelineCause
        });
        return;
      }
      case 'host-report': {
        const result = this.service.applyHostReport(connection.roomId, connection.userId, {
          revision: message.revision,
          positionSeconds: message.positionSeconds,
          paused: message.paused
        });
        if (result.accepted) {
          this.broadcast(connection.roomId, {
            type: 'timeline', timeline: result.timeline, cause: 'host-report'
          });
        } else {
          this.send(connection.peer, {
            type: 'timeline', timeline: result.timeline, cause: 'periodic'
          });
        }
        return;
      }
      case 'preferences': {
        const room = this.service.updatePreferences(connection.roomId, connection.userId, {
          ...(message.audioTrackIndex === undefined
            ? {}
            : { audioTrackIndex: message.audioTrackIndex }),
          ...(message.subtitleTrackIndex === undefined
            ? {}
            : { subtitleTrackIndex: message.subtitleTrackIndex })
        });
        this.send(connection.peer, { type: 'preferences', preferences: room.self.preferences });
        return;
      }
      case 'ping': {
        if (!Number.isFinite(message.clientTimeMs)) {
          throw new WatchRoomError('INVALID_INPUT', 'clientTimeMs must be finite');
        }
        this.send(connection.peer, {
          type: 'pong', clientTimeMs: message.clientTimeMs, serverTimeMs: this.now()
        });
        return;
      }
      default:
        throw new WatchRoomError('INVALID_INPUT', 'Unsupported realtime message type');
    }
  }

  private consumeRate(connection: Connection): boolean {
    const now = this.now();
    if (now - connection.windowStartedAtMs >= this.rateWindowMs) {
      connection.windowStartedAtMs = now;
      connection.messagesInWindow = 0;
    }
    connection.messagesInWindow += 1;
    return connection.messagesInWindow <= this.maxMessagesPerWindow;
  }

  private broadcastPresence(roomId: string, snapshot: WatchRoomSnapshot): void {
    this.broadcast(roomId, {
      type: 'presence',
      hostUserId: snapshot.hostUserId,
      participants: snapshot.participants
    });
  }

  private broadcast(roomId: string, message: WatchRoomServerMessage): void {
    for (const connection of this.connections.get(roomId)?.values() ?? []) {
      this.send(connection.peer, message);
    }
  }

  private send(peer: WatchRoomRealtimePeer, message: WatchRoomServerMessage): void {
    peer.send(JSON.stringify(message));
  }

  private error(
    peer: WatchRoomRealtimePeer,
    code: string,
    message: string,
    requestId?: string
  ): void {
    this.send(peer, {
      type: 'error', code, message, ...(requestId ? { requestId } : {})
    });
  }

  private firstConnection(roomId: string): Connection | undefined {
    return this.connections.get(roomId)?.values().next().value;
  }

  private now(): number {
    const value = this.nowProvider();
    if (!Number.isFinite(value)) throw new Error('Realtime clock returned a non-finite value');
    return value;
  }
}
