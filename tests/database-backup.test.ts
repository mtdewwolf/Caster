import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  validateDatabaseFile
} from '../apps/server/src/db/backup';

describe('SQLite backup and restore operations', () => {
  let testRoot: string;
  let activeDatabasePath: string;
  let activeDatabase: Database | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-database-backup-'));
    const dataDirectory = path.join(testRoot, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    activeDatabasePath = path.join(dataDirectory, 'media.db');
    activeDatabase = new Database(activeDatabasePath, { create: true });
    activeDatabase.run('PRAGMA journal_mode = WAL');
    activeDatabase.run('PRAGMA wal_autocheckpoint = 0');
    activeDatabase.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    activeDatabase.run('PRAGMA wal_checkpoint(TRUNCATE)');
    activeDatabase.run('INSERT INTO entries (value) VALUES (?)', ['committed-in-wal']);
  });

  afterEach(() => {
    activeDatabase?.close();
    activeDatabase = undefined;
    Bun.gc(true);
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('backs up a live WAL database without copying media or caches', () => {
    const backupDirectory = path.join(testRoot, 'backups');
    const mediaDirectory = path.join(testRoot, 'media');
    const thumbnailDirectory = path.join(testRoot, 'thumbnails');
    const transcodeDirectory = path.join(testRoot, 'transcode-cache');
    fs.mkdirSync(mediaDirectory);
    fs.mkdirSync(thumbnailDirectory);
    fs.mkdirSync(transcodeDirectory);
    fs.writeFileSync(path.join(mediaDirectory, 'movie.mkv'), 'not part of a database backup');
    fs.writeFileSync(path.join(thumbnailDirectory, 'poster.jpg'), 'thumbnail');
    fs.writeFileSync(path.join(transcodeDirectory, 'segment.ts'), 'transcode segment');

    expect(fs.existsSync(`${activeDatabasePath}-wal`)).toBe(true);

    const result = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: backupDirectory,
      retention: 3,
      now: new Date('2026-08-23T12:34:56.789Z')
    });

    expect(result.integrityCheck).toBe('ok');
    expect(result.checkpoint.busy).toBe(0);
    expect(result.path).toMatch(/caster-media-2026-08-23T12-34-56\.789Z-.+\.sqlite$/);
    expect(fs.readdirSync(backupDirectory)).toEqual([path.basename(result.path)]);

    const backup = new Database(result.path, { readonly: true });
    expect(backup.query('SELECT value FROM entries').all()).toEqual([
      { value: 'committed-in-wal' }
    ]);
    backup.close();

    expect(activeDatabase?.query('SELECT COUNT(*) AS count FROM entries').get()).toEqual({ count: 1 });
    expect(fs.existsSync(path.join(backupDirectory, 'movie.mkv'))).toBe(false);
    expect(fs.existsSync(path.join(backupDirectory, 'poster.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(backupDirectory, 'segment.ts'))).toBe(false);
  });

  test('retains only the configured number of Caster database backups', () => {
    const backupDirectory = path.join(testRoot, 'backups');
    fs.mkdirSync(backupDirectory);
    fs.writeFileSync(path.join(backupDirectory, 'operator-notes.txt'), 'keep me');
    fs.writeFileSync(path.join(backupDirectory, 'caster-media-manual.sqlite'), 'keep me too');

    const first = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: backupDirectory,
      retention: 2,
      now: new Date('2026-08-21T00:00:00.000Z')
    });
    fs.utimesSync(first.path, new Date('2026-08-21T00:00:00.000Z'), new Date('2026-08-21T00:00:00.000Z'));

    activeDatabase?.run('INSERT INTO entries (value) VALUES (?)', ['second']);
    const second = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: backupDirectory,
      retention: 2,
      now: new Date('2026-08-22T00:00:00.000Z')
    });
    fs.utimesSync(second.path, new Date('2026-08-22T00:00:00.000Z'), new Date('2026-08-22T00:00:00.000Z'));

    activeDatabase?.run('INSERT INTO entries (value) VALUES (?)', ['third']);
    const third = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: backupDirectory,
      retention: 2,
      now: new Date('2026-08-23T00:00:00.000Z')
    });

    expect(third.prunedPaths).toEqual([first.path]);
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.existsSync(third.path)).toBe(true);
    expect(fs.readFileSync(path.join(backupDirectory, 'operator-notes.txt'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(backupDirectory, 'caster-media-manual.sqlite'), 'utf8')).toBe('keep me too');
  });

  test('validates and restores a snapshot to a separate unused database', () => {
    const result = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: path.join(testRoot, 'backups'),
      retention: 1
    });
    activeDatabase?.run('INSERT INTO entries (value) VALUES (?)', ['written-after-backup']);

    const restoredPath = path.join(testRoot, 'restore', 'media.restored.db');
    const restored = restoreDatabaseBackup({
      backupPath: result.path,
      destinationPath: restoredPath,
      activeDatabasePath
    });

    expect(restored.integrityCheck).toBe('ok');
    expect(validateDatabaseFile(restoredPath).integrityCheck).toBe('ok');

    const restoredDatabase = new Database(restoredPath, { readonly: true });
    expect(restoredDatabase.query('SELECT value FROM entries ORDER BY id').all()).toEqual([
      { value: 'committed-in-wal' }
    ]);
    restoredDatabase.close();

    expect(activeDatabase?.query('SELECT value FROM entries ORDER BY id').all()).toEqual([
      { value: 'committed-in-wal' },
      { value: 'written-after-backup' }
    ]);
    expect(fs.existsSync(`${restoredPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${restoredPath}-shm`)).toBe(false);
  });

  test('exposes validation through the documented operations command', () => {
    const backup = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: path.join(testRoot, 'backups'),
      retention: 1
    });
    const command = Bun.spawnSync({
      cmd: [
        process.execPath,
        'run',
        path.resolve('apps/server/src/db/backup.ts'),
        'validate',
        '--backup',
        backup.path
      ],
      cwd: path.resolve('.'),
      stdout: 'pipe',
      stderr: 'pipe'
    });

    expect(command.exitCode).toBe(0);
    expect(JSON.parse(command.stdout.toString())).toMatchObject({
      path: backup.path,
      integrityCheck: 'ok'
    });
  });

  test('refuses unsafe restore destinations and corrupt backup files', () => {
    const backup = createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: path.join(testRoot, 'backups'),
      retention: 1
    });

    expect(() => restoreDatabaseBackup({
      backupPath: backup.path,
      destinationPath: activeDatabasePath,
      activeDatabasePath
    })).toThrow('Restore destination must differ from the active database');

    expect(() => restoreDatabaseBackup({
      backupPath: activeDatabasePath,
      destinationPath: path.join(testRoot, 'unsafe-copy.db'),
      activeDatabasePath
    })).toThrow('Backup must differ from the active database');

    const existingDestination = path.join(testRoot, 'existing.db');
    fs.writeFileSync(existingDestination, 'do not overwrite');
    expect(() => restoreDatabaseBackup({
      backupPath: backup.path,
      destinationPath: existingDestination,
      activeDatabasePath
    })).toThrow('Restore destination already exists');
    expect(fs.readFileSync(existingDestination, 'utf8')).toBe('do not overwrite');

    const corruptBackup = path.join(testRoot, 'corrupt.sqlite');
    const corruptDestination = path.join(testRoot, 'corrupt-restored.db');
    fs.writeFileSync(corruptBackup, 'not a sqlite database');
    expect(() => restoreDatabaseBackup({
      backupPath: corruptBackup,
      destinationPath: corruptDestination,
      activeDatabasePath
    })).toThrow('Invalid SQLite database');
    expect(fs.existsSync(corruptDestination)).toBe(false);
  });

  test('rejects invalid retention before creating a backup', () => {
    const backupDirectory = path.join(testRoot, 'backups');
    expect(() => createDatabaseBackup({
      databasePath: activeDatabasePath,
      destinationDirectory: backupDirectory,
      retention: 0
    })).toThrow('Backup retention must be a positive integer');
    expect(fs.existsSync(backupDirectory)).toBe(true);
    expect(fs.readdirSync(backupDirectory)).toEqual([]);
  });
});
