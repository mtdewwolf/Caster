import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Sparkles, Film, Tv, RefreshCw, FolderPlus, Info, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { MediaItem, Series, SystemHardwareStatus, ScanStatus } from './types';
import { api } from './api';
import { Navbar, AppView } from './components/Navbar';
import { MediaCard } from './components/MediaCard';
import { SeriesCard } from './components/SeriesCard';
import { SeriesDetailPage } from './components/SeriesDetailPage';
import { MediaDetailModal } from './components/MediaDetailModal';
import { VideoPlayer } from './components/VideoPlayer';
import { AudioPlayer } from './components/AudioPlayer';
import { SettingsModal } from './components/SettingsModal';
import { ProgressPage } from './components/ProgressPage';
import {
  DEFAULT_LIBRARY_FILTERS,
  LibraryFilterBar,
  type LibraryFilters,
  countActiveFilters
} from './components/LibraryFilterBar';
import { describeError, useToast } from './components/Toaster';
import { HomePage } from './components/HomePage';
import { MusicLibraryPage } from './features/music/MusicLibraryPage';
import {
  createInitialMusicQueueState,
  hydrateMusicQueueForUser,
  musicQueueReducer,
  persistMusicQueueState,
  type MusicQueueAction
} from './features/music/queue-reducer';
import type { WatchRoomLaunch } from './features/watch-together/contracts';
import { joinWatchRoom, leaveWatchRoom } from './features/watch-together/api';
import {
  clearWatchRoomInviteFromAddressBar,
  readWatchRoomInvite
} from './features/watch-together/invite-fragment';

const MEDIA_PAGE_SIZE = 50;

