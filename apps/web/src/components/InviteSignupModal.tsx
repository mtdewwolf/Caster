import React, { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus, X } from 'lucide-react';
import { api } from '../api';

interface InviteSignupModalProps {
  token: string;
  onClose: () => void;
  onSignup: (token: string, username: string, password: string) => Promise<void>;
}

export const InviteSignupModal: React.FC<InviteSignupModalProps> = ({ token, onClose, onSignup }) => {
  const [role, setRole] = useState<'admin' | 'viewer' | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    api.inspectInvite(token)
      .then((invite) => {
        if (active) setRole(invite.role);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Unable to validate this invite');
      });
    return () => { active = false; };
  }, [token]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!role || !username.trim() || password.length < 8 || isSubmitting) return;
    if (password !== confirmation) {
      setError('Passwords do not match');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onSignup(token, username, password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create your account');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="invite-signup-title" className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close account signup" className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button>
        <div className="border-b border-white/10 bg-slate-950/50 px-6 py-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-400"><UserPlus className="h-5 w-5" /></div>
          <h2 id="invite-signup-title" className="text-xl font-bold text-white">Create your Caster account</h2>
          <p className="mt-1.5 text-sm text-slate-400">{role ? `This invite creates a${role === 'admin' ? 'n administrator' : ' viewer'} account.` : 'Validating your invite...'}</p>
        </div>
        <form onSubmit={handleSubmit} aria-busy={isSubmitting} className="space-y-4 p-6">
          <div><label htmlFor="signup-username" className="mb-1.5 block text-xs font-semibold text-slate-300">Username</label><input id="signup-username" autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={!role} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50" /></div>
          <div><label htmlFor="signup-password" className="mb-1.5 block text-xs font-semibold text-slate-300">Password</label><input id="signup-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={!role} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50" /></div>
          <div><label htmlFor="signup-password-confirmation" className="mb-1.5 block text-xs font-semibold text-slate-300">Confirm password</label><input id="signup-password-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={!role} aria-describedby={error ? 'invite-signup-error' : undefined} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-2.5 text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50" /></div>
          {error ? <div id="invite-signup-error" role="alert" className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div> : null}
          <button type="submit" disabled={!role || !username.trim() || password.length < 8 || !confirmation || isSubmitting} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"><ShieldCheck className="h-4 w-4" /><span>{isSubmitting ? 'Creating account...' : 'Create account'}</span></button>
        </form>
      </div>
    </div>
  );
};
