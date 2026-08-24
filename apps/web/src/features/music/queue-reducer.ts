import type { MediaItem } from '../../types';

export const MUSIC_QUEUE_VERSION = 1 as const;
export const MUSIC_QUEUE_STORAGE_PREFIX = 'caster:music-queue:v1';

export type MusicQueueRepeat = 'off' | 'all' | 'one';

export interface MusicQueueEntry {
  id: string;
  track: MediaItem;
}

export interface MusicQueueState {
  version: typeof MUSIC_QUEUE_VERSION;
  entries: MusicQueueEntry[];
  currentEntryId: string | null;
  repeat: MusicQueueRepeat;
  shuffle: boolean;
  /** Entry IDs in playback order. Always an exact permutation of entries. */
  shuffleOrder: string[];
}

export type MusicQueueAction =
  | { type: 'replace'; entries: MusicQueueEntry[]; currentEntryId?: string | null }
  | { type: 'append'; entries: MusicQueueEntry[] }
  | { type: 'remove'; entryId: string }
  | { type: 'reorder'; entryId: string; toIndex: number }
  | { type: 'set-current'; entryId: string | null }
  | { type: 'set-repeat'; repeat: MusicQueueRepeat }
  | { type: 'toggle-shuffle'; enabled?: boolean }
  | { type: 'advance' };

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type QueueRandomSource = () => number;
export type MusicQueueReducer = (
  state: MusicQueueState,
  action: MusicQueueAction
) => MusicQueueState;

const MEDIA_TYPES = new Set(['movie', 'episode', 'track', 'video']);

