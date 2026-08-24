import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Music,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX
} from 'lucide-react';
import type { MediaItem } from '../types';
import { api } from '../api';

interface AudioPlayerProps {
  item: MediaItem;
  onClose: () => void;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds
      .toString()
      .padStart(2, '0')}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ item, onClose }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item.duration || 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playbackError, setPlaybackError] = useState(false);

  const streamUrl = `/api/media/${item.id}/stream`;
  const initialSeek = item.progress && item.progress.position_seconds > 10 && !item.progress.completed
    ? item.progress.position_seconds
    : 0;

  const saveProgress = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.currentTime <= 0) return;
    void api.updateProgress(item.id, audio.currentTime, audio.duration || item.duration);
  }, [item.id, item.duration]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio && audio.currentTime > 0 && !audio.paused) saveProgress();
    }, 5000);

    return () => {
      window.clearInterval(interval);
      saveProgress();
    };
  }, [saveProgress]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }, []);

  const skipTime = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || item.duration, audio.currentTime + seconds));
  }, [item.duration]);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setIsMuted(audio.muted);
  }, []);

  const handleClose = useCallback(() => {
    saveProgress();
    onClose();
  }, [onClose, saveProgress]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        togglePlay();
      } else if (event.code === 'ArrowLeft' || event.key.toLowerCase() === 'j') {
        event.preventDefault();
        skipTime(-10);
      } else if (event.code === 'ArrowRight' || event.key.toLowerCase() === 'l') {
        event.preventDefault();
        skipTime(10);
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggleMute();
      } else if (event.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, skipTime, toggleMute, togglePlay]);

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    if (initialSeek > 0) {
      audio.currentTime = Math.min(initialSeek, audio.duration || initialSeek);
      setCurrentTime(audio.currentTime);
    }

    audio.play().catch(() => setIsPlaying(false));
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;

    setCurrentTime(audio.currentTime);
    if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    if (audio.buffered.length > 0) {
      setBuffered(audio.buffered.end(audio.buffered.length - 1));
    }
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.target.value);
    if (audioRef.current) audioRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.target.value);
    const audio = audioRef.current;
    if (!audio) return;

    audio.volume = nextVolume;
    audio.muted = nextVolume === 0;
    setVolume(nextVolume);
    setIsMuted(nextVolume === 0);
  };

  const handlePlaybackRateChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextRate = Number(event.target.value);
    if (audioRef.current) audioRef.current.playbackRate = nextRate;
    setPlaybackRate(nextRate);
  };

  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950 text-white">
      <audio
        ref={audioRef}
        src={streamUrl}
        autoPlay
        preload="auto"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onProgress={handleTimeUpdate}
        onPlay={() => {
          setIsPlaying(true);
          setPlaybackError(false);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          saveProgress();
        }}
        onError={() => {
          setIsPlaying(false);
          setPlaybackError(true);
        }}
      />

      {item.poster_path && (
        <div
          className="fixed inset-0 bg-cover bg-center opacity-20 blur-3xl scale-110"
          style={{ backgroundImage: `url(${item.poster_path})` }}
          aria-hidden="true"
        />
      )}
      <div className="fixed inset-0 bg-gradient-to-b from-slate-950/60 via-slate-950/85 to-slate-950" aria-hidden="true" />

      <header className="relative z-10 flex items-center gap-4 p-4 sm:p-6">
        <button
          type="button"
          onClick={handleClose}
          className="rounded-full p-2.5 text-slate-200 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
          aria-label="Back to library"
          title="Back to library"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-400">Now playing</p>
          <p className="mt-0.5 text-sm text-slate-400">Direct play from your library</p>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-[calc(100vh-104px)] w-full max-w-5xl items-center px-5 pb-12 sm:px-8">
        <div className="grid w-full items-center gap-10 md:grid-cols-[minmax(260px,0.9fr)_minmax(320px,1.1fr)] md:gap-14">
          <div className="mx-auto aspect-square w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-500/20 via-slate-900 to-indigo-500/20 shadow-2xl shadow-black/50">
            {item.poster_path ? (
              <img src={item.poster_path} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <div className="flex h-32 w-32 items-center justify-center rounded-full border border-white/10 bg-black/20 shadow-inner sm:h-40 sm:w-40">
                  <Music className="h-14 w-14 text-emerald-300 sm:h-16 sm:w-16" strokeWidth={1.5} />
                </div>
              </div>
            )}
          </div>

          <section aria-label="Audio controls" className="min-w-0">
            <div className="mb-8">
              <h1 className="truncate text-3xl font-black tracking-tight text-white sm:text-4xl" title={item.title}>
                {item.title}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                {item.year && <span>{item.year}</span>}
                <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono uppercase text-slate-300">
                  {item.audio_codec || item.format}
                </span>
                {item.audio_channel_layout && (
                  <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-slate-300">
                    {item.audio_channel_layout}
                  </span>
                )}
                <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 font-semibold text-emerald-300">
                  Direct play
                </span>
              </div>
            </div>

            {playbackError && (
              <div className="mb-5 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
                This track could not be played by your browser.
              </div>
            )}

            <div className="space-y-3">
              <div className="relative flex h-5 items-center">
                <div className="pointer-events-none absolute left-0 right-0 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${bufferedPercent}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-emerald-400" style={{ width: `${progressPercent}%` }} />
                </div>
                <input
                  type="range"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(currentTime, duration || 0)}
                  onChange={handleSeek}
                  className="relative z-10 h-5 w-full cursor-pointer appearance-none bg-transparent accent-emerald-400"
                  aria-label="Seek through track"
                />
              </div>
              <div className="flex justify-between font-mono text-xs text-slate-400">
                <span>{formatTime(currentTime)}</span>
                <span>-{formatTime(Math.max(0, duration - currentTime))}</span>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-center gap-4 sm:gap-6">
              <button
                type="button"
                onClick={() => skipTime(-10)}
                className="rounded-full p-3 text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                aria-label="Skip back 10 seconds"
                title="Skip back 10 seconds"
              >
                <RotateCcw className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={togglePlay}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 transition-transform hover:scale-105 hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:ring-offset-4 focus:ring-offset-slate-950 active:scale-95"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause className="h-7 w-7 fill-current" /> : <Play className="ml-1 h-7 w-7 fill-current" />}
              </button>
              <button
                type="button"
                onClick={() => skipTime(10)}
                className="rounded-full p-3 text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                aria-label="Skip forward 10 seconds"
                title="Skip forward 10 seconds"
              >
                <RotateCw className="h-6 w-6" />
              </button>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleMute}
                  className="rounded-full p-2 text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="h-1 w-24 cursor-pointer accent-emerald-400 sm:w-32"
                  aria-label="Volume"
                />
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-400">
                <span>Speed</span>
                <select
                  value={playbackRate}
                  onChange={handlePlaybackRateChange}
                  className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-400"
                  aria-label="Playback speed"
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <option key={rate} value={rate}>{rate}x</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};
