import type { WatchRoomSnapshot } from './contracts';

async function watchRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/watch-rooms${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Watch room request failed (${response.status})`);
  return body as T;
}

export async function createWatchRoom(
  mediaId: string,
  positionSeconds: number
): Promise<{ roomId: string; inviteToken: string; room: WatchRoomSnapshot }> {
  return watchRequest('', {
    method: 'POST',
    body: JSON.stringify({ mediaId, positionSeconds })
  });
}

export async function joinWatchRoom(
  roomId: string,
  inviteToken: string
): Promise<WatchRoomSnapshot> {
  const result = await watchRequest<{ room: WatchRoomSnapshot }>(
    `/${encodeURIComponent(roomId)}/join`,
    { method: 'POST', body: JSON.stringify({ inviteToken }) }
  );
  return result.room;
}

export async function leaveWatchRoom(roomId: string): Promise<void> {
  await watchRequest(`/${encodeURIComponent(roomId)}/leave`, { method: 'POST' });
}
