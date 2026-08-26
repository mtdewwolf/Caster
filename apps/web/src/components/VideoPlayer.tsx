import React, { useEffect, useReducer, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  Settings,
  Subtitles,
  ArrowLeft,
  Cast,
  Check,
  Users,
  Copy,
  LogOut,
  X
} from 'lucide-react';
import type { MediaItem, MediaStreamTrack, PlaybackDescriptor } from '../types';
import { api, type CastPlaybackAccess } from '../api';
import type { WatchRoomLaunch } from '../features/watch-together/contracts';
import { createWatchRoom, leaveWatchRoom } from '../features/watch-together/api';
import { buildWatchRoomInviteUrl } from '../features/watch-together/invite-fragment';
import { decideDriftCorrection } from '../features/watch-together/correction';
import { useWatchRoom } from '../features/watch-together/use-watch-room';
import {
  promptForRemotePlayback,
  supportsRemotePlayback,
  type CastableVideoElement,
  type CastConnectionState
} from '../features/casting/remote-playback';
import {
  autoplayReducer,
  DEFAULT_AUTOPLAY_SECONDS,
  initialAutoplayState,
  isCountdownVisible,
  shouldAdvance
} from '../features/playback/autoplay';
import {
  audioModeFor,
  browserSurroundProbe,
  withAudioMode
} from '../features/playback/audio-capability';
import { isImageSubtitle } from '../features/playback/subtitle-capability';
import {
  browserCapabilityProbe,
  detectClientCapabilities,
  withCapabilities
} from '../features/playback/client-capabilities';

interface VideoPlayerProps {
  item: MediaItem;
  onClose: () => void;
  trackProgress: boolean;
  onAdvance?: (item: MediaItem) => void;
  watchRoom?: WatchRoomLaunch | null;
  onWatchRoomStarted?: (room: WatchRoomLaunch) => void;
  onWatchRoomEnded?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  item,
  onClose,
  trackProgress,
  onAdvance,
  watchRoom,
  onWatchRoomStarted,
  onWatchRoomEnded
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item.duration || 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [streamMode, setStreamMode] = useState<'direct' | 'hls'>('direct');
  const [selectedQuality, setSelectedQuality] = useState<'auto' | '1080p' | '720p' | '480p'>('auto');
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [castPlayback, setCastPlayback] = useState<CastPlaybackAccess | null | undefined>(undefined);
  const [castSupported, setCastSupported] = useState(false);
  const [castAvailable, setCastAvailable] = useState(true);
  const [castState, setCastState] = useState<CastConnectionState>('disconnected');
  const [castMessage, setCastMessage] = useState<string | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number>(0);
  const [playbackDescriptor, setPlaybackDescriptor] = useState<PlaybackDescriptor>({
    markers: [],
    nextEpisode: null
  });
  const [watchAction, setWatchAction] = useState<string | null>(null);
  const watchConnection = useWatchRoom(watchRoom?.roomId ?? null);
  const isWatchHost = watchConnection.room?.self.role === 'host';
  const canControlTimeline = !watchRoom || isWatchHost;

  const hideTimeoutRef = useRef<any>(null);

  // Parse embedded streams
  let streams: MediaStreamTrack[] = [];
  try {
    streams = JSON.parse(item.streams_json || '[]');
  } catch {}

  const subtitleTracks = streams.filter((s) => s.codec_type === 'subtitle');

  // Image subtitles are pictures, not text: the only way to show them is to
  // have the server draw them onto the video, which means an HLS transcode.
  const burnedInSubtitle = subtitleTracks.find((track) =>
    track.index === selectedSubtitle && isImageSubtitle(track.codec_name) && !track.is_external
  );
  const audioTracks = streams.filter((s) => s.codec_type === 'audio');

  useEffect(() => {
    const preferences = watchConnection.room?.self.preferences;
    if (!preferences) return;
    setSelectedSubtitle(preferences.subtitleTrackIndex);
    setSelectedAudio(preferences.audioTrackIndex);
  }, [watchConnection.room?.self.preferences]);

