import { MediaMarkerStore, type MediaMarker } from '../db/media-marker-store';
import type { MarkerAnalysisInput, MarkerCandidate, MarkerDetector } from './types';

export interface MarkerAnalysisResult {
  detectorCount: number;
  candidateCount: number;
  markers: MediaMarker[];
  warnings: string[];
}

function abortError(signal: AbortSignal): never {
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function validCandidate(candidate: MarkerCandidate, duration: number): boolean {
  return (candidate.type === 'intro' || candidate.type === 'credits')
    && Number.isFinite(candidate.startSeconds)
    && candidate.startSeconds >= 0
    && Number.isFinite(candidate.endSeconds)
    && candidate.endSeconds > candidate.startSeconds
    && (duration <= 0 || candidate.endSeconds <= duration + 1)
    && Number.isFinite(candidate.confidence)
    && candidate.confidence >= 0
    && candidate.confidence <= 1;
}

export class MarkerAnalysisService {
  constructor(
    private readonly markerStore: MediaMarkerStore,
    private readonly detectors: readonly MarkerDetector[]
  ) {}

  async analyze(input: MarkerAnalysisInput, signal: AbortSignal): Promise<MarkerAnalysisResult> {
    const bestByType = new Map<MarkerCandidate['type'], { candidate: MarkerCandidate; detector: MarkerDetector }>();
    const warnings: string[] = [];
    let candidateCount = 0;

    for (const detector of this.detectors) {
      if (signal.aborted) abortError(signal);
      try {
        const candidates = await detector.detect(input, signal);
        for (const candidate of candidates) {
          if (!validCandidate(candidate, input.duration)) {
            warnings.push(`${detector.id} returned an invalid ${candidate.type} candidate`);
            continue;
          }
          candidateCount += 1;
          const current = bestByType.get(candidate.type);
          if (!current || candidate.confidence > current.candidate.confidence) {
            bestByType.set(candidate.type, { candidate, detector });
          }
        }
      } catch (error) {
        if (signal.aborted) abortError(signal);
        warnings.push(`${detector.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const markers: MediaMarker[] = [];
    for (const type of ['intro', 'credits'] as const) {
      const selected = bestByType.get(type);
      if (!selected) continue;
      markers.push(this.markerStore.upsertDetected({
        mediaId: input.mediaId,
        type,
        startSeconds: selected.candidate.startSeconds,
        endSeconds: input.duration > 0
          ? Math.min(selected.candidate.endSeconds, input.duration)
          : selected.candidate.endSeconds,
        confidence: selected.candidate.confidence,
        source: selected.detector.id,
        analyzerVersion: selected.detector.version
      }));
    }

    return { detectorCount: this.detectors.length, candidateCount, markers, warnings };
  }
}
