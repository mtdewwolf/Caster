import React from 'react';
import { Tv, Check } from 'lucide-react';
import type { Series } from '../types';

interface SeriesCardProps {
  series: Series;
  onSelect: (series: Series) => void;
}

export const SeriesCard: React.FC<SeriesCardProps> = ({ series, onSelect }) => {
  const formatDuration = (secs: number) => {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    if (h > 0) return `${h}h`;
    return `${Math.floor(secs / 60)}m`;
  };

  const watchedPercent =
    series.episode_count > 0
      ? Math.round((series.watched_count / series.episode_count) * 100)
      : 0;
  const fullyWatched = watchedPercent >= 100;

  return (
    <div
      onClick={() => onSelect(series)}
      className="group relative flex flex-col bg-slate-900/60 hover:bg-slate-800/80 border border-white/5 hover:border-blue-500/40 rounded-xl overflow-hidden cursor-pointer transition-all duration-300 transform hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-500/10"
    >
      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
        {series.poster_path ? (
          <img
            src={series.poster_path}
            alt={series.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 gap-2 bg-gradient-to-br from-slate-900 to-slate-950">
            <Tv className="w-5 h-5 text-blue-400" />
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              TV Series
            </span>
          </div>
        )}

        <div className="absolute top-2 left-2 flex items-center gap-1.5 pointer-events-none">
          {fullyWatched && (
            <span className="px-1.5 py-0.5 bg-emerald-950/80 backdrop-blur text-[10px] font-bold text-emerald-400 border border-emerald-500/30 rounded flex items-center gap-1">
              <Check className="w-3 h-3" />
              Watched
            </span>
          )}
          {series.year && (
            <span className="px-1.5 py-0.5 bg-slate-950/80 backdrop-blur text-[10px] font-bold text-slate-300 rounded">
              {series.year}
            </span>
          )}
        </div>

        {watchedPercent > 0 && !fullyWatched && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-800">
            <div className="h-full bg-blue-500" style={{ width: `${watchedPercent}%` }} />
          </div>
        )}
      </div>

      <div className="p-3 flex flex-col justify-between flex-1">
        <h3 className="text-sm font-semibold text-slate-100 group-hover:text-blue-400 transition-colors line-clamp-1">
          {series.title}
        </h3>

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5 text-[11px] text-slate-400">
          <span className="font-mono text-slate-300">
            {series.season_count} season{series.season_count === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2">
            <span>{series.episode_count} ep</span>
            {series.total_duration > 0 && <span>{formatDuration(series.total_duration)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
