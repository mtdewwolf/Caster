import React, { useState, useEffect } from 'react';
import { X, FolderPlus, Trash2, RefreshCw, Cpu, Shield, ExternalLink, HardDrive, CheckCircle } from 'lucide-react';
import type { Library, SystemHardwareStatus, ScanStatus } from '../types';
import { api } from '../api';

interface SettingsModalProps {
  onClose: () => void;
  onLibrariesChanged: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onLibrariesChanged }) => {
  const [activeTab, setActiveTab] = useState<'libraries' | 'hardware' | 'tailscale'>('libraries');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [hardware, setHardware] = useState<SystemHardwareStatus | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);

  // New Library Form State
  const [newLibName, setNewLibName] = useState('');
  const [newLibPath, setNewLibPath] = useState('');
  const [newLibType, setNewLibType] = useState<'movies' | 'tv' | 'music' | 'home_videos'>('movies');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [libs, sys, scan] = await Promise.all([
        api.getLibraries(),
        api.getSystemStatus(),
        api.getScanStatus()
      ]);
      setLibraries(libs);
      setHardware(sys.hardware);
      setScanStatus(scan);
    } catch (err: any) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(async () => {
      const status = await api.getScanStatus();
      setScanStatus(status);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleAddLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLibName.trim() || !newLibPath.trim()) return;

    setError(null);
    setIsAdding(true);
    try {
      await api.createLibrary({
        name: newLibName.trim(),
        path: newLibPath.trim(),
        type: newLibType
      });
      setNewLibName('');
      setNewLibPath('');
      await loadData();
      onLibrariesChanged();
    } catch (err: any) {
      setError(err.message || 'Failed to add library');
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteLibrary = async (id: string) => {
    if (confirm('Are you sure you want to remove this library? Media files on disk will not be deleted.')) {
      await api.deleteLibrary(id);
      await loadData();
      onLibrariesChanged();
    }
  };

  const handleScanLibrary = async (id: string) => {
    await api.scanLibrary(id);
    await loadData();
  };

  const handleScanAll = async () => {
    await api.scanAllLibraries();
    await loadData();
  };

  const handleAccelChange = async (accel: 'qsv' | 'nvenc' | 'vaapi' | 'none') => {
    await api.setHardwareAccel(accel);
    const sys = await api.getSystemStatus();
    setHardware(sys.hardware);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-slate-950/50">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span>Server Settings & Configuration</span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-white/10 bg-slate-950/30 px-6 gap-6 text-sm font-medium">
          <button
            onClick={() => setActiveTab('libraries')}
            className={`py-3 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'libraries'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            <span>Media Libraries</span>
          </button>

          <button
            onClick={() => setActiveTab('hardware')}
            className={`py-3 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'hardware'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-4 h-4" />
            <span>Hardware Transcoding</span>
          </button>

          <button
            onClick={() => setActiveTab('tailscale')}
            className={`py-3 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'tailscale'
                ? 'border-blue-500 text-blue-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>Tailscale & Remote Access</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6 text-sm">
          {/* Tab 1: Libraries */}
          {activeTab === 'libraries' && (
            <div className="space-y-6">
              {/* Scan Status Banner */}
              {scanStatus?.isScanning && (
                <div className="p-3 bg-blue-950/60 border border-blue-500/30 rounded-xl flex items-center justify-between text-blue-200 text-xs">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
                    <span>
                      Scanning... ({scanStatus.processedFiles}/{scanStatus.totalFiles} files):{' '}
                      <span className="font-mono text-white">{scanStatus.currentFile}</span>
                    </span>
                  </div>
                </div>
              )}

              {/* Add New Library Form */}
              <form onSubmit={handleAddLibrary} className="p-4 bg-slate-950/60 border border-white/5 rounded-xl space-y-4">
                <div className="font-semibold text-slate-200 flex items-center gap-2 text-xs uppercase tracking-wider">
                  <FolderPlus className="w-4 h-4 text-blue-400" />
                  <span>Add TrueNAS Media Folder</span>
                </div>

                {error && <div className="text-xs text-rose-400">{error}</div>}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Library Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Movies 4K"
                      value={newLibName}
                      onChange={(e) => setNewLibName(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Folder Path (TrueNAS)</label>
                    <input
                      type="text"
                      placeholder="e.g. /media/movies or D:\Media"
                      value={newLibPath}
                      onChange={(e) => setNewLibPath(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Media Type</label>
                    <select
                      value={newLibType}
                      onChange={(e) => setNewLibType(e.target.value as any)}
                      className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                    >
                      <option value="movies">Movies</option>
                      <option value="tv">TV Shows / Series</option>
                      <option value="music">Music</option>
                      <option value="home_videos">Home Videos</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isAdding}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg text-xs transition-colors flex items-center gap-1.5"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Add Library</span>
                  </button>
                </div>
              </form>

              {/* Configured Libraries List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-300 text-xs uppercase tracking-wider">
                    Configured Libraries ({libraries.length})
                  </span>
                  {libraries.length > 0 && (
                    <button
                      onClick={handleScanAll}
                      className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Rescan All</span>
                    </button>
                  )}
                </div>

                {libraries.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-xs bg-slate-950/30 rounded-xl border border-dashed border-white/10">
                    No libraries configured yet. Add your first media folder above!
                  </div>
                ) : (
                  libraries.map((lib) => (
                    <div
                      key={lib.id}
                      className="p-3 bg-slate-950/40 border border-white/5 rounded-xl flex items-center justify-between"
                    >
                      <div>
                        <div className="font-semibold text-slate-200 flex items-center gap-2">
                          <span>{lib.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 bg-blue-900/50 text-blue-300 border border-blue-500/20 rounded capitalize">
                            {lib.type}
                          </span>
                        </div>
                        <div className="font-mono text-xs text-slate-400 truncate max-w-md">{lib.path}</div>
                        <div className="text-[11px] text-slate-500 mt-1">
                          {lib.item_count} items &bull; Last scanned:{' '}
                          {lib.last_scanned_at ? new Date(lib.last_scanned_at).toLocaleTimeString() : 'Never'}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleScanLibrary(lib.id)}
                          className="p-2 text-slate-400 hover:text-blue-400 hover:bg-white/5 rounded-lg transition-colors"
                          title="Scan this library"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteLibrary(lib.id)}
                          className="p-2 text-slate-400 hover:text-rose-400 hover:bg-white/5 rounded-lg transition-colors"
                          title="Delete library"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Hardware Transcoding */}
          {activeTab === 'hardware' && (
            <div className="space-y-6">
              <div className="p-4 bg-slate-950/60 border border-white/5 rounded-xl space-y-3">
                <div className="font-semibold text-slate-200 text-xs uppercase tracking-wider flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-blue-400" />
                  <span>Hardware Acceleration Engine</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  NovaStream supports GPU-accelerated transcoding on TrueNAS SCALE via Intel QuickSync (QSV),
                  VAAPI, or NVIDIA NVENC.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                  {[
                    { id: 'qsv', label: 'Intel QSV', supported: hardware?.qsvSupported },
                    { id: 'nvenc', label: 'NVIDIA NVENC', supported: hardware?.nvencSupported },
                    { id: 'vaapi', label: 'VAAPI (Linux)', supported: hardware?.vaapiSupported },
                    { id: 'none', label: 'CPU Software', supported: true }
                  ].map((engine) => {
                    const isSelected = hardware?.accelType === engine.id;
                    return (
                      <button
                        key={engine.id}
                        onClick={() => handleAccelChange(engine.id as any)}
                        disabled={!engine.supported}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'bg-blue-600/20 border-blue-500 text-blue-200 shadow-md shadow-blue-500/10'
                            : engine.supported
                            ? 'bg-slate-900 border-white/10 text-slate-300 hover:border-white/20'
                            : 'bg-slate-950/40 border-white/5 text-slate-600 cursor-not-allowed opacity-50'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-xs">{engine.label}</span>
                          {isSelected && <CheckCircle className="w-3.5 h-3.5 text-blue-400" />}
                        </div>
                        <div className="text-[10px]">
                          {engine.supported ? 'Supported' : 'Not Available'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Status Specs */}
              <div className="p-4 bg-slate-950/40 border border-white/5 rounded-xl space-y-2 text-xs">
                <div className="flex justify-between text-slate-400">
                  <span>Current Active Mode:</span>
                  <span className="font-mono text-blue-400 font-bold uppercase">{hardware?.accelType}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>GPU Device Node:</span>
                  <span className="font-mono text-slate-200">{hardware?.devicePath || 'None (or Auto)'}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>FFmpeg Build:</span>
                  <span className="font-mono text-slate-200 truncate max-w-xs">{hardware?.ffmpegVersion}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Active Transcode Streams:</span>
                  <span className="font-mono text-slate-200">{hardware?.activeTranscodes || 0}</span>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Tailscale Remote Access */}
          {activeTab === 'tailscale' && (
            <div className="space-y-4">
              <div className="p-4 bg-emerald-950/30 border border-emerald-500/20 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs uppercase tracking-wider">
                  <Shield className="w-4 h-4" />
                  <span>Zero-Trust Tailnet Connection</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Tailscale enables secure end-to-end encrypted streaming directly from your TrueNAS SCALE server to
                  any device (iPhone, iPad, Android, Apple TV, Mac, Windows) with <strong>zero open router ports</strong>.
                </p>
              </div>

              <div className="space-y-3 text-xs">
                <div className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
                  How to Stream from Any Device:
                </div>

                <div className="p-3 bg-slate-950/40 border border-white/5 rounded-xl space-y-2">
                  <div className="font-semibold text-slate-200">1. Mobile / Laptop (iOS, Android, Mac, PC)</div>
                  <p className="text-slate-400">
                    Install the Tailscale app, sign in, and open the server URL in your browser:
                  </p>
                  <code className="block p-2 bg-slate-900 rounded font-mono text-blue-300">
                    http://&lt;truenas-tailscale-ip&gt;:3001
                  </code>
                </div>

                <div className="p-3 bg-slate-950/40 border border-white/5 rounded-xl space-y-2">
                  <div className="font-semibold text-slate-200">2. Apple TV / Android TV</div>
                  <p className="text-slate-400">
                    Install Tailscale from the Apple TV or Google Play Store, or enable Tailscale Subnet Router on TrueNAS.
                  </p>
                </div>

                <div className="p-3 bg-slate-950/40 border border-white/5 rounded-xl space-y-2">
                  <div className="font-semibold text-slate-200">3. Tailscale Serve / Funnel (Automatic HTTPS)</div>
                  <p className="text-slate-400">
                    Run on your TrueNAS shell for automated TLS certificates:
                  </p>
                  <code className="block p-2 bg-slate-900 rounded font-mono text-blue-300">
                    tailscale serve --bg 3001
                  </code>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
