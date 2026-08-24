import crypto from 'crypto';
import type { Database } from 'bun:sqlite';
import type { ContentRatingScope } from '../types';
import { contentRatingLevel, normalizeContentRating } from '../content-ratings';

export type AccessRole = 'admin' | 'viewer';

export interface AccessPrincipal {
  userId: string;
  role: AccessRole;
  active: boolean;
}

export type RestrictedCapability =
  | 'download'
  | 'stream_remote'
  | 'delete_media'
  | 'manage_profiles';

export type MediaAccessAction = 'discover' | 'stream' | 'download' | 'delete';

export interface UserPermissions {
  maxContentRating: string | null;
  allowUnrated: boolean;
  canDownload: boolean;
  canStreamRemote: boolean;
  canDeleteMedia: boolean;
  canManageProfiles: boolean;
  hasProfilePin: boolean;
}

export interface UpdateUserPermissions {
  maxContentRating?: string | null;
  allowUnrated?: boolean;
  canDownload?: boolean;
  canStreamRemote?: boolean;
  canDeleteMedia?: boolean;
  canManageProfiles?: boolean;
}

export interface MediaAccessOptions {
  action?: MediaAccessAction;
  /** Whether the client is outside the trusted/local network boundary. */
  remote?: boolean;
  /** Optional normalized or common US movie/TV rating. Missing values are unrated. */
  contentRating?: string | null;
}

interface PermissionRow {
  max_content_rating: string | null;
  allow_unrated: number;
  can_download: number;
  can_stream_remote: number;
  can_delete_media: number;
  can_manage_profiles: number;
  profile_pin_hash: string | null;
}

const DEFAULT_PERMISSIONS: UserPermissions = Object.freeze({
  maxContentRating: null,
  allowUnrated: true,
  canDownload: false,
  canStreamRemote: true,
  canDeleteMedia: false,
  canManageProfiles: false,
  hasProfilePin: false
});

const PIN_KEY_BYTES = 32;
const PIN_SALT_BYTES = 16;
const PIN_SCRYPT_COST = 16_384;
const PIN_FORMAT = 'scrypt-v1';

function asBoolean(value: number): boolean {
  return value === 1;
}

function ratingIsAllowed(
  contentRating: string | null | undefined,
  permissions: UserPermissions
): boolean {
  const actual = contentRatingLevel(contentRating);
  if (actual === null) return permissions.allowUnrated;
  if (!permissions.maxContentRating) return true;

  const maximum = contentRatingLevel(permissions.maxContentRating);
  if (maximum === null) return false;
  return actual <= maximum;
}

function validatePin(pin: string): void {
  if (!/^\d{4,12}$/.test(pin)) {
    throw new Error('Profile PIN must contain 4 to 12 digits');
  }
}

function hashPin(pin: string): string {
  validatePin(pin);
  const salt = crypto.randomBytes(PIN_SALT_BYTES);
  const derivedKey = crypto.scryptSync(pin, salt, PIN_KEY_BYTES, {
    N: PIN_SCRYPT_COST,
    r: 8,
    p: 1
  });
  return [PIN_FORMAT, PIN_SCRYPT_COST, salt.toString('base64url'), derivedKey.toString('base64url')].join('$');
}

