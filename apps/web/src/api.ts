import type { AlbumSummary, ArtistSummary, BrowseResult, Library, MediaItem,
  MediaMetadata,
  MediaVersion,
  MetadataCandidate,
  PlaybackDecision, PlaybackDescriptor, ScanStatus, Series, SeriesSeason, SystemHardwareStatus } from './types';

const API_BASE = '/api';

export interface CastPlaybackAccess {
  directUrl: string;
  hlsUrl: string;
  hlsQualityUrls: Record<'1080p' | '720p' | '480p', string>;
  subtitleUrlBase: string;
  query: string;
  expiresAt: string | null;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : null;
  if (!response.ok) {
    const message = data && typeof data.error === 'string' ? data.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return data as T;
}

export const api = {
  async getLibraries(): Promise<Library[]> {
    const data = await request<{ libraries: Library[] }>('/libraries');
    return data.libraries || [];
  },

  async createLibrary(payload: { name: string; path: string; type: string }): Promise<Library> {
    const data = await request<{ library: Library }>('/libraries', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return data.library;
  },

  async deleteLibrary(id: string): Promise<void> {
    await request(`/libraries/${id}`, { method: 'DELETE' });
  },

  async scanLibrary(id: string): Promise<void> {
    await request(`/libraries/${id}/scan`, { method: 'POST' });
  },

  async scanAllLibraries(): Promise<void> {
    await request('/libraries/scan-all', { method: 'POST' });
  },

  getScanStatus(): Promise<ScanStatus> {
    return request('/libraries/scan/status');
  },

  getMedia(params: {
    libraryId?: string;
    type?: string;
    search?: string;
    resolution?: string;
    genre?: string;
    watched?: string;
    hdr?: boolean;
    sort?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: MediaItem[]; total: number }> {
    const query = new URLSearchParams();
    if (params.libraryId) query.set('libraryId', params.libraryId);
    if (params.type) query.set('type', params.type);
    if (params.search) query.set('search', params.search);
    if (params.resolution) query.set('resolution', params.resolution);
    if (params.genre) query.set('genre', params.genre);
    if (params.watched && params.watched !== 'all') query.set('watched', params.watched);
    if (params.hdr) query.set('hdr', 'true');
    if (params.sort) query.set('sort', params.sort);
    if (params.limit) query.set('limit', params.limit.toString());
    if (params.offset) query.set('offset', params.offset.toString());

    return request(`/media?${query.toString()}`);
  },

  async getHomeRows(): Promise<{
    continueWatching: MediaItem[];
    nextUp: MediaItem[];
    recentlyAdded: MediaItem[];
    recentlyWatched: MediaItem[];
  }> {
    const data = await request<{ rows: Record<string, MediaItem[]> }>('/media/home');
    return {
      continueWatching: data.rows?.continueWatching || [],
      nextUp: data.rows?.nextUp || [],
      recentlyAdded: data.rows?.recentlyAdded || [],
      recentlyWatched: data.rows?.recentlyWatched || []
    };
  },

  async getGenres(params: { libraryId?: string; type?: string } = {}): Promise<string[]> {
    const query = new URLSearchParams();
    if (params.libraryId) query.set('libraryId', params.libraryId);
    if (params.type) query.set('type', params.type);
    const data = await request<{ genres: string[] }>(`/media/genres?${query.toString()}`);
    return data.genres || [];
  },

  async getContinueWatching(): Promise<MediaItem[]> {
    const data = await request<{ items: MediaItem[] }>('/media/continue-watching');
    return data.items || [];
  },

  async getProgress(status?: 'in_progress' | 'completed'): Promise<MediaItem[]> {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    const data = await request<{ items: MediaItem[] }>(`/media/progress?${query.toString()}`);
    return data.items || [];
  },

  async getSeries(params: { libraryId?: string; search?: string } = {}): Promise<Series[]> {
    const query = new URLSearchParams();
    if (params.libraryId) query.set('libraryId', params.libraryId);
    if (params.search) query.set('search', params.search);

    const data = await request<{ items: Series[] }>(`/series?${query.toString()}`);
    return data.items || [];
  },

  getSeriesDetail(id: string): Promise<{ series: Series; seasons: SeriesSeason[] }> {
    return request(`/series/${id}`);
  },

  getSeriesEpisodes(id: string): Promise<{ series: Series; items: MediaItem[] }> {
    return request(`/series/${id}/episodes`);
  },

  async markWatched(id: string): Promise<void> {
    await request(`/media/${id}/progress/watched`, { method: 'POST' });
  },

  async markUnwatched(id: string): Promise<void> {
    await request(`/media/${id}/progress/unwatched`, { method: 'POST' });
  },

  async removeProgress(id: string): Promise<void> {
    await request(`/media/${id}/progress`, { method: 'DELETE' });
  },

  async getMediaItem(id: string): Promise<MediaItem> {
    const data = await request<{ item: MediaItem }>(`/media/${id}`);
    return data.item;
  },

  /** Item plus everything a detail view needs, in one request. */
  getMediaDetail(id: string, capabilities?: string): Promise<{
    item: MediaItem;
    metadata: MediaMetadata | null;
    versions: MediaVersion[];
    playback: PlaybackDecision;
  }> {
    return request(`/media/${id}${capabilities ? `?${capabilities}` : ''}`);
  },

  getMediaMetadata(id: string): Promise<{
    metadata: MediaMetadata | null;
    supported: boolean;
  }> {
    return request(`/media/${id}/metadata`);
  },

  async getMetadataCandidates(id: string, query?: string): Promise<MetadataCandidate[]> {
    const search = new URLSearchParams();
    if (query) search.set('query', query);
    const data = await request<{ candidates: MetadataCandidate[] }>(
      `/media/${id}/metadata/candidates?${search.toString()}`
    );
    return data.candidates || [];
  },

  async applyMetadataMatch(id: string, candidate: MetadataCandidate): Promise<MediaMetadata | null> {
    const data = await request<{ metadata: MediaMetadata | null }>(`/media/${id}/metadata/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: candidate.providerId,
        externalId: candidate.externalId,
        entityType: candidate.entityType
      })
    });
    return data.metadata;
  },

  refreshMetadata(id: string): Promise<{ status: string; message?: string; metadata: MediaMetadata | null }> {
    return request(`/media/${id}/metadata/refresh`, { method: 'POST' });
  },

  async clearMetadata(id: string): Promise<void> {
    await request(`/media/${id}/metadata`, { method: 'DELETE' });
  },

  getPlaybackDescriptor(id: string): Promise<PlaybackDescriptor> {
    return request(`/media/${id}/playback`);
  },

  getCastPlaybackAccess(id: string): Promise<CastPlaybackAccess> {
    return request(`/media/${id}/cast`);
  },

  async getMusicArtists(search?: string): Promise<ArtistSummary[]> {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    const data = await request<{ items: ArtistSummary[] }>(`/music/artists?${query.toString()}`);
    return data.items || [];
  },

  async getMusicAlbums(params: { artistId?: string; search?: string } = {}): Promise<AlbumSummary[]> {
    const query = new URLSearchParams();
    if (params.artistId) query.set('artistId', params.artistId);
    if (params.search) query.set('search', params.search);
    const data = await request<{ items: AlbumSummary[] }>(`/music/albums?${query.toString()}`);
    return data.items || [];
  },

  getMusicAlbum(id: string): Promise<{ album: AlbumSummary; tracks: MediaItem[] }> {
    return request(`/music/albums/${id}`);
  },

  async updateProgress(id: string, position: number, duration: number): Promise<void> {
    await request(`/media/${id}/progress`, {
      method: 'POST',
      body: JSON.stringify({ position, duration })
    });
  },

  getSystemStatus(): Promise<{ hardware: SystemHardwareStatus; server: string; uptime: number }> {
    return request('/system/status');
  },

  async setHardwareAccel(accel: 'qsv' | 'nvenc' | 'vaapi' | 'none'): Promise<void> {
    await request('/system/hardware/accel', {
      method: 'POST',
      body: JSON.stringify({ accel })
    });
  },

  browseFilesystem(dirPath?: string): Promise<BrowseResult> {
    const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    return request(`/fs/browse${query}`);
  }
};
