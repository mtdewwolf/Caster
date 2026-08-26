/**
 * Decides where a requested HLS segment should come from.
 *
 * The old engine answered this by spawning one FFmpeg per six-second segment,
 * which meant a full process start, seek and teardown for every few seconds of
 * video. A session encodes continuously instead, so most requests are just a
 * file read — and the interesting question becomes when a request falls outside
 * what the running session will produce and needs a fresh one.
 *
 * Kept free of process and filesystem calls so every branch is directly
 * testable.
 */

export interface SessionWindow {
  /** First segment number this session was started at. */
  startSegment: number;
  /** Highest segment number known to be completely written. */
  highestReady: number;
  /** False once the encoder has exited, successfully or not. */
  running: boolean;
}

export type SegmentDecision =
  /** Read it from the session directory now. */
  | { action: 'serve' }
  /** The encoder is close behind; wait for it rather than starting over. */
  | { action: 'wait' }
  /** No usable session. Start one positioned at this segment. */
  | { action: 'start'; startSegment: number }
  /** The request is outside what this session will reach. Re-seek. */
  | { action: 'restart'; startSegment: number; reason: RestartReason };

export type RestartReason = 'seek-backward' | 'seek-forward' | 'encoder-stopped';

export interface SegmentDecisionOptions {
  /**
   * How many segments ahead of the encoder a request may be before it is
   * cheaper to re-seek than to wait. Roughly the number of segments the encoder
   * can produce in the time a viewer will tolerate buffering.
   */
  lookaheadLimit: number;
}

export const DEFAULT_LOOKAHEAD_SEGMENTS = 12;

export function decideSegmentSource(
  requested: number,
  session: SessionWindow | null,
  options: SegmentDecisionOptions = { lookaheadLimit: DEFAULT_LOOKAHEAD_SEGMENTS }
): SegmentDecision {
  if (!session) {
    return { action: 'start', startSegment: requested };
  }

  // Seeking backwards past the session's origin: this encoder will never
  // produce the segment, however long we wait.
  if (requested < session.startSegment) {
    return { action: 'restart', startSegment: requested, reason: 'seek-backward' };
  }

  if (requested <= session.highestReady) {
    return { action: 'serve' };
  }

  if (!session.running) {
    return { action: 'restart', startSegment: requested, reason: 'encoder-stopped' };
  }

  const lookaheadLimit = Math.max(1, options.lookaheadLimit);
  if (requested <= session.highestReady + lookaheadLimit) {
    return { action: 'wait' };
  }

  // A long jump forward: re-seeking gets there far sooner than encoding
  // everything in between.
  return { action: 'restart', startSegment: requested, reason: 'seek-forward' };
}

/**
 * Identity for a session. Two viewers watching the same media at the same
 * quality and audio settings share one encoder; anything else gets its own.
 */
export function sessionKey(
  mediaId: string,
  quality: string,
  audioKey: string
): string {
  return `${mediaId}::${quality}::${audioKey}`;
}

/**
 * Directory name for a session, safe for any media ID.
 *
 * Separators and dots are both removed: slashes would escape the cache root,
 * and a bare `..` component has no business appearing in a path even once the
 * slashes are gone.
 */
export function sessionDirectoryName(key: string, sessionId: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  return `session_${safe}_${sessionId}`;
}
