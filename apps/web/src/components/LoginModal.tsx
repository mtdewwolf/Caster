import React, { useState } from 'react';
import { AlertTriangle, LockKeyhole, ShieldCheck, X } from 'lucide-react';

interface LoginModalProps {
  configured: boolean;
  onClose: () => void;
  onLogin: (credential: string) => Promise<void>;
}

export const LoginModal: React.FC<LoginModalProps> = ({ configured, onClose, onLogin }) => {
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!credential || !configured || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      await onLogin(credential);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to sign in');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-login-title"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Close admin login"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="border-b border-white/10 bg-slate-950/50 px-6 py-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-400">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h2 id="admin-login-title" className="text-xl font-bold text-white">
            Admin access
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Browsing and streaming are public on your LAN. Sign in to change libraries, scans, progress, or server settings.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {!configured ? (
            <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-950/30 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <p>
                Authentication is locked. Set <code className="font-mono text-amber-100">ADMIN_PASSWORD</code> or{' '}
                <code className="font-mono text-amber-100">ADMIN_TOKEN</code> on the server and restart it.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="admin-credential" className="mb-1.5 block text-xs font-semibold text-slate-300">
                  Admin password or token
                </label>
                <input
                  id="admin-credential"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                  placeholder="Enter admin credential"
                />
              </div>

              {error ? (
                <div role="alert" className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={!credential || isSubmitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>{isSubmitting ? 'Signing in...' : 'Sign in as admin'}</span>
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
};
