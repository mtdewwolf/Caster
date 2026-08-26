import React, { useState, useRef } from 'react';
import { useFocusTrap } from '../features/a11y/focus-trap';
import { LockKeyhole, ShieldCheck, X } from 'lucide-react';

interface LoginModalProps {
  onClose: () => void;
  onLogin: (username: string, credential: string) => Promise<void>;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onClose, onLogin }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: onClose });

  const [username, setUsername] = useState('');
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !credential || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      await onLogin(username, credential);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to sign in');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        data-testid="login-dialog"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Close sign in"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="border-b border-white/10 bg-slate-950/50 px-6 py-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-400">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h2 id="login-title" className="text-xl font-bold text-white">
            Sign in to Caster
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Use your account to access shared libraries and keep watch progress separate.
          </p>
        </div>

        <form onSubmit={handleSubmit} aria-busy={isSubmitting} className="space-y-4 p-6">
          <>
            <div>
              <label htmlFor="username" className="mb-1.5 block text-xs font-semibold text-slate-300">
                Username
              </label>
              <input
                id="username"
                type="text"
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                placeholder="Enter your username"
              />
            </div>

            <div>
              <label htmlFor="admin-credential" className="mb-1.5 block text-xs font-semibold text-slate-300">
                Password
              </label>
              <input
                id="admin-credential"
                type="password"
                autoComplete="current-password"
                value={credential}
                aria-describedby={error ? 'login-error' : undefined}
                onChange={(event) => setCredential(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                placeholder="Enter your password"
              />
            </div>

            {error ? (
              <div id="login-error" role="alert" className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!username.trim() || !credential || isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>{isSubmitting ? 'Signing in...' : 'Sign in'}</span>
            </button>
          </>
        </form>
      </div>
    </div>
  );
};
