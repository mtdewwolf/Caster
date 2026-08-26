import React, { useState } from 'react';
import { Search, RefreshCw, Unlink, Star, Lock, ChevronDown, ChevronUp } from 'lucide-react';
import type { MediaMetadata, MetadataCandidate } from '../types';
import { api } from '../api';
import { describeError, useToast } from './Toaster';

/** Picks the best artwork of a kind, preferring the widest image available. */
export function pickArtwork(metadata: MediaMetadata | null, kind: string): string | null {
  if (!metadata) return null;
  const matches = metadata.artwork.filter((art) => art.kind === kind);
  if (matches.length === 0) return null;
  const best = matches.reduce((widest, art) =>
    (art.width ?? 0) > (widest.width ?? 0) ? art : widest);
  return best.url;
}

function formatReleaseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function directorsOf(metadata: MediaMetadata): string[] {
  return metadata.crew
    .filter((person) => (person.role ?? '').toLowerCase() === 'director')
    .map((person) => person.name);
}

interface CandidateListProps {
  mediaId: string;
  onApplied: (metadata: MediaMetadata | null) => void;
  onDone: () => void;
}

function FixMatch({ mediaId, onApplied, onDone }: CandidateListProps) {
  const { notify } = useToast();
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<MetadataCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const runSearch = async () => {
    setBusy(true);
    try {
      setCandidates(await api.getMetadataCandidates(mediaId, query || undefined));
    } catch (error) {
      notify({
        title: 'Could not search for matches',
        description: describeError(error, 'The metadata provider did not respond.'),
        tone: 'error'
      });
    } finally {
      setBusy(false);
    }
  };

  const choose = async (candidate: MetadataCandidate) => {
    setBusy(true);
    try {
      onApplied(await api.applyMetadataMatch(mediaId, candidate));
      notify({ title: `Matched to “${candidate.title}”`, tone: 'success' });
      onDone();
    } catch (error) {
      notify({
        title: 'Could not apply that match',
        description: describeError(error, 'The metadata provider did not respond.'),
        tone: 'error'
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="fix-match-query">Search for the correct title</label>
        <input
          id="fix-match-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
          placeholder="Search by title…"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          Search
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          Cancel
        </button>
      </div>

      {candidates?.length === 0 && (
        <p className="text-xs text-slate-400">No matches found. Try a different title.</p>
      )}

      {candidates && candidates.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {candidates.map((candidate) => (
            <li key={`${candidate.providerId}:${candidate.externalId}`}>
              <button
                type="button"
                onClick={() => void choose(candidate)}
                disabled={busy}
                className="flex w-full items-start gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
              >
                {candidate.poster?.url && (
                  <img
                    src={candidate.poster.url}
                    alt=""
                    className="h-16 w-11 shrink-0 rounded object-cover"
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-white">
                    {candidate.title}
                    {candidate.year ? <span className="ml-1.5 font-normal text-slate-400">{candidate.year}</span> : null}
                  </span>
                  {candidate.overview && (
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-slate-400">
                      {candidate.overview}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface MetadataPanelProps {
  mediaId: string;
  metadata: MediaMetadata | null;
  onChange: (metadata: MediaMetadata | null) => void;
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  mediaId,
  metadata,
  onChange
}) => {
  const { notify } = useToast();
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showFullCast, setShowFullCast] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      const result = await api.refreshMetadata(mediaId);
      onChange(result.metadata);

      if (result.status === 'matched') {
        notify({ title: 'Metadata refreshed', tone: 'success' });
      } else if (result.status === 'disabled') {
        notify({
          title: 'No metadata provider is set up',
          description: 'Add a provider access token to the server to enable lookups.',
          tone: 'info'
        });
      } else if (result.status === 'ambiguous') {
        notify({
          title: 'More than one close match',
          description: 'Use Fix match to choose the right one.',
          tone: 'info'
        });
      } else {
        notify({
          title: 'No match found',
          description: result.message ?? 'Try Fix match to search by a different title.',
          tone: 'info'
        });
      }
    } catch (error) {
      notify({
        title: 'Could not refresh metadata',
        description: describeError(error, 'The metadata provider did not respond.'),
        tone: 'error'
      });
    } finally {
      setBusy(false);
    }
  };

  const unmatch = async () => {
    setBusy(true);
    try {
      await api.clearMetadata(mediaId);
      onChange(null);
      notify({ title: 'Match removed', tone: 'success' });
    } catch (error) {
      notify({
        title: 'Could not remove the match',
        description: describeError(error, 'The server did not respond.'),
        tone: 'error'
      });
    } finally {
      setBusy(false);
    }
  };

  const directors = metadata ? directorsOf(metadata) : [];
  const releaseDate = formatReleaseDate(metadata?.releaseDate ?? null);
  const visibleCast = metadata ? (showFullCast ? metadata.cast : metadata.cast.slice(0, 8)) : [];

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setFixing((open) => !open)}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        Fix match
      </button>
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
        Refresh
      </button>
      {metadata && (
        <button
          type="button"
          onClick={() => void unmatch()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-rose-300 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
          Unmatch
        </button>
      )}
    </div>
  );

  if (!metadata) {
    return (
      <section className="space-y-3 rounded-xl border border-white/5 bg-slate-950/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            No description or artwork has been matched to this title yet.
          </p>
          {controls}
        </div>
        {fixing && (
          <FixMatch mediaId={mediaId} onApplied={onChange} onDone={() => setFixing(false)} />
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {metadata.tagline && (
            <p className="text-sm italic text-slate-400">“{metadata.tagline}”</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            {releaseDate && <span>{releaseDate}</span>}
            {metadata.contentRating && (
              <span className="rounded border border-white/15 px-1.5 py-0.5 font-semibold text-slate-300">
                {metadata.contentRating}
              </span>
            )}
            {metadata.rating !== null && (
              <span className="flex items-center gap-1 text-amber-300">
                <Star className="h-3.5 w-3.5 fill-amber-300" aria-hidden="true" />
                <span className="font-semibold tabular-nums">{metadata.rating.toFixed(1)}</span>
              </span>
            )}
            {metadata.locked && (
              <span
                className="flex items-center gap-1 text-slate-500"
                title="Matched by hand. Automatic updates will not change it."
              >
                <Lock className="h-3 w-3" aria-hidden="true" />
                Set manually
              </span>
            )}
          </div>
        </div>
        {controls}
      </div>

      {fixing && (
        <FixMatch mediaId={mediaId} onApplied={onChange} onDone={() => setFixing(false)} />
      )}

      {metadata.overview && (
        <p className="max-w-prose text-sm leading-relaxed text-slate-300">{metadata.overview}</p>
      )}

      {metadata.genres.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {metadata.genres.map((genre) => (
            <li
              key={genre}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-slate-300"
            >
              {genre}
            </li>
          ))}
        </ul>
      )}

      {(directors.length > 0 || metadata.studios.length > 0 || metadata.networks.length > 0) && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          {directors.length > 0 && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-slate-500">Director</dt>
              <dd className="text-slate-300">{directors.join(', ')}</dd>
            </div>
          )}
          {metadata.studios.length > 0 && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-slate-500">Studio</dt>
              <dd className="text-slate-300">{metadata.studios.join(', ')}</dd>
            </div>
          )}
          {metadata.networks.length > 0 && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-slate-500">Network</dt>
              <dd className="text-slate-300">{metadata.networks.join(', ')}</dd>
            </div>
          )}
        </dl>
      )}

      {metadata.cast.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Cast</h3>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {visibleCast.map((person, index) => (
              <li key={`${person.name}-${index}`} className="min-w-0">
                <span className="block truncate font-medium text-slate-200">{person.name}</span>
                {person.character && (
                  <span className="block truncate text-slate-500">{person.character}</span>
                )}
              </li>
            ))}
          </ul>
          {metadata.cast.length > 8 && (
            <button
              type="button"
              onClick={() => setShowFullCast((open) => !open)}
              className="flex items-center gap-1 text-xs font-semibold text-blue-400 transition-colors hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              {showFullCast ? (
                <><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> Show fewer</>
              ) : (
                <><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> Show all {metadata.cast.length}</>
              )}
            </button>
          )}
        </div>
      )}
    </section>
  );
};
