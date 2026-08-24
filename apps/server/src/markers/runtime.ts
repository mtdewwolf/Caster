import { db } from '../db';
import { MediaMarkerStore } from '../db/media-marker-store';
import { MarkerAnalysisService, type MarkerAnalysisResult } from './analysis-service';
import { ChapterMarkerDetector } from './chapter-detector';
import {
  MarkerAnalysisQueueFullError,
  MarkerAnalysisScheduler
} from './scheduler';
import type { MarkerAnalysisInput, MarkerAnalysisStatus } from './types';

const runtimeMarkerStore = new MediaMarkerStore(db);
const runtimeAnalysisService = new MarkerAnalysisService(
  runtimeMarkerStore,
  [new ChapterMarkerDetector()]
);

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number(raw)));
}

/** Shared by scanner enqueue calls and playback analysis/status routes. */
export const defaultMarkerAnalysisScheduler = new MarkerAnalysisScheduler<
  MarkerAnalysisInput,
  MarkerAnalysisResult
>(
  (input, signal) => runtimeAnalysisService.analyze(input, signal),
  {
    concurrency: boundedEnvironmentInteger('CASTER_MARKER_ANALYSIS_CONCURRENCY', 1, 1, 4),
    // A large first scan remains nonblocking while memory usage stays bounded.
    maxQueue: boundedEnvironmentInteger('CASTER_MARKER_ANALYSIS_QUEUE_CAPACITY', 2048, 32, 10_000),
    timeoutMs: boundedEnvironmentInteger('CASTER_MARKER_ANALYSIS_TIMEOUT_MS', 120_000, 1000, 600_000)
  }
);

export interface SafeMarkerAnalysisEnqueueResult {
  accepted: boolean;
  reason?:
    | 'already_queued'
    | 'queue_full'
    | 'invalid_input'
    | 'manual_override'
    | 'markers_complete';
  status: MarkerAnalysisStatus<MarkerAnalysisResult> | null;
}

interface MarkerGovernanceReader {
  get: MediaMarkerStore['get'];
}

interface MarkerSchedulerEnqueuer {
  enqueue: MarkerAnalysisScheduler<MarkerAnalysisInput, MarkerAnalysisResult>['enqueue'];
}

/**
 * Scanner integration hook. It never throws into a library scan: malformed
 * inputs and temporary queue saturation are reported as an unaccepted result.
 */
export function createMediaMarkerAnalysisEnqueuer(
  markerStore: MarkerGovernanceReader,
  scheduler: MarkerSchedulerEnqueuer
): (input: MarkerAnalysisInput) => SafeMarkerAnalysisEnqueueResult {
  return (input) => {
    if (
      !input.mediaId.trim() || !input.fullPath.trim() ||
      !Number.isFinite(input.duration) || input.duration < 0
    ) {
      return { accepted: false, reason: 'invalid_input', status: null };
    }

    try {
      const existing = [
        markerStore.get(input.mediaId, 'intro'),
        markerStore.get(input.mediaId, 'credits')
      ];
      if (existing.every((marker) => marker && (marker.source === 'manual' || marker.state === 'disabled'))) {
        return { accepted: false, reason: 'manual_override', status: null };
      }
      if (existing.every((marker) => marker?.state === 'active')) {
        return { accepted: false, reason: 'markers_complete', status: null };
      }

      const queued = scheduler.enqueue(input.mediaId, input);
      return {
        ...queued,
        ...(queued.accepted ? {} : { reason: 'already_queued' as const })
      };
    } catch (error) {
      if (error instanceof MarkerAnalysisQueueFullError) {
        return { accepted: false, reason: 'queue_full', status: null };
      }
      // Analysis must remain best-effort and must never make media scanning fail.
      return { accepted: false, reason: 'invalid_input', status: null };
    }
  };
}

/**
 * Scanner integration hook. The configurable queue is bounded; callers can
 * count `queue_full` outcomes and schedule a later retry without failing the
 * scan. Existing complete/manual marker sets are not needlessly reanalyzed.
 */
export const enqueueMediaMarkerAnalysis = createMediaMarkerAnalysisEnqueuer(
  runtimeMarkerStore,
  defaultMarkerAnalysisScheduler
);
