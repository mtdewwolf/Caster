import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BACKUP_RETENTION = 7;

const BACKUP_FILENAME_PATTERN =
  /^caster-media-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/i;

export interface CreateDatabaseBackupOptions {
  databasePath: string;
  destinationDirectory: string;
  retention?: number;
  /** Allows callers and tests to supply the timestamp used in the filename. */
  now?: Date;
}

export interface WalCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

export interface DatabaseFileValidation {
  path: string;
  sizeBytes: number;
  integrityCheck: 'ok';
}

export interface DatabaseBackupResult extends DatabaseFileValidation {
  createdAt: string;
  checkpoint: WalCheckpointResult;
  prunedPaths: string[];
}

export interface RestoreDatabaseBackupOptions {
  backupPath: string;
  destinationPath: string;
  /**
   * The path Caster currently uses. Restore always stages to another path and
   * refuses to replace this file while a process may still have it open.
   */
  activeDatabasePath: string;
}

/**
 * Create a standalone, consistent snapshot of a live SQLite database.
 *
 * VACUUM INTO is deliberately used instead of copying media.db. A plain file
 * copy can omit committed pages that still live in the WAL sidecar.
 */
export function createDatabaseBackup(options: CreateDatabaseBackupOptions): DatabaseBackupResult {
  const databasePath = requireRegularFile(options.databasePath, 'Database');
  const destinationDirectory = ensureDirectory(options.destinationDirectory, 'Backup destination');
  const retention = validateRetention(options.retention ?? DEFAULT_BACKUP_RETENTION);
  const createdAt = validateDate(options.now ?? new Date()).toISOString();
  const identifier = crypto.randomUUID();
  const timestamp = createdAt.replaceAll(':', '-');
  const backupPath = path.join(
    destinationDirectory,
    `caster-media-${timestamp}-${identifier}.sqlite`
  );
  const temporaryPath = path.join(destinationDirectory, `.caster-backup-${identifier}.tmp`);

  assertDistinctPaths(databasePath, backupPath, 'Backup destination must differ from the active database');
  assertPathDoesNotExist(backupPath, 'Backup destination');
  assertPathDoesNotExist(temporaryPath, 'Temporary backup');

  let database: Database | undefined;
  let checkpoint: WalCheckpointResult;
  try {
    database = new Database(databasePath, { create: false, strict: true });
    database.run('PRAGMA busy_timeout = 5000');
    checkpoint = checkpointWal(database);

    // The filename is bound as data rather than interpolated into SQL.
    database.run('VACUUM main INTO ?', [temporaryPath]);
  } catch (error) {
    removeOwnedFile(temporaryPath);
    throw contextualError('Failed to create SQLite backup', error);
  } finally {
    database?.close();
  }

  let validation: DatabaseFileValidation;
  try {
    validation = validateDatabaseFile(temporaryPath);
    // The UUID makes a collision extraordinarily unlikely. The explicit
    // existence check also prevents an accidental overwrite in normal use.
    assertPathDoesNotExist(backupPath, 'Backup destination');
    fs.renameSync(temporaryPath, backupPath);
  } catch (error) {
    removeOwnedFile(temporaryPath);
    throw contextualError('SQLite backup validation failed', error);
  }

  const prunedPaths = pruneDatabaseBackups(destinationDirectory, retention);

  return {
    path: backupPath,
    sizeBytes: validation.sizeBytes,
    integrityCheck: 'ok',
    createdAt,
    checkpoint,
    prunedPaths
  };
}

/** Validate that a standalone file is a structurally sound SQLite database. */
export function validateDatabaseFile(databasePath: string): DatabaseFileValidation {
  const resolvedPath = requireRegularFile(databasePath, 'Database file');
  let database: Database | undefined;

  try {
    database = new Database(resolvedPath, { readonly: true, strict: true });
    const rows = database.query('PRAGMA integrity_check').values() as unknown[][];
    const messages = rows.map((row) => String(row[0]));

    if (messages.length !== 1 || messages[0]?.toLowerCase() !== 'ok') {
      throw new Error(messages.join('; ') || 'integrity_check returned no result');
    }
  } catch (error) {
    throw contextualError(`Invalid SQLite database at ${resolvedPath}`, error);
  } finally {
    database?.close();
  }

  return {
    path: resolvedPath,
    sizeBytes: fs.statSync(resolvedPath).size,
    integrityCheck: 'ok'
  };
}

/**
 * Restore a validated backup to a new, unused path.
 *
 * The active database is never overwritten. Operators can stop Caster,
 * preserve the old database and its sidecars, then promote the staged file.
 */
