const ROOM_KEY = 'watch-room';
const INVITE_KEY = 'invite';

export interface WatchRoomInvite {
  roomId: string;
  inviteToken: string;
}

export function buildWatchRoomInviteUrl(
  roomId: string,
  inviteToken: string,
  baseUrl: string = window.location.href
): string {
  const url = new URL(baseUrl);
  url.hash = new URLSearchParams({ [ROOM_KEY]: roomId, [INVITE_KEY]: inviteToken }).toString();
  return url.toString();
}

export function readWatchRoomInvite(hash: string = window.location.hash): WatchRoomInvite | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = parameters.get(ROOM_KEY)?.trim();
  const inviteToken = parameters.get(INVITE_KEY)?.trim();
  return roomId && inviteToken ? { roomId, inviteToken } : null;
}

export function clearWatchRoomInviteFromAddressBar(): void {
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(window.history.state, '', url);
}
