import { spawn } from 'child_process';
import type { MarkerAnalysisInput, MarkerCandidate, MarkerDetector } from './types';

const MAX_PROBE_OUTPUT_BYTES = 2 * 1024 * 1024;
const INTRO_TITLE = /\b(intro(?:duction)?|opening(?: credits?)?|theme)\b/i;
const CREDITS_TITLE = /\b(end credits?|closing credits?|credits?|outro|ending)\b/i;

interface ProbeChapter {
  start_time?: unknown;
  end_time?: unknown;
  tags?: { title?: unknown; TITLE?: unknown };
}

interface ProbeDocument {
  chapters?: unknown;
}

export type ChapterProbe = (fullPath: string, signal: AbortSignal) => Promise<unknown>;

function finiteTime(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseChapterMarkerCandidates(
  document: unknown,
  duration: number
): MarkerCandidate[] {
  if (!document || typeof document !== 'object') return [];
  const chapters = (document as ProbeDocument).chapters;
  if (!Array.isArray(chapters)) return [];

  const candidates: MarkerCandidate[] = [];
  for (const rawChapter of chapters) {
    if (!rawChapter || typeof rawChapter !== 'object') continue;
    const chapter = rawChapter as ProbeChapter;
    const startSeconds = finiteTime(chapter.start_time);
    const endSeconds = finiteTime(chapter.end_time);
    const rawTitle = chapter.tags?.title ?? chapter.tags?.TITLE;
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds || !title) continue;
    if (duration > 0 && (startSeconds >= duration || endSeconds > duration + 1)) continue;

    const rangeDuration = endSeconds - startSeconds;
    if (
      INTRO_TITLE.test(title)
      && startSeconds <= Math.min(600, duration > 0 ? duration * 0.35 : 600)
      && rangeDuration >= 5
      && rangeDuration <= 300
    ) {
      candidates.push({
        type: 'intro', startSeconds, endSeconds: duration > 0 ? Math.min(endSeconds, duration) : endSeconds,
        confidence: 0.98
      });
    }

    const creditsThreshold = duration > 0 ? Math.max(duration * 0.65, duration - 1200) : 0;
    if (
      CREDITS_TITLE.test(title)
      && startSeconds >= creditsThreshold
      && rangeDuration >= 10
      && rangeDuration <= 1800
    ) {
      candidates.push({
        type: 'credits', startSeconds, endSeconds: duration > 0 ? Math.min(endSeconds, duration) : endSeconds,
        confidence: 0.99
      });
    }
  }

  const intro = candidates.find((candidate) => candidate.type === 'intro');
  const credits = [...candidates].reverse().find((candidate) => candidate.type === 'credits');
  return [intro, credits].filter((candidate): candidate is MarkerCandidate => !!candidate);
}

export async function runChapterProbe(fullPath: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

  return await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_chapters',
      fullPath
    ], { windowsHide: true });
    let output = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
    };
    signal.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error('ffprobe chapter output exceeded the safety limit')));
        return;
      }
      output += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`ffprobe chapter scan failed with exit code ${code ?? 'unknown'}`));
        return;
      }
      try {
        resolve(JSON.parse(output || '{}'));
      } catch {
        reject(new Error('ffprobe returned invalid chapter JSON'));
      }
    }));
  });
}

export class ChapterMarkerDetector implements MarkerDetector {
  readonly id = 'chapters';
  readonly version = '1';

  constructor(private readonly probe: ChapterProbe = runChapterProbe) {}

  async detect(input: MarkerAnalysisInput, signal: AbortSignal): Promise<MarkerCandidate[]> {
    const document = await this.probe(input.fullPath, signal);
    return parseChapterMarkerCandidates(document, input.duration);
  }
}
