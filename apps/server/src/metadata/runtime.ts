import { db } from '../db';
import { MetadataStore } from '../db/metadata-store';
import { ArtworkCache } from './artwork-cache';
import { MetadataEnrichmentService } from './enrichment';
import { MetadataProviderRegistry } from './registry';
import { TmdbMetadataProvider } from './tmdb';

/**
 * Wires the metadata layer into the running server.
 *
 * Registration is credential-driven: with no TMDB token the registry stays
 * empty, every enrichment call returns `disabled`, and the rest of Caster
 * behaves exactly as it did before — local media stays fully playable.
 */

export const metadataStore = new MetadataStore(db);
export const metadataRegistry = new MetadataProviderRegistry();
export const artworkCache = new ArtworkCache({ database: db });

function readTmdbToken(): string | undefined {
  const token = (process.env.CASTER_TMDB_ACCESS_TOKEN || process.env.TMDB_ACCESS_TOKEN || '').trim();
  return token || undefined;
}

function registerConfiguredProviders(): void {
  const accessToken = readTmdbToken();
  if (!accessToken) return;

  try {
    metadataRegistry.register(new TmdbMetadataProvider({
      accessToken,
      ...(process.env.CASTER_TMDB_LANGUAGE ? { language: process.env.CASTER_TMDB_LANGUAGE } : {}),
      ...(process.env.CASTER_TMDB_REGION ? { region: process.env.CASTER_TMDB_REGION } : {})
    }));
  } catch (error) {
    console.warn('Could not register the TMDB metadata provider:', error);
  }
}

registerConfiguredProviders();

export const metadataEnrichment = new MetadataEnrichmentService({
  registry: metadataRegistry,
  store: metadataStore,
  artworkCache,
  ...(process.env.CASTER_TMDB_LANGUAGE ? { language: process.env.CASTER_TMDB_LANGUAGE } : {}),
  ...(process.env.CASTER_TMDB_REGION ? { region: process.env.CASTER_TMDB_REGION } : {})
});

export function metadataIsConfigured(): boolean {
  return metadataRegistry.list().length > 0;
}

/** Re-reads credentials. Exposed so tests and settings changes can re-register. */
export function reloadMetadataProviders(): void {
  for (const provider of metadataRegistry.list()) {
    metadataRegistry.unregister(provider.id);
  }
  registerConfiguredProviders();
}