  useEffect(() => {
    let cancelled = false;
    setPlaybackDescriptor({ markers: [], nextEpisode: null });
    api.getPlaybackDescriptor(item.id)
      .then((descriptor) => {
        if (!cancelled) setPlaybackDescriptor(descriptor);
      })
      .catch((error) => console.warn('Playback markers unavailable:', error));
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  useEffect(() => {
    let cancelled = false;
    setCastPlayback(undefined);
    api.getCastPlaybackAccess(item.id)
      .then((access) => {
        if (!cancelled) setCastPlayback(access);
      })
      .catch((error) => {
        console.warn('Cast access unavailable:', error);
        if (!cancelled) setCastPlayback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  useEffect(() => {
    const video = videoRef.current as CastableVideoElement | null;
    if (!video) return;
    video.disableRemotePlayback = false;
    video.setAttribute('x-webkit-airplay', 'allow');
    setCastSupported(supportsRemotePlayback(video));

    const remote = video.remote;
    let availabilityId: number | undefined;
    if (remote) setCastState(remote.state);
    const handleConnecting = () => setCastState('connecting');
    const handleConnect = () => {
      setCastState('connected');
      setCastMessage('Playing on cast device');
    };
    const handleDisconnect = () => {
      setCastState('disconnected');
      setCastMessage(null);
    };
    const handleWebKitTarget = () => {
      const connected = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
      setCastState(connected ? 'connected' : 'disconnected');
      setCastMessage(connected ? 'Playing on AirPlay device' : null);
    };

    remote?.addEventListener('connecting', handleConnecting);
    remote?.addEventListener('connect', handleConnect);
    remote?.addEventListener('disconnect', handleDisconnect);
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', handleWebKitTarget);
    if (remote?.watchAvailability) {
      void remote.watchAvailability((available) => setCastAvailable(available))
        .then((id) => { availabilityId = id; })
        .catch(() => setCastAvailable(true));
    }

    return () => {
      remote?.removeEventListener('connecting', handleConnecting);
      remote?.removeEventListener('connect', handleConnect);
      remote?.removeEventListener('disconnect', handleDisconnect);
      video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', handleWebKitTarget);
      if (availabilityId !== undefined) void remote?.cancelWatchAvailability?.(availabilityId);
    };
  }, []);

  // Initialize playback source
  useEffect(() => {
    const video = videoRef.current;
    if (!video || castPlayback === undefined) return;

    const initialSeek = item.progress && item.progress.position_seconds > 10 && !item.progress.completed
      ? item.progress.position_seconds
      : 0;

    if (streamMode === 'hls') {
      const baseHlsUrl = selectedQuality === 'auto'
        ? castPlayback?.hlsUrl ?? `/api/media/${item.id}/hls/master.m3u8`
        : castPlayback?.hlsQualityUrls[selectedQuality] ?? `/api/media/${item.id}/hls/${selectedQuality}/index.m3u8`;

      // Ask for surround only when this browser can actually decode it; the
      // server downmixes to stereo for anyone who does not ask.
      const audioUrl = withAudioMode(baseHlsUrl, audioModeFor(browserSurroundProbe(video)));
      const subtitledUrl = burnedInSubtitle
        ? `${audioUrl}${audioUrl.includes('?') ? '&' : '?'}subtitle=${burnedInSubtitle.index}`
        : audioUrl;
      // Telling the server what this browser decodes is what lets it send HEVC
      // or AV1, which carry the same picture in roughly half the bandwidth.
      // Without it every stream is H.264 at a bitrate chosen for nobody.
      // Ask the decoder that will actually play this stream: Safari plays the
      // playlist itself, everything else goes through Media Source Extensions,
      // and the two do not support the same codecs.
      const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
      const hlsUrl = withCapabilities(
        subtitledUrl,
        detectClientCapabilities(browserCapabilityProbe(video, nativeHls ? 'native' : 'mse'))
      );

      // Prefer the browser's native HLS pipeline when available. In Safari it
      // keeps the real playlist URL visible to AirPlay instead of replacing it
      // with an hls.js MediaSource blob.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        if (initialSeek > 0) video.currentTime = initialSeek;
        video.play().catch(() => setIsPlaying(false));
      } else if (Hls.isSupported()) {
        if (hlsRef.current) {
          hlsRef.current.destroy();
        }
        const hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          enableWorker: true
        });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (initialSeek > 0) video.currentTime = initialSeek;
          video.play().catch(() => setIsPlaying(false));
        });
      }
    } else {
      // Direct Play Range stream
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.src = castPlayback?.directUrl ?? `/api/media/${item.id}/stream`;
      if (initialSeek > 0) {
        video.currentTime = initialSeek;
      }
      video.play().catch(() => setIsPlaying(false));
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [item.id, streamMode, selectedQuality, castPlayback, burnedInSubtitle?.index]);

  useEffect(() => {
    if (selectedAudio === null) return;
    const selectedPosition = audioTracks.findIndex((track) => track.index === selectedAudio);
    if (selectedPosition < 0) return;
    if (hlsRef.current && selectedPosition < hlsRef.current.audioTracks.length) {
      hlsRef.current.audioTrack = selectedPosition;
    }
    const browserTracks = (videoRef.current as (HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { enabled: boolean } };
    }) | null)?.audioTracks;
    if (browserTracks && selectedPosition < browserTracks.length) {
      for (let index = 0; index < browserTracks.length; index += 1) {
        browserTracks[index].enabled = index === selectedPosition;
      }
    }
  }, [selectedAudio, streamMode, item.id]);

  useEffect(() => {
    const event = watchConnection.timelineEvent;
    const video = videoRef.current;
    if (!event || !video || event.timeline.mediaId !== item.id) return;
    // The host reports its real player position and is the room reference.
    // A reconnect snapshot is the one event that must also realign the host.
    if (isWatchHost && event.cause !== 'snapshot') return;

    const correction = decideDriftCorrection({
      localPositionSeconds: video.currentTime,
      localPaused: video.paused,
      targetPositionSeconds: event.timeline.positionSeconds,
      targetPaused: event.timeline.paused
    });
    video.playbackRate = correction.playbackRate;
    if (correction.kind === 'hard-sync') {
      video.currentTime = correction.positionSeconds;
      if (correction.paused) video.pause();
      else void video.play().catch(() => setIsPlaying(false));
    } else if (correction.kind === 'seek') {
      video.currentTime = correction.positionSeconds;
      if (!event.timeline.paused) void video.play().catch(() => setIsPlaying(false));
    } else if (correction.kind === 'rate' && video.paused) {
      void video.play().catch(() => setIsPlaying(false));
    }
  }, [watchConnection.timelineEvent?.sequence, isWatchHost, item.id]);

  useEffect(() => {
    if (!watchConnection.connected || !isWatchHost || !watchConnection.room) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(video.currentTime)) return;
      watchConnection.sendHostReport(
        watchConnection.room!.timeline.revision,
        video.currentTime,
        video.paused
      );
    }, 2000);
    return () => window.clearInterval(interval);
  }, [watchConnection.connected, isWatchHost, watchConnection.room?.timeline.revision]);

  // Periodic progress tracking to server (every 5s)
  useEffect(() => {
    if (!trackProgress) return;

    const saveProgress = (position: number, videoDuration: number) => {
      void api.updateProgress(item.id, position, videoDuration).catch((error) => {
        console.warn('Failed to update watch progress:', error);
      });
    };

    const interval = setInterval(() => {
      const video = videoRef.current;
      if (video && video.currentTime > 0 && !video.paused) {
        saveProgress(video.currentTime, video.duration || item.duration);
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      const video = videoRef.current;
      if (video && video.currentTime > 0) {
        saveProgress(video.currentTime, video.duration || item.duration);
      }
    };
  }, [item.id, item.duration, trackProgress]);

  // Handle Controls auto-hide
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
        setShowSettingsMenu(false);
        setShowSubtitleMenu(false);
      }
    }, 3500);
  }, [isPlaying]);

  // Video event handlers
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (video.duration && !isNaN(video.duration)) {
      setDuration(video.duration);
    }
    if (video.buffered.length > 0) {
      setBuffered(video.buffered.end(video.buffered.length - 1));
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !canControlTimeline) return;
    if (video.paused) {
      void video.play();
      setIsPlaying(true);
      if (watchRoom) watchConnection.sendCommand('play', video.currentTime);
    } else {
      video.pause();
      setIsPlaying(false);
      if (watchRoom) watchConnection.sendCommand('pause', video.currentTime);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    const video = videoRef.current;
    if (video && canControlTimeline) {
      video.currentTime = time;
      setCurrentTime(time);
      if (watchRoom) watchConnection.sendCommand('seek', time);
    }
  };

  const skipTime = (seconds: number) => {
    const video = videoRef.current;
    if (video && canControlTimeline) {
      const position = Math.max(0, Math.min(video.duration || duration, video.currentTime + seconds));
      video.currentTime = position;
      if (watchRoom) watchConnection.sendCommand('seek', position);
    }
  };

  const activeMarker = playbackDescriptor.markers.find((marker) => (
    currentTime >= marker.startSeconds && currentTime < marker.endSeconds
  ));

  const [playbackSummary, setPlaybackSummary] = useState<string | null>(null);
  const [autoplay, dispatchAutoplay] = useReducer(autoplayReducer, initialAutoplayState);

  // Ask the server what it will do for this device, and why. The answer is
  // what the badge shows instead of a bare protocol name.
  useEffect(() => {
    let cancelled = false;
    setPlaybackSummary(null);
    const declared = detectClientCapabilities(browserCapabilityProbe(videoRef.current));
    api.getMediaDetail(item.id, withCapabilities('', declared).replace(/^\?/, ''))
      .then((detail) => { if (!cancelled) setPlaybackSummary(detail.playback?.summary ?? null); })
      .catch(() => { if (!cancelled) setPlaybackSummary(null); });
    return () => { cancelled = true; };
  }, [item.id]);
  const nextEpisode = playbackDescriptor.nextEpisode as MediaItem | null;
  const canAutoAdvance = Boolean(!watchRoom && nextEpisode && onAdvance);

  // A new item clears any earlier decision to cancel.
  useEffect(() => {
    dispatchAutoplay({ type: 'reset' });
  }, [item.id]);

  useEffect(() => {
    if (!isCountdownVisible(autoplay)) return;
    const timer = window.setInterval(() => dispatchAutoplay({ type: 'tick' }), 1000);
    return () => window.clearInterval(timer);
  }, [autoplay.status]);

  useEffect(() => {
    if (!shouldAdvance(autoplay)) return;
    if (canAutoAdvance && nextEpisode && onAdvance) onAdvance(nextEpisode);
  }, [autoplay.status, canAutoAdvance, nextEpisode, onAdvance]);

  const handleSkipMarker = () => {
    if (!activeMarker || !canControlTimeline) return;
    if (activeMarker.type === 'credits' && canAutoAdvance) {
      dispatchAutoplay({ type: 'advance-now' });
      return;
    }
    const video = videoRef.current;
    if (video) {
      video.currentTime = activeMarker.endSeconds;
      setCurrentTime(activeMarker.endSeconds);
      if (watchRoom) watchConnection.sendCommand('seek', activeMarker.endSeconds);
    }
  };

  const handleStartWatchRoom = async () => {
    const video = videoRef.current;
    if (!video || !onWatchRoomStarted) return;
    setWatchAction('Creating room...');
    try {
      const created = await createWatchRoom(item.id, video.currentTime);
      const inviteUrl = buildWatchRoomInviteUrl(created.roomId, created.inviteToken);
      onWatchRoomStarted({ roomId: created.roomId, inviteUrl });
      setWatchAction('Room ready');
    } catch (error) {
      setWatchAction(error instanceof Error ? error.message : 'Unable to create room');
    }
  };

  const handleCopyInvite = async () => {
    if (!watchRoom?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(watchRoom.inviteUrl);
      setWatchAction('Invite copied');
    } catch {
      window.prompt('Copy this Watch Together invite', watchRoom.inviteUrl);
      setWatchAction('Invite ready to copy');
    }
  };

  const handleLeaveWatchRoom = async () => {
    if (!watchRoom) return;
    try {
      await leaveWatchRoom(watchRoom.roomId);
    } catch {
      // The room may already have expired; leaving the local session is safe.
    }
    onWatchRoomEnded?.();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const video = videoRef.current;
    if (video) {
      video.volume = val;
      setVolume(val);
      setIsMuted(val === 0);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(console.error);
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(console.error);
      setIsFullscreen(false);
    }
  };

  const handleCast = () => {
    const video = videoRef.current as CastableVideoElement | null;
    if (!video) return;
    if (!castPlayback) {
      setCastMessage('Secure cast access is unavailable');
      return;
    }
    setCastMessage(null);
    // Keep this call in the click handler: browsers require a user gesture to
    // show their native Cast/AirPlay device picker.
    void promptForRemotePlayback(video).catch((error) => {
      const name = error instanceof DOMException ? error.name : '';
      if (name !== 'NotAllowedError') {
        setCastMessage(error instanceof Error ? error.message : 'Unable to open the cast device picker');
      }
      setCastState('disconnected');
    });
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if ((e.code === 'Space' || e.key === 'k') && canControlTimeline) {
        e.preventDefault();
        togglePlay();
      } else if ((e.code === 'ArrowLeft' || e.key === 'j') && canControlTimeline) {
        e.preventDefault();
        skipTime(-10);
      } else if ((e.code === 'ArrowRight' || e.key === 'l') && canControlTimeline) {
        e.preventDefault();
        skipTime(10);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          const newVol = Math.min(1, video.volume + 0.1);
          video.volume = newVol;
          setVolume(newVol);
          setIsMuted(false);
        }
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          const newVol = Math.max(0, video.volume - 0.1);
          video.volume = newVol;
          setVolume(newVol);
          setIsMuted(newVol === 0);
        }
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'Escape') {
        if (!document.fullscreenElement) {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, isMuted, onClose, canControlTimeline]);

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center select-none overflow-hidden"
    >
      <video
        ref={videoRef}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => {
          setIsPlaying(false);
          if (canAutoAdvance) dispatchAutoplay({ type: 'playback-ended' });
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onClick={togglePlay}
        className={`w-full h-full object-contain ${canControlTimeline ? 'cursor-pointer' : 'cursor-default'}`}
        playsInline
        disableRemotePlayback={false}
      >
        {selectedSubtitle !== null && !burnedInSubtitle && (
          <track
            kind="subtitles"
            label="Subtitles"
            src={`${castPlayback?.subtitleUrlBase ?? `/api/media/${item.id}/subtitles/`}${selectedSubtitle}${castPlayback?.query ?? ''}`}
            default
          />
        )}
      </video>

      {activeMarker && canControlTimeline && (
        <button
          type="button"
          onClick={handleSkipMarker}
          className="absolute bottom-28 right-6 rounded-lg border border-white/20 bg-black/80 px-5 py-2.5 text-sm font-semibold text-white shadow-xl backdrop-blur transition-colors hover:bg-white hover:text-black focus:outline-none focus:ring-2 focus:ring-white"
        >
          {activeMarker.type === 'intro'
            ? 'Skip Intro'
            : playbackDescriptor.nextEpisode ? 'Next Episode' : 'Skip Credits'}
        </button>
      )}

      {isCountdownVisible(autoplay) && nextEpisode && (
        <div
          role="dialog"
          aria-live="polite"
          aria-label="Up next"
          className="absolute bottom-28 right-6 w-80 max-w-[calc(100vw-3rem)] rounded-xl border border-white/15 bg-black/85 p-4 shadow-2xl backdrop-blur"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Up next</p>
              <p className="mt-1 truncate text-sm font-bold text-white">{nextEpisode.title}</p>
              {nextEpisode.season_number !== undefined && nextEpisode.episode_number !== undefined && (
                <p className="text-xs text-slate-400">
                  Season {nextEpisode.season_number}, Episode {nextEpisode.episode_number}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dispatchAutoplay({ type: 'cancel' })}
              aria-label="Cancel autoplay"
              className="rounded p-1 text-slate-400 transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full bg-white transition-[width] duration-1000 ease-linear"
              style={{ width: `${(autoplay.secondsRemaining / DEFAULT_AUTOPLAY_SECONDS) * 100}%` }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => dispatchAutoplay({ type: 'advance-now' })}
              className="flex-1 rounded-lg bg-white px-3 py-2 text-xs font-bold text-black transition-colors hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-white"
            >
              Play now
            </button>
            <button
              type="button"
              onClick={() => dispatchAutoplay({ type: 'cancel' })}
              className="rounded-lg border border-white/20 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white"
            >
              Cancel
            </button>
            <span className="w-6 text-right text-xs font-semibold tabular-nums text-slate-300">
              {autoplay.secondsRemaining}s
            </span>
          </div>
        </div>
      )}

      {/* Top Header Overlay */}
      <div
        className={`absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/90 via-black/40 to-transparent transition-opacity duration-300 flex items-center justify-between ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/20 text-white transition-colors"
            title="Back to library"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white tracking-wide">
              {item.series_title ? `${item.series_title} - ` : ''}
              {item.title}
            </h1>
            <div className="flex items-center gap-3 text-xs text-gray-300 mt-1">
              {item.season_number && item.episode_number && (
                <span className="bg-white/10 px-2 py-0.5 rounded font-mono">
                  S{item.season_number.toString().padStart(2, '0')}E{item.episode_number.toString().padStart(2, '0')}
                </span>
              )}
              {item.resolution_label && (
                <span className="bg-blue-600/60 text-blue-200 border border-blue-400/30 px-2 py-0.5 rounded font-semibold text-[10px]">
                  {item.resolution_label}
                </span>
              )}
              {item.is_hdr && (
                <span className="bg-amber-600/60 text-amber-200 border border-amber-400/30 px-2 py-0.5 rounded font-semibold text-[10px]">
                  HDR
                </span>
              )}
              <span title={playbackSummary ?? undefined}>
                {playbackSummary ?? (streamMode === 'direct' ? 'Playing directly' : `Converting (${selectedQuality})`)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-white">
          {watchRoom ? (
            <>
              <span className="rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1.5">
                {watchConnection.connected ? 'Together' : 'Reconnecting'} ·{' '}
                {watchConnection.room?.participants.filter((participant) => participant.connected).length ?? 0}
                {' '}watching · {isWatchHost ? 'Host' : 'Member'}
              </span>
              {watchRoom.inviteUrl && (
                <button type="button" onClick={() => void handleCopyInvite()} className="rounded-full bg-white/15 p-2 hover:bg-white/25" title="Copy invite">
                  <Copy className="h-4 w-4" />
                </button>
              )}
              <button type="button" onClick={() => void handleLeaveWatchRoom()} className="rounded-full bg-white/15 p-2 hover:bg-rose-500/50" title="Leave room">
                <LogOut className="h-4 w-4" />
              </button>
            </>
          ) : trackProgress ? (
            <button type="button" onClick={() => void handleStartWatchRoom()} className="flex items-center gap-2 rounded-full bg-indigo-600/90 px-3 py-2 font-semibold hover:bg-indigo-500">
              <Users className="h-4 w-4" /> Watch Together
            </button>
          ) : null}
          {(watchAction || watchConnection.error) && (
            <span className="max-w-48 truncate text-amber-200">{watchConnection.error || watchAction}</span>
          )}
          {castMessage && (
            <span className="max-w-56 truncate text-blue-200">{castMessage}</span>
          )}
        </div>
      </div>

      {/* Bottom Controls Overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/60 to-transparent transition-opacity duration-300 flex flex-col gap-3 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Seekbar */}
        <div className="relative group flex items-center w-full">
          {/* Hover Time Tooltip */}
          {hoverTime !== null && (
            <div
              className="absolute -top-8 px-2 py-1 bg-black/90 text-white text-xs rounded border border-white/20 pointer-events-none transform -translate-x-1/2"
              style={{ left: `${hoverPos}%` }}
            >
              {formatTime(hoverTime)}
            </div>
          )}

          {/* Buffered track */}
          <div className="absolute inset-y-0 left-0 w-full h-1.5 bg-white/20 rounded-full overflow-hidden my-auto pointer-events-none">
            <div
              className="h-full bg-white/40"
              style={{ width: `${duration > 0 ? (buffered / duration) * 100 : 0}%` }}
            />
          </div>

          <input
            type="range"
            min="0"
            max={duration || 100}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
            disabled={!canControlTimeline}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setHoverPos(pos * 100);
              setHoverTime(pos * duration);
            }}
            onMouseLeave={() => setHoverTime(null)}
            className="w-full h-1.5 bg-transparent accent-blue-500 rounded-lg disabled:cursor-not-allowed cursor-pointer appearance-none z-10 hover:h-2.5 transition-all"
          />
        </div>

        {/* Control Buttons Row */}
        <div className="flex items-center justify-between text-white">
          <div className="flex items-center gap-4">
            <button
              onClick={togglePlay}
              disabled={!canControlTimeline}
              className="p-2.5 rounded-full hover:bg-white/20 disabled:opacity-40 text-white transition-colors"
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white" />}
            </button>

            <button
              onClick={() => skipTime(-10)}
              disabled={!canControlTimeline}
              className="p-2 rounded-full hover:bg-white/20 disabled:opacity-40 text-gray-300 hover:text-white transition-colors"
              title="Skip back 10s"
            >
              <RotateCcw className="w-5 h-5" />
            </button>

            <button
              onClick={() => skipTime(10)}
              disabled={!canControlTimeline}
              className="p-2 rounded-full hover:bg-white/20 disabled:opacity-40 text-gray-300 hover:text-white transition-colors"
              title="Skip forward 10s"
            >
              <RotateCw className="w-5 h-5" />
            </button>

            {/* Volume */}
            <div className="flex items-center gap-2 group">
              <button
                onClick={toggleMute}
                className="p-2 rounded-full hover:bg-white/20 text-gray-300 hover:text-white transition-colors"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-20 h-1 bg-white/30 accent-blue-500 rounded cursor-pointer"
              />
            </div>

            {/* Timestamps */}
            <div className="text-xs text-gray-300 font-mono select-none">
              <span>{formatTime(currentTime)}</span>
              <span className="mx-1 text-gray-500">/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Right Controls */}
          <div className="flex items-center gap-3 relative">
            {castSupported && (
              <button
                type="button"
                onClick={handleCast}
                disabled={(castState === 'disconnected' && !castAvailable) || castPlayback === undefined}
                className={`p-2 rounded-full hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40 transition-colors ${
                  castState === 'connected' ? 'text-blue-400' : 'text-gray-300 hover:text-white'
                }`}
                title={castState === 'connected' ? 'Change or stop casting' : 'Cast to a device'}
                aria-label={castState === 'connected' ? 'Change or stop casting' : 'Cast to a device'}
              >
                <Cast className={`w-5 h-5 ${castState === 'connecting' ? 'animate-pulse' : ''}`} />
              </button>
            )}

            {/* Subtitles Menu Toggle */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowSubtitleMenu(!showSubtitleMenu);
                  setShowSettingsMenu(false);
                }}
                className={`p-2 rounded-full hover:bg-white/20 transition-colors ${
                  selectedSubtitle !== null ? 'text-blue-400' : 'text-gray-300 hover:text-white'
                }`}
                title="Subtitles"
              >
                <Subtitles className="w-5 h-5" />
              </button>

              {showSubtitleMenu && (
                <div className="absolute bottom-12 right-0 w-48 bg-gray-900/95 backdrop-blur border border-white/10 rounded-lg p-2 shadow-2xl text-xs z-50">
                  <div className="font-semibold text-gray-400 px-2 py-1 uppercase text-[10px]">Subtitles</div>
                  <button
                    onClick={() => {
                      setSelectedSubtitle(null);
                      watchConnection.sendPreferences({ subtitleTrackIndex: null });
                      setShowSubtitleMenu(false);
                    }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 flex items-center justify-between"
                  >
                    <span>Off</span>
                    {selectedSubtitle === null && <Check className="w-3.5 h-3.5 text-blue-400" />}
                  </button>
                  {subtitleTracks.map((sub) => (
                    <button
                      key={sub.index}
                      onClick={() => {
                        setSelectedSubtitle(sub.index);
                        // Direct Play cannot show an image subtitle, so picking
                        // one switches to the stream the server can draw on.
                        if (isImageSubtitle(sub.codec_name) && !sub.is_external) {
                          setStreamMode('hls');
                        }
                        watchConnection.sendPreferences({ subtitleTrackIndex: sub.index });
                        setShowSubtitleMenu(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 flex items-center justify-between"
                    >
                      <span className="truncate">
                        {sub.language || sub.title || `Track ${sub.index}`}
                        {isImageSubtitle(sub.codec_name) && !sub.is_external && (
                          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                            image
                          </span>
                        )}
                      </span>
                      {selectedSubtitle === sub.index && <Check className="w-3.5 h-3.5 text-blue-400" />}
                    </button>
                  ))}
                  {subtitleTracks.length === 0 && (
                    <div className="px-2 py-1 text-gray-500 italic">No subtitles found</div>
                  )}
                </div>
              )}
            </div>

            {/* Playback Settings Menu */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowSettingsMenu(!showSettingsMenu);
                  setShowSubtitleMenu(false);
                }}
                className="p-2 rounded-full hover:bg-white/20 text-gray-300 hover:text-white transition-colors"
                title="Playback Settings"
              >
                <Settings className="w-5 h-5" />
              </button>

              {showSettingsMenu && (
                <div className="absolute bottom-12 right-0 w-60 bg-gray-900/95 backdrop-blur border border-white/10 rounded-lg p-3 shadow-2xl text-xs z-50 space-y-3">
                  {/* Stream Mode */}
                  <div>
                    <div className="font-semibold text-gray-400 mb-1.5 uppercase text-[10px]">Stream Engine</div>
                    <div className="grid grid-cols-2 gap-1 bg-black/40 p-1 rounded">
                      <button
                        onClick={() => setStreamMode('direct')}
                        className={`px-2 py-1 rounded transition-colors ${
                          streamMode === 'direct' ? 'bg-blue-600 text-white font-medium' : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        Direct Play
                      </button>
                      <button
                        onClick={() => setStreamMode('hls')}
                        className={`px-2 py-1 rounded transition-colors ${
                          streamMode === 'hls' ? 'bg-blue-600 text-white font-medium' : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        HLS Transcode
                      </button>
                    </div>
                  </div>

                  {/* Quality (if HLS) */}
                  {streamMode === 'hls' && (
                    <div>
                      <div className="font-semibold text-gray-400 mb-1.5 uppercase text-[10px]">Transcode Quality</div>
                      <div className="space-y-1">
                        {(['auto', '1080p', '720p', '480p'] as const).map((q) => (
                          <button
                            key={q}
                            onClick={() => setSelectedQuality(q)}
                            className="w-full text-left px-2 py-1 rounded hover:bg-white/10 flex items-center justify-between"
                          >
                            <span className="capitalize">{q}</span>
                            {selectedQuality === q && <Check className="w-3.5 h-3.5 text-blue-400" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {audioTracks.length > 0 && (
                    <div>
                      <div className="font-semibold text-gray-400 mb-1.5 uppercase text-[10px]">Audio track</div>
                      <div className="space-y-1">
                        {audioTracks.map((track) => (
                          <button
                            key={track.index}
                            onClick={() => {
                              setSelectedAudio(track.index);
                              watchConnection.sendPreferences({ audioTrackIndex: track.index });
                            }}
                            className="w-full text-left px-2 py-1 rounded hover:bg-white/10 flex items-center justify-between"
                          >
                            <span>{track.language || track.title || `Track ${track.index}`}</span>
                            {selectedAudio === track.index && <Check className="w-3.5 h-3.5 text-blue-400" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Speed */}
                  {!watchRoom && <div>
                    <div className="font-semibold text-gray-400 mb-1.5 uppercase text-[10px]">Playback Speed</div>
                    <div className="flex gap-1 overflow-x-auto">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <button
                          key={rate}
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.playbackRate = rate;
                              setPlaybackRate(rate);
                            }
                          }}
                          className={`px-2 py-0.5 rounded text-[11px] ${
                            playbackRate === rate ? 'bg-blue-600 text-white' : 'bg-white/5 text-gray-300 hover:bg-white/10'
                          }`}
                        >
                          {rate}x
                        </button>
                      ))}
                    </div>
                  </div>}
                </div>
              )}
            </div>

            {/* Fullscreen Toggle */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-full hover:bg-white/20 text-gray-300 hover:text-white transition-colors"
              title="Fullscreen"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
