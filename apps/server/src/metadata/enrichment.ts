import type { MetadataStore, MetadataSubject } from '../db/metadata-store';
import type { ArtworkCache } from './artwork-cache';
import type { MediaItem } from '../types';
import type { MetadataProviderRegistry } from './registry';
import {
  DEFAULT_AUTOMATIC_MATCH_CONFIDENCE,
  planMetadataMatch,
  type MetadataMatchPlan
} from './scanner-adapter';
import type { MetadataMatchResult, MetadataSearchResult } from './provider';

export type EnrichmentStatus =
  | 'matched'
  | 'ambiguous'
  | 'not_found'
  | 'error'
  | 'skipped'
  | 'locked'
  | 'unsupported'
  | 'disabled';

export interface EnrichmentResult {
  status: EnrichmentStatus;
  subject?: MetadataSubject;
  confidence?: number;
  candidates?: readonly MetadataSearchResult[];
  message?: string;
}

type EnrichableItem = Pick<
  MediaItem,
  'id' | 'library_id' | 'type' | 'title' | 'series_title' | 'season_number' | 'episode_number' | 'year'
>;

export interface MetadataEnrichmentOptions {
  registry: MetadataProviderRegistry;
  store: MetadataStore;
  /** Optional local artwork cache. Without one, provider URLs are used as-is. */
  artworkCache?: ArtworkCache;
  /** Provider to consult. Defaults to the first registered one. */
  providerId?: string;
  minimumConfidence?: number;
  language?: string;
  region?: string;
  /** Concurrent provider requests. Kept low so a scan stays polite. */
  concurrency?: number;
  retryMissAfterMs?: number;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
}

/**
 * Enriches scanned media from a metadata provider.
 *
 * Two rules shape everything here. Enrichment is strictly optional: every
 * failure path is swallowed into a result status, because a provider outage
 * must never fail a scan or make local media unplayable. And an ambiguous
 * match is never applied — it is recorded so a person can resolve it through
 * Fix Match instead of the wrong poster appearing silently.
 */
export class MetadataEnrichmentService {
  readonly #registry: MetadataProviderRegistry;
  readonly #store: MetadataStore;
  readonly #artworkCache: ArtworkCache | undefined;
  readonly #providerId?: string;
  readonly #minimumConfidence: number;
  readonly #language?: string;
  readonly #region?: string;
  readonly #concurrency: number;
  readonly #retryMissAfterMs?: number;
  readonly #now: () => number;
  readonly #warn: (...args: unknown[]) => void;

  readonly #queue: EnrichableItem[] = [];
  readonly #queued = new Set<string>();
  #active = 0;

  constructor(options: MetadataEnrichmentOptions) {
    this.#registry = options.registry;
    this.#store = options.store;
    this.#artworkCache = options.artworkCache;
    this.#providerId = options.providerId;
    this.#minimumConfidence = options.minimumConfidence ?? DEFAULT_AUTOMATIC_MATCH_CONFIDENCE;
    this.#language = options.language;
    this.#region = options.region;
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#retryMissAfterMs = options.retryMissAfterMs;
    this.#now = options.now ?? (() => Date.now());
    this.#warn = options.warn ?? ((...args) => console.warn(...args));
  }

  get enabled(): boolean {
    return this.#registry.list().length > 0;
  }

  get pending(): number {
    return this.#queue.length + this.#active;
  }

  #resolveProviderId(): string | null {
    if (this.#providerId) return this.#providerId;
    return this.#registry.list()[0]?.id ?? null;
  }

