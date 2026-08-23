import React, { useState, useEffect, useCallback } from 'react';
import {
  Play,
  Info,
  History,
  Eye,
  CheckCircle2,
  Trash2,
  RefreshCw,
  Film,
  Tv,
  Music,
  Clock,
  ListVideo
} from 'lucide-react';
import type { MediaItem } from '../types';
import { api } from '../api';

type StatusFilter = 'all' | 'in_progress' | 'completed';

interface ProgressPageProps {
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  refreshToken: number;
  isAdmin: boolean;
  onRequireAdmin: () => void;
}

const formatDuration = (secs: number) => {
  if (!secs || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatRelative = (iso: string) => {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

export const ProgressPage: React.FC<ProgressPageProps> = ({
  onPlay,
  onSelect,
  refreshToken,
  isAdmin,
  onRequireAdmin
}) => {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState<boolean>(true);

  const loadProgress = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProgress();
      setItems(res || []);
    } catch (err) {
      console.error('Error fetching progress:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProgress();
  }, [loadProgress, refreshToken]);

  const inProgress = items.filter((i) => i.progress && !i.progress.completed);
  const completed = items.filter((i) => i.progress?.completed);

  const visible =
    filter === 'in_progress' ? inProgress : filter === 'completed' ? completed : items;

  const totalSecondsLeft = inProgress.reduce(
    (acc, i) =>
      acc +
      Math.max(
        0,
        (i.progress!.duration_seconds || i.duration) - i.progress!.position_seconds
      ),
    0
  );

  const handleMarkWatched = async (id: string) => {
    if (!isAdmin) {
      onRequireAdmin();
      return;
    }
    await api.markWatched(id);
    await loadProgress();
  };

  const handleMarkUnwatched = async (id: string) => {
    if (!isAdmin) {
      onRequireAdmin();
      return;
    }
    await api.markUnwatched(id);
    await loadProgress();
  };

  const handleRemove = async (id: string) => {
    if (!isAdmin) {
      onRequireAdmin();
      return;
    }
    await api.removeProgress(id);
    await loadProgress();
  };

  const getMediaIcon = (type: string) => {
    if (type === 'episode') return <Tv className="w-3.5 h-3.5 text-blue-400" />;
    if (type === 'track') return <Music className="w-3.5 h-3.5 text-emerald-400" />;
    return <Film className="w-3.5 h-3.5 text-purple-400" />;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-8 mt-8 space-y-8">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-blue-600/10 border border-blue-500/20 rounded-xl text-blue-400">
          <History className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-extrabold text-white tracking-tight">Watch Progress</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Everything you have started or finished watching across your libraries.
          </p>
        </div>
      </div>

      {/* Stats Summary */}
      {!loading && items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex items-center gap-4 bg-slate-900/60 border border-white/5 rounded-xl p-4">
            <div className="p-2.5 bg-blue-600/10 text-blue-400 rounded-lg">
              <ListVideo className="w-5 h-5" />
            </div>
            <div>
              <div className="text-2xl font-black text-white leading-none">{inProgress.length}</div>
              <div className="text-[11px] text-slate-400 font-medium mt-1">In Progress</div>
            </div>
          </div>

          <div className="flex items-center gap-4 bg-slate-900/60 border border-white/5 rounded-xl p-4">
            <div className="p-2.5 bg-emerald-600/10 text-emerald-400 rounded-lg">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-2xl font-black text-white leading-none">{completed.length}</div>
              <div className="text-[11px] text-slate-400 font-medium mt-1">Completed</div>
            </div>
          </div>

          <div className="flex items-center gap-4 bg-slate-900/60 border border-white/5 rounded-xl p-4">
            <div className="p-2.5 bg-amber-600/10 text-amber-400 rounded-lg">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <div className="text-2xl font-black text-white leading-none">
                {formatDuration(totalSecondsLeft) || '0m'}
              </div>
              <div className="text-[11px] text-slate-400 font-medium mt-1">Watch Time Remaining</div>
            </div>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        <div className="flex items-center gap-2 text-xs">
          {(
            [
              ['all', `All (${items.length})`],
              ['in_progress', `In Progress (${inProgress.length})`],
              ['completed', `Completed (${completed.length})`]
            ] as [StatusFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                filter === value
                  ? 'bg-blue-600 text-white font-semibold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={loadProgress}
          className="p-2 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-white rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Progress List */}
      {loading ? (
        <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-500">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
          <span className="text-xs">Loading watch progress...</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-20 flex flex-col items-center justify-center text-center p-8 bg-slate-900/40 border border-dashed border-white/10 rounded-2xl max-w-lg mx-auto">
          <div className="p-4 bg-blue-600/10 text-blue-400 rounded-full mb-3">
            <History className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">
            {items.length === 0 ? 'No Watch History Yet' : 'Nothing Here'}
          </h3>
          <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
            {items.length === 0
              ? 'Start playing something and it will show up here so you can pick up where you left off.'
              : 'No items match this filter. Try another tab.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((item) => {
            const p = item.progress!;
            const remaining = Math.max(0, (p.duration_seconds || item.duration) - p.position_seconds);

            return (
              <div
                key={item.id}
                className="group flex flex-col sm:flex-row gap-4 bg-slate-900/60 hover:bg-slate-800/70 border border-white/5 hover:border-blue-500/30 rounded-xl p-3 transition-all"
              >
                {/* Thumbnail */}
                <div
                  className="relative w-full sm:w-44 shrink-0 aspect-video bg-slate-950 rounded-lg overflow-hidden cursor-pointer"
                  onClick={() => onSelect(item)}
                >
                  {item.poster_path ? (
                    <img
                      src={item.poster_path}
                      alt={item.title}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-600 bg-gradient-to-br from-slate-900 to-slate-950">
                      {getMediaIcon(item.type)}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlay(item);
                      }}
                      className="p-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg transition-transform active:scale-95"
                      title="Resume playback"
                    >
                      <Play className="w-4 h-4 fill-white ml-0.5" />
                    </button>
                  </div>

                  {/* Progress Bar Overlay */}
                  {p.progress_percent > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-800">
                      <div
                        className={`h-full ${p.completed ? 'bg-emerald-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(100, p.progress_percent)}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    {getMediaIcon(item.type)}
                    {item.series_title && (
                      <span className="font-medium text-blue-400 truncate">{item.series_title}</span>
                    )}
                    {item.season_number != null && item.episode_number != null && (
                      <span className="font-mono text-slate-400">
                        S{String(item.season_number).padStart(2, '0')}E
                        {String(item.episode_number).padStart(2, '0')}
                      </span>
                    )}
                    {p.completed && (
                      <span className="px-1.5 py-0.5 bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 rounded text-[10px] font-bold uppercase tracking-wide">
                        Watched
                      </span>
                    )}
                  </div>

                  <h3
                    className="text-sm font-semibold text-slate-100 truncate cursor-pointer hover:text-blue-400 transition-colors"
                    onClick={() => onSelect(item)}
                  >
                    {item.title}
                  </h3>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span>{Math.round(p.progress_percent)}% watched</span>
                    {!p.completed && remaining > 0 && (
                      <>
                        <span className="text-slate-600">&bull;</span>
                        <span>{formatDuration(remaining)} left</span>
                      </>
                    )}
                    <span className="text-slate-600">&bull;</span>
                    <span>Last watched {formatRelative(p.last_watched_at)}</span>
                    {item.resolution_label && (
                      <span className="px-1.5 py-0.5 bg-slate-950/80 text-blue-400 border border-blue-500/30 rounded text-[10px] font-bold">
                        {item.resolution_label}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex sm:flex-col items-center sm:items-end justify-end gap-2 shrink-0 self-center sm:self-stretch">
                  <button
                    onClick={() => onPlay(item)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-blue-600/20 transition-all active:scale-95"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    <span>{p.completed ? 'Replay' : 'Resume'}</span>
                  </button>

                  <button
                    onClick={() => onSelect(item)}
                    className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-white rounded-lg transition-colors"
                    title="Details"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>

                  {p.completed ? (
                    <button
                      onClick={() => handleMarkUnwatched(item.id)}
                      className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-amber-400 rounded-lg transition-colors"
                      title="Mark as unwatched"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleMarkWatched(item.id)}
                      className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-emerald-400 rounded-lg transition-colors"
                      title="Mark as watched"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    onClick={() => handleRemove(item.id)}
                    className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-red-400 rounded-lg transition-colors"
                    title="Remove from history"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
