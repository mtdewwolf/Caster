import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Disc3,
  ListMusic,
  ListPlus,
  LoaderCircle,
  Music2,
  Play,
  RefreshCw,
  X
} from 'lucide-react';
import { api } from '../../api';
import type { AlbumSummary, MediaItem } from '../../types';
import { PlaylistManagement } from './PlaylistManagement';
import { playlistApi, type PlaylistSummary } from './playlist-api';

interface MusicLibraryPageProps {
  search: string;
  onPlayTracks: (tracks: MediaItem[]) => void;
}

type MusicTab = 'albums' | 'playlists';

const formatDuration = (seconds: number) => {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function replacePlaylist(playlists: PlaylistSummary[], updated: PlaylistSummary): PlaylistSummary[] {
  return playlists.map((playlist) => playlist.id === updated.id ? updated : playlist);
}

export const MusicLibraryPage: React.FC<MusicLibraryPageProps> = ({ search, onPlayTracks }) => {
  const [activeTab, setActiveTab] = useState<MusicTab>('albums');
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [selected, setSelected] = useState<{ album: AlbumSummary; tracks: MediaItem[] } | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [albumTargetId, setAlbumTargetId] = useState('');
  const [trackTargetId, setTrackTargetId] = useState('');
  const [trackMenuId, setTrackMenuId] = useState<string | null>(null);
  const [busyAdd, setBusyAdd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'albums') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    api.getMusicAlbums({ search: search || undefined })
      .then((items) => {
        if (!cancelled) setAlbums(items);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught, 'Unable to load music'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, search]);

  const openAlbum = async (album: AlbumSummary) => {
    setLoading(true);
    setError(null);
    setPlaylistError(null);
    setNotice(null);
    const [albumResult, playlistResult] = await Promise.allSettled([
      api.getMusicAlbum(album.id),
      playlistApi.list()
    ]);
    if (albumResult.status === 'fulfilled') setSelected(albumResult.value);
    else setError(errorMessage(albumResult.reason, 'Unable to load this album'));

    if (playlistResult.status === 'fulfilled') {
      setPlaylists(playlistResult.value);
      const firstId = playlistResult.value[0]?.id || '';
      setAlbumTargetId(firstId);
      setTrackTargetId(firstId);
    } else {
      setPlaylistError(errorMessage(playlistResult.reason, 'Unable to load playlists'));
    }
    setLoading(false);
  };

  const addTrack = async (track: MediaItem) => {
    if (!trackTargetId) return;
    setBusyAdd(`track:${track.id}`);
    setPlaylistError(null);
    setNotice(null);
    try {
      const updated = await playlistApi.addItem(trackTargetId, track.id);
      setPlaylists((current) => replacePlaylist(current, updated));
      setTrackMenuId(null);
      setNotice(`Added “${track.title}” to ${updated.name}.`);
    } catch (caught) {
      setPlaylistError(errorMessage(caught, 'Unable to add this track'));
    } finally {
      setBusyAdd(null);
    }
  };

  const addAlbum = async () => {
    if (!selected || !albumTargetId || selected.tracks.length === 0) return;
    setBusyAdd('album');
    setPlaylistError(null);
    setNotice(null);
    let updated: PlaylistSummary | undefined;
    let completed = 0;
    try {
      // Each insert establishes the next stable server-side position.
      for (const track of selected.tracks) {
        updated = await playlistApi.addItem(albumTargetId, track.id);
        completed += 1;
      }
      if (updated) {
        setPlaylists((current) => replacePlaylist(current, updated!));
        setNotice(`Added ${completed} tracks from “${selected.album.title}” to ${updated.name}.`);
      }
    } catch (caught) {
      if (updated) setPlaylists((current) => replacePlaylist(current, updated!));
      const prefix = completed > 0 ? `${completed} tracks were added before the request stopped. ` : '';
      setPlaylistError(`${prefix}${errorMessage(caught, 'Unable to add this album')}`);
    } finally {
      setBusyAdd(null);
    }
  };

  const changeTab = (tab: MusicTab) => {
    setActiveTab(tab);
    setSelected(null);
    setError(null);
    setPlaylistError(null);
    setNotice(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-white/10">
        <div role="tablist" aria-label="Music library sections" className="flex gap-1">
          <button id="music-albums-tab" type="button" role="tab" aria-selected={activeTab === 'albums'} aria-controls="music-albums-panel" onClick={() => changeTab('albums')} className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${activeTab === 'albums' ? 'border-emerald-400 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}>
            <Disc3 className="h-4 w-4" /> Albums
          </button>
          <button id="music-playlists-tab" type="button" role="tab" aria-selected={activeTab === 'playlists'} aria-controls="music-playlists-panel" onClick={() => changeTab('playlists')} className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${activeTab === 'playlists' ? 'border-emerald-400 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}>
            <ListMusic className="h-4 w-4" /> Playlists
          </button>
        </div>
      </div>

      {activeTab === 'playlists' ? (
        <div id="music-playlists-panel" role="tabpanel" aria-labelledby="music-playlists-tab">
          <PlaylistManagement search={search} onPlayTracks={onPlayTracks} />
        </div>
      ) : (
        <div id="music-albums-panel" role="tabpanel" aria-labelledby="music-albums-tab">
          {loading && !selected ? (
            <div className="flex min-h-[40vh] items-center justify-center gap-3 text-sm text-slate-400" role="status"><RefreshCw className="h-5 w-5 animate-spin text-emerald-400" /> Loading music library…</div>
          ) : selected ? (
            <section aria-labelledby="album-title">
              <button type="button" onClick={() => setSelected(null)} className="mb-6 flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> All albums</button>
              <div className="grid gap-8 md:grid-cols-[260px_1fr]">
                <div className="aspect-square overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-500/20 via-slate-900 to-indigo-500/20">
                  {selected.album.poster_path ? <img src={selected.album.poster_path} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Disc3 className="h-20 w-20 text-emerald-300" /></div>}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Album</p>
                  <h1 id="album-title" className="mt-2 text-4xl font-black text-white">{selected.album.title}</h1>
                  <p className="mt-2 text-slate-400">{selected.album.album_artist}{selected.album.year ? ` · ${selected.album.year}` : ''}</p>
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => onPlayTracks(selected.tracks)} disabled={selected.tracks.length === 0} className="flex items-center gap-2 rounded-full bg-emerald-400 px-6 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50"><Play className="h-4 w-4 fill-current" /> Play album</button>
                    {playlists.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-slate-900/60 p-1 pl-3">
                        <label htmlFor="album-playlist-target" className="text-xs text-slate-400">Save to</label>
                        <select id="album-playlist-target" value={albumTargetId} onChange={(event) => setAlbumTargetId(event.target.value)} className="max-w-44 bg-transparent text-xs text-white outline-none">
                          {playlists.map((playlist) => <option key={playlist.id} value={playlist.id} className="bg-slate-900">{playlist.name}</option>)}
                        </select>
                        <button type="button" onClick={() => void addAlbum()} disabled={busyAdd !== null} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50">
                          {busyAdd === 'album' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ListPlus className="h-3.5 w-3.5" />} Add album
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => changeTab('playlists')} className="text-sm font-semibold text-emerald-300 hover:text-emerald-200">Create a playlist</button>
                    )}
                  </div>
                  {playlistError ? <p role="alert" className="mt-4 rounded-xl border border-rose-500/20 bg-rose-950/30 p-3 text-sm text-rose-200">{playlistError}</p> : null}
                  {notice ? <p role="status" className="mt-4 text-sm text-emerald-300">{notice}</p> : null}

                  <ol className="mt-8 divide-y divide-white/5 rounded-2xl border border-white/10 bg-slate-900/40">
                    {selected.tracks.map((track, index) => (
                      <li key={track.id}>
                        <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 hover:bg-white/5">
                          <span className="text-xs text-slate-500">{track.track_number ?? index + 1}</span>
                          <button type="button" onClick={() => onPlayTracks(selected.tracks.slice(index))} className="min-w-0 text-left">
                            <span className="block truncate text-sm font-medium text-white hover:text-emerald-300">{track.title}</span><span className="block truncate text-xs text-slate-500">{track.artist || selected.album.album_artist}</span>
                          </button>
                          <span className="text-xs text-slate-500">{formatDuration(track.duration)}</span>
                          <button type="button" onClick={() => { setTrackMenuId((current) => current === track.id ? null : track.id); setTrackTargetId((current) => current || playlists[0]?.id || ''); }} disabled={playlists.length === 0} className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30" aria-label={`Add ${track.title} to playlist`} aria-expanded={trackMenuId === track.id}><ListPlus className="h-4 w-4" /></button>
                        </div>
                        {trackMenuId === track.id ? (
                          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/5 bg-slate-950/40 px-4 py-2">
                            <label htmlFor={`track-playlist-${track.id}`} className="text-xs text-slate-400">Add to playlist</label>
                            <select id={`track-playlist-${track.id}`} value={trackTargetId} onChange={(event) => setTrackTargetId(event.target.value)} className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-xs text-white">
                              {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
                            </select>
                            <button type="button" onClick={() => void addTrack(track)} disabled={busyAdd !== null} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-50">{busyAdd === `track:${track.id}` ? 'Adding…' : 'Add'}</button>
                            <button type="button" onClick={() => setTrackMenuId(null)} className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close add to playlist controls"><X className="h-4 w-4" /></button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          ) : (
            <section aria-labelledby="albums-title">
              <div className="mb-6 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Your library</p><h1 id="albums-title" className="mt-1 text-2xl font-black text-white">Albums</h1></div><span className="flex items-center gap-1.5 text-xs text-slate-500"><ListMusic className="h-4 w-4" /> {albums.length} albums</span></div>
              {error ? <div role="alert" className="rounded-xl border border-rose-500/20 bg-rose-950/30 p-4 text-rose-200">{error}</div> : null}
              {!error && albums.length === 0 ? (
                <div className="flex min-h-[35vh] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 text-center text-slate-400"><Music2 className="mb-3 h-10 w-10 text-emerald-400" /><p className="font-semibold text-white">No albums found</p><p className="mt-1 text-sm">Scan a music library to organize tracks by album.</p></div>
              ) : (
                <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {albums.map((album) => (
                    <button key={album.id} type="button" onClick={() => void openAlbum(album)} className="group min-w-0 text-left">
                      <div className="aspect-square overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-500/15 via-slate-900 to-indigo-500/15 shadow-lg transition-transform group-hover:-translate-y-1">{album.poster_path ? <img src={album.poster_path} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Disc3 className="h-12 w-12 text-emerald-300/80" /></div>}</div>
                      <h2 className="mt-3 truncate text-sm font-bold text-white">{album.title}</h2><p className="truncate text-xs text-slate-500">{album.album_artist}</p>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
};