export function createInitialMusicQueueState(): MusicQueueState {
  return {
    version: MUSIC_QUEUE_VERSION,
    entries: [],
    currentEntryId: null,
    repeat: 'off',
    shuffle: false,
    shuffleOrder: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalValueIs(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean
): boolean {
  return record[key] === undefined || predicate(record[key]);
}

function isWatchProgress(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.user_id === 'string'
    && typeof value.media_id === 'string'
    && isFiniteNumber(value.position_seconds)
    && isFiniteNumber(value.duration_seconds)
    && isFiniteNumber(value.progress_percent)
    && typeof value.completed === 'boolean'
    && typeof value.last_watched_at === 'string';
}

function isPersistedMediaItem(value: unknown): value is MediaItem {
  if (!isRecord(value)) return false;

  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.library_id === 'string'
    && typeof value.title === 'string'
    && typeof value.original_filename === 'string'
    && typeof value.relative_path === 'string'
    && typeof value.type === 'string' && MEDIA_TYPES.has(value.type)
    && isFiniteNumber(value.duration) && value.duration >= 0
    && isFiniteNumber(value.size_bytes) && value.size_bytes >= 0
    && typeof value.format === 'string'
    && typeof value.is_hdr === 'boolean'
    && typeof value.streams_json === 'string'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && optionalValueIs(value, 'series_title', (item) => typeof item === 'string')
    && optionalValueIs(value, 'season_number', isFiniteNumber)
    && optionalValueIs(value, 'episode_number', isFiniteNumber)
    && optionalValueIs(value, 'year', isFiniteNumber)
    && optionalValueIs(value, 'video_codec', (item) => typeof item === 'string')
    && optionalValueIs(value, 'width', isFiniteNumber)
    && optionalValueIs(value, 'height', isFiniteNumber)
    && optionalValueIs(value, 'resolution_label', (item) => typeof item === 'string')
    && optionalValueIs(value, 'frame_rate', isFiniteNumber)
    && optionalValueIs(value, 'bit_rate', isFiniteNumber)
    && optionalValueIs(value, 'audio_codec', (item) => typeof item === 'string')
    && optionalValueIs(value, 'audio_channels', isFiniteNumber)
    && optionalValueIs(value, 'audio_channel_layout', (item) => typeof item === 'string')
    && optionalValueIs(value, 'audio_language', (item) => typeof item === 'string')
    && optionalValueIs(value, 'poster_path', (item) => typeof item === 'string')
    && optionalValueIs(value, 'library_name', (item) => typeof item === 'string')
    && optionalValueIs(value, 'progress', isWatchProgress);
}

/** Never retain an administrator-only server path in queue or persisted state. */
function withoutFullPath(track: MediaItem): MediaItem {
  const { full_path: _fullPath, ...safeTrack } = track;
  return safeTrack;
}

function normalizeEntries(entries: MusicQueueEntry[]): MusicQueueEntry[] {
  const seen = new Set<string>();
  const normalized: MusicQueueEntry[] = [];
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push({ id: entry.id, track: withoutFullPath(entry.track) });
  }
  return normalized;
}

function naturalOrder(entries: readonly MusicQueueEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

export function shuffleEntryIds(
  entryIds: readonly string[],
  random: QueueRandomSource = Math.random
): string[] {
  const shuffled = [...entryIds];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError('Queue random source must return a number in [0, 1)');
    }
    const swapIndex = Math.floor(sample * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function shuffledOrder(
  entries: readonly MusicQueueEntry[],
  currentEntryId: string | null,
  random: QueueRandomSource
): string[] {
  const ids = naturalOrder(entries);
  if (!currentEntryId || !ids.includes(currentEntryId)) {
    return shuffleEntryIds(ids, random);
  }
  return [
    currentEntryId,
    ...shuffleEntryIds(ids.filter((id) => id !== currentEntryId), random)
  ];
}

function validPlaybackOrder(state: MusicQueueState): string[] {
  const ids = naturalOrder(state.entries);
  if (!state.shuffle) return ids;

  const known = new Set(ids);
  const order = state.shuffleOrder.filter((id, index, all) => (
    known.has(id) && all.indexOf(id) === index
  ));
  for (const id of ids) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

function advance(state: MusicQueueState): MusicQueueState {
  const order = validPlaybackOrder(state);
  if (order.length === 0) return { ...state, currentEntryId: null };
  if (state.repeat === 'one' && state.currentEntryId && order.includes(state.currentEntryId)) {
    return state;
  }
  if (state.currentEntryId === null || !order.includes(state.currentEntryId)) {
    return { ...state, currentEntryId: order[0] };
  }

  const currentIndex = order.indexOf(state.currentEntryId);
  if (currentIndex < order.length - 1) {
    return { ...state, currentEntryId: order[currentIndex + 1] };
  }
  return {
    ...state,
    currentEntryId: state.repeat === 'all' ? order[0] : null
  };
}

export function createMusicQueueReducer(
  random: QueueRandomSource = Math.random
): MusicQueueReducer {
  return (state, action) => {
    switch (action.type) {
      case 'replace': {
        const entries = normalizeEntries(action.entries);
        const requestedCurrent = action.currentEntryId === undefined
          ? entries[0]?.id ?? null
          : action.currentEntryId;
        const currentEntryId = requestedCurrent === null
          ? null
          : entries.some((entry) => entry.id === requestedCurrent)
            ? requestedCurrent
            : entries[0]?.id ?? null;
        return {
          ...state,
          version: MUSIC_QUEUE_VERSION,
          entries,
          currentEntryId,
          shuffleOrder: state.shuffle
            ? shuffledOrder(entries, currentEntryId, random)
            : naturalOrder(entries)
        };
      }

      case 'append': {
        const existingIds = new Set(state.entries.map((entry) => entry.id));
        const appended = normalizeEntries(action.entries).filter((entry) => !existingIds.has(entry.id));
        if (appended.length === 0) return state;
        const entries = [...state.entries, ...appended];
        return {
          ...state,
          entries,
          shuffleOrder: state.shuffle
            ? [...validPlaybackOrder(state), ...shuffleEntryIds(naturalOrder(appended), random)]
            : naturalOrder(entries)
        };
      }

      case 'remove': {
        const removedIndex = state.entries.findIndex((entry) => entry.id === action.entryId);
        if (removedIndex < 0) return state;
        const oldOrder = validPlaybackOrder(state);
        const oldPlaybackIndex = oldOrder.indexOf(action.entryId);
        const entries = state.entries.filter((entry) => entry.id !== action.entryId);
        const nextOrder = oldOrder.filter((id) => id !== action.entryId);
        let currentEntryId = state.currentEntryId;
        if (currentEntryId === action.entryId) {
          currentEntryId = oldPlaybackIndex >= 0 && oldPlaybackIndex < nextOrder.length
            ? nextOrder[oldPlaybackIndex]
            : state.repeat === 'all' ? nextOrder[0] ?? null : null;
        }
        return {
          ...state,
          entries,
          currentEntryId,
          shuffleOrder: state.shuffle ? nextOrder : naturalOrder(entries)
        };
      }

      case 'reorder': {
        const fromIndex = state.entries.findIndex((entry) => entry.id === action.entryId);
        if (fromIndex < 0 || !Number.isInteger(action.toIndex) || state.entries.length < 2) return state;
        const toIndex = Math.max(0, Math.min(state.entries.length - 1, action.toIndex));
        if (fromIndex === toIndex) return state;
        const entries = [...state.entries];
        const [entry] = entries.splice(fromIndex, 1);
        entries.splice(toIndex, 0, entry);
        return {
          ...state,
          entries,
          shuffleOrder: state.shuffle ? validPlaybackOrder(state) : naturalOrder(entries)
        };
      }

      case 'set-current':
        return action.entryId === null || state.entries.some((entry) => entry.id === action.entryId)
          ? { ...state, currentEntryId: action.entryId }
          : state;

      case 'set-repeat':
        return state.repeat === action.repeat ? state : { ...state, repeat: action.repeat };

      case 'toggle-shuffle': {
        const shuffle = action.enabled ?? !state.shuffle;
        if (shuffle === state.shuffle) return state;
        return {
          ...state,
          shuffle,
          shuffleOrder: shuffle
            ? shuffledOrder(state.entries, state.currentEntryId, random)
            : naturalOrder(state.entries)
        };
      }

      case 'advance':
        return advance(state);
    }
  };
}

export const musicQueueReducer = createMusicQueueReducer();

function validatedPersistedState(value: unknown): MusicQueueState | null {
  if (!isRecord(value)
    || value.version !== MUSIC_QUEUE_VERSION
    || !Array.isArray(value.entries)
    || (value.currentEntryId !== null && typeof value.currentEntryId !== 'string')
    || (value.repeat !== 'off' && value.repeat !== 'all' && value.repeat !== 'one')
    || typeof value.shuffle !== 'boolean'
    || !Array.isArray(value.shuffleOrder)
    || value.shuffleOrder.some((id) => typeof id !== 'string')) {
    return null;
  }

  const entries: MusicQueueEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of value.entries) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || candidate.id.length === 0
      || ids.has(candidate.id)
      || !isPersistedMediaItem(candidate.track)) {
      return null;
    }
    ids.add(candidate.id);
    entries.push({ id: candidate.id, track: withoutFullPath(candidate.track) });
  }

  if (value.currentEntryId !== null && !ids.has(value.currentEntryId)) return null;
  const shuffleOrder = value.shuffleOrder as string[];
  if (shuffleOrder.length !== entries.length
    || new Set(shuffleOrder).size !== shuffleOrder.length
    || shuffleOrder.some((id) => !ids.has(id))) {
    return null;
  }

  return {
    version: MUSIC_QUEUE_VERSION,
    entries,
    currentEntryId: value.currentEntryId,
    repeat: value.repeat,
    shuffle: value.shuffle,
    shuffleOrder: [...shuffleOrder]
  };
}

export function serializeMusicQueueState(state: MusicQueueState): string {
  const safeState = {
    ...state,
    version: MUSIC_QUEUE_VERSION,
    entries: state.entries.map((entry) => ({
      id: entry.id,
      track: withoutFullPath(entry.track)
    }))
  };
  if (!validatedPersistedState(safeState)) {
    throw new TypeError('Cannot serialize an invalid music queue state');
  }
  return JSON.stringify(safeState);
}

export function hydrateMusicQueueState(serialized: string): MusicQueueState | null {
  try {
    return validatedPersistedState(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function musicQueueStorageKey(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) throw new TypeError('userId must not be empty');
  return `${MUSIC_QUEUE_STORAGE_PREFIX}:${encodeURIComponent(normalized)}`;
}

export function persistMusicQueueState(
  storage: QueueStorage,
  userId: string,
  state: MusicQueueState
): void {
  storage.setItem(musicQueueStorageKey(userId), serializeMusicQueueState(state));
}

export function hydrateMusicQueueForUser(
  storage: QueueStorage,
  userId: string
): MusicQueueState | null {
  const key = musicQueueStorageKey(userId);
  const serialized = storage.getItem(key);
  if (serialized === null) return null;
  const state = hydrateMusicQueueState(serialized);
  if (!state) storage.removeItem(key);
  return state;
}

export function clearPersistedMusicQueue(storage: QueueStorage, userId: string): void {
  storage.removeItem(musicQueueStorageKey(userId));
}
