export type WatchRoomRole = 'host' | 'member';

export interface WatchRoomPreferences {
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
}

export interface WatchRoomTimeline {
  mediaId: string;
  durationSeconds: number;
  positionSeconds: number;
  paused: boolean;
  revision: number;
  serverTimeMs: number;
}

export interface WatchRoomParticipant {
  userId: string;
  role: WatchRoomRole;
  connected: boolean;
  joinedAtMs: number;
  lastSeenAtMs: number;
}

export interface WatchRoomSelf extends WatchRoomParticipant {
  preferences: WatchRoomPreferences;
}

/**
 * A member-scoped room view. Track preferences are deliberately exposed only
 * for the requesting member; they never form part of the shared timeline.
 */
export interface WatchRoomSnapshot {
  roomId: string;
  hostUserId: string;
  mediaId: string;
  createdAtMs: number;
  expiresAtMs: number;
  timeline: WatchRoomTimeline;
  participants: WatchRoomParticipant[];
  self: WatchRoomSelf;
}

export interface CreateWatchRoomInput {
  hostUserId: string;
  mediaId: string;
  durationSeconds: number;
  positionSeconds?: number;
}

export interface CreateWatchRoomResult {
  roomId: string;
  /** Returned once. The service retains only a SHA-256 digest. */
  inviteToken: string;
  snapshot: WatchRoomSnapshot;
}

export interface JoinWatchRoomInput {
  roomId: string;
  userId: string;
  inviteToken: string;
}

export type WatchRoomCommand =
  | { action: 'play'; positionSeconds: number }
  | { action: 'pause'; positionSeconds: number }
  | { action: 'seek'; positionSeconds: number };

export interface WatchRoomHostReport {
  revision: number;
  positionSeconds: number;
  paused: boolean;
}

export interface WatchRoomHostReportResult {
  /** False means a report raced with a newer host command and was ignored. */
  accepted: boolean;
  timeline: WatchRoomTimeline;
}

export interface UpdateWatchRoomPreferences {
  audioTrackIndex?: number | null;
  subtitleTrackIndex?: number | null;
}

export type WatchRoomClientMessage =
  | ({ type: 'command'; requestId?: string } & WatchRoomCommand)
  | ({ type: 'host-report' } & WatchRoomHostReport)
  | ({ type: 'preferences' } & UpdateWatchRoomPreferences)
  | { type: 'ping'; clientTimeMs: number };

export type WatchRoomTimelineCause =
  | 'snapshot'
  | 'play'
  | 'pause'
  | 'seek'
  | 'host-report'
  | 'periodic';

export type WatchRoomServerMessage =
  | { type: 'snapshot'; room: WatchRoomSnapshot }
  | { type: 'timeline'; timeline: WatchRoomTimeline; cause: WatchRoomTimelineCause }
  | {
      type: 'presence';
      hostUserId: string;
      participants: WatchRoomParticipant[];
    }
  | { type: 'preferences'; preferences: WatchRoomPreferences }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number }
  | { type: 'error'; code: string; message: string; requestId?: string };

export type WatchRoomErrorCode =
  | 'INVALID_INPUT'
  | 'ROOM_NOT_FOUND'
  | 'INVALID_INVITE'
  | 'NOT_MEMBER'
  | 'HOST_ONLY'
  | 'ROOM_FULL'
  | 'ROOM_LIMIT_REACHED';

export class WatchRoomError extends Error {
  constructor(
    public readonly code: WatchRoomErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WatchRoomError';
  }
}
