import { describe, expect, it } from 'bun:test';
import type { MediaItem } from '../apps/web/src/types';
import {
  createInitialMusicQueueState,
  createMusicQueueReducer,
  hydrateMusicQueueForUser,
  hydrateMusicQueueState,
  musicQueueStorageKey,
  persistMusicQueueState,
  serializeMusicQueueState,
  type MusicQueueEntry,
  type QueueStorage
} from '../apps/web/src/features/music/queue-reducer';

function track(id: string): MediaItem {
  return {
    id,
    library_id: 'music',
    title: `Track ${id}`,
    original_filename: `${id}.flac`,
    relative_path: `${id}.flac`,
    full_path: `/private/music/${id}.flac`,
    type: 'track',
    duration: 180,
    size_bytes: 1024,
    format: 'flac',
    is_hdr: false,
    streams_json: '[]',
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z'
  };
}

function entry(id: string): MusicQueueEntry {
  return { id: `entry-${id}`, track: track(id) };
}

function queue(...ids: string[]) {
  const reducer = createMusicQueueReducer(() => 0);
  return reducer(createInitialMusicQueueState(), {
    type: 'replace', entries: ids.map(entry)
  });
}

class MemoryStorage implements QueueStorage {
  values = new Map<string, string>();
  removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
    this.removed.push(key);
  }
}

describe('music queue reducer', () => {
  it('advances through off, repeat-one, and repeat-all modes', () => {
    const reducer = createMusicQueueReducer(() => 0);
    let state = queue('a', 'b', 'c');

    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBe('entry-b');
    state = reducer(state, { type: 'set-repeat', repeat: 'one' });
    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBe('entry-b');

    state = reducer(state, { type: 'set-repeat', repeat: 'off' });
    state = reducer(state, { type: 'set-current', entryId: 'entry-c' });
    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBeNull();

    state = reducer(state, { type: 'set-current', entryId: 'entry-c' });
    state = reducer(state, { type: 'set-repeat', repeat: 'all' });
    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBe('entry-a');
  });

  it('allows a replacement queue to remain stopped until advanced', () => {
    const reducer = createMusicQueueReducer(() => 0);
    let state = reducer(createInitialMusicQueueState(), {
      type: 'replace', entries: [entry('a'), entry('b')], currentEntryId: null
    });
    expect(state.currentEntryId).toBeNull();
    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBe('entry-a');
  });

  it('uses deterministic shuffled playback while keeping the current entry anchored', () => {
    const samples = [0.5, 0];
    const reducer = createMusicQueueReducer(() => samples.shift() ?? 0);
    let state = queue('a', 'b', 'c', 'd');
    state = reducer(state, { type: 'set-current', entryId: 'entry-b' });
    state = reducer(state, { type: 'toggle-shuffle', enabled: true });

    expect(state.shuffle).toBe(true);
    expect(state.shuffleOrder).toEqual(['entry-b', 'entry-d', 'entry-a', 'entry-c']);
    state = reducer(state, { type: 'advance' });
    expect(state.currentEntryId).toBe('entry-d');

    state = reducer(state, { type: 'toggle-shuffle', enabled: false });
    expect(state.shuffleOrder).toEqual(['entry-a', 'entry-b', 'entry-c', 'entry-d']);
  });

  it('selects the successor when removing the current entry', () => {
    const reducer = createMusicQueueReducer(() => 0);
    let state = queue('a', 'b', 'c');
    state = reducer(state, { type: 'set-current', entryId: 'entry-b' });
    state = reducer(state, { type: 'remove', entryId: 'entry-b' });
    expect(state.entries.map((item) => item.id)).toEqual(['entry-a', 'entry-c']);
    expect(state.currentEntryId).toBe('entry-c');

    state = reducer(state, { type: 'remove', entryId: 'entry-c' });
    expect(state.currentEntryId).toBeNull();

    state = reducer(state, { type: 'set-current', entryId: 'entry-a' });
    state = reducer(state, { type: 'set-repeat', repeat: 'all' });
    state = reducer(state, { type: 'remove', entryId: 'entry-a' });
    expect(state.currentEntryId).toBeNull();
  });

  it('reorders natural playback without disturbing shuffled playback order', () => {
    const reducer = createMusicQueueReducer(() => 0);
    let state = queue('a', 'b', 'c');
    state = reducer(state, { type: 'reorder', entryId: 'entry-c', toIndex: 0 });
    expect(state.entries.map((item) => item.id)).toEqual(['entry-c', 'entry-a', 'entry-b']);
    expect(state.shuffleOrder).toEqual(['entry-c', 'entry-a', 'entry-b']);

    state = reducer(state, { type: 'toggle-shuffle', enabled: true });
    const playbackOrder = state.shuffleOrder;
    state = reducer(state, { type: 'reorder', entryId: 'entry-b', toIndex: 0 });
    expect(state.entries.map((item) => item.id)).toEqual(['entry-b', 'entry-c', 'entry-a']);
    expect(state.shuffleOrder).toEqual(playbackOrder);
  });
});

describe('music queue persistence', () => {
  it('round-trips per user without persisting full_path', () => {
    const storage = new MemoryStorage();
    const state = queue('a', 'b');
    persistMusicQueueState(storage, 'user/name', state);

    const key = musicQueueStorageKey('user/name');
    expect(key).toBe('caster:music-queue:v1:user%2Fname');
    expect(storage.values.get(key)).not.toContain('full_path');
    expect(storage.values.get(key)).not.toContain('/private/music');

    const hydrated = hydrateMusicQueueForUser(storage, 'user/name');
    expect(hydrated).toEqual(state);
    expect(hydrated?.entries[0].track.full_path).toBeUndefined();
    expect(hydrateMusicQueueForUser(storage, 'different-user')).toBeNull();
  });

  it('strips an injected path and rejects corrupt persisted structures', () => {
    const serialized = serializeMusicQueueState(queue('a'));
    const injected = JSON.parse(serialized);
    injected.entries[0].track.full_path = '/server/secret.flac';
    const hydrated = hydrateMusicQueueState(JSON.stringify(injected));
    expect(hydrated?.entries[0].track.full_path).toBeUndefined();

    const corruptStates = [
      '{not-json',
      JSON.stringify({ ...JSON.parse(serialized), version: 2 }),
      JSON.stringify({ ...JSON.parse(serialized), currentEntryId: 'missing' }),
      JSON.stringify({ ...JSON.parse(serialized), shuffleOrder: [] }),
      JSON.stringify({
        ...JSON.parse(serialized),
        entries: [JSON.parse(serialized).entries[0], JSON.parse(serialized).entries[0]]
      }),
      JSON.stringify({
        ...JSON.parse(serialized),
        entries: [{ id: 'entry-a', track: { id: 'a', type: 'track' } }]
      })
    ];
    for (const corrupt of corruptStates) {
      expect(hydrateMusicQueueState(corrupt)).toBeNull();
    }
  });

  it('evicts corrupt user state from storage', () => {
    const storage = new MemoryStorage();
    const key = musicQueueStorageKey('alice');
    storage.values.set(key, JSON.stringify({ version: 1, entries: 'bad' }));
    expect(hydrateMusicQueueForUser(storage, 'alice')).toBeNull();
    expect(storage.values.has(key)).toBe(false);
    expect(storage.removed).toEqual([key]);
  });
});
