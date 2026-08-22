import React from 'react';
import { Play, Film, Tv, Music } from 'lucide-react';
import type { MediaItem } from '../types';

interface MediaCardProps {
  item: MediaItem;
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({ item, onPlay, onSelect }) => {
  const formatDuration = (secs: number) => {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const getMediaIcon = () => {
    if (item.type === 'episode') return <Tv className="w-4 h-4 text-blue-400" />;
    if (item.type === 'track') return <Music className="w-4 h-4 text-emerald-400" />;
    return <Film className="w-4 h-4 text-purple-400" />;
  };

  return (
    <div
      onClick={() => onSelect(item)}
      className="group relative flex flex-col bg-slate-900/60 hover:bg-slate-800/80 border border-white/5 hover:border-blue-500/40 rounded-xl overflow-hidden cursor-pointer transition-all duration-300 transform hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-500/10"
    >
      {/* Thumbnail Aspect Box */}
      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
        {item.poster_path ? (
          <img
            src={item.poster_path}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 gap-2 bg-gradient-to-br from-slate-900 to-slate-950">
            {getMediaIcon()}
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              {item.format.toUpperCase()}
            </span>
          </div>
        )}

        {/* Hover Play Button Overlay */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay(item);
            }}
            className="p-3 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg transform transition-transform group-hover:scale-110 active:scale-95"
            title="Play Now"
          >
            <Play className="w-5 h-5 fill-white ml-0.5" />
          </button>
        </div>

        {/* Badges Overlay */}
        <div className="absolute top-2 left-2 flex items-center gap-1.5 pointer-events-none">
          {item.resolution_label && (
            <span className="px-1.5 py-0.5 bg-slate-950/80 backdrop-blur text-[10px] font-bold text-blue-400 border border-blue-500/30 rounded">
              {item.resolution_label}
            </span>
          )}
          {item.is_hdr && (
            <span className="px-1.5 py-0.5 bg-amber-950/80 backdrop-blur text-[10px] font-bold text-amber-400 border border-amber-500/30 rounded">
              HDR
            </span>
          )}
        </div>

        {/* Watch Progress Bar */}
        {item.progress && item.progress.progress_percent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-800">
            <div
              className={`h-full ${item.progress.completed ? 'bg-emerald-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(100, item.progress.progress_percent)}%` }}
            />
          </div>
        )}
      </div>

      {/* Info Body */}
      <div className="p-3 flex flex-col justify-between flex-1">
        <div>
          {item.series_title && (
            <div className="text-[11px] font-medium text-blue-400 truncate mb-0.5">
              {item.series_title}
            </div>
          )}
          <h3 className="text-sm font-semibold text-slate-100 group-hover:text-blue-400 transition-colors line-clamp-1">
            {item.title}
          </h3>
        </div>

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5 text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            {item.season_number && item.episode_number && (
              <span className="font-mono text-slate-300">
                S{item.season_number}E{item.episode_number}
              </span>
            )}
            {item.year && <span>{item.year}</span>}
          </div>
          {item.duration > 0 && <span>{formatDuration(item.duration)}</span>}
        </div>
      </div>
    </div>
  );
};
