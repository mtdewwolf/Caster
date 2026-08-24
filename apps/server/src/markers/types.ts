import type { MediaMarkerType } from '../db/media-marker-store';

export interface MarkerAnalysisInput {
  mediaId: string;
  fullPath: string;
  duration: number;
}

export interface MarkerCandidate {
  type: MediaMarkerType;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
}

export interface MarkerDetector {
  readonly id: string;
  readonly version: string;
  detect(input: MarkerAnalysisInput, signal: AbortSignal): Promise<MarkerCandidate[]>;
}

export type MarkerAnalysisState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface MarkerAnalysisStatus<TResult = unknown> {
  mediaId: string;
  state: MarkerAnalysisState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: TResult;
  error?: string;
}

export function markerAnalysisIsTerminal(state: MarkerAnalysisState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed_out';
}
