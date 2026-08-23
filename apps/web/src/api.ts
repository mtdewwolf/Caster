import type { Library, MediaItem, Series, SeriesSeason, SystemHardwareStatus, ScanStatus, BrowseResult } from './types';

const API_BASE = '/api';

export interface AuthSession {
  authenticated: boolean;
  configured: boolean;
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
    credentials: 'same-origin',
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
  getAuthSession(): Promise<AuthSession> {
    return request<AuthSession>('/auth/session');
  },

  login(password: string): Promise<{ authenticated: true }> {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
  },

  logout(): Promise<{ authenticated: false }> {
    return request('/auth/logout', { method: 'POST' });
  },

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
    sort?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: MediaItem[]; total: number }> {
    const query = new URLSearchParams();
    if (params.libraryId) query.set('libraryId', params.libraryId);
    if (params.type) query.set('type', params.type);
    if (params.search) query.set('search', params.search);
    if (params.resolution) query.set('resolution', params.resolution);
    if (params.sort) query.set('sort', params.sort);
    if (params.limit) query.set('limit', params.limit.toString());
    if (params.offset) query.set('offset', params.offset.toString());

    return request(`/media?${query.toString()}`);
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
