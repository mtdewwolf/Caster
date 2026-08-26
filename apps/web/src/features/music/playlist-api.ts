import type { MediaItem } from '../../types';

const PLAYLIST_API_BASE = '/api/playlists';

export interface PlaylistSummary {
  id: string;
  user_id: string;
  name: string;
  revision: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistEntry {
  id: string;
  playlist_id: string;
  media_id: string;
  position: number;
  added_at: string;
  media: MediaItem;
}

export interface PlaylistDetail {
  playlist: PlaylistSummary;
  items: PlaylistEntry[];
}

interface PlaylistMutation {
  playlist: PlaylistSummary;
}

export class PlaylistApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PlaylistApiError';
  }
}

async function playlistRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${PLAYLIST_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    });
  } catch {
    throw new PlaylistApiError('Unable to reach the Caster server', 0);
  }

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const message = data && typeof data.error === 'string'
      ? data.error
      : `Playlist request failed (${response.status})`;
    throw new PlaylistApiError(message, response.status);
  }
  return data as T;
}

export const playlistApi = {
  async list(): Promise<PlaylistSummary[]> {
    const data = await playlistRequest<{ playlists: PlaylistSummary[] }>('/');
    return data.playlists || [];
  },

  get(id: string): Promise<PlaylistDetail> {
    return playlistRequest(`/${encodeURIComponent(id)}`);
  },

  async create(name: string): Promise<PlaylistSummary> {
    const data = await playlistRequest<{ playlist: PlaylistSummary }>('/', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    return data.playlist;
  },

  async rename(id: string, name: string, revision: number): Promise<PlaylistSummary> {
    const data = await playlistRequest<{ playlist: PlaylistSummary }>(`/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, revision })
    });
    return data.playlist;
  },

  remove(id: string): Promise<{ success: true }> {
    return playlistRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async addItem(id: string, mediaId: string, position?: number): Promise<PlaylistSummary> {
    const data = await playlistRequest<PlaylistMutation>(`/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify({ mediaId, ...(position === undefined ? {} : { position }) })
    });
    return data.playlist;
  },

  async reorder(id: string, itemIds: string[], revision: number): Promise<PlaylistSummary> {
    const data = await playlistRequest<PlaylistMutation>(`/${encodeURIComponent(id)}/items/order`, {
      method: 'PUT',
      body: JSON.stringify({ itemIds, revision })
    });
    return data.playlist;
  },

  async removeItem(id: string, itemId: string): Promise<PlaylistSummary> {
    const data = await playlistRequest<PlaylistMutation>(
      `/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' }
    );
    return data.playlist;
  }
};

export function movePlaylistEntry(
  entries: readonly PlaylistEntry[],
  entryId: string,
  direction: -1 | 1
): PlaylistEntry[] {
  const index = entries.findIndex((entry) => entry.id === entryId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= entries.length) return [...entries];
  const reordered = [...entries];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered.map((entry, position) => ({ ...entry, position }));
}

