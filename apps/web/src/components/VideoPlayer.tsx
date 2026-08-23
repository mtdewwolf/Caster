import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  Tv,
  Check
} from 'lucide-react';
import type { MediaItem, MediaStreamTrack } from '../types';
import { api } from '../api';

interface VideoPlayerProps {
  item: MediaItem;
  onClose: () => void;
  trackProgress: boolean;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ item, onClose, trackProgress }) => {
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
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number>(0);

  const hideTimeoutRef = useRef<any>(null);

  // Parse embedded streams
  let streams: MediaStreamTrack[] = [];
  try {
    streams = JSON.parse(item.streams_json || '[]');
  } catch {}

  const subtitleTracks = streams.filter((s) => s.codec_type === 'subtitle');
  const audioTracks = streams.filter((s) => s.codec_type === 'audio');

  // Initialize playback source
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const initialSeek = item.progress && item.progress.position_seconds > 10 && !item.progress.completed
      ? item.progress.position_seconds
      : 0;

    if (streamMode === 'hls') {
      const hlsUrl = selectedQuality === 'auto'
        ? `/api/media/${item.id}/hls/master.m3u8`
        : `/api/media/${item.id}/hls/${selectedQuality}/index.m3u8`;

      if (Hls.isSupported()) {
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
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        if (initialSeek > 0) video.currentTime = initialSeek;
        video.play().catch(() => setIsPlaying(false));
      }
    } else {
      // Direct Play Range stream
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.src = `/api/media/${item.id}/stream`;
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
  }, [item.id, streamMode, selectedQuality]);

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
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    const video = videoRef.current;
    if (video) {
      video.currentTime = time;
      setCurrentTime(time);
    }
  };

  const skipTime = (seconds: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = Math.max(0, Math.min(video.duration || duration, video.currentTime + seconds));
    }
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

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === 'Space' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft' || e.key === 'j') {
        e.preventDefault();
        skipTime(-10);
      } else if (e.code === 'ArrowRight' || e.key === 'l') {
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
  }, [isPlaying, isMuted, onClose]);

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
        onEnded={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onClick={togglePlay}
        className="w-full h-full object-contain cursor-pointer"
        playsInline
      >
        {selectedSubtitle !== null && (
          <track
            kind="subtitles"
            label="Subtitles"
            src={`/api/media/${item.id}/subtitles/${selectedSubtitle}`}
            default
          />
        )}
      </video>

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
              <span>{streamMode === 'direct' ? '⚡ Direct Play' : `🔥 HLS (${selectedQuality})`}</span>
            </div>
          </div>
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
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setHoverPos(pos * 100);
              setHoverTime(pos * duration);
            }}
            onMouseLeave={() => setHoverTime(null)}
            className="w-full h-1.5 bg-transparent accent-blue-500 rounded-lg cursor-pointer appearance-none z-10 hover:h-2.5 transition-all"
          />
        </div>

        {/* Control Buttons Row */}
        <div className="flex items-center justify-between text-white">
          <div className="flex items-center gap-4">
            <button
              onClick={togglePlay}
              className="p-2.5 rounded-full hover:bg-white/20 text-white transition-colors"
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white" />}
            </button>

            <button
              onClick={() => skipTime(-10)}
              className="p-2 rounded-full hover:bg-white/20 text-gray-300 hover:text-white transition-colors"
              title="Skip back 10s"
            >
              <RotateCcw className="w-5 h-5" />
            </button>

            <button
              onClick={() => skipTime(10)}
              className="p-2 rounded-full hover:bg-white/20 text-gray-300 hover:text-white transition-colors"
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
                        setShowSubtitleMenu(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 flex items-center justify-between"
                    >
                      <span className="truncate">{sub.language || sub.title || `Track ${sub.index}`}</span>
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

                  {/* Speed */}
                  <div>
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
                  </div>
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
