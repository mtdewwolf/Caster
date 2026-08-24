import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ListMusic,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import type { MediaItem } from '../../types';
import {
  movePlaylistEntry,
  playlistApi,
  type PlaylistDetail,
  type PlaylistSummary
} from './playlist-api';

interface PlaylistManagementProps {
  search: string;
  onPlayTracks: (tracks: MediaItem[]) => void;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function replacePlaylist(
  playlists: PlaylistSummary[],
  updated: PlaylistSummary
): PlaylistSummary[] {
  return playlists.map((playlist) => playlist.id === updated.id ? updated : playlist);
}

export const PlaylistManagement: React.FC<PlaylistManagementProps> = ({ search, onPlayTracks }) => {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [selected, setSelected] = useState<PlaylistDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadPlaylists = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      setPlaylists(await playlistApi.list());
    } catch (caught) {
      setError(messageFor(caught, 'Unable to load playlists'));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadPlaylists();
  }, [loadPlaylists]);

  const openPlaylist = async (playlist: PlaylistSummary) => {
    setLoadingDetail(true);
    setError(null);
    setNotice(null);
    setConfirmDelete(false);
    setRenaming(false);
    try {
      const detail = await playlistApi.get(playlist.id);
      setSelected(detail);
      setRenameName(detail.playlist.name);
    } catch (caught) {
      setError(messageFor(caught, 'Unable to load this playlist'));
    } finally {
      setLoadingDetail(false);
    }
  };

  const createPlaylist = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusyAction('create');
    setError(null);
    setNotice(null);
    try {
      const playlist = await playlistApi.create(name);
      setPlaylists((current) => [playlist, ...current]);
      setNewName('');
      setNotice(`Created “${playlist.name}”.`);
      await openPlaylist(playlist);
    } catch (caught) {
      setError(messageFor(caught, 'Unable to create the playlist'));
    } finally {
      setBusyAction(null);
    }
  };

  const renamePlaylist = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !renameName.trim()) return;
    setBusyAction('rename');
    setError(null);
    setNotice(null);
    try {
      const playlist = await playlistApi.rename(
        selected.playlist.id,
        renameName.trim(),
        selected.playlist.revision
      );
      setSelected((current) => current ? { ...current, playlist } : current);
      setPlaylists((current) => replacePlaylist(current, playlist));
      setRenaming(false);
      setNotice('Playlist renamed.');
    } catch (caught) {
      setError(messageFor(caught, 'Unable to rename the playlist'));
    } finally {
      setBusyAction(null);
    }
  };

  const deletePlaylist = async () => {
    if (!selected) return;
    const deletedId = selected.playlist.id;
    setBusyAction('delete');
    setError(null);
    try {
      await playlistApi.remove(deletedId);
      setPlaylists((current) => current.filter((playlist) => playlist.id !== deletedId));
      setSelected(null);
      setConfirmDelete(false);
      setNotice('Playlist deleted.');
    } catch (caught) {
      setError(messageFor(caught, 'Unable to delete the playlist'));
    } finally {
      setBusyAction(null);
    }
  };

  const removeEntry = async (entryId: string) => {
    if (!selected) return;
    setBusyAction(`remove:${entryId}`);
    setError(null);
    try {
      const playlist = await playlistApi.removeItem(selected.playlist.id, entryId);
      setSelected((current) => current ? {
        playlist,
        items: current.items
          .filter((entry) => entry.id !== entryId)
          .map((entry, position) => ({ ...entry, position }))
      } : current);
      setPlaylists((current) => replacePlaylist(current, playlist));
      setNotice('Track removed.');
    } catch (caught) {
      setError(messageFor(caught, 'Unable to remove the track'));
    } finally {
      setBusyAction(null);
    }
  };

  const moveEntry = async (entryId: string, direction: -1 | 1) => {
    if (!selected) return;
    const reordered = movePlaylistEntry(selected.items, entryId, direction);
    if (reordered.every((entry, index) => entry.id === selected.items[index]?.id)) return;
    setBusyAction(`move:${entryId}`);
    setError(null);
    try {
      const playlist = await playlistApi.reorder(
        selected.playlist.id,
        reordered.map((entry) => entry.id),
        selected.playlist.revision
      );
      setSelected({ playlist, items: reordered });
      setPlaylists((current) => replacePlaylist(current, playlist));
      setNotice('Playlist order updated.');
    } catch (caught) {
      setError(messageFor(caught, 'Unable to reorder the playlist'));
    } finally {
      setBusyAction(null);
    }
  };

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visiblePlaylists = normalizedSearch
    ? playlists.filter((playlist) => playlist.name.toLocaleLowerCase().includes(normalizedSearch))
    : playlists;

  if (selected) {
    const playableTracks = selected.items.map((entry) => entry.media);
    return (
      <section aria-labelledby="playlist-detail-title">
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setConfirmDelete(false);
            setRenaming(false);
          }}
          className="mb-5 flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" /> All playlists
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Playlist</p>
            <h2 id="playlist-detail-title" className="mt-1 text-3xl font-black text-white">{selected.playlist.name}</h2>
            <p className="mt-1 text-sm text-slate-500">{selected.items.length} track{selected.items.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onPlayTracks(playableTracks)}
              disabled={playableTracks.length === 0}
              className="flex items-center gap-2 rounded-full bg-emerald-400 px-5 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4 fill-current" /> Play playlist
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming((value) => !value);
                setRenameName(selected.playlist.name);
              }}
              className="rounded-full border border-white/10 p-2 text-slate-300 hover:bg-white/10 hover:text-white"
              aria-label="Rename playlist"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-full border border-rose-400/20 p-2 text-rose-300 hover:bg-rose-500/10"
              aria-label="Delete playlist"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {renaming ? (
          <form onSubmit={renamePlaylist} className="mt-5 flex max-w-lg flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 p-3">
            <label htmlFor="playlist-rename" className="sr-only">Playlist name</label>
            <input
              id="playlist-rename"
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              maxLength={120}
              autoFocus
              className="min-w-48 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
            />
            <button type="submit" disabled={!renameName.trim() || busyAction === 'rename'} className="rounded-lg bg-emerald-400 p-2 text-slate-950 disabled:opacity-50" aria-label="Save playlist name">
              {busyAction === 'rename' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => setRenaming(false)} className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Cancel rename">
              <X className="h-4 w-4" />
            </button>
          </form>
        ) : null}

        {confirmDelete ? (
          <div role="alert" className="mt-5 flex max-w-xl flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-950/30 p-4 text-sm text-rose-100">
            <span>Delete “{selected.playlist.name}”? Its tracks will remain in your library.</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg px-3 py-1.5 text-slate-300 hover:bg-white/10">Cancel</button>
              <button type="button" onClick={() => void deletePlaylist()} disabled={busyAction === 'delete'} className="rounded-lg bg-rose-500 px-3 py-1.5 font-semibold text-white disabled:opacity-50">
                {busyAction === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p role="alert" className="mt-4 rounded-xl border border-rose-500/20 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p> : null}
        {notice ? <p role="status" className="mt-4 text-sm text-emerald-300">{notice}</p> : null}

        {selected.items.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-400">
            Add an album or track from the Albums tab.
          </div>
        ) : (
          <ol className="mt-7 divide-y divide-white/5 rounded-2xl border border-white/10 bg-slate-900/40">
            {selected.items.map((entry, index) => {
              const busy = busyAction?.endsWith(entry.id) === true;
              return (
                <li key={entry.id} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4">
                  <span className="text-center text-xs text-slate-500">{index + 1}</span>
                  <button type="button" onClick={() => onPlayTracks(playableTracks.slice(index))} className="min-w-0 text-left">
                    <span className="block truncate text-sm font-medium text-white hover:text-emerald-300">{entry.media.title}</span>
                    <span className="block truncate text-xs text-slate-500">{entry.media.artist || entry.media.album_artist || 'Unknown Artist'}</span>
                  </button>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => void moveEntry(entry.id, -1)} disabled={index === 0 || busyAction !== null} className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={`Move ${entry.media.title} up`}>
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => void moveEntry(entry.id, 1)} disabled={index === selected.items.length - 1 || busyAction !== null} className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={`Move ${entry.media.title} down`}>
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => void removeEntry(entry.id)} disabled={busyAction !== null} className="rounded p-1.5 text-rose-300 hover:bg-rose-500/10 disabled:opacity-30" aria-label={`Remove ${entry.media.title} from playlist`}>
                      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="playlists-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Saved for you</p>
          <h2 id="playlists-title" className="mt-1 text-2xl font-black text-white">Playlists</h2>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-slate-500"><ListMusic className="h-4 w-4" /> {playlists.length} playlists</span>
      </div>

      <form onSubmit={createPlaylist} className="mb-6 flex max-w-xl gap-2">
        <label htmlFor="new-playlist-name" className="sr-only">New playlist name</label>
        <input
          id="new-playlist-name"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          maxLength={120}
          placeholder="New playlist name"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-emerald-400"
        />
        <button type="submit" disabled={!newName.trim() || busyAction === 'create'} className="flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">
          {busyAction === 'create' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create
        </button>
      </form>

      {error ? <p role="alert" className="mb-4 rounded-xl border border-rose-500/20 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p> : null}
      {notice ? <p role="status" className="mb-4 text-sm text-emerald-300">{notice}</p> : null}

      {loadingList || loadingDetail ? (
        <div className="flex min-h-[28vh] items-center justify-center gap-3 text-sm text-slate-400"><LoaderCircle className="h-5 w-5 animate-spin text-emerald-400" /> Loading playlists…</div>
      ) : visiblePlaylists.length === 0 ? (
        <div className="flex min-h-[28vh] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 text-center text-slate-400">
          <ListMusic className="mb-3 h-10 w-10 text-emerald-400" />
          <p className="font-semibold text-white">{normalizedSearch ? 'No matching playlists' : 'Create your first playlist'}</p>
          <p className="mt-1 text-sm">{normalizedSearch ? 'Try a different search.' : 'Save albums and tracks for later.'}</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visiblePlaylists.map((playlist) => (
            <li key={playlist.id}>
              <button type="button" onClick={() => void openPlaylist(playlist)} className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4 text-left hover:border-emerald-400/30 hover:bg-slate-900/70">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300"><ListMusic className="h-6 w-6" /></span>
                <span className="min-w-0"><span className="block truncate font-bold text-white">{playlist.name}</span><span className="mt-1 block text-xs text-slate-500">{playlist.item_count} track{playlist.item_count === 1 ? '' : 's'}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

