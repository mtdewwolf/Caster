import React from 'react';
import { Play, RotateCcw, X, HardDrive, FileVideo, Volume2, Subtitles, Layers } from 'lucide-react';
import type { MediaItem, MediaStreamTrack } from '../types';

interface MediaDetailModalProps {
  item: MediaItem;
  onClose: () => void;
  onPlay: (item: MediaItem) => void;
}

export const MediaDetailModal: React.FC<MediaDetailModalProps> = ({ item, onClose, onPlay }) => {
  let streams: MediaStreamTrack[] = [];
  try {
    streams = JSON.parse(item.streams_json || '[]');
  } catch {}

  const formatDuration = (secs: number) => {
    if (!secs) return 'Unknown';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const hasResume = item.progress && item.progress.position_seconds > 10 && !item.progress.completed;

  return (
    <div className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-detail-title"
        className="relative w-full max-w-3xl bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden my-8"
      >
        {/* Header / Backdrop Image */}
        <div className="relative aspect-video max-h-72 w-full bg-slate-950 overflow-hidden">
          {item.poster_path ? (
            <img src={item.poster_path} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-t from-slate-900 via-slate-950 to-slate-900" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/60 to-transparent" />

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close media details"
            className="absolute top-4 right-4 p-2 bg-black/60 hover:bg-black/80 text-slate-300 hover:text-white rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Banner Details */}
          <div className="absolute bottom-4 left-6 right-6">
            {item.series_title && (
              <div className="text-sm font-semibold text-blue-400 mb-1 tracking-wide uppercase">
                {item.series_title}
              </div>
            )}
            <h1 id="media-detail-title" className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {item.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2.5 mt-2 text-xs text-slate-300">
              {item.year && <span className="text-slate-400">{item.year}</span>}
              {item.season_number && item.episode_number && (
                <span className="bg-white/10 px-2 py-0.5 rounded font-mono">
                  S{item.season_number}E{item.episode_number}
                </span>
              )}
              {item.duration > 0 && <span>{formatDuration(item.duration)}</span>}
              {item.resolution_label && (
                <span className="px-2 py-0.5 bg-blue-600/70 border border-blue-400/30 text-blue-100 font-bold rounded">
                  {item.resolution_label}
                </span>
              )}
              {item.is_hdr && (
                <span className="px-2 py-0.5 bg-amber-600/70 border border-amber-400/30 text-amber-100 font-bold rounded">
                  HDR
                </span>
              )}
              {item.video_codec && (
                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 rounded font-mono uppercase">
                  {item.video_codec}
                </span>
              )}
              {item.audio_channel_layout && (
                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 rounded font-mono">
                  {item.audio_channel_layout}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6">
          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3">
            {hasResume ? (
              <>
                <button
                  onClick={() => onPlay(item)}
                  className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl shadow-lg shadow-blue-600/20 transition-all transform active:scale-95"
                >
                  <Play className="w-5 h-5 fill-white" />
                  <span>Resume at {formatDuration(item.progress?.position_seconds || 0)}</span>
                </button>
                <button
                  onClick={() => {
                    const freshItem = { ...item, progress: undefined };
                    onPlay(freshItem);
                  }}
                  className="flex items-center gap-2 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl border border-white/10 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Play from Beginning</span>
                </button>
              </>
            ) : (
              <button
                onClick={() => onPlay(item)}
                className="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl shadow-lg shadow-blue-600/20 transition-all transform active:scale-95"
              >
                <Play className="w-5 h-5 fill-white" />
                <span>Play Now</span>
              </button>
            )}
          </div>

          {/* Technical Specs & Stream Tracks */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="bg-slate-950/60 border border-white/5 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-slate-300 uppercase tracking-wider text-[11px] mb-2">
                <FileVideo className="w-4 h-4 text-blue-400" />
                <span>Video & Codec Info</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Dimensions:</span>
                <span className="text-slate-200 font-mono">{item.width ? `${item.width}x${item.height}` : 'N/A'}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Framerate:</span>
                <span className="text-slate-200 font-mono">{item.frame_rate ? `${item.frame_rate} fps` : 'N/A'}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>File Size:</span>
                <span className="text-slate-200 font-mono">{formatBytes(item.size_bytes)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Container:</span>
                <span className="text-slate-200 font-mono uppercase">{item.format}</span>
              </div>
            </div>

            <div className="bg-slate-950/60 border border-white/5 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-slate-300 uppercase tracking-wider text-[11px] mb-2">
                <Volume2 className="w-4 h-4 text-emerald-400" />
                <span>Audio & Subtitles</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Audio Codec:</span>
                <span className="text-slate-200 font-mono uppercase">{item.audio_codec || 'N/A'}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Channels:</span>
                <span className="text-slate-200 font-mono">{item.audio_channel_layout || item.audio_channels || 'N/A'}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Subtitles Available:</span>
                <span className="text-slate-200 font-mono">
                  {streams.filter(s => s.codec_type === 'subtitle').length} track(s)
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Library:</span>
                <span className="text-slate-200">{item.library_name || 'Default'}</span>
              </div>
            </div>
          </div>

          {/* The API deliberately omits absolute paths from viewer responses. */}
          {item.full_path ? (
            <div className="bg-slate-950/60 border border-white/5 rounded-xl p-3 flex items-start gap-3 text-xs">
              <HardDrive className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
              <div className="overflow-hidden">
                <div className="text-slate-400 font-medium mb-0.5">TrueNAS File Path:</div>
                <div className="font-mono text-slate-300 truncate">{item.full_path}</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
