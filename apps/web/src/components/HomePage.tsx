import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, AlertTriangle } from 'lucide-react';
import type { MediaItem } from '../types';
import { api } from '../api';
import { MediaCard } from './MediaCard';
import { describeError } from './Toaster';

export interface HomeRows {
  continueWatching: MediaItem[];
  nextUp: MediaItem[];
  recentlyAdded: MediaItem[];
  recentlyWatched: MediaItem[];
}

/**
 * Row order is the order a person is most likely to want something: finish what
 * you started, then the next episode, then what is new, then what you finished.
 */
const ROW_ORDER: ReadonlyArray<{ key: keyof HomeRows; title: string; blurb: string }> = [
  { key: 'continueWatching', title: 'Continue watching', blurb: 'Pick up where you stopped' },
  { key: 'nextUp', title: 'Next up', blurb: 'The next episode in shows you are watching' },
  { key: 'recentlyAdded', title: 'Recently added', blurb: 'New in your libraries' },
  { key: 'recentlyWatched', title: 'Recently watched', blurb: 'Finished recently' }
];

const EMPTY_ROWS: HomeRows = {
  continueWatching: [],
  nextUp: [],
  recentlyAdded: [],
  recentlyWatched: []
};

interface MediaRowProps {
  title: string;
  blurb: string;
  items: MediaItem[];
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
}

function MediaRow({ title, blurb, items, onPlay, onSelect }: MediaRowProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const headingId = `home-row-${title.replace(/\s+/g, '-').toLowerCase()}`;

  const scrollBy = (direction: -1 | 1) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollBy({ left: direction * Math.max(240, element.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id={headingId} className="text-lg font-bold tracking-tight text-white">{title}</h2>
          <p className="text-xs text-slate-500">{blurb}</p>
        </div>
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label={`Scroll ${title} left`}
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label={`Scroll ${title} right`}
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2"
      >
        {items.map((item) => (
          <div key={item.id} className="w-36 shrink-0 snap-start sm:w-44">
            <MediaCard item={item} onPlay={onPlay} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </section>
  );
}

interface HomePageProps {
  refreshToken: number;
  onPlay: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  onBrowseLibrary: () => void;
}

export const HomePage: React.FC<HomePageProps> = ({
  refreshToken,
  onPlay,
  onSelect,
  onBrowseLibrary
}) => {
  const [rows, setRows] = useState<HomeRows>(EMPTY_ROWS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getHomeRows()
      .then((next) => { if (!cancelled) setRows(next); })
      .catch((caught) => {
        if (cancelled) return;
        setRows(EMPTY_ROWS);
        setError(describeError(caught, 'The server did not respond.'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [refreshToken, reloadToken]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-500">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-500" aria-hidden="true" />
        <span className="text-xs">Building your home view…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-lg flex-col items-center justify-center rounded-2xl border border-dashed border-rose-500/30 bg-rose-950/20 p-8 py-20 text-center"
      >
        <div className="mb-3 rounded-full bg-rose-500/10 p-4 text-rose-400">
          <AlertTriangle className="h-8 w-8" aria-hidden="true" />
        </div>
        <h3 className="mb-1 text-base font-bold text-white">Could not build your home view</h3>
        <p className="mb-4 max-w-xs text-xs leading-relaxed text-rose-200/80">{error}</p>
        <button
          type="button"
          onClick={() => setReloadToken((token) => token + 1)}
          className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-rose-500"
        >
          Try again
        </button>
      </div>
    );
  }

  const populated = ROW_ORDER.filter(({ key }) => rows[key].length > 0);

  if (populated.length === 0) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-8 py-20 text-center">
        <h3 className="mb-1 text-base font-bold text-white">Nothing here yet</h3>
        <p className="mb-4 max-w-xs text-xs leading-relaxed text-slate-400">
          Once you scan a library and start watching, your home view fills in with what to
          play next.
        </p>
        <button
          type="button"
          onClick={onBrowseLibrary}
          className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-blue-500"
        >
          Browse the library
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {populated.map(({ key, title, blurb }) => (
        <MediaRow
          key={key}
          title={title}
          blurb={blurb}
          items={rows[key]}
              onPlay={onPlay}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};
