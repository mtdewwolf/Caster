import React, { useState, useEffect } from 'react';
import { Play, Sparkles, Film, Tv, RefreshCw, FolderPlus, Info, CheckCircle2 } from 'lucide-react';
import type { MediaItem, SystemHardwareStatus, ScanStatus } from './types';
import { api } from './api';
import { Navbar } from './components/Navbar';
import { MediaCard } from './components/MediaCard';
import { MediaDetailModal } from './components/MediaDetailModal';
import { VideoPlayer } from './components/VideoPlayer';
import { SettingsModal } from './components/SettingsModal';

export const App: React.FC = () => {
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>([]);
  const [activeType, setActiveType] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedResolution, setSelectedResolution] = useState<string>('');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [playingItem, setPlayingItem] = useState<MediaItem | null>(null);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [hardware, setHardware] = useState<SystemHardwareStatus | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const loadMedia = async () => {
    setLoading(true);
    try {
      const [mediaRes, cwRes, sysRes, scanRes] = await Promise.all([
        api.getMedia({
          type: activeType || undefined,
          search: searchQuery || undefined,
          resolution: selectedResolution || undefined
        }),
        api.getContinueWatching(),
        api.getSystemStatus(),
        api.getScanStatus()
      ]);

      setMediaItems(mediaRes.items || []);
      setContinueWatching(cwRes || []);
      setHardware(sysRes.hardware);
      setScanStatus(scanRes);
    } catch (err) {
      console.error('Error fetching media:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMedia();
  }, [activeType, searchQuery, selectedResolution]);

  useEffect(() => {
    if (!scanStatus?.isScanning) return;

    const interval = setInterval(async () => {
      try {
        setScanStatus(await api.getScanStatus());
      } catch (err) {
        console.error('Error fetching scan status:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [scanStatus?.isScanning]);

  // Featured hero item (either the first continue watching or first media item)
  const heroItem = continueWatching[0] || mediaItems[0];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Navigation Header */}
      <Navbar
        activeType={activeType}
        onTypeChange={setActiveType}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenSettings={() => setShowSettings(true)}
        hardware={hardware}
        isScanning={!!scanStatus?.isScanning}
      />

      {/* Main Content Area */}
      <main className="flex-1 pb-16">
        {/* Hero Spotlight (shown if items exist and not actively searching) */}
        {heroItem && !searchQuery && !activeType && !selectedResolution && (
          <div className="relative aspect-[21/9] max-h-[460px] w-full bg-slate-950 overflow-hidden border-b border-white/5">
            {heroItem.poster_path ? (
              <img
                src={heroItem.poster_path}
                alt={heroItem.title}
                className="w-full h-full object-cover opacity-60 transform scale-105 filter blur-[1px]"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-tr from-slate-950 via-slate-900 to-indigo-950 opacity-80" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/40 to-transparent" />

            <div className="absolute bottom-8 left-4 sm:left-12 max-w-2xl space-y-3">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 bg-blue-600/80 text-blue-100 text-[10px] font-bold rounded tracking-wider uppercase">
                  Featured On NAS
                </span>
                {heroItem.resolution_label && (
                  <span className="px-2 py-0.5 bg-white/10 text-white text-[10px] font-bold rounded">
                    {heroItem.resolution_label}
                  </span>
                )}
                {heroItem.is_hdr && (
                  <span className="px-2 py-0.5 bg-amber-600/80 text-amber-100 text-[10px] font-bold rounded">
                    HDR
                  </span>
                )}
              </div>

              <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight drop-shadow-md">
                {heroItem.series_title ? `${heroItem.series_title}: ` : ''}
                {heroItem.title}
              </h1>

              <div className="flex items-center gap-3 text-xs text-slate-300">
                {heroItem.year && <span>{heroItem.year}</span>}
                {heroItem.duration > 0 && (
                  <span>{Math.floor(heroItem.duration / 60)} min</span>
                )}
                {heroItem.video_codec && (
                  <span className="uppercase font-mono text-slate-400">{heroItem.video_codec}</span>
                )}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => setPlayingItem(heroItem)}
                  className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl shadow-lg shadow-blue-600/25 transition-all transform active:scale-95 text-xs sm:text-sm"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>{heroItem.progress?.position_seconds ? 'Resume' : 'Play Now'}</span>
                </button>
                <button
                  onClick={() => setSelectedItem(heroItem)}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white font-medium rounded-xl backdrop-blur transition-colors text-xs sm:text-sm"
                >
                  <Info className="w-4 h-4" />
                  <span>Details</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="max-w-7xl mx-auto px-4 sm:px-8 mt-8 space-y-10">
          {/* Continue Watching Section */}
          {continueWatching.length > 0 && !searchQuery && (
            <section className="space-y-4">
              <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <span>Continue Watching</span>
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {continueWatching.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    onPlay={(i) => setPlayingItem(i)}
                    onSelect={(i) => setSelectedItem(i)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 font-medium">Filter Resolution:</span>
              {['', '4K', '1080p', '720p'].map((res) => (
                <button
                  key={res}
                  onClick={() => setSelectedResolution(res)}
                  className={`px-2.5 py-1 rounded-lg transition-colors ${
                    selectedResolution === res
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {res === '' ? 'All' : res}
                </button>
              ))}
            </div>

            <div className="text-xs text-slate-400">
              Showing <span className="font-semibold text-slate-200">{mediaItems.length}</span> item(s)
            </div>
          </div>

          {/* Media Grid / Empty States */}
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-500">
              <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
              <span className="text-xs">Loading media from TrueNAS...</span>
            </div>
          ) : mediaItems.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-center p-8 bg-slate-900/40 border border-dashed border-white/10 rounded-2xl max-w-lg mx-auto">
              <div className="p-4 bg-blue-600/10 text-blue-400 rounded-full mb-3">
                <FolderPlus className="w-8 h-8" />
              </div>
              <h3 className="text-base font-bold text-white mb-1">No Media Files Found</h3>
              <p className="text-xs text-slate-400 mb-4 max-w-xs leading-relaxed">
                Add your TrueNAS media folder (e.g. <code>/media/movies</code>) in Server Settings to index your collection.
              </p>
              <button
                onClick={() => setShowSettings(true)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl shadow-lg transition-all"
              >
                Open Server Settings
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {mediaItems.map((item) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  onPlay={(i) => setPlayingItem(i)}
                  onSelect={(i) => setSelectedItem(i)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Video Player Modal */}
      {playingItem && (
        <VideoPlayer
          item={playingItem}
          onClose={() => {
            setPlayingItem(null);
            loadMedia();
          }}
        />
      )}

      {/* Media Detail Modal */}
      {selectedItem && (
        <MediaDetailModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onPlay={(i) => {
            setSelectedItem(null);
            setPlayingItem(i);
          }}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onLibrariesChanged={loadMedia}
        />
      )}
    </div>
  );
};

export default App;
