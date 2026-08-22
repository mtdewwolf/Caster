import type { Library, MediaItem, SystemHardwareStatus, ScanStatus } from './types';

const API_BASE = '/api';

export const api = {
  async getLibraries(): Promise<Library[]> {
    const res = await fetch(`${API_BASE}/libraries`);
    const data = await res.json();
    return data.libraries || [];
  },

  async createLibrary(payload: { name: string; path: string; type: string }): Promise<Library> {
    const res = await fetch(`${API_BASE}/libraries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data.library;
  },

  async deleteLibrary(id: string): Promise<void> {
    await fetch(`${API_BASE}/libraries/${id}`, { method: 'DELETE' });
  },

  async scanLibrary(id: string): Promise<void> {
    await fetch(`${API_BASE}/libraries/${id}/scan`, { method: 'POST' });
  },

  async scanAllLibraries(): Promise<void> {
    await fetch(`${API_BASE}/libraries/scan-all`, { method: 'POST' });
  },

  async getScanStatus(): Promise<ScanStatus> {
    const res = await fetch(`${API_BASE}/libraries/scan/status`);
    return await res.json();
  },

  async getMedia(params: {
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

    const res = await fetch(`${API_BASE}/media?${query.toString()}`);
    return await res.json();
  },

  async getContinueWatching(): Promise<MediaItem[]> {
    const res = await fetch(`${API_BASE}/media/continue-watching`);
    const data = await res.json();
    return data.items || [];
  },

  async getMediaItem(id: string): Promise<MediaItem> {
    const res = await fetch(`${API_BASE}/media/${id}`);
    const data = await res.json();
    return data.item;
  },

  async updateProgress(id: string, position: number, duration: number): Promise<void> {
    try {
      await fetch(`${API_BASE}/media/${id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position, duration })
      });
    } catch (e) {
      console.warn('Failed to update progress', e);
    }
  },

  async getSystemStatus(): Promise<{ hardware: SystemHardwareStatus; server: string; uptime: number }> {
    const res = await fetch(`${API_BASE}/system/status`);
    return await res.json();
  },

  async setHardwareAccel(accel: 'qsv' | 'nvenc' | 'vaapi' | 'none'): Promise<void> {
    await fetch(`${API_BASE}/system/hardware/accel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accel })
    });
  }
};
