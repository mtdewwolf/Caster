import { describe, expect, it } from 'bun:test';
import {
  ChapterMarkerDetector,
  enqueueMediaMarkerAnalysis,
  MarkerAnalysisQueueFullError,
  MarkerAnalysisScheduler,
  parseChapterMarkerCandidates
} from '../apps/server/src/markers';

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Condition was not reached');
}

describe('chapter marker detector', () => {
  it('conservatively maps named opening and end-credit chapters', () => {
    const candidates = parseChapterMarkerCandidates({
      chapters: [
        { start_time: '0', end_time: '25', tags: { title: 'Cold Open' } },
        { start_time: '25', end_time: '115', tags: { title: 'Opening Theme' } },
        { start_time: '115', end_time: '2500', tags: { title: 'Episode' } },
        { start_time: '2500', end_time: '2700', tags: { title: 'End Credits' } }
      ]
    }, 2700);

    expect(candidates).toEqual([
      { type: 'intro', startSeconds: 25, endSeconds: 115, confidence: 0.98 },
      { type: 'credits', startSeconds: 2500, endSeconds: 2700, confidence: 0.99 }
    ]);
  });

  it('rejects malformed, overly broad, and implausibly placed chapters', () => {
    expect(parseChapterMarkerCandidates({ chapters: [
      { start_time: 'bad', end_time: '90', tags: { title: 'Intro' } },
      { start_time: '900', end_time: '1000', tags: { title: 'Opening' } },
      { start_time: '20', end_time: '100', tags: { title: 'Credits' } },
      { start_time: '5', end_time: '500', tags: { title: 'Intro' } }
    ] }, 1200)).toEqual([]);
  });

  it('uses an injectable probe and forwards cancellation', async () => {
    const controller = new AbortController();
    const detector = new ChapterMarkerDetector(async (path, signal) => {
      expect(path).toBe('/media/episode.mkv');
      expect(signal).toBe(controller.signal);
      return { chapters: [{ start_time: 10, end_time: 80, tags: { title: 'Intro' } }] };
    });
    const candidates = await detector.detect({
      mediaId: 'episode', fullPath: '/media/episode.mkv', duration: 1200
    }, controller.signal);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('intro');
  });
});

describe('bounded marker analysis scheduler', () => {
  it('offers a non-throwing scanner enqueue boundary for invalid work', () => {
    expect(enqueueMediaMarkerAnalysis({
      mediaId: '', fullPath: '/media/episode.mkv', duration: 1200
    })).toEqual({ accepted: false, reason: 'invalid_input', status: null });
    expect(enqueueMediaMarkerAnalysis({
      mediaId: 'episode', fullPath: '', duration: Number.NaN
    })).toEqual({ accepted: false, reason: 'invalid_input', status: null });
  });

  it('deduplicates media IDs and enforces its concurrency bound', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const scheduler = new MarkerAnalysisScheduler<string, string>(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return input.toUpperCase();
    }, { concurrency: 2, maxQueue: 4, timeoutMs: 1000 });

    expect(scheduler.enqueue('a', 'alpha').accepted).toBe(true);
    expect(scheduler.enqueue('a', 'ignored').accepted).toBe(false);
    scheduler.enqueue('b', 'bravo');
    scheduler.enqueue('c', 'charlie');
    await until(() => releases.length === 2);
    expect(maxActive).toBe(2);

    releases.shift()!();
    await until(() => releases.length === 2);
    releases.shift()!();
    releases.shift()!();
    expect((await scheduler.waitFor('a')).result).toBe('ALPHA');
    expect((await scheduler.waitFor('b')).state).toBe('completed');
    expect((await scheduler.waitFor('c')).state).toBe('completed');
    expect(maxActive).toBe(2);
  });

  it('isolates worker failures, cancellation, timeout, and queue capacity', async () => {
    const failed = new MarkerAnalysisScheduler<string, string>(async () => {
      throw new Error('detector exploded');
    });
    failed.enqueue('failed', 'x');
    expect(await failed.waitFor('failed')).toMatchObject({ state: 'failed', error: 'detector exploded' });

    const cancellable = new MarkerAnalysisScheduler<string, string>(async (_input, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return 'unreachable';
    }, { timeoutMs: 1000 });
    cancellable.enqueue('cancelled', 'x');
    await until(() => cancellable.getStatus('cancelled')?.state === 'running');
    expect(cancellable.cancel('cancelled')).toBe(true);
    expect((await cancellable.waitFor('cancelled')).state).toBe('cancelled');

    const timedOut = new MarkerAnalysisScheduler<string, string>(
      async () => await new Promise<string>(() => {}),
      { timeoutMs: 5 }
    );
    timedOut.enqueue('slow', 'x');
    expect((await timedOut.waitFor('slow')).state).toBe('timed_out');

    const blocked = new MarkerAnalysisScheduler<string, string>(
      async () => await new Promise<string>(() => {}),
      { concurrency: 1, maxQueue: 1, timeoutMs: 1000 }
    );
    blocked.enqueue('running', 'x');
    await until(() => blocked.getStatus('running')?.state === 'running');
    blocked.enqueue('queued', 'y');
    expect(() => blocked.enqueue('overflow', 'z')).toThrow(MarkerAnalysisQueueFullError);
    blocked.cancel('running');
    blocked.cancel('queued');
    await blocked.waitFor('running');
  });
});
