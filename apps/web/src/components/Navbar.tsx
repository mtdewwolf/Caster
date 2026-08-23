import React from 'react';
import { Film, Search, Settings, Shield, Sparkles, Tv, Music, Clapperboard, History, LockKeyhole, LogOut } from 'lucide-react';
import type { SystemHardwareStatus } from '../types';

export type AppView = 'library' | 'progress';

interface NavbarProps {
  activeType: string;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  onTypeChange: (type: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenSettings: () => void;
  hardware: SystemHardwareStatus | null;
  isScanning: boolean;
  isAdmin: boolean;
  onLogin: () => void;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeType,
  activeView,
  onViewChange,
  onTypeChange,
  searchQuery,
  onSearchChange,
  onOpenSettings,
  hardware,
  isScanning,
  isAdmin,
  onLogin,
  onLogout
}) => {
  return (
    <header className="sticky top-0 z-30 bg-slate-950/80 backdrop-blur-xl border-b border-white/5 px-4 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
      {/* Brand & Main Nav */}
      <div className="flex items-center gap-8">
        <div
          className="flex items-center gap-2.5 cursor-pointer"
          onClick={() => {
            onViewChange('library');
            onTypeChange('');
          }}
        >
          <div className="p-2 bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-400 rounded-xl shadow-lg shadow-blue-500/20 text-white">
            <Clapperboard className="w-5 h-5" />
          </div>
          <div>
            <div className="text-base font-extrabold tracking-tight text-white flex items-center gap-1.5">
              <span>Caster</span>
              <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.2 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded">
                NAS
              </span>
            </div>
          </div>
        </div>

        {/* Categories */}
        <nav className="hidden md:flex items-center gap-1 bg-slate-900/60 p-1 rounded-xl border border-white/5 text-xs font-medium">
          <button
            onClick={() => {
              onViewChange('library');
              onTypeChange('');
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              activeView === 'library' && activeType === ''
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Media
          </button>
          <button
            onClick={() => {
              onViewChange('library');
              onTypeChange('movie');
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${
              activeView === 'library' && activeType === 'movie'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Film className="w-3.5 h-3.5" />
            <span>Movies</span>
          </button>
          <button
            onClick={() => {
              onViewChange('library');
              onTypeChange('episode');
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${
              activeView === 'library' && activeType === 'episode'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Tv className="w-3.5 h-3.5" />
            <span>TV Shows</span>
          </button>
          <button
            onClick={() => {
              onViewChange('library');
              onTypeChange('track');
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${
              activeView === 'library' && activeType === 'track'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Music className="w-3.5 h-3.5" />
            <span>Music</span>
          </button>

          {/* View Divider */}
          <div className="w-px h-5 bg-white/10 mx-1" />

          <button
            onClick={() => onViewChange('progress')}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${
              activeView === 'progress'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Progress</span>
          </button>
        </nav>
      </div>

      {/* Search & Actions */}
      <div className="flex items-center gap-3 flex-1 sm:flex-initial justify-end">
        {/* Search Bar */}
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 transform -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search titles, series..."
            value={searchQuery}
            onChange={(e) => {
              onViewChange('library');
              onSearchChange(e.target.value);
            }}
            className="w-full bg-slate-900/80 border border-white/10 rounded-xl pl-9 pr-4 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
          />
        </div>

        {/* Tailscale Pill */}
        <div
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-emerald-950/40 border border-emerald-500/30 rounded-lg text-emerald-400 text-[11px] font-medium"
          title="Tailscale mesh connection active"
        >
          <Shield className="w-3.5 h-3.5" />
          <span>Tailscale Ready</span>
        </div>

        {/* Hardware Transcoding Pill */}
        {hardware && (
          <div
            className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-blue-950/40 border border-blue-500/30 rounded-lg text-blue-300 text-[11px] font-medium"
            title={`Hardware Transcoder: ${hardware.accelType.toUpperCase()}`}
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
            <span className="uppercase">{hardware.accelType}</span>
          </div>
        )}

        {isAdmin ? (
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-950/40 hover:bg-blue-900/50 border border-blue-500/30 rounded-lg text-blue-300 text-[11px] font-medium transition-colors"
            title="Sign out of admin mode"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Admin</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onLogin}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-white/10 rounded-lg text-slate-300 hover:text-white text-[11px] font-medium transition-colors"
            title="Sign in for admin access"
          >
            <LockKeyhole className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Admin login</span>
          </button>
        )}

        {/* Progress button (mobile only — desktop uses nav pill) */}
        <button
          onClick={() => onViewChange(activeView === 'progress' ? 'library' : 'progress')}
          className={`md:hidden p-2 border rounded-xl transition-colors relative ${
            activeView === 'progress'
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-slate-900 hover:bg-slate-800 border-white/10 text-slate-300 hover:text-white'
          }`}
          title="Watch Progress"
        >
          <History className="w-4 h-4" />
        </button>

        {/* Settings button */}
        <button
          onClick={onOpenSettings}
          className="p-2 bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 hover:text-white rounded-xl transition-colors relative"
          title="Server Settings"
        >
          <Settings className="w-4 h-4" />
          {isScanning && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-blue-500 rounded-full animate-ping" />
          )}
        </button>
      </div>
    </header>
  );
};