export function restoreDatabaseBackup(options: RestoreDatabaseBackupOptions): DatabaseFileValidation {
  const backupPath = requireRegularFile(options.backupPath, 'Backup');
  const activeDatabasePath = requireFilesystemPath(options.activeDatabasePath, 'Active database');
  const destinationPath = requireFilesystemPath(options.destinationPath, 'Restore destination');
  const destinationDirectory = ensureDirectory(path.dirname(destinationPath), 'Restore destination directory');
  const canonicalDestination = path.join(destinationDirectory, path.basename(destinationPath));

  assertDistinctPaths(backupPath, activeDatabasePath, 'Backup must differ from the active database');
  assertDistinctPaths(backupPath, canonicalDestination, 'Restore destination must differ from the backup');
  assertDistinctPaths(
    activeDatabasePath,
    canonicalDestination,
    'Restore destination must differ from the active database'
  );
  assertPathDoesNotExist(canonicalDestination, 'Restore destination');
  validateDatabaseFile(backupPath);

  let destinationCreated = false;
  try {
    fs.copyFileSync(backupPath, canonicalDestination, fs.constants.COPYFILE_EXCL);
    destinationCreated = true;
    return validateDatabaseFile(canonicalDestination);
  } catch (error) {
    if (destinationCreated) removeOwnedFile(canonicalDestination);
    throw contextualError('Failed to restore SQLite backup', error);
  }
}

/** Remove only older files created by this module, leaving unrelated files alone. */
export function pruneDatabaseBackups(destinationDirectory: string, retention: number): string[] {
  const resolvedDirectory = requireDirectory(destinationDirectory, 'Backup destination');
  const keep = validateRetention(retention);
  const candidates = fs.readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILENAME_PATTERN.test(entry.name))
    .map((entry) => {
      const candidatePath = path.join(resolvedDirectory, entry.name);
      return {
        path: candidatePath,
        name: entry.name,
        modifiedAt: fs.statSync(candidatePath).mtimeMs
      };
    })
    .sort((left, right) =>
      right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name)
    );

  const prunedPaths: string[] = [];
  for (const candidate of candidates.slice(keep)) {
    fs.unlinkSync(candidate.path);
    prunedPaths.push(candidate.path);
  }
  return prunedPaths;
}

function checkpointWal(database: Database): WalCheckpointResult {
  const row = database.query('PRAGMA wal_checkpoint(PASSIVE)').get() as
    | Record<string, number>
    | null;
  const values = row ? Object.values(row).map(Number) : [];

  return {
    busy: Number(row?.busy ?? values[0] ?? 0),
    logFrames: Number(row?.log ?? values[1] ?? -1),
    checkpointedFrames: Number(row?.checkpointed ?? values[2] ?? -1)
  };
}

function validateRetention(retention: number): number {
  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new Error('Backup retention must be a positive integer');
  }
  return retention;
}

function validateDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('Backup timestamp must be a valid Date');
  }
  return value;
}

function requireFilesystemPath(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error(`${label} path must be a non-empty filesystem path`);
  }
  if (value === ':memory:') {
    throw new Error(`${label} must be file-backed`);
  }
  return path.resolve(value);
}

function requireRegularFile(value: string, label: string): string {
  const resolvedPath = requireFilesystemPath(value, label);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolvedPath);
  } catch {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${resolvedPath}`);
  }
  return fs.realpathSync.native(resolvedPath);
}

function requireDirectory(value: string, label: string): string {
  const resolvedPath = requireFilesystemPath(value, label);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory: ${resolvedPath}`);
  }
  return fs.realpathSync.native(resolvedPath);
}

function ensureDirectory(value: string, label: string): string {
  const resolvedPath = requireFilesystemPath(value, label);
  fs.mkdirSync(resolvedPath, { recursive: true });
  return requireDirectory(resolvedPath, label);
}

function assertPathDoesNotExist(candidatePath: string, label: string): void {
  try {
    fs.lstatSync(candidatePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error(`${label} already exists: ${candidatePath}`);
}

function assertDistinctPaths(left: string, right: string, message: string): void {
  if (comparablePath(left) === comparablePath(right)) {
    throw new Error(message);
  }
}

function comparablePath(value: string): string {
  const resolvedPath = path.resolve(value);
  const existingPath = fs.existsSync(resolvedPath)
    ? fs.realpathSync.native(resolvedPath)
    : path.join(fs.realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
  return process.platform === 'win32' ? existingPath.toLowerCase() : existingPath;
}

function removeOwnedFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function contextualError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${detail}`, { cause: error });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseArguments(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; received ${key ?? '(nothing)'}`);
    }
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function requiredArgument(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing required --${name} argument`);
  return value;
}

function runCommandLine(): void {
  const [command, ...rawArguments] = process.argv.slice(2);
  const args = parseArguments(rawArguments);

  if (command === 'backup') {
    const retentionValue = args.get('retention');
    const result = createDatabaseBackup({
      databasePath: requiredArgument(args, 'database'),
      destinationDirectory: requiredArgument(args, 'destination'),
      retention: retentionValue === undefined ? DEFAULT_BACKUP_RETENTION : Number(retentionValue)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'validate') {
    console.log(JSON.stringify(validateDatabaseFile(requiredArgument(args, 'backup')), null, 2));
    return;
  }

  if (command === 'restore') {
    const result = restoreDatabaseBackup({
      backupPath: requiredArgument(args, 'backup'),
      destinationPath: requiredArgument(args, 'destination'),
      activeDatabasePath: requiredArgument(args, 'active-database')
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(
    'Usage: backup --database <media.db> --destination <dir> [--retention <count>] | ' +
    'validate --backup <file> | restore --backup <file> --destination <staged.db> ' +
    '--active-database <media.db>'
  );
}

if (import.meta.main) {
  try {
    runCommandLine();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
