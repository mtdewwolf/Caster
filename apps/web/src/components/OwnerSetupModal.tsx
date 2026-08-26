import React, { useState, useRef } from 'react';
import { useFocusTrap } from '../features/a11y/focus-trap';
import { LockKeyhole, ShieldCheck } from 'lucide-react';

interface OwnerSetupModalProps {
  onSetup: (username: string, password: string) => Promise<void>;
}

export const OwnerSetupModal: React.FC<OwnerSetupModalProps> = ({ onSetup }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || password.length < 8 || isSubmitting) return;
    if (password !== confirmation) {
      setError('Passwords do not match');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onSetup(username, password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create the owner account');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="owner-setup-title" className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <div className="border-b border-white/10 bg-slate-950/50 px-6 py-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-400">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h1 id="owner-setup-title" className="text-xl font-bold text-white">Claim this Caster server</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Create the one owner account for this server. This setup closes permanently after it succeeds.
          </p>
        </div>
        <form onSubmit={handleSubmit} aria-busy={isSubmitting} className="space-y-4 p-6">
          <div>
            <label htmlFor="owner-username" className="mb-1.5 block text-xs font-semibold text-slate-300">Owner username</label>
            <input id="owner-username" autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
          </div>
          <div>
            <label htmlFor="owner-password" className="mb-1.5 block text-xs font-semibold text-slate-300">Password</label>
            <input id="owner-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
            <p className="mt-1 text-[11px] text-slate-500">Use at least 8 characters. The password is stored only as a salted hash.</p>
          </div>
          <div>
            <label htmlFor="owner-password-confirmation" className="mb-1.5 block text-xs font-semibold text-slate-300">Confirm password</label>
            <input id="owner-password-confirmation" type="password" autoComplete="new-password" value={confirmation} aria-describedby={error ? 'owner-setup-error' : undefined} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
          </div>
          {error ? <div id="owner-setup-error" role="alert" className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div> : null}
          <button type="submit" disabled={!username.trim() || password.length < 8 || !confirmation || isSubmitting} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60">
            <ShieldCheck className="h-4 w-4" />
            <span>{isSubmitting ? 'Creating owner...' : 'Create owner account'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
