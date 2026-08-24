import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Sparkles, Film, Tv, RefreshCw, FolderPlus, Info, CheckCircle2 } from 'lucide-react';
import type { MediaItem, Series, SystemHardwareStatus, ScanStatus } from './types';
import { api, AUTH_INVALIDATED_EVENT } from './api';
import type { AuthSession } from './api';
import { Navbar, AppView } from './components/Navbar';
import { MediaCard } from './components/MediaCard';
import { SeriesCard } from './components/SeriesCard';
import { SeriesDetailPage } from './components/SeriesDetailPage';
import { MediaDetailModal } from './components/MediaDetailModal';
import { VideoPlayer } from './components/VideoPlayer';
import { AudioPlayer } from './components/AudioPlayer';
import { SettingsModal } from './components/SettingsModal';
import { ProgressPage } from './components/ProgressPage';
import { LoginModal } from './components/LoginModal';
import { ProfileSwitchModal } from './components/ProfileSwitchModal';
import { OwnerSetupModal } from './components/OwnerSetupModal';
import { InviteSignupModal } from './components/InviteSignupModal';

const MEDIA_PAGE_SIZE = 50;

export const App: React.FC = () => {
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaTotal, setMediaTotal] = useState<number>(0);
  const [continueWatching, setContinueWatching] = useState<MediaItem[]>([]);
  const [activeType, setActiveType] = useState<string>('');
  const [view, setView] = useState<AppView>('library');
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [selectedResolution, setSelectedResolution] = useState<string>('');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [playingItem, setPlayingItem] = useState<MediaItem | null>(null);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [hardware, setHardware] = useState<SystemHardwareStatus | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const mediaRequestId = useRef(0);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authSessionError, setAuthSessionError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [openSettingsAfterLogin, setOpenSettingsAfterLogin] = useState(false);
  const [showProfileSwitch, setShowProfileSwitch] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => {
    const match = window.location.hash.match(/^#invite=([^&]+)$/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  });
  const isAuthenticated = authSession?.authenticated === true;
  const isAdmin = authSession?.user?.role === 'admin';
  const principalKey = authSession?.authenticated && authSession.user
    ? `${authSession.user.id}:${authSession.user.role}`
    : 'anonymous';

  const resetUserScopedState = useCallback(() => {
    mediaRequestId.current += 1;
    setMediaItems([]);
    setMediaTotal(0);
    setContinueWatching([]);
    setSeriesList([]);
    setSelectedSeriesId(null);
    setSelectedItem(null);
    setPlayingItem(null);
    setHardware(null);
    setScanStatus(null);
    setShowSettings(false);
    setShowProfileSwitch(false);
    setView('library');
    setRefreshToken((token) => token + 1);
    setLoading(true);
    setLoadingMore(false);
  }, []);

  const applyAuthSession = useCallback((session: AuthSession) => {
    resetUserScopedState();
    setAuthSessionError(null);
    setAuthSession(session);
  }, [resetUserScopedState]);


  const loadMedia = async () => {
    const requestId = ++mediaRequestId.current;
    setLoading(true);
    setLoadingMore(false);
    try {
      const [mediaRes, cwRes, sysRes, scanRes] = await Promise.all([
        api.getMedia({
          type: activeType || undefined,
          search: debouncedSearchQuery || undefined,
          resolution: selectedResolution || undefined,
          limit: MEDIA_PAGE_SIZE,
          offset: 0
        }),
        api.getContinueWatching(),
        isAdmin ? api.getSystemStatus() : Promise.resolve(null),
        isAdmin ? api.getScanStatus() : Promise.resolve(null)
      ]);

      if (requestId !== mediaRequestId.current) return;
      setMediaItems(mediaRes.items || []);
      setMediaTotal(mediaRes.total || 0);
      setContinueWatching(cwRes || []);
      setHardware(sysRes?.hardware ?? null);
      setScanStatus(scanRes);
    } catch (err) {
      console.error('Error fetching media:', err);
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
        resolution: selectedResolution || undefined,
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
      console.error('Error fetching more media:', err);
    } finally {
      if (requestId === mediaRequestId.current) setLoadingMore(false);
    }
  };

  const checkAuthSession = useCallback(async () => {
    setAuthSessionError(null);
    try {
      applyAuthSession(await api.getAuthSession());
    } catch (caught) {
      resetUserScopedState();
      setAuthSession(null);
      setLoading(false);
      setAuthSessionError(caught instanceof Error ? caught.message : 'Unable to check your session');
    }
  }, [applyAuthSession, resetUserScopedState]);

  useEffect(() => {
    void checkAuthSession();
  }, [checkAuthSession]);

  useEffect(() => {
    const handleAuthInvalidated = (event: Event) => {
      const message = event instanceof CustomEvent && typeof event.detail?.message === 'string'
        ? event.detail.message
        : 'Your session has ended. Sign in again to continue.';
      resetUserScopedState();
      setAuthSession((current) => ({
        authenticated: false,
        configured: current?.configured ?? true,
        protectedMode: current?.protectedMode ?? true,
        setupRequired: current?.setupRequired ?? false
      }));
      setAuthSessionError(message);
      setShowLogin(false);
      setOpenSettingsAfterLogin(false);
    };
    window.addEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated);
    return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated);
  }, [resetUserScopedState]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    if (authSession === null || (authSession.protectedMode && !authSession.authenticated)) {
      setLoading(authSession === null);
      return;
    }
    loadMedia();
  }, [activeType, debouncedSearchQuery, selectedResolution, authSession?.authenticated, authSession?.user?.id, authSession?.user?.role]);

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
    if (authSession === null || (authSession.protectedMode && !authSession.authenticated)) return;
    api
      .getSeries({ search: searchQuery || undefined })
      .then(setSeriesList)
      .catch((err) => console.error('Error fetching series:', err));
  }, [activeType, searchQuery, refreshToken, authSession?.authenticated, authSession?.user?.id]);

  const closePlayer = () => {
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

  const openLogin = (continueToSettings = false) => {
    setOpenSettingsAfterLogin(continueToSettings);
    setShowLogin(true);
  };

  const handleOpenSettings = () => {
    if (isAdmin) {
      setShowSettings(true);
      return;
    }
    openLogin(true);
  };

  const handleLogin = async (username: string, credential: string) => {
    const response = await api.login(username, credential);
    applyAuthSession({
      authenticated: true,
      configured: true,
      protectedMode: true,
      setupRequired: false,
      user: response.user
    });
    setShowLogin(false);
    if (openSettingsAfterLogin && response.user.role === 'admin') setShowSettings(true);
    setOpenSettingsAfterLogin(false);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      applyAuthSession({
        authenticated: false,
        configured: authSession?.configured ?? true,
        protectedMode: authSession?.protectedMode ?? true,
        setupRequired: authSession?.setupRequired ?? false
      });
    }
  };

  const handleProfileSwitch = async (username: string, pin: string) => {
    const response = await api.switchProfile(username, pin);
    applyAuthSession({
      authenticated: true,
      configured: authSession?.configured ?? true,
      protectedMode: authSession?.protectedMode ?? true,
      setupRequired: authSession?.setupRequired ?? false,
      user: response.user
    });
  };

  const handleOwnerSetup = async (username: string, password: string) => {
    const response = await api.setupOwner(username, password);
    applyAuthSession({
      authenticated: true,
      configured: true,
      protectedMode: true,
      setupRequired: false,
      user: response.user
    });
  };

  const clearInvite = () => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setInviteToken(null);
  };

  const handleInviteSignup = async (token: string, username: string, password: string) => {
    const response = await api.signup(token, username, password);
    clearInvite();
    applyAuthSession({
      authenticated: true,
      configured: true,
      protectedMode: true,
      setupRequired: false,
      user: response.user
    });
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
        user={authSession?.user}
        isAdmin={isAdmin}
        onLogin={() => openLogin(false)}
        onSwitchProfile={() => setShowProfileSwitch(true)}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1 pb-16">
        {authSessionError && authSession === null ? (
          <div role="alert" className="mx-auto mt-20 max-w-md rounded-2xl border border-rose-500/25 bg-rose-950/30 p-6 text-center">
            <h1 className="text-lg font-bold text-white">Unable to check your session</h1>
            <p className="mt-2 text-sm text-rose-200">{authSessionError}</p>
            <button type="button" onClick={() => void checkAuthSession()} className="mt-5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">
              Try again
            </button>
          </div>
        ) : authSession?.setupRequired ? (
          <div className="mx-auto mt-20 max-w-md rounded-2xl border border-white/10 bg-slate-900/60 p-8 text-center">
            <h1 className="text-xl font-bold text-white">This Caster server needs an owner</h1>
            <p className="mt-2 text-sm text-slate-400">Complete the one-time setup from the server host's local network.</p>
          </div>
        ) : authSession?.protectedMode && !isAuthenticated ? (
          <div className="mx-auto mt-20 max-w-md rounded-2xl border border-white/10 bg-slate-900/60 p-8 text-center">
            <h1 className="text-xl font-bold text-white">Sign in to view this Caster library</h1>
            <p className="mt-2 text-sm text-slate-400">
              {authSessionError || 'This server requires an account before media and watch progress can be viewed.'}
            </p>
            <button type="button" onClick={() => openLogin(false)} className="mt-5 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">
              Sign in
            </button>
          </div>
        ) : view === 'progress' ? (
          <div className="mt-4">
            <ProgressPage
              key={principalKey}
              refreshToken={refreshToken}
              onPlay={(i) => setPlayingItem(i)}
              onSelect={(i) => setSelectedItem(i)}
              isAuthenticated={isAuthenticated}
              onRequireAuthentication={() => openLogin(false)}
            />
          </div>
        ) : (
          <>
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
              Showing <span className="font-semibold text-slate-200">{mediaItems.length}</span>
              {' of '}
              <span className="font-semibold text-slate-200">{mediaTotal}</span> item(s)
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
          item={playingItem}
          onClose={closePlayer}
        />
      ) : playingItem ? (
        <VideoPlayer
          item={playingItem}
          onClose={closePlayer}
          trackProgress={isAuthenticated}
        />
      ) : null}

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

      {showLogin && (
        <LoginModal
          onClose={() => {
            setShowLogin(false);
            setOpenSettingsAfterLogin(false);
          }}
          onLogin={handleLogin}
        />
      )}

      {authSession?.setupRequired ? <OwnerSetupModal onSetup={handleOwnerSetup} /> : null}

      {inviteToken && authSession && !authSession.setupRequired ? (
        <InviteSignupModal token={inviteToken} onClose={clearInvite} onSignup={handleInviteSignup} />
      ) : null}

      {showProfileSwitch && authSession?.user ? (
        <ProfileSwitchModal
          currentUsername={authSession.user.username}
          onClose={() => setShowProfileSwitch(false)}
          onSwitch={handleProfileSwitch}
        />
      ) : null}
    </div>
  );
};

export default App;
