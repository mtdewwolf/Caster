import { Hono, type Context } from 'hono';
import { getCurrentUserId, resolvePrincipal } from '../auth';
import { db, MediaModel } from '../db';
import { AccessControlStore } from '../db/access-control';
import {
  PlaylistConflictError,
  PlaylistNotFoundError,
  PlaylistStore
} from '../db/playlist-store';

const store = new PlaylistStore(db);
const access = new AccessControlStore(db);

function principalFor(c: Context) {
  const principal = resolvePrincipal(c);
  return principal
    ? { userId: principal.id, role: principal.role, active: true as const }
    : null;
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function playlistError(c: Context, error: unknown): Response {
  if (error instanceof PlaylistNotFoundError) return c.json({ error: 'Playlist not found' }, 404);
  if (error instanceof PlaylistConflictError) return c.json({ error: 'Playlist changed; reload and try again' }, 409);
  if (error instanceof RangeError) return c.json({ error: error.message }, 400);
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return c.json({ error: 'A playlist with that name already exists' }, 409);
  }
  throw error;
}

function visibleMedia(c: Context, mediaId: string) {
  const principal = principalFor(c);
  if (!principal || !access.canAccessMedia(principal, mediaId)) return null;
  const item = MediaModel.getById(
    mediaId,
    getCurrentUserId(c),
    access.getLibraryScope(principal),
    access.getContentRatingScope(principal)
  );
  if (!item) return null;
  if (principal.role === 'admin') return item;
  const { full_path: _fullPath, ...safe } = item;
  return safe;
}

export const playlistRouter = new Hono();

playlistRouter.get('/', (c) => c.json({ playlists: store.list(getCurrentUserId(c)) }));

playlistRouter.post('/', async (c) => {
  const body = await readBody(c);
  if (!body || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }
  try {
    return c.json({ playlist: store.create(getCurrentUserId(c), body.name) }, 201);
  } catch (error) {
    return playlistError(c, error);
  }
});

playlistRouter.get('/:id', (c) => {
  const userId = getCurrentUserId(c);
  const playlist = store.get(userId, c.req.param('id'));
  if (!playlist) return c.json({ error: 'Playlist not found' }, 404);
  const storedItems = store.items(userId, playlist.id) || [];
  const items = storedItems.flatMap((entry) => {
    const media = visibleMedia(c, entry.media_id);
    return media ? [{ ...entry, media }] : [];
  });
  return c.json({ playlist, items });
});

playlistRouter.patch('/:id', async (c) => {
  const body = await readBody(c);
  if (!body || typeof body.name !== 'string' || !Number.isSafeInteger(body.revision)) {
    return c.json({ error: 'name and integer revision are required' }, 400);
  }
  try {
    return c.json({
      playlist: store.rename(
        getCurrentUserId(c),
        c.req.param('id'),
        body.name,
        body.revision as number
      )
    });
  } catch (error) {
    return playlistError(c, error);
  }
});

playlistRouter.delete('/:id', (c) => {
  if (!store.delete(getCurrentUserId(c), c.req.param('id'))) {
    return c.json({ error: 'Playlist not found' }, 404);
  }
  return c.json({ success: true });
});

playlistRouter.post('/:id/items', async (c) => {
  const body = await readBody(c);
  if (
    !body
    || typeof body.mediaId !== 'string'
    || (body.position !== undefined && !Number.isSafeInteger(body.position))
  ) {
    return c.json({ error: 'mediaId and an optional integer position are required' }, 400);
  }
  const media = visibleMedia(c, body.mediaId);
  if (!media || media.type !== 'track') return c.json({ error: 'Track not found' }, 404);
  try {
    return c.json(store.addItem(
      getCurrentUserId(c),
      c.req.param('id'),
      body.mediaId,
      body.position as number | undefined
    ), 201);
  } catch (error) {
    return playlistError(c, error);
  }
});

playlistRouter.put('/:id/items/order', async (c) => {
  const body = await readBody(c);
  if (
    !body
    || !Array.isArray(body.itemIds)
    || body.itemIds.some((id) => typeof id !== 'string')
    || !Number.isSafeInteger(body.revision)
  ) {
    return c.json({ error: 'itemIds and integer revision are required' }, 400);
  }
  try {
    return c.json({
      playlist: store.reorder(
        getCurrentUserId(c),
        c.req.param('id'),
        body.itemIds as string[],
        body.revision as number
      )
    });
  } catch (error) {
    return playlistError(c, error);
  }
});

playlistRouter.delete('/:id/items/:itemId', (c) => {
  try {
    const playlist = store.removeItem(
      getCurrentUserId(c),
      c.req.param('id'),
      c.req.param('itemId')
    );
    if (!playlist) return c.json({ error: 'Playlist item not found' }, 404);
    return c.json({ playlist });
  } catch (error) {
    return playlistError(c, error);
  }
});
