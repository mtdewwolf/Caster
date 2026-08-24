import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AccessControlStore, type AccessPrincipal } from '../apps/server/src/db/access-control';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';

const admin: AccessPrincipal = { userId: 'admin', role: 'admin', active: true };
const alice: AccessPrincipal = { userId: 'alice', role: 'viewer', active: true };
const bob: AccessPrincipal = { userId: 'bob', role: 'viewer', active: true };

describe('household access control', () => {
  let database: Database;
  let access: AccessControlStore;

  beforeEach(() => {
    database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    runDatabaseMigrations(database);
    const now = new Date().toISOString();
    database.run(`
      INSERT INTO users (id, username, role, active, created_at, updated_at)
      VALUES ('alice', 'alice', 'viewer', 1, ?, ?),
             ('bob', 'bob', 'viewer', 1, ?, ?)
    `, [now, now, now, now]);
    database.run(`
      INSERT INTO libraries (id, name, path, type, created_at)
      VALUES ('family', 'Family', '/family', 'movies', ?),
             ('adults', 'Adults', '/adults', 'movies', ?)
    `, [now, now]);
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, created_at, updated_at
      ) VALUES
        ('family-movie', 'family', 'Family Movie', 'family.mkv', 'family.mkv',
         '/family/family.mkv', 'movie', ?, ?),
        ('adult-movie', 'adults', 'Adult Movie', 'adult.mkv', 'adult.mkv',
         '/adults/adult.mkv', 'movie', ?, ?)
    `, [now, now, now, now]);
    access = new AccessControlStore(database);
  });

  afterEach(() => database.close());

  it('uses a secure allowlist while active admins bypass library ACLs', () => {
    expect(access.getAllowedLibraryIds(alice)).toEqual([]);
    expect(access.canAccessLibrary(alice, 'family')).toBe(false);
    expect(access.canAccessMedia(alice, 'family-movie')).toBe(false);

    access.shareLibrary('alice', 'family');
    expect(access.getAllowedLibraryIds(alice)).toEqual(['family']);
    expect(access.canAccessMedia(alice, 'family-movie')).toBe(true);
    expect(access.canAccessMedia(alice, 'adult-movie')).toBe(false);
    expect(access.getAllowedLibraryIds(admin)).toEqual(['adults', 'family']);
    expect(access.getLibraryScope(admin)).toBeUndefined();
    expect(access.getLibraryScope(alice)).toEqual(['family']);
    expect(access.getLibraryScope({ ...alice, active: false })).toEqual([]);
    expect(access.canAccessMedia(admin, 'adult-movie', { action: 'delete' })).toBe(true);
  });

  it('denies every operation to disabled principals, including admins', () => {
    expect(access.canAccessLibrary({ ...admin, active: false }, 'family')).toBe(false);
    expect(access.canAccessMedia({ ...alice, active: false }, 'family-movie')).toBe(false);
    expect(access.canUseCapability({ ...admin, active: false }, 'manage_profiles')).toBe(false);
  });

  it('enforces content ratings and explicit viewer capabilities', () => {
    access.shareLibrary('alice', 'family');
    access.updatePermissions('alice', {
      maxContentRating: 'PG-13',
      allowUnrated: false,
      canDownload: true,
      canStreamRemote: false
    });

    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'PG' })).toBe(true);
    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'R' })).toBe(false);
    expect(access.canAccessMedia(alice, 'family-movie')).toBe(false);
    expect(access.getLibraryScope(alice)).toEqual(['family']);
    expect(access.getContentRatingScope(alice)).toEqual({ maxLevel: 3, allowUnrated: false });
    expect(access.canAccessContentRating(alice, 'R')).toBe(false);
    expect(access.canAccessMedia(alice, 'family-movie', {
      action: 'download', contentRating: 'PG'
    })).toBe(true);
    expect(access.canAccessMedia(alice, 'family-movie', {
      action: 'stream', remote: true, contentRating: 'PG'
    })).toBe(false);
    expect(access.canUseCapability(alice, 'delete_media')).toBe(false);
  });

  it('treats unknown ratings as unrated and preserves the level-zero TV-Y boundary', () => {
    access.shareLibrary('alice', 'family');
    access.updatePermissions('alice', { maxContentRating: null, allowUnrated: false });

    expect(access.getContentRatingScope(alice)).toEqual({ maxLevel: null, allowUnrated: false });
    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'PG' })).toBe(true);
    expect(access.canAccessMedia(alice, 'family-movie')).toBe(false);
    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'not-classified' })).toBe(false);

    access.updatePermissions('alice', { maxContentRating: 'TV-Y' });
    expect(access.getContentRatingScope(alice)).toEqual({ maxLevel: 0, allowUnrated: false });
    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'TV-Y' })).toBe(true);
    expect(access.canAccessMedia(alice, 'family-movie', { contentRating: 'TV-Y7' })).toBe(false);

    expect(access.updatePermissions('alice', { maxContentRating: 'tv_y7' }).maxContentRating)
      .toBe('TV-Y7');
  });

  it('stores a salted profile PIN hash and verifies profile switching', () => {
    access.setProfilePin('alice', '0427');
    const stored = database.query(`
      SELECT profile_pin_hash FROM user_permissions WHERE user_id = 'alice'
    `).get() as { profile_pin_hash: string };

    expect(stored.profile_pin_hash).not.toContain('0427');
    expect(stored.profile_pin_hash).toStartWith('scrypt-v1$');
    expect(access.verifyProfilePin('alice', '0427')).toBe(true);
    expect(access.verifyProfilePin('alice', '0428')).toBe(false);
    expect(() => access.setProfilePin('alice', '12')).toThrow();

    access.setProfilePin('alice', null);
    expect(access.verifyProfilePin('alice', '0427')).toBe(false);
  });

  it('keeps progress owner-scoped even when two viewers share media access', () => {
    access.shareLibrary('alice', 'family');
    access.shareLibrary('bob', 'family');
    database.run(`
      INSERT INTO watch_progress (
        id, user_id, media_id, position_seconds, duration_seconds,
        progress_percent, completed, last_watched_at
      ) VALUES
        ('alice-progress', 'alice', 'family-movie', 30, 100, 30, 0, ?),
        ('bob-progress', 'bob', 'family-movie', 90, 100, 90, 0, ?)
    `, [new Date().toISOString(), new Date().toISOString()]);

    expect(access.canAccessMedia(alice, 'family-movie')).toBe(true);
    expect(access.canAccessMedia(bob, 'family-movie')).toBe(true);
    expect(database.query(`
      SELECT position_seconds FROM watch_progress WHERE user_id = ? AND media_id = ?
    `).get('alice', 'family-movie')).toEqual({ position_seconds: 30 });
    expect(database.query(`
      SELECT position_seconds FROM watch_progress WHERE user_id = ? AND media_id = ?
    `).get('bob', 'family-movie')).toEqual({ position_seconds: 90 });
  });

  it('removes sharing access immediately and cascades deleted profiles', () => {
    access.shareLibrary('alice', 'family');
    access.unshareLibrary('alice', 'family');
    expect(access.canAccessMedia(alice, 'family-movie')).toBe(false);

    access.shareLibrary('bob', 'family');
    access.updatePermissions('bob', { canDownload: true });
    database.run(`DELETE FROM users WHERE id = 'bob'`);
    expect(database.query(`SELECT COUNT(*) AS count FROM user_library_access WHERE user_id = 'bob'`).get())
      .toEqual({ count: 0 });
    expect(database.query(`SELECT COUNT(*) AS count FROM user_permissions WHERE user_id = 'bob'`).get())
      .toEqual({ count: 0 });
  });
});
