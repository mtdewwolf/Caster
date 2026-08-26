import React, { useState, useRef } from 'react';
import { useFocusTrap } from '../features/a11y/focus-trap';
import { KeyRound, UsersRound, X } from 'lucide-react';

interface ProfileSwitchModalProps {
  currentUsername: string;
  onClose: () => void;
  onSwitch: (username: string, pin: string) => Promise<void>;
}

export const ProfileSwitchModal: React.FC<ProfileSwitchModalProps> = ({
  currentUsername,
  onClose,
  onSwitch
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: onClose });

  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !/^\d{4,12}$/.test(pin) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSwitch(username, pin);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to switch profile');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="switch-profile-title" data-testid="profile-switch-dialog" className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close profile switch" className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
          <X className="h-5 w-5" />
        </button>
        <div className="border-b border-white/10 bg-slate-950/50 px-6 py-5">
          <UsersRound className="mb-3 h-6 w-6 text-blue-400" />
          <h2 id="switch-profile-title" className="text-lg font-bold text-white">Switch profile</h2>
          <p className="mt-1 text-xs text-slate-400">Currently watching as {currentUsername}.</p>
        </div>
        <form onSubmit={submit} aria-busy={submitting} className="space-y-4 p-6">
          <div>
            <label htmlFor="profile-username" className="mb-1 block text-xs font-semibold text-slate-300">Profile username</label>
            <input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus autoComplete="username" className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
          </div>
          <div>
            <label htmlFor="profile-pin" className="mb-1 block text-xs font-semibold text-slate-300">Profile PIN</label>
            <input id="profile-pin" type="password" inputMode="numeric" pattern="[0-9]{4,12}" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))} autoComplete="current-password" aria-describedby={error ? 'profile-switch-error' : undefined} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
          </div>
          {error ? <div id="profile-switch-error" role="alert" className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div> : null}
          <button type="submit" disabled={submitting || !username.trim() || !/^\d{4,12}$/.test(pin)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
            <KeyRound className="h-4 w-4" />
            <span>{submitting ? 'Switching…' : 'Switch profile'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
