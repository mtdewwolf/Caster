export type CastConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface RemotePlaybackController extends EventTarget {
  readonly state: CastConnectionState;
  prompt(): Promise<void>;
  watchAvailability?(callback: (available: boolean) => void): Promise<number>;
  cancelWatchAvailability?(id?: number): Promise<void>;
}

export type CastableVideoElement = HTMLVideoElement & {
  remote?: RemotePlaybackController;
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export function supportsRemotePlayback(video: CastableVideoElement): boolean {
  return Boolean(video.remote || video.webkitShowPlaybackTargetPicker);
}

export function promptForRemotePlayback(video: CastableVideoElement): Promise<void> {
  if (video.remote) return video.remote.prompt();
  if (video.webkitShowPlaybackTargetPicker) {
    video.webkitShowPlaybackTargetPicker();
    return Promise.resolve();
  }
  return Promise.reject(new Error('This browser does not support casting.'));
}

