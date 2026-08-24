import type { MarkerEditorType } from './editor-state';

export interface AdminMediaMarker {
  id: string;
  mediaId: string;
  type: MarkerEditorType;
  startSeconds: number | null;
  endSeconds: number | null;
  state: 'active' | 'disabled';
  source: string;
  confidence: number | null;
  analyzerVersion: string | null;
  revision: number;
}

export type MarkerAnalysisState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface MarkerAnalysisStatus {
  mediaId: string;
  state: MarkerAnalysisState;
  error?: string;
  result?: { candidateCount: number; warnings: string[] };
}

async function markerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const data = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `Marker request failed (${response.status})`);
  return data as T;
}

export const markerApi = {
  getEditor(mediaId: string): Promise<{
    markers: AdminMediaMarker[];
    analysis: MarkerAnalysisStatus | null;
  }> {
    return markerRequest(`/media/${encodeURIComponent(mediaId)}/markers`);
  },

  putMarker(
    mediaId: string,
    type: MarkerEditorType,
    payload: { enabled: false } | { enabled: true; startSeconds: number; endSeconds: number }
  ): Promise<{ marker: AdminMediaMarker }> {
    return markerRequest(`/media/${encodeURIComponent(mediaId)}/markers/${type}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },

  startAnalysis(mediaId: string): Promise<{
    accepted: boolean;
    status: MarkerAnalysisStatus;
  }> {
    return markerRequest(`/media/${encodeURIComponent(mediaId)}/markers/analysis`, { method: 'POST' });
  },

  getAnalysisStatus(mediaId: string): Promise<{ status: MarkerAnalysisStatus }> {
    return markerRequest(`/media/${encodeURIComponent(mediaId)}/markers/analysis`);
  }
};
