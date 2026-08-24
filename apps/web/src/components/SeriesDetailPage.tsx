import React, { useState, useEffect } from 'react';
import { ArrowLeft, Play, CheckCircle2, Circle, Tv, RefreshCw } from 'lucide-react';
import type { MediaItem, Series, SeriesSeason } from '../types';
import { api } from '../api';

interface SeriesDetailPageProps {
  seriesId: string;
  onBack: () => void;
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  refreshToken: number;
}

export const SeriesDetailPage: React.FC<SeriesDetailPageProps> = ({
  seriesId,
  onBack,
  onPlay,
  onSelect,
  refreshToken
}) => {
  const [series, setSeries] = useState<Series | null>(null);
  const [seasons, setSeasons] = useState<SeriesSeason[]>([]);
  const [episodes, setEpisodes] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [detailRes, episodesRes] = await Promise.all([
          api.getSeriesDetail(seriesId),
          api.getSeriesEpisodes(seriesId)
        ]);
        if (cancelled) return;
        setSeries(detailRes.series);
        setSeasons(detailRes.seasons || []);
        setEpisodes(episodesRes.items || []);
      } catch (err) {
        if (!cancelled) {
          setSeries(null);
          setSeasons([]);
          setEpisodes([]);
          setError(err instanceof Error ? err.message : 'Unable to load series');
        }
        console.error('Error fetching series detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seriesId, refreshToken]);

  const formatDuration = (secs: number) => {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  if (loading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-500">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
        <span className="text-xs">Loading series...</span>
      </div>
    );
  }

  if (!series) {
    return (
      <div role={error ? 'alert' : undefined} className="py-20 text-center text-slate-400 text-sm">
        {error || 'Series not found.'}
        <button onClick={onBack} className="ml-2 text-blue-400 hover:text-blue-300">
          Go back
        </button>
      </div>
    );
  }

  const watchedPercent =
    series.episode_count > 0
      ? Math.round((series.watched_count / series.episode_count) * 100)
      : 0;

  // Find next unwatched episode for quick play
  const resumeEpisode =
    episodes.find(
      (e) => e.progress && !e.progress.completed && e.progress.position_seconds > 10
    ) || episodes.find((e) => !e.progress?.completed);

  return (
    <div>
      {/* Back */}
      <button
        onClick={onBack}
        className="mt-4 flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>All Series</span>
      </button>

      {/* Header */}
      <div className="relative mt-4 rounded-2xl overflow-hidden border border-white/5 bg-slate-900/60">
        <div className="relative aspect-[21/9] max-h-[320px] w-full bg-slate-950">
          {series.poster_path ? (
            <img
              src={series.poster_path}
              alt={series.title}
              className="w-full h-full object-cover opacity-60 filter blur-[1px]"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-tr from-slate-950 via-slate-900 to-indigo-950 opacity-80" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent" />

          <div className="absolute bottom-6 left-6 right-6 space-y-2">
            <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight drop-shadow-md flex items-center gap-3">
              {series.title}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              {series.year && <span>{series.year}</span>}
              <span className="flex items-center gap-1.5">
                <Tv className="w-3.5 h-3.5 text-blue-400" />
                {series.season_count} season{series.season_count === 1 ? '' : 's'}
              </span>
              <span>{series.episode_count} episode{series.episode_count === 1 ? '' : 's'}</span>
              {series.total_duration > 0 && <span>{formatDuration(series.total_duration)} total</span>}
              {watchedPercent >= 100 ? (
                <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Watched
                </span>
              ) : (
                <span className="text-slate-400">{watchedPercent}% watched</span>
              )}
            </div>

            {resumeEpisode && (
              <button
                onClick={() => onPlay(resumeEpisode)}
                className="mt-2 flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl shadow-lg shadow-blue-600/25 transition-all transform active:scale-95 text-xs sm:text-sm"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>
                  {resumeEpisode.progress?.position_seconds
                    ? `Resume S${resumeEpisode.season_number}E${resumeEpisode.episode_number}`
                    : 'Play First Unwatched'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Seasons & Episodes */}
      <div className="mt-8 space-y-8 pb-16">
        {seasons.map((season) => {
          const seasonEpisodes = episodes.filter(
            (e) => (e.season_number ?? 0) === season.season_number
          );
          return (
            <section key={season.season_number} className="space-y-3">
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  {season.season_number === 0 ? 'Specials' : `Season ${season.season_number}`}
                </h2>
                <span className="text-[11px] text-slate-400">
                  {season.episode_count} ep · {season.watched_count}/{season.episode_count} watched
                  {season.total_duration > 0 && ` · ${formatDuration(season.total_duration)}`}
                </span>
              </div>

              <div className="space-y-1.5">
                {seasonEpisodes.map((episode) => {
                  const completed = !!episode.progress?.completed;
                  return (
                    <div
                      key={episode.id}
                      className="group flex items-center gap-3 p-2 rounded-xl hover:bg-slate-800/60 transition-colors cursor-pointer"
                      onClick={() => onSelect(episode)}
                    >
                      {/* Thumbnail */}
                      <div className="relative w-28 aspect-video shrink-0 rounded-lg overflow-hidden bg-slate-950 border border-white/5">
                        {episode.poster_path ? (
                          <img src={episode.poster_path} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950">
                            <Tv className="w-4 h-4 text-slate-600" />
                          </div>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlay(episode);
                          }}
                          className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          title="Play"
                        >
                          <span className="p-2 bg-blue-600 rounded-full shadow-lg">
                            <Play className="w-4 h-4 fill-white ml-0.5" />
                          </span>
                        </button>
                        {completed && (
                          <CheckCircle2 className="absolute bottom-1 right-1 w-3.5 h-3.5 text-emerald-400 drop-shadow" />
                        )}
                        {episode.progress && !completed && episode.progress.progress_percent > 0 && (
                          <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-800">
                            <div
                              className="h-full bg-blue-500"
                              style={{ width: `${Math.min(100, episode.progress.progress_percent)}%` }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 ${completed ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {completed ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
                          </span>
                          <span className="font-mono text-[11px] text-slate-400 shrink-0">
                            S{episode.season_number ?? 0}E{episode.episode_number ?? '?'}
                          </span>
                          <span className="text-sm font-medium text-slate-200 truncate group-hover:text-blue-400 transition-colors">
                            {episode.title}
                          </span>
                        </div>
                        <div className="mt-0.5 pl-6 flex items-center gap-2 text-[11px] text-slate-500">
                          {episode.duration > 0 && <span>{formatDuration(episode.duration)}</span>}
                          {episode.resolution_label && <span>{episode.resolution_label}</span>}
                          {episode.progress && !completed && episode.progress.position_seconds > 10 && (
                            <span className="text-blue-400">
                              Resume at {formatDuration(episode.progress.position_seconds)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