  #context() {
    return {
      ...(this.#language ? { language: this.#language } : {}),
      ...(this.#region ? { region: this.#region } : {})
    };
  }

  /**
   * Queues an item for background enrichment. Safe to call for every scanned
   * file: unsupported types and already-queued subjects are dropped here rather
   * than becoming provider traffic.
   */
  enqueue(item: EnrichableItem): void {
    if (!this.enabled) return;
    const plan = planMetadataMatch(item, this.#minimumConfidence);
    if (!plan) return;

    const key = `${plan.subject.type}:${plan.subject.id}`;
    if (this.#queued.has(key)) return;
    this.#queued.add(key);
    this.#queue.push(item);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      this.#active += 1;
      void this.enrich(item)
        .catch((error) => {
          this.#warn('Metadata enrichment failed:', error);
        })
        .finally(() => {
          this.#active -= 1;
          const plan = planMetadataMatch(item, this.#minimumConfidence);
          if (plan) this.#queued.delete(`${plan.subject.type}:${plan.subject.id}`);
          if (this.#queue.length > 0) void this.#drain();
        });
    }
  }

  /** Enriches one item immediately. Never throws. */
  async enrich(
    item: EnrichableItem,
    options: { force?: boolean } = {}
  ): Promise<EnrichmentResult> {
    if (!this.enabled) {
      return { status: 'disabled', message: 'No metadata provider is configured' };
    }

    const plan = planMetadataMatch(item, this.#minimumConfidence);
    if (!plan) {
      return { status: 'unsupported', message: 'This media type has no metadata provider' };
    }

    const existing = this.#store.get(plan.subject);
    if (existing?.locked && !options.force) {
      return { status: 'locked', subject: plan.subject };
    }

    if (!options.force && this.#store.shouldSkipFetch(plan.subject, plan.fingerprint, {
      ...(this.#retryMissAfterMs !== undefined ? { retryMissAfterMs: this.#retryMissAfterMs } : {}),
      now: this.#now()
    })) {
      return { status: 'skipped', subject: plan.subject };
    }

    const providerId = this.#resolveProviderId();
    if (!providerId) {
      return { status: 'disabled', message: 'No metadata provider is configured' };
    }

    let match: MetadataMatchResult;
    try {
      match = await this.#registry.match(providerId, plan.request, this.#context());
    } catch (error) {
      // A provider outage is recorded and retried later, never surfaced as a
      // scan failure.
      this.#store.recordFetch(plan.subject, plan.fingerprint, 'error', this.#isoNow());
      return {
        status: 'error',
        subject: plan.subject,
        message: error instanceof Error ? error.message : 'Metadata provider request failed'
      };
    }

    if (match.status !== 'matched') {
      this.#store.recordFetch(
        plan.subject,
        plan.fingerprint,
        match.status === 'ambiguous' ? 'ambiguous' : 'not_found',
        this.#isoNow()
      );
      return {
        status: match.status === 'ambiguous' ? 'ambiguous' : 'not_found',
        subject: plan.subject,
        candidates: match.candidates,
        ...(match.status === 'ambiguous' && match.reason ? { message: match.reason } : {})
      };
    }

    return this.applyMatch(plan, match.match, {
      confidence: match.confidence,
      source: 'provider'
    });
  }

  /**
   * Writes a chosen candidate to the store, pulling full details and artwork.
   *
   * Shared by automatic matching and Fix Match; the only difference is whether
   * the result is locked against future automatic refreshes.
   */
  async applyMatch(
    plan: MetadataMatchPlan,
    choice: MetadataSearchResult,
    options: { confidence?: number; source?: 'provider' | 'manual' } = {}
  ): Promise<EnrichmentResult> {
    const reference = {
      providerId: choice.providerId,
      externalId: choice.externalId,
      entityType: choice.entityType
    };

    try {
      const [details, artwork] = await Promise.all([
        this.#registry.getDetails(reference, this.#context()),
        this.#registry.getArtwork(reference, this.#context()).catch(() => [])
      ]);

      if (!details) {
        this.#store.recordFetch(plan.subject, plan.fingerprint, 'not_found', this.#isoNow());
        return { status: 'not_found', subject: plan.subject };
      }

      this.#store.save({
        subject: plan.subject,
        details,
        artwork,
        ...(options.confidence !== undefined ? { matchConfidence: options.confidence } : {}),
        matchSource: options.source ?? 'provider',
        locked: options.source === 'manual'
      });
      this.#store.recordFetch(plan.subject, plan.fingerprint, 'matched', this.#isoNow());

      // Pull the images down in the background. A CDN failure here must not
      // turn a successful match into a failed one.
      if (this.#artworkCache && artwork.length > 0) {
        void this.#artworkCache.cachePending().catch((error) => {
          this.#warn('Could not cache provider artwork:', error);
        });
      }

      return {
        status: 'matched',
        subject: plan.subject,
        ...(options.confidence !== undefined ? { confidence: options.confidence } : {})
      };
    } catch (error) {
      this.#store.recordFetch(plan.subject, plan.fingerprint, 'error', this.#isoNow());
      return {
        status: 'error',
        subject: plan.subject,
        message: error instanceof Error ? error.message : 'Metadata provider request failed'
      };
    }
  }

  /** Candidate list for the Fix Match picker. */
  async search(
    item: EnrichableItem,
    query?: string
  ): Promise<{ plan: MetadataMatchPlan; candidates: readonly MetadataSearchResult[] } | null> {
    const plan = planMetadataMatch(item, this.#minimumConfidence);
    const providerId = this.#resolveProviderId();
    if (!plan || !providerId) return null;

    const request = query?.trim()
      ? { ...plan.request, title: query.trim(), year: undefined }
      : plan.request;

    const candidates = await this.#registry.search(providerId, request, this.#context());
    return { plan, candidates };
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString();
  }
}
