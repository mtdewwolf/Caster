export const ADMIN_USER_ID = 'admin';
export const PUBLIC_USER_ID = 'public';

/** Caster currently runs as one shared, account-free household identity. */
export function getCurrentUserId(..._args: unknown[]): string {
  return PUBLIC_USER_ID;
}