export const App: React.FC = () => {
  const { notify } = useToast();
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaTotal, setMediaTotal] = useState<number>(0);
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>([]);
  const [activeType, setActiveType] = useState<string>('');
  const [view, setView] = useState<AppView>('home');
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);
  const [genres, setGenres] = useState<string[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [playingItem, setPlayingItem] = useState<MediaItem | null>(null);
  const [watchRoom, setWatchRoom] = useState<WatchRoomLaunch | null>(null);
  const [watchRoomJoinError, setWatchRoomJoinError] = useState<string | null>(null);
  const handledWatchInviteRef = useRef<string | null>(null);
  const [musicQueue, setMusicQueue] = useState(createInitialMusicQueueState);
  const queueOwnerRef = useRef('anonymous');
  const skipQueuePersistRef = useRef(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [hardware, setHardware] = useState<SystemHardwareStatus | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const mediaRequestId = useRef(0);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const principalKey = 'public';
  const queueUserId = 'public';

  useEffect(() => {
    queueOwnerRef.current = queueUserId;
    skipQueuePersistRef.current = true;
    setMusicQueue(hydrateMusicQueueForUser(window.localStorage, queueUserId) || createInitialMusicQueueState());
    setPlayingItem(null);
    setWatchRoom(null);
    setWatchRoomJoinError(null);
  }, [queueUserId]);

  useEffect(() => {
    if (queueOwnerRef.current !== queueUserId) return;
    if (skipQueuePersistRef.current) {
      skipQueuePersistRef.current = false;
      return;
    }
    persistMusicQueueState(window.localStorage, queueUserId, musicQueue);
  }, [musicQueue, queueUserId]);

  const updateMusicQueue = useCallback((action: MusicQueueAction) => {
    setMusicQueue((current) => musicQueueReducer(current, action));
  }, []);

  const playTracks = useCallback((tracks: MediaItem[]) => {
    if (tracks.length === 0) return;
    const entries = tracks.map((track, index) => ({
      id: `${track.id}:${crypto.randomUUID?.() || `${Date.now()}-${index}`}`,
      track
    }));
    setMusicQueue((current) => musicQueueReducer(current, { type: 'replace', entries }));
    setPlayingItem(tracks[0]);
  }, []);

  const advanceMusicQueue = useCallback((): MediaItem | null => {
    const next = musicQueueReducer(musicQueue, { type: 'advance' });
    const nextTrack = next.entries.find((entry) => entry.id === next.currentEntryId)?.track ?? null;
    setMusicQueue(next);
    setPlayingItem(nextTrack);
    return nextTrack;
  }, [musicQueue]);

  const loadMedia = async () => {
    const requestId = ++mediaRequestId.current;
    setLoading(true);
    setLoadingMore(false);
    setMediaError(null);
    try {
      const [mediaRes, cwRes, sysRes, scanRes] = await Promise.all([
        api.getMedia({
          type: activeType || undefined,
          search: debouncedSearchQuery || undefined,
          resolution: filters.resolution || undefined,
          genre: filters.genre || undefined,
          watched: filters.watched,
          hdr: filters.hdrOnly,
          sort: filters.sort,
          limit: MEDIA_PAGE_SIZE,
          offset: 0
        }),
        api.getContinueWatching(),
        api.getSystemStatus(),
        api.getScanStatus()
      ]);

      if (requestId !== mediaRequestId.current) return;
      setMediaError(null);
      setMediaItems(mediaRes.items || []);
      setMediaTotal(mediaRes.total || 0);
      setContinueWatching(cwRes || []);
      setHardware(sysRes.hardware);
      setScanStatus(scanRes);
    } catch (err) {
      if (requestId !== mediaRequestId.current) return;
      // A silent console.error leaves an empty grid that reads as "no media".
      // Say what failed, and give the person a way to try again.
      const message = describeError(err, 'The server did not respond.');
      setMediaError(message);
      notify({
        title: 'Could not load your library',
        description: message,
        tone: 'error',
        action: { label: 'Try again', onSelect: () => { void loadMedia(); } }
      });
    } finally {
      if (requestId === mediaRequestId.current) setLoading(false);
    }
  };

  const loadMoreMedia = async () => {
    if (loadingMore || mediaItems.length >= mediaTotal) return;

    const requestId = mediaRequestId.current;
    setLoadingMore(true);
    try {
      const mediaRes = await api.getMedia({
        type: activeType || undefined,
        search: debouncedSearchQuery || undefined,
        resolution: filters.resolution || undefined,
        genre: filters.genre || undefined,
        watched: filters.watched,
        hdr: filters.hdrOnly,
        sort: filters.sort,
        limit: MEDIA_PAGE_SIZE,
        offset: mediaItems.length
      });

      if (requestId !== mediaRequestId.current) return;
      setMediaItems((currentItems) => {
        const currentIds = new Set(currentItems.map((item) => item.id));
        return [...currentItems, ...(mediaRes.items || []).filter((item) => !currentIds.has(item.id))];
      });
      setMediaTotal(mediaRes.total || 0);
    } catch (err) {
      notify({
        title: 'Could not load more items',
        description: describeError(err, 'The server did not respond.'),
        tone: 'error',
        action: { label: 'Try again', onSelect: () => { void loadMoreMedia(); } }
      });
    } finally {
      if (requestId === mediaRequestId.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    const invitation = readWatchRoomInvite();
    if (!invitation) return;
    const invitationKey = `${invitation.roomId}:${invitation.inviteToken}`;
    if (handledWatchInviteRef.current === invitationKey) return;
    handledWatchInviteRef.current = invitationKey;
    // Remove the secret before any subsequent navigation or resource request
    // can retain it in browser history. It remains only in this closure.
    clearWatchRoomInviteFromAddressBar();
    setWatchRoomJoinError(null);
    void joinWatchRoom(invitation.roomId, invitation.inviteToken)
      .then(async (room) => {
        const item = await api.getMediaItem(room.mediaId);
        setSelectedItem(null);
        setWatchRoom({ roomId: room.roomId });
        setPlayingItem(item);
      })
      .catch((error) => {
        handledWatchInviteRef.current = null;
        setWatchRoomJoinError(error instanceof Error ? error.message : 'Unable to join watch room');
      });
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    if (activeType === 'track') {
      setLoading(false);
      return;
    }
    loadMedia();
  }, [activeType, debouncedSearchQuery, filters]);

  // Genres come from what is actually indexed, so the menu never offers a
  // filter that would return nothing. A failure here just hides the menu.
  useEffect(() => {
    let cancelled = false;
    api.getGenres({ type: activeType || undefined })
      .then((names) => { if (!cancelled) setGenres(names); })
      .catch(() => { if (!cancelled) setGenres([]); });
    return () => { cancelled = true; };
  }, [activeType, refreshToken]);

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

  useEffect(() => {
    if (activeType !== 'episode') {
      setSelectedSeriesId(null);
      return;
    }
    api
      .getSeries({ search: searchQuery || undefined })
      .then(setSeriesList)
      .catch((err) => console.error('Error fetching series:', err));
  }, [activeType, searchQuery, refreshToken]);

  const closePlayer = () => {
    if (watchRoom) void leaveWatchRoom(watchRoom.roomId).catch(() => undefined);
    setWatchRoom(null);
    setPlayingItem(null);
    setRefreshToken((t) => t + 1);
    loadMedia();
    if (selectedSeriesId) {
      api
        .getSeries({ search: searchQuery || undefined })
        .then(setSeriesList)
        .catch(console.error);
    }
  };

  const handleOpenSettings = () => {
    setShowSettings(true);
  };

  // Featured hero item (either the first continue watching or first media item)
  const heroItem = continueWatching[0] || mediaItems[0];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      {/* Navigation Header */}
      <Navbar
        activeType={activeType}
        activeView={view}
        onViewChange={setView}
        onTypeChange={setActiveType}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenSettings={handleOpenSettings}
        hardware={hardware}
        isScanning={!!scanStatus?.isScanning}
      />

      {/* Main Content Area */}
      <main className="flex-1 pb-16">
        {watchRoomJoinError && (
          <div role="alert" className="fixed right-4 top-20 z-[70] max-w-sm rounded-xl border border-rose-400/30 bg-rose-950/95 p-4 text-sm text-rose-100 shadow-2xl">
            <div className="font-semibold">Could not join Watch Together</div>
            <div className="mt-1 text-xs text-rose-200">{watchRoomJoinError}</div>
            <button type="button" onClick={() => setWatchRoomJoinError(null)} className="mt-2 text-xs font-semibold underline">Dismiss</button>
          </div>
        )}
        {view === 'home' ? (
          <div className="mx-auto mt-8 max-w-7xl px-4 sm:px-8">
            <HomePage
              key={principalKey}
              refreshToken={refreshToken}
              onPlay={(i) => setPlayingItem(i)}
              onSelect={(i) => setSelectedItem(i)}
              onBrowseLibrary={() => { setView('library'); setActiveType(''); }}
            />
          </div>
        ) : view === 'progress' ? (
          <div className="mt-4">
            <ProgressPage
              key={principalKey}
              refreshToken={refreshToken}
              onPlay={(i) => setPlayingItem(i)}
              onSelect={(i) => setSelectedItem(i)}
            />
          </div>
        ) : activeType === 'track' ? (
          <MusicLibraryPage search={debouncedSearchQuery} onPlayTracks={playTracks} />
        ) : (
          <>
        {/* Hero Spotlight (shown if items exist and not actively searching) */}
        {heroItem && !searchQuery && !activeType && countActiveFilters(filters) === 0 && (
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

          {/* Series Rollup / Media Grid */}
          {activeType === 'episode' ? (
            selectedSeriesId ? (
              <SeriesDetailPage
                key={`${principalKey}:${selectedSeriesId}`}
                seriesId={selectedSeriesId}
                refreshToken={refreshToken}
                onBack={() => setSelectedSeriesId(null)}
                onPlay={(i) => setPlayingItem(i)}
                onSelect={(i) => setSelectedItem(i)}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
                  <h2 className="text-lg font-bold text-white tracking-tight">TV Series</h2>
                  <div className="text-xs text-slate-400">
                    Showing <span className="font-semibold text-slate-200">{seriesList.length}</span> series
                  </div>
                </div>
                {seriesList.length === 0 ? (
                  <div className="py-20 flex flex-col items-center justify-center text-center p-8 bg-slate-900/40 border border-dashed border-white/10 rounded-2xl max-w-lg mx-auto">
                    <div className="p-4 bg-blue-600/10 text-blue-400 rounded-full mb-3">
                      <Tv className="w-8 h-8" />
                    </div>
                    <h3 className="text-base font-bold text-white mb-1">No TV Series Found</h3>
                    <p className="text-xs text-slate-400 mb-4 max-w-xs leading-relaxed">
                      Add a TV library and scan episodes named like <code>Show.Name.S01E02.mkv</code> to group them into series.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {seriesList.map((series) => (
                      <SeriesCard
                        key={series.id}
                        series={series}
                        onSelect={(s) => setSelectedSeriesId(s.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            )
          ) : (
            <>
          <LibraryFilterBar
            filters={filters}
            genres={genres}
            shownCount={mediaItems.length}
            totalCount={mediaTotal}
            onChange={setFilters}
          />

          {/* Media Grid / Empty States */}
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-500">
              <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
              <span className="text-xs">Loading media from TrueNAS...</span>
            </div>
          ) : mediaError ? (
            <div
              role="alert"
              className="py-20 flex flex-col items-center justify-center text-center p-8 bg-rose-950/20 border border-dashed border-rose-500/30 rounded-2xl max-w-lg mx-auto"
            >
              <div className="p-4 bg-rose-500/10 text-rose-400 rounded-full mb-3">
                <AlertTriangle className="w-8 h-8" />
              </div>
              <h3 className="text-base font-bold text-white mb-1">Could not load your library</h3>
              <p className="text-xs text-rose-200/80 mb-4 max-w-xs leading-relaxed">{mediaError}</p>
              <button
                onClick={() => { void loadMedia(); }}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-lg transition-all"
              >
                Try again
              </button>
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
                onClick={handleOpenSettings}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl shadow-lg transition-all"
              >
                Open Server Settings
              </button>
            </div>
          ) : (
            <div className="space-y-8">
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

              {mediaItems.length < mediaTotal && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={loadMoreMedia}
                    disabled={loadingMore}
                    className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed text-sm font-semibold text-white rounded-xl border border-white/10 transition-colors"
                  >
                    {loadingMore && <RefreshCw className="w-4 h-4 animate-spin" />}
                    <span>{loadingMore ? 'Loading more...' : 'Load more'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
            </>
          )}
        </div>
          </>
        )}
      </main>

      {/* Media Player Modal */}
      {playingItem?.type === 'track' ? (
        <AudioPlayer
          key={playingItem.id}
          item={playingItem}
          onClose={closePlayer}
          queue={musicQueue}
          onEnded={advanceMusicQueue}
          onSelectQueueEntry={(entryId) => {
            const track = musicQueue.entries.find((entry) => entry.id === entryId)?.track;
            if (!track) return;
            updateMusicQueue({ type: 'set-current', entryId });
            setPlayingItem(track);
          }}
          onRemoveQueueEntry={(entryId) => {
            const next = musicQueueReducer(musicQueue, { type: 'remove', entryId });
            setMusicQueue(next);
            if (musicQueue.currentEntryId === entryId) {
              setPlayingItem(next.entries.find((entry) => entry.id === next.currentEntryId)?.track ?? null);
            }
          }}
          onMoveQueueEntry={(entryId, toIndex) => updateMusicQueue({ type: 'reorder', entryId, toIndex })}
          onRepeatChange={(repeat) => updateMusicQueue({ type: 'set-repeat', repeat })}
          onShuffleChange={() => updateMusicQueue({ type: 'toggle-shuffle' })}
        />
      ) : playingItem ? (
        <VideoPlayer
          key={playingItem.id}
          item={playingItem}
          onClose={closePlayer}
          trackProgress
          onAdvance={(nextItem) => setPlayingItem(nextItem)}
          watchRoom={watchRoom}
          onWatchRoomStarted={setWatchRoom}
          onWatchRoomEnded={() => setWatchRoom(null)}
        />
      ) : null}

      {/* Media Detail Modal */}
      {selectedItem && (
        <MediaDetailModal
          item={selectedItem}
          onSelectVersion={(mediaId) => {
            // Swap the detail view to the chosen file; progress follows the
            // title, so the resume point is unchanged.
            void api.getMediaItem(mediaId).then(setSelectedItem).catch(() => {});
          }}
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
