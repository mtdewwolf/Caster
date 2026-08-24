import type { Library, MediaItem, Series, SeriesSeason, SystemHardwareStatus, ScanStatus, BrowseResult } from './types';

const API_BASE = '/api';
export const AUTH_INVALIDATED_EVENT = 'caster:auth-invalidated';

export interface AuthSession {
  authenticated: boolean;
  configured: boolean;
  protectedMode: boolean;
  user?: AuthUser;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
}

export interface UserAccount extends AuthUser {
  active: boolean;
}

export interface UserPermissions {
  maxContentRating: string | null;
  allowUnrated: boolean;
  canDownload: boolean;
  canStreamRemote: boolean;
  canDeleteMedia: boolean;
  canManageProfiles: boolean;
  hasProfilePin: boolean;
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
    if (
      response.status === 401
      && path !== '/auth/login'
      && path !== '/auth/profile/switch'
      && typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT, { detail: { message } }));
    }
    throw new ApiError(message, response.status);
  }

  return data as T;
}

export const api = {
  getAuthSession(): Promise<AuthSession> {
    return request<AuthSession>('/auth/session');
  },

  login(username: string, password: string): Promise<{ authenticated: true; user: AuthUser }> {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...(username.trim() ? { username: username.trim() } : {}), password })
    });
  },

  logout(): Promise<{ authenticated: false }> {
    return request('/auth/logout', { method: 'POST' });
  },

  switchProfile(username: string, pin: string): Promise<{ authenticated: true; user: AuthUser }> {
    return request('/auth/profile/switch', {
      method: 'POST',
      body: JSON.stringify({ username: username.trim(), pin })
    });
  },

  async getUsers(): Promise<UserAccount[]> {
    const data = await request<{ users: UserAccount[] }>('/auth/users');
    return data.users || [];
  },

  async createUser(payload: {
    username: string;
    password: string;
    role: 'admin' | 'viewer';
  }): Promise<UserAccount> {
    const data = await request<{ user: UserAccount }>('/auth/users', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return data.user;
  },

  async updateUser(
    id: string,
    changes: Partial<Pick<UserAccount, 'username' | 'role' | 'active'>> & { password?: string }
  ): Promise<UserAccount> {
    const data = await request<{ user: UserAccount }>(`/auth/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes)
    });
    return data.user;
  },

  async getUserLibraryAccess(userId: string): Promise<string[]> {
    const data = await request<{ libraryIds: string[] }>(`/access/users/${userId}/libraries`);
    return data.libraryIds || [];
  },

  async replaceUserLibraryAccess(userId: string, libraryIds: string[]): Promise<string[]> {
    const data = await request<{ libraryIds: string[] }>(`/access/users/${userId}/libraries`, {
      method: 'PUT',
      body: JSON.stringify({ libraryIds })
    });
    return data.libraryIds || [];
  },

  async getUserPermissions(userId: string): Promise<UserPermissions> {
    const data = await request<{ permissions: UserPermissions }>(`/access/users/${userId}/permissions`);
    return data.permissions;
  },

  async updateUserPermissions(
    userId: string,
    changes: Partial<Omit<UserPermissions, 'hasProfilePin'>>
  ): Promise<UserPermissions> {
    const data = await request<{ permissions: UserPermissions }>(`/access/users/${userId}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify(changes)
    });
    return data.permissions;
  },

  async setUserProfilePin(userId: string, pin: string | null): Promise<UserPermissions> {
    const data = await request<{ permissions: UserPermissions }>(`/access/users/${userId}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pin })
    });
    return data.permissions;
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
