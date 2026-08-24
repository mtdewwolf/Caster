import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  MusicLibraryStore,
  MusicQueryScope,
  MusicTrack
} from '../db/music-library';

export interface MusicRouteDependencies {
  store: MusicLibraryStore;
  getUserId: (context: Context) => string;
  getScope?: (context: Context) => MusicQueryScope;
  serializeTrack?: (context: Context, track: MusicTrack) => unknown;
}

/** Creates a router intended to be mounted at `/music`. */
export function createMusicRouter(dependencies: MusicRouteDependencies): Hono {
  const router = new Hono();
  const optionsFor = (context: Context) => ({
    ...(dependencies.getScope?.(context) || {}),
    libraryId: context.req.query('libraryId') || undefined,
    search: context.req.query('search')?.trim() || undefined
  });

  router.get('/artists', (context) => {
    return context.json({ items: dependencies.store.getArtists(optionsFor(context)) });
  });

  router.get('/artists/:id', (context) => {
    const detail = dependencies.store.getArtist(context.req.param('id'), optionsFor(context));
    return detail ? context.json(detail) : context.json({ error: 'Artist not found' }, 404);
  });

  router.get('/albums', (context) => {
    const items = dependencies.store.getAlbums({
      ...optionsFor(context),
      artistId: context.req.query('artistId') || undefined
    });
    return context.json({ items });
  });

  router.get('/albums/:id', (context) => {
    const detail = dependencies.store.getAlbum(context.req.param('id'), {
      ...optionsFor(context),
      userId: dependencies.getUserId(context)
    });
    if (!detail) return context.json({ error: 'Album not found' }, 404);
    const serialize = dependencies.serializeTrack || ((_context: Context, track: MusicTrack) => track);
    return context.json({
      album: detail.album,
      tracks: detail.tracks.map((track) => serialize(context, track))
    });
  });

  return router;
}

