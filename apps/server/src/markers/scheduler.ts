import {
  markerAnalysisIsTerminal,
  type MarkerAnalysisStatus
} from './types';

export interface MarkerAnalysisSchedulerOptions {
  concurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
  now?: () => string;
}

interface QueuedTask<TInput> {
  mediaId: string;
  input: TInput;
}

interface Waiter<TResult> {
  resolve: (status: MarkerAnalysisStatus<TResult>) => void;
}

class SchedulerTimeoutError extends Error {}
class SchedulerCancelledError extends Error {}

export class MarkerAnalysisQueueFullError extends Error {
  constructor(readonly maxQueue: number) {
    super(`Marker analysis queue is full (${maxQueue})`);
    this.name = 'MarkerAnalysisQueueFullError';
  }
}

export class MarkerAnalysisScheduler<TInput, TResult> {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly queue: QueuedTask<TInput>[] = [];
  private readonly statuses = new Map<string, MarkerAnalysisStatus<TResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Waiter<TResult>[]>();
  private running = 0;

  constructor(
    private readonly worker: (input: TInput, signal: AbortSignal) => Promise<TResult>,
    options: MarkerAnalysisSchedulerOptions = {}
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? 32));
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 120_000));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  enqueue(mediaId: string, input: TInput): { accepted: boolean; status: MarkerAnalysisStatus<TResult> } {
    const existing = this.statuses.get(mediaId);
    if (existing && !markerAnalysisIsTerminal(existing.state)) {
      return { accepted: false, status: { ...existing } };
    }
    if (this.queue.length >= this.maxQueue) throw new MarkerAnalysisQueueFullError(this.maxQueue);

    const status: MarkerAnalysisStatus<TResult> = {
      mediaId,
      state: 'queued',
      queuedAt: this.now()
    };
    this.statuses.set(mediaId, status);
    this.queue.push({ mediaId, input });
    queueMicrotask(() => this.drain());
    return { accepted: true, status: { ...status } };
  }

  getStatus(mediaId: string): MarkerAnalysisStatus<TResult> | null {
    const status = this.statuses.get(mediaId);
    return status ? { ...status } : null;
  }

  cancel(mediaId: string): boolean {
    const status = this.statuses.get(mediaId);
    if (!status || markerAnalysisIsTerminal(status.state)) return false;
    const queuedIndex = this.queue.findIndex((task) => task.mediaId === mediaId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.finish(mediaId, { state: 'cancelled', error: 'Analysis cancelled' });
      return true;
    }
    this.controllers.get(mediaId)?.abort(new SchedulerCancelledError('Analysis cancelled'));
    return true;
  }

  waitFor(mediaId: string): Promise<MarkerAnalysisStatus<TResult>> {
    const status = this.statuses.get(mediaId);
    if (!status) return Promise.reject(new Error(`No marker analysis exists for ${mediaId}`));
    if (markerAnalysisIsTerminal(status.state)) return Promise.resolve({ ...status });
    return new Promise((resolve) => {
      const waiters = this.waiters.get(mediaId) ?? [];
      waiters.push({ resolve });
      this.waiters.set(mediaId, waiters);
    });
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      void this.run(task).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async run(task: QueuedTask<TInput>): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.mediaId, controller);
    const status = this.statuses.get(task.mediaId)!;
    status.state = 'running';
    status.startedAt = this.now();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new SchedulerTimeoutError(`Analysis exceeded ${this.timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason ?? new SchedulerCancelledError('Analysis cancelled'));
      }, { once: true });
    });

    try {
      const workerPromise = this.worker(task.input, controller.signal);
      // Prevent an abort-insensitive worker from producing an unhandled rejection later.
      void workerPromise.catch(() => undefined);
      const result = await Promise.race([workerPromise, timeout, cancellation]);
      this.finish(task.mediaId, { state: 'completed', result });
    } catch (error) {
      if (error instanceof SchedulerTimeoutError) {
        this.finish(task.mediaId, { state: 'timed_out', error: error.message });
      } else if (error instanceof SchedulerCancelledError) {
        this.finish(task.mediaId, { state: 'cancelled', error: error.message });
      } else {
        this.finish(task.mediaId, {
          state: 'failed',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(task.mediaId);
    }
  }

  private finish(
    mediaId: string,
    update: Pick<MarkerAnalysisStatus<TResult>, 'state'> &
      Partial<Pick<MarkerAnalysisStatus<TResult>, 'result' | 'error'>>
  ): void {
    const status = this.statuses.get(mediaId);
    if (!status) return;
    Object.assign(status, update, { finishedAt: this.now() });
    const snapshot = { ...status };
    for (const waiter of this.waiters.get(mediaId) ?? []) waiter.resolve(snapshot);
    this.waiters.delete(mediaId);
  }
}
