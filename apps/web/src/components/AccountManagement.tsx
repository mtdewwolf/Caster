import React, { useCallback, useEffect, useState } from 'react';
import { Ban, ClipboardCopy, KeyRound, Link2, Power, RefreshCw, UserPlus, Users } from 'lucide-react';
import { api, type AccountInvite, type UserAccount, type UserPermissions } from '../api';
import type { Library } from '../types';

interface AccessSettings {
  libraryIds: string[];
  permissions: UserPermissions;
}

export const AccountManagement: React.FC = () => {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [invites, setInvites] = useState<AccountInvite[]>([]);
  const [accessSettings, setAccessSettings] = useState<Record<string, AccessSettings>>({});
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [createdInviteLink, setCreatedInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passwordUpdates, setPasswordUpdates] = useState<Record<string, string>>({});
  const [pinUpdates, setPinUpdates] = useState<Record<string, string>>({});
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAccess = useCallback(async (account: UserAccount): Promise<AccessSettings> => {
    const [libraryIds, permissions] = await Promise.all([
      api.getUserLibraryAccess(account.id),
      api.getUserPermissions(account.id)
    ]);
    return { libraryIds, permissions };
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accounts, availableLibraries, accountInvites] = await Promise.all([
        api.getUsers(),
        api.getLibraries(),
        api.getInvites()
      ]);
      const settings = await Promise.all(accounts.map(async (account) => (
        [account.id, await loadAccess(account)] as const
      )));
      setUsers(accounts);
      setLibraries(availableLibraries);
      setInvites(accountInvites);
      setAccessSettings(Object.fromEntries(settings));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load accounts');
    } finally {
      setLoading(false);
    }
  }, [loadAccess]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const createInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creating) return;

    setCreating(true);
    setError(null);
    setCreatedInviteLink(null);
    setCopied(false);
    try {
      const invite = await api.createInvite({ role, expiresInHours });
      setInvites((current) => [invite, ...current]);
      setCreatedInviteLink(`${window.location.origin}${window.location.pathname}#invite=${encodeURIComponent(invite.token)}`);
      setRole('viewer');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create invite');
    } finally {
      setCreating(false);
    }
  };

  const copyInviteLink = async () => {
    if (!createdInviteLink) return;
    try {
      await navigator.clipboard.writeText(createdInviteLink);
      setCopied(true);
    } catch {
      setError('The invite was created, but the link could not be copied. Copy it from the field instead.');
    }
  };

  const revokeInvite = async (invite: AccountInvite) => {
    setError(null);
    try {
      await api.revokeInvite(invite.id);
      setInvites((current) => current.map((item) => (
        item.id === invite.id ? { ...item, revokedAt: Date.now() } : item
      )));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to revoke invite');
    }
  };

  const replaceLibraryAccess = async (user: UserAccount, libraryId: string, allowed: boolean) => {
    const current = accessSettings[user.id];
    if (!current) return;
    const nextIds = allowed
      ? [...new Set([...current.libraryIds, libraryId])]
      : current.libraryIds.filter((id) => id !== libraryId);
    setBusyUserId(user.id);
    setError(null);
    try {
      const libraryIds = await api.replaceUserLibraryAccess(user.id, nextIds);
      setAccessSettings((settings) => ({
        ...settings,
        [user.id]: { ...settings[user.id], libraryIds }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update library access');
    } finally {
      setBusyUserId(null);
    }
  };

  const updatePermissions = async (
    user: UserAccount,
    changes: Partial<Omit<UserPermissions, 'hasProfilePin'>>
  ) => {
    setBusyUserId(user.id);
    setError(null);
    try {
      const permissions = await api.updateUserPermissions(user.id, changes);
      setAccessSettings((settings) => ({
        ...settings,
        [user.id]: { ...settings[user.id], permissions }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update permissions');
    } finally {
      setBusyUserId(null);
    }
  };

  const updateProfilePin = async (user: UserAccount, pin: string | null) => {
    setBusyUserId(user.id);
    setError(null);
    try {
      const permissions = await api.setUserProfilePin(user.id, pin);
      setAccessSettings((settings) => ({
        ...settings,
        [user.id]: { ...settings[user.id], permissions }
      }));
      setPinUpdates((current) => ({ ...current, [user.id]: '' }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update profile PIN');
    } finally {
      setBusyUserId(null);
    }
  };

  const updateAccount = async (
    user: UserAccount,
    changes: Parameters<typeof api.updateUser>[1]
  ) => {
    setBusyUserId(user.id);
    setError(null);
    try {
      const updated = await api.updateUser(user.id, changes);
      setUsers((current) => current.map((account) => account.id === updated.id ? updated : account));
      if (changes.password) {
        setPasswordUpdates((current) => ({ ...current, [user.id]: '' }));
      }
      if (changes.role && changes.role !== user.role) {
        // An administrator reads as having every library. Drop that snapshot before
        // reloading the newly effective viewer grants so it can never be submitted.
        setAccessSettings((current) => {
          const next = { ...current };
          delete next[updated.id];
          return next;
        });
        try {
          const access = await loadAccess(updated);
          setAccessSettings((current) => ({ ...current, [updated.id]: access }));
        } catch {
          setError(`The role was updated, but ${updated.username}'s access settings could not be refreshed. Refresh accounts before making grant changes.`);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update account');
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <div className="space-y-6">
      <form data-testid="create-invite-form" aria-labelledby="create-invite-heading" onSubmit={createInvite} className="space-y-4 rounded-xl border border-white/5 bg-slate-950/60 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
          <UserPlus className="h-4 w-4 text-blue-400" />
          <span id="create-invite-heading">Invite account</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="new-account-role" className="mb-1 block text-[11px] font-medium text-slate-400">
              Role
            </label>
            <select
              id="new-account-role"
              value={role}
              onChange={(event) => setRole(event.target.value as 'admin' | 'viewer')}
              className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
            >
              <option value="viewer">Viewer</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          <div>
            <label htmlFor="invite-expiration" className="mb-1 block text-[11px] font-medium text-slate-400">
              Expires
            </label>
            <select
              id="invite-expiration"
              value={expiresInHours}
              onChange={(event) => setExpiresInHours(Number(event.target.value))}
              className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
            >
              <option value={24}>24 hours</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-[11px] text-slate-500">The recipient chooses their own username and password. Each link works once.</p>
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create invite'}
          </button>
        </div>
        {createdInviteLink ? (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3">
            <p className="mb-2 text-[11px] text-emerald-300">Copy this link now. Only its hash is stored, so it cannot be shown again.</p>
            <div className="flex gap-2">
              <input aria-label="New invite link" readOnly value={createdInviteLink} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-200" />
              <button type="button" onClick={() => void copyInviteLink()} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-950/30">
                <ClipboardCopy className="h-3.5 w-3.5" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : null}
      </form>

      {invites.length > 0 ? (
        <section aria-labelledby="invites-heading" className="space-y-2 rounded-xl border border-white/5 bg-slate-950/40 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
            <Link2 className="h-4 w-4 text-blue-400" />
            <h3 id="invites-heading">Invite history</h3>
          </div>
          {invites.map((invite) => {
            const pending = !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > Date.now();
            const status = invite.acceptedAt
              ? `Used by ${invite.acceptedUsername ?? 'an account'}`
              : invite.revokedAt ? 'Revoked' : invite.expiresAt <= Date.now() ? 'Expired' : 'Pending';
            return (
              <div key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 px-3 py-2 text-xs">
                <div>
                  <span className="font-medium capitalize text-slate-200">{invite.role}</span>
                  <span className="ml-2 text-slate-500">{status} · expires {new Date(invite.expiresAt).toLocaleString()}</span>
                </div>
                {pending ? (
                  <button type="button" onClick={() => void revokeInvite(invite)} className="flex items-center gap-1 text-rose-300 hover:text-rose-200">
                    <Ban className="h-3.5 w-3.5" /> Revoke
                  </button>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
          <span>{error}</span>
          <button type="button" onClick={() => void loadAccounts()} className="shrink-0 rounded border border-rose-400/30 px-2 py-1 font-semibold hover:bg-rose-900/40">
            Refresh accounts
          </button>
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
            <Users className="h-4 w-4 text-blue-400" />
            <span>Accounts ({users.length})</span>
          </div>
          <button type="button" disabled={loading} onClick={() => void loadAccounts()} aria-label="Refresh accounts" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loading && users.length === 0 ? <p role="status" className="text-xs text-slate-500">Loading accounts...</p> : null}

        {users.map((user) => {
          const busy = busyUserId === user.id;
          const access = accessSettings[user.id];
          return (
            <div key={user.id} data-testid={`account-row-${user.id}`} className="space-y-3 rounded-xl border border-white/5 bg-slate-950/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-semibold text-slate-200">
                    <span>{user.username}</span>
                    {!user.active ? (
                      <span className="rounded border border-rose-500/25 bg-rose-950/30 px-1.5 py-0.5 text-[10px] text-rose-300">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-600">{user.id}</div>
                </div>

                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`role-${user.id}`}>Role for {user.username}</label>
                  <select
                    id={`role-${user.id}`}
                    value={user.role}
                    disabled={busy}
                    onChange={(event) => updateAccount(user, { role: event.target.value as 'admin' | 'viewer' })}
                    className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 outline-none focus:border-blue-500"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="admin">Administrator</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => updateAccount(user, { active: !user.active })}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition disabled:opacity-50 ${
                      user.active
                        ? 'border-rose-500/20 text-rose-300 hover:bg-rose-950/30'
                        : 'border-emerald-500/20 text-emerald-300 hover:bg-emerald-950/30'
                    }`}
                  >
                    <Power className="h-3.5 w-3.5" />
                    <span>{user.active ? 'Disable' : 'Enable'}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-2 border-t border-white/5 pt-3">
                <div className="min-w-48 flex-1">
                  <label htmlFor={`password-${user.id}`} className="mb-1 block text-[11px] text-slate-500">
                    Set a new password
                  </label>
                  <input
                    id={`password-${user.id}`}
                    type="password"
                    autoComplete="new-password"
                    value={passwordUpdates[user.id] ?? ''}
                    onChange={(event) => setPasswordUpdates((current) => ({
                      ...current,
                      [user.id]: event.target.value
                    }))}
                    className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || (passwordUpdates[user.id]?.length ?? 0) < 8}
                  onClick={() => updateAccount(user, { password: passwordUpdates[user.id] })}
                  className="flex items-center gap-1.5 rounded-lg border border-blue-500/25 px-3 py-2 text-xs text-blue-300 transition hover:bg-blue-950/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Update password</span>
                </button>
              </div>

              {user.role === 'viewer' && access ? (
                <div className="grid gap-4 border-t border-white/5 pt-3 lg:grid-cols-2">
                  <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Shared libraries
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {libraries.map((library) => (
                        <label key={library.id} className="flex items-center gap-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={access.libraryIds.includes(library.id)}
                            disabled={busy}
                            onChange={(event) => replaceLibraryAccess(user, library.id, event.target.checked)}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900 text-blue-600"
                          />
                          <span>{library.name}</span>
                        </label>
                      ))}
                    </div>
                    {libraries.length === 0 ? <p className="text-[11px] text-slate-600">No libraries configured.</p> : null}
                  </fieldset>

                  <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Capabilities and restrictions
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {([ 
                        ['canStreamRemote', 'Remote streaming'],
                        ['canDownload', 'Source downloads'],
                        ['canDeleteMedia', 'Delete source media'],
                        ['canManageProfiles', 'Switch household profiles'],
                        ['allowUnrated', 'Unrated content']
                      ] as const).map(([permission, label]) => (
                        <label key={permission} className="flex items-center gap-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={access.permissions[permission]}
                            disabled={busy}
                            onChange={(event) => updatePermissions(user, { [permission]: event.target.checked })}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900 text-blue-600"
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                    <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
                      <span>Maximum rating</span>
                      <select
                        value={access.permissions.maxContentRating ?? ''}
                        disabled={busy}
                        onChange={(event) => updatePermissions(user, {
                          maxContentRating: event.target.value || null
                        })}
                        className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                      >
                        <option value="">No limit</option>
                        <option value="TV-Y">TV-Y</option>
                        <option value="G">G / TV-G</option>
                        <option value="PG">PG / TV-PG</option>
                        <option value="PG-13">PG-13 / TV-14</option>
                        <option value="R">R / TV-MA</option>
                        <option value="NC-17">NC-17</option>
                      </select>
                    </label>
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <div>
                        <label htmlFor={`pin-${user.id}`} className="mb-1 block text-[11px] text-slate-500">
                          TV profile PIN {access.permissions.hasProfilePin ? '(configured)' : ''}
                        </label>
                        <input
                          id={`pin-${user.id}`}
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]{4,12}"
                          autoComplete="new-password"
                          value={pinUpdates[user.id] ?? ''}
                          onChange={(event) => setPinUpdates((current) => ({
                            ...current,
                            [user.id]: event.target.value.replace(/\D/g, '').slice(0, 12)
                          }))}
                          className="w-32 rounded-lg border border-white/10 bg-slate-900 px-3 py-1.5 text-xs text-white outline-none focus:border-blue-500"
                          placeholder="4–12 digits"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy || !/^\d{4,12}$/.test(pinUpdates[user.id] ?? '')}
                        onClick={() => updateProfilePin(user, pinUpdates[user.id])}
                        className="rounded-lg border border-blue-500/25 px-2.5 py-1.5 text-xs text-blue-300 disabled:opacity-50"
                      >
                        Set PIN
                      </button>
                      {access.permissions.hasProfilePin ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => updateProfilePin(user, null)}
                          className="rounded-lg border border-rose-500/20 px-2.5 py-1.5 text-xs text-rose-300 disabled:opacity-50"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </fieldset>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