function verifyPinHash(pin: string, encodedHash: string): boolean {
  const [format, costText, saltText, digestText, extra] = encodedHash.split('$');
  if (format !== PIN_FORMAT || extra !== undefined) return false;

  const cost = Number(costText);
  if (!Number.isInteger(cost) || cost !== PIN_SCRYPT_COST) return false;

  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    if (salt.length !== PIN_SALT_BYTES || expected.length !== PIN_KEY_BYTES) return false;
    const actual = crypto.scryptSync(pin, salt, expected.length, { N: cost, r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * SQLite-backed household authorization policy.
 *
 * Route handlers should call `canAccessLibrary` before returning a library and
 * `canAccessMedia` before loading media metadata or opening any derivative
 * (direct streams, HLS, thumbnails, or subtitles). This keeps denied media
 * indistinguishable from missing media at the route boundary.
 */
export class AccessControlStore {
  constructor(private readonly database: Database) {}

  getPermissions(userId: string): UserPermissions {
    const row = this.database.query(`
      SELECT max_content_rating, allow_unrated, can_download,
             can_stream_remote, can_delete_media, can_manage_profiles,
             profile_pin_hash
      FROM user_permissions
      WHERE user_id = ?
    `).get(userId) as PermissionRow | null;

    if (!row) return { ...DEFAULT_PERMISSIONS };
    return {
      maxContentRating: row.max_content_rating,
      allowUnrated: asBoolean(row.allow_unrated),
      canDownload: asBoolean(row.can_download),
      canStreamRemote: asBoolean(row.can_stream_remote),
      canDeleteMedia: asBoolean(row.can_delete_media),
      canManageProfiles: asBoolean(row.can_manage_profiles),
      hasProfilePin: row.profile_pin_hash !== null
    };
  }

  updatePermissions(userId: string, update: UpdateUserPermissions): UserPermissions {
    const current = this.getPermissions(userId);
    const requestedMaxRating = update.maxContentRating === undefined
      ? current.maxContentRating
      : update.maxContentRating?.trim() || null;
    const normalizedMaxRating = normalizeContentRating(requestedMaxRating);
    if (requestedMaxRating && !normalizedMaxRating) {
      throw new Error(`Unsupported content rating: ${requestedMaxRating}`);
    }

    const next = {
      maxContentRating: normalizedMaxRating,
      allowUnrated: update.allowUnrated ?? current.allowUnrated,
      canDownload: update.canDownload ?? current.canDownload,
      canStreamRemote: update.canStreamRemote ?? current.canStreamRemote,
      canDeleteMedia: update.canDeleteMedia ?? current.canDeleteMedia,
      canManageProfiles: update.canManageProfiles ?? current.canManageProfiles
    };

    this.database.run(`
      INSERT INTO user_permissions (
        user_id, max_content_rating, allow_unrated, can_download,
        can_stream_remote, can_delete_media, can_manage_profiles, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        max_content_rating = excluded.max_content_rating,
        allow_unrated = excluded.allow_unrated,
        can_download = excluded.can_download,
        can_stream_remote = excluded.can_stream_remote,
        can_delete_media = excluded.can_delete_media,
        can_manage_profiles = excluded.can_manage_profiles,
        updated_at = excluded.updated_at
    `, [
      userId,
      next.maxContentRating,
      Number(next.allowUnrated),
      Number(next.canDownload),
      Number(next.canStreamRemote),
      Number(next.canDeleteMedia),
      Number(next.canManageProfiles),
      new Date().toISOString()
    ]);

    return this.getPermissions(userId);
  }

  getAllowedLibraryIds(principal: AccessPrincipal): string[] {
    if (!principal.active) return [];
    if (principal.role === 'admin') {
      return (this.database.query('SELECT id FROM libraries ORDER BY id').all() as Array<{ id: string }>)
        .map((row) => row.id);
    }

    return (this.database.query(`
      SELECT library_id FROM user_library_access
      WHERE user_id = ?
      ORDER BY library_id
    `).all(principal.userId) as Array<{ library_id: string }>).map((row) => row.library_id);
  }

  /**
   * Scope value intended for model `allowedLibraryIds` options. `undefined`
   * deliberately means an unrestricted active admin, while an empty array
   * means a principal that must receive no rows.
   */
  getLibraryScope(principal: AccessPrincipal): string[] | undefined {
    if (!principal.active) return [];
    if (principal.role === 'admin') return undefined;
    return this.getAllowedLibraryIds(principal);
  }

  getContentRatingScope(principal: AccessPrincipal): ContentRatingScope | undefined {
    if (!principal.active || principal.role === 'admin') return undefined;
    const permissions = this.getPermissions(principal.userId);
    const maxLevel = contentRatingLevel(permissions.maxContentRating);
    return maxLevel === null && permissions.allowUnrated
      ? undefined
      : { maxLevel, allowUnrated: permissions.allowUnrated };
  }

  canAccessContentRating(
    principal: AccessPrincipal,
    contentRating?: string | null
  ): boolean {
    if (!principal.active) return false;
    if (principal.role === 'admin') return true;
    return ratingIsAllowed(contentRating, this.getPermissions(principal.userId));
  }

  shareLibrary(userId: string, libraryId: string): void {
    this.database.run(`
      INSERT INTO user_library_access (user_id, library_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, library_id) DO NOTHING
    `, [userId, libraryId, new Date().toISOString()]);
  }

  unshareLibrary(userId: string, libraryId: string): void {
    this.database.run(
      'DELETE FROM user_library_access WHERE user_id = ? AND library_id = ?',
      [userId, libraryId]
    );
  }

  canAccessLibrary(principal: AccessPrincipal, libraryId: string): boolean {
    if (!principal.active) return false;
    if (principal.role === 'admin') return true;
    return !!this.database.query(`
      SELECT 1 FROM user_library_access
      WHERE user_id = ? AND library_id = ?
    `).get(principal.userId, libraryId);
  }

  canUseCapability(principal: AccessPrincipal, capability: RestrictedCapability): boolean {
    if (!principal.active) return false;
    if (principal.role === 'admin') return true;
    const permissions = this.getPermissions(principal.userId);
    switch (capability) {
      case 'download': return permissions.canDownload;
      case 'stream_remote': return permissions.canStreamRemote;
      case 'delete_media': return permissions.canDeleteMedia;
      case 'manage_profiles': return permissions.canManageProfiles;
    }
  }

  canAccessMedia(
    principal: AccessPrincipal,
    mediaId: string,
    options: MediaAccessOptions = {}
  ): boolean {
    if (!principal.active) return false;
    const media = this.database.query(`
      SELECT library_id, content_rating FROM media_items WHERE id = ?
    `).get(mediaId) as { library_id: string; content_rating: string | null } | null;
    if (!media || !this.canAccessLibrary(principal, media.library_id)) return false;
    if (principal.role === 'admin') return true;

    const action = options.action ?? 'discover';
    if (action === 'download' && !this.canUseCapability(principal, 'download')) return false;
    if (action === 'delete' && !this.canUseCapability(principal, 'delete_media')) return false;
    if (action === 'stream' && options.remote
      && !this.canUseCapability(principal, 'stream_remote')) return false;

    return ratingIsAllowed(
      options.contentRating === undefined ? media.content_rating : options.contentRating,
      this.getPermissions(principal.userId)
    );
  }

  setProfilePin(userId: string, pin: string | null): void {
    const encodedHash = pin === null ? null : hashPin(pin);
    this.database.run(`
      INSERT INTO user_permissions (user_id, profile_pin_hash, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        profile_pin_hash = excluded.profile_pin_hash,
        updated_at = excluded.updated_at
    `, [userId, encodedHash, new Date().toISOString()]);
  }

  verifyProfilePin(userId: string, pin: string): boolean {
    const row = this.database.query(`
      SELECT profile_pin_hash FROM user_permissions WHERE user_id = ?
    `).get(userId) as { profile_pin_hash: string | null } | null;
    if (!row?.profile_pin_hash) return false;
    return verifyPinHash(pin, row.profile_pin_hash);
  }
}
