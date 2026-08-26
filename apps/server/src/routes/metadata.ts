import { Hono, type Context } from 'hono';
import type { MetadataStore, StoredMetadata } from '../db/metadata-store';
import type { MetadataEnrichmentService } from '../metadata/enrichment';
import type { MetadataProviderRegistry } from '../metadata/registry';
import type { ArtworkCache } from '../metadata/artwork-cache';
import { planMetadataMatch } from '../metadata/scanner-adapter';
import type { MediaItem } from '../types';

type MaybePromise<T> = T | Promise<T>;

export interface MetadataRouterDependencies {
  store: MetadataStore;
  enrichment: MetadataEnrichmentService;
  registry: MetadataProviderRegistry;
  /** Must return null unless the current principal may see this item. */
  resolveMedia: (context: Context, mediaId: string) => MaybePromise<MediaItem | null>;
  isAdmin: (context: Context) => MaybePromise<boolean>;
}

/** Shapes stored metadata for clients. Credits are trimmed to a usable slice. */
export function publicMetadata(metadata: StoredMetadata) {
  return {
    subject: metadata.subject,
    providerId: metadata.providerId,
    externalId: metadata.externalId,
    title: metadata.title,
    originalTitle: metadata.originalTitle,
    overview: metadata.overview,
    tagline: metadata.tagline,
    releaseDate: metadata.releaseDate,
    genres: metadata.genres,
    studios: metadata.studios,
    networks: metadata.networks,
    rating: metadata.rating,
    contentRating: metadata.contentRating,
    cast: metadata.cast.slice(0, 24),
    crew: metadata.crew.slice(0, 24),
    externalIds: metadata.externalIds,
    matchConfidence: metadata.matchConfidence,
    matchSource: metadata.matchSource,
    locked: metadata.locked,
    refreshedAt: metadata.refreshedAt,
    artwork: metadata.artwork
  };
}

async function readJsonObject(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const value = await context.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createMetadataRouter(dependencies: MetadataRouterDependencies): Hono {
  const router = new Hono();

  async function requireMedia(context: Context): Promise<MediaItem | null> {
    const mediaId = context.req.param('id');
    if (!mediaId) return null;
    return dependencies.resolveMedia(context, mediaId);
  }

  async function requireAdminMedia(
    context: Context
  ): Promise<{ media: MediaItem } | { response: Response }> {
    if (!await dependencies.isAdmin(context)) {
      return { response: context.json({ error: 'Administrator access required' }, 403) };
    }
    const media = await requireMedia(context);
    if (!media) return { response: context.json({ error: 'Media not found' }, 404) };
    return { media };
  }

  // Readable by anyone who can already see the item: metadata describes media
  // they are allowed to browse, and carries no filesystem detail.
  router.get('/:id/metadata', async (context) => {
    const media = await requireMedia(context);
    if (!media) return context.json({ error: 'Media not found' }, 404);

    const plan = planMetadataMatch(media);
    if (!plan) return context.json({ metadata: null, supported: false });

    const metadata = dependencies.store.get(plan.subject);
    return context.json({
      metadata: metadata ? publicMetadata(metadata) : null,
      supported: true,
      subject: plan.subject
    });
  });

  router.get('/:id/metadata/candidates', async (context) => {
    const outcome = await requireAdminMedia(context);
    if ('response' in outcome) return outcome.response;

    try {
      const found = await dependencies.enrichment.search(
        outcome.media,
        context.req.query('query')
      );
      if (!found) {
        return context.json({ error: 'No metadata provider is configured for this media type' }, 409);
      }
      return context.json({ subject: found.plan.subject, candidates: found.candidates });
    } catch (error) {
      return context.json({
        error: error instanceof Error ? error.message : 'Metadata provider request failed'
      }, 502);
    }
  });

  // Fix Match. The chosen candidate is stored as a manual override and locked,
  // so a later automatic refresh cannot quietly undo the correction.
  router.post('/:id/metadata/match', async (context) => {
    const outcome = await requireAdminMedia(context);
    if ('response' in outcome) return outcome.response;

    const body = await readJsonObject(context);
    if (!body) return context.json({ error: 'Invalid JSON body' }, 400);

    const providerId = nonEmptyString(body.providerId);
    const externalId = nonEmptyString(body.externalId);
    const entityType = nonEmptyString(body.entityType);
    if (!providerId || !externalId || !entityType) {
      return context.json({
        error: 'providerId, externalId, and entityType are required'
      }, 400);
    }
    if (!dependencies.registry.get(providerId)) {
      return context.json({ error: `Metadata provider "${providerId}" is not registered` }, 400);
    }

    const plan = planMetadataMatch(outcome.media);
    if (!plan) {
      return context.json({ error: 'This media type has no metadata provider' }, 409);
    }

    const result = await dependencies.enrichment.applyMatch(
      plan,
      { providerId, externalId, entityType: entityType as any, title: outcome.media.title },
      { source: 'manual' }
    );

    if (result.status !== 'matched') {
      return context.json({
        error: result.message ?? 'The selected match could not be applied',
        status: result.status
      }, result.status === 'error' ? 502 : 409);
    }

    const metadata = dependencies.store.get(plan.subject);
    return context.json({ metadata: metadata ? publicMetadata(metadata) : null });
  });

  router.post('/:id/metadata/refresh', async (context) => {
    const outcome = await requireAdminMedia(context);
    if ('response' in outcome) return outcome.response;

    // A refresh is an explicit instruction, so it overrides both the repeat
    // suppression and an existing manual lock.
    const result = await dependencies.enrichment.enrich(outcome.media, { force: true });
    const metadata = result.subject ? dependencies.store.get(result.subject) : null;

    return context.json({
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      ...(result.candidates ? { candidates: result.candidates } : {}),
      metadata: metadata ? publicMetadata(metadata) : null
    }, result.status === 'error' ? 502 : 200);
  });

  router.delete('/:id/metadata', async (context) => {
    const outcome = await requireAdminMedia(context);
    if ('response' in outcome) return outcome.response;

    const plan = planMetadataMatch(outcome.media);
    if (!plan) return context.json({ error: 'This media type has no metadata provider' }, 409);

    return context.json({ cleared: dependencies.store.clear(plan.subject) });
  });

  return router;
}

export function createMetadataProvidersRouter(dependencies: {
  registry: MetadataProviderRegistry;
  artworkCache?: ArtworkCache;
  isAdmin: (context: Context) => MaybePromise<boolean>;
}): Hono {
  const router = new Hono();

  router.get('/artwork', async (context) => {
    if (!await dependencies.isAdmin(context)) {
      return context.json({ error: 'Administrator access required' }, 403);
    }
    if (!dependencies.artworkCache) {
      return context.json({ error: 'Artwork caching is not configured' }, 409);
    }
    return context.json(dependencies.artworkCache.status());
  });

  // Clearing forgets the local copies only. Every row keeps its provider URL,
  // so the library still shows artwork and can re-cache on the next refresh.
  router.delete('/artwork', async (context) => {
    if (!await dependencies.isAdmin(context)) {
      return context.json({ error: 'Administrator access required' }, 403);
    }
    if (!dependencies.artworkCache) {
      return context.json({ error: 'Artwork caching is not configured' }, 409);
    }
    const cleared = dependencies.artworkCache.clear();
    dependencies.artworkCache.pruneOrphanFiles();
    return context.json({ cleared });
  });

  router.get('/providers', async (context) => {
    if (!await dependencies.isAdmin(context)) {
      return context.json({ error: 'Administrator access required' }, 403);
    }
    return context.json({
      providers: dependencies.registry.list().map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilities
      }))
    });
  });

  return router;
}
