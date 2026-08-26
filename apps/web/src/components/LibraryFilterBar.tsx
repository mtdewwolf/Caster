import React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

export type WatchedFilter = 'all' | 'unwatched' | 'in_progress' | 'watched';

export interface LibraryFilters {
  resolution: string;
  genre: string;
  watched: WatchedFilter;
  hdrOnly: boolean;
  sort: string;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  resolution: '',
  genre: '',
  watched: 'all',
  hdrOnly: false,
  sort: 'added'
};

/** Mirrors MEDIA_SORT_OPTIONS on the server; keep the two lists in step. */
export const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'added', label: 'Recently added' },
  { value: 'oldest', label: 'Oldest added' },
  { value: 'title', label: 'Title (A–Z)' },
  { value: 'title_desc', label: 'Title (Z–A)' },
  { value: 'year', label: 'Newest release' },
  { value: 'year_asc', label: 'Oldest release' },
  { value: 'duration', label: 'Longest' },
  { value: 'duration_asc', label: 'Shortest' },
  { value: 'size', label: 'Largest file' }
];

const WATCHED_OPTIONS: ReadonlyArray<{ value: WatchedFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'unwatched', label: 'Unwatched' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'watched', label: 'Watched' }
];

const RESOLUTIONS = ['4K', '1080p', '720p'];

export function countActiveFilters(filters: LibraryFilters): number {
  let active = 0;
  if (filters.resolution) active += 1;
  if (filters.genre) active += 1;
  if (filters.watched !== 'all') active += 1;
  if (filters.hdrOnly) active += 1;
  return active;
}

const selectClass =
  'appearance-none rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 pr-7 text-xs ' +
  'text-slate-200 transition-colors hover:border-white/20 focus:border-blue-500 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-blue-500/60';

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

interface LibraryFilterBarProps {
  filters: LibraryFilters;
  genres: string[];
  shownCount: number;
  totalCount: number;
  onChange: (filters: LibraryFilters) => void;
}

export function LibraryFilterBar({
  filters,
  genres,
  shownCount,
  totalCount,
  onChange
}: LibraryFilterBarProps) {
  const activeCount = countActiveFilters(filters);

  const update = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="flex flex-col gap-3 border-b border-white/5 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-1.5 text-slate-400">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs font-semibold">Filter</span>
          </span>

          <Field label="Sort">
            <select
              value={filters.sort}
              onChange={(event) => update('sort', event.target.value)}
              className={selectClass}
              aria-label="Sort library by"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Status">
            <select
              value={filters.watched}
              onChange={(event) => update('watched', event.target.value as WatchedFilter)}
              className={selectClass}
              aria-label="Filter by watched status"
            >
              {WATCHED_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>

          {genres.length > 0 && (
            <Field label="Genre">
              <select
                value={filters.genre}
                onChange={(event) => update('genre', event.target.value)}
                className={selectClass}
                aria-label="Filter by genre"
              >
                <option value="">Any genre</option>
                {genres.map((genre) => (
                  <option key={genre} value={genre}>{genre}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Quality">
            <span className="flex items-center gap-1">
              {['', ...RESOLUTIONS].map((resolution) => (
                <button
                  key={resolution || 'any'}
                  type="button"
                  onClick={() => update('resolution', resolution)}
                  aria-pressed={filters.resolution === resolution}
                  className={`rounded-lg px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                    filters.resolution === resolution
                      ? 'bg-blue-600 font-semibold text-white'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {resolution || 'Any'}
                </button>
              ))}
              <button
                type="button"
                onClick={() => update('hdrOnly', !filters.hdrOnly)}
                aria-pressed={filters.hdrOnly}
                className={`rounded-lg px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                  filters.hdrOnly
                    ? 'bg-amber-600 font-semibold text-amber-50'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                HDR
              </button>
            </span>
          </Field>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_LIBRARY_FILTERS, sort: filters.sort })}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
            </button>
          )}
        </div>

        <div className="text-xs text-slate-400" aria-live="polite">
          Showing <span className="font-semibold text-slate-200">{shownCount}</span>
          {' of '}
          <span className="font-semibold text-slate-200">{totalCount}</span> item{totalCount === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  );
}
