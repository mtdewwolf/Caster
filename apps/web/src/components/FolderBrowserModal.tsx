import React, { useState, useEffect, useMemo } from 'react';
import { X, Folder, ChevronRight, ArrowUp, RefreshCw, Film, CornerDownLeft } from 'lucide-react';
import type { BrowseResult } from '../types';
import { api } from '../api';

interface FolderBrowserModalProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export const FolderBrowserModal: React.FC<FolderBrowserModalProps> = ({ initialPath, onSelect, onClose }) => {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath || '');
  const [selectedPath, setSelectedPath] = useState<string>(initialPath || '');

  const loadDirectory = async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browseFilesystem(target || undefined);
      setBrowse(result);
      setPathInput(result.current || '');
      setSelectedPath(target || '');
    } catch (err: any) {
      setError(err.message || 'Failed to browse folder');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDirectory(initialPath || undefined);
  }, []);

  const breadcrumb = useMemo(() => {
    if (!browse || !browse.current) return [];
    const current = browse.current;
    const sep = current.includes('\\') ? '\\' : '/';
    const parts = current.split(/[\\/]/).filter(Boolean);
    let acc = '';
    return parts.map((part, index) => {
      if (index === 0) {
        acc = part.endsWith(':') ? `${part}${sep}` : `${sep}${part}`;
      } else {
        acc = `${acc}${sep}${part}`;
      }
      return { name: part, path: acc };
    });
  }, [browse]);

  const handleUseFolder = () => {
    const chosen = selectedPath || browse?.current;
    if (!chosen) return;
    onSelect(chosen);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-xl bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-slate-950/50">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Folder className="w-4 h-4 text-blue-400" />
            <span>Browse Server Folders</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Path bar */}
        <div className="px-5 py-3 space-y-2 border-b border-white/5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadDirectory('')}
              className="px-2 py-1.5 text-[11px] text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors shrink-0"
              title="Back to root devices"
            >
              Root
            </button>
            <button
              onClick={() => {
                if (browse?.parent) loadDirectory(browse.parent);
              }}
              disabled={!browse?.parent}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors shrink-0"
              title="Parent folder"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pathInput.trim()) loadDirectory(pathInput.trim());
              }}
              className="flex-1 min-w-0"
            >
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="/mnt/user/media"
                className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-blue-500"
              />
            </form>
          </div>

          {breadcrumb.length > 0 && (
            <div className="flex items-center flex-wrap gap-0.5 text-[11px] text-slate-400">
              <button onClick={() => loadDirectory('')} className="hover:text-blue-300">
                Devices
              </button>
              {breadcrumb.map((segment) => (
                <React.Fragment key={segment.path}>
                  <ChevronRight className="w-3 h-3 text-slate-600" />
                  <button
                    onClick={() => loadDirectory(segment.path)}
                    className={`hover:text-blue-300 ${segment.path === browse?.current ? 'text-blue-400 font-semibold' : ''}`}
                  >
                    {segment.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 min-h-[220px]">
          {error && <div className="text-xs text-rose-400 py-2">{error}</div>}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-slate-500 text-xs gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Loading folders...</span>
            </div>
          ) : browse && browse.entries.length > 0 ? (
            <div className="space-y-1">
              {browse.entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => {
                    setSelectedPath(entry.path);
                    loadDirectory(entry.path);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                    selectedPath === entry.path
                      ? 'bg-blue-600/20 border border-blue-500/50 text-blue-100'
                      : 'border border-transparent hover:bg-white/5 text-slate-300'
                  }`}
                >
                  <Folder className={`w-4 h-4 shrink-0 ${entry.hasMedia ? 'text-amber-400' : 'text-slate-500'}`} />
                  <span className="text-xs font-medium truncate flex-1">{entry.name}</span>
                  {entry.hasMedia && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 border border-emerald-500/20 rounded-full flex items-center gap-1 shrink-0">
                      <Film className="w-2.5 h-2.5" />
                      Media
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : browse ? (
            <div className="text-center py-8 text-slate-500 text-xs">No subfolders here.</div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-white/10 bg-slate-950/50">
          <div className="font-mono text-[11px] text-slate-400 truncate max-w-xs" title={selectedPath || browse?.current}>
            {selectedPath || browse?.current || 'No folder selected'}
          </div>
          <button
            onClick={handleUseFolder}
            disabled={!selectedPath && !browse?.current}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium rounded-lg text-xs transition-colors flex items-center gap-1.5 shrink-0"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
            <span>Use This Folder</span>
          </button>
        </div>
      </div>
    </div>
  );
};
