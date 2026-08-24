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

export interface WatchRoomSnapshot {
  roomId: string;
  hostUserId: string;
  mediaId: string;
  createdAtMs: number;
  expiresAtMs: number;
  timeline: WatchRoomTimeline;
  participants: WatchRoomParticipant[];
  self: WatchRoomParticipant & { preferences: WatchRoomPreferences };
}

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
  | { type: 'presence'; hostUserId: string; participants: WatchRoomParticipant[] }
  | { type: 'preferences'; preferences: WatchRoomPreferences }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number }
  | { type: 'error'; code: string; message: string; requestId?: string };

export interface WatchRoomLaunch {
  roomId: string;
  /** Present only for the creator and kept in memory for copying. */
  inviteUrl?: string;
}
