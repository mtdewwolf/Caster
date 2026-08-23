import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';

export const fsRouter = new Hono();

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.ts', '.m4v', '.flv', '.wmv', '.iso']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.wma', '.alac']);

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '@eaDir',
  '#recycle',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
  '.snapshots',
  '.git'
]);

interface FilesystemEntry {
  name: string;
  path: string;
  hasMedia: boolean;
}

interface BrowseResult {
  isRoot: boolean;
  current: string;
  parent: string | null;
  entries: FilesystemEntry[];
}

function isMediaFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
}

function listDriveRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let i = 67; i <= 90; i++) {
    const letter = `${String.fromCharCode(i)}:\\`;
    try {
      if (fs.existsSync(letter)) drives.push(letter);
    } catch {
      // ignore inaccessible drives
    }
  }
  return drives;
}

function safeReadDir(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function directoryHasMedia(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).some(
      (entry) => entry.isFile() && isMediaFile(entry.name)
    );
  } catch {
    return false;
  }
}

function normalizeExistingDir(requestedPath: string): string | null {
  try {
    const resolved = path.resolve(requestedPath);
    if (!fs.existsSync(resolved)) return null;
    if (!fs.statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

fsRouter.get('/browse', (c) => {
  const requestedPath = c.req.query('path');

  if (!requestedPath || !requestedPath.trim()) {
    const entries: FilesystemEntry[] = listDriveRoots().map((root) => ({
      name: process.platform === 'win32' ? root : root === '/' ? '/' : path.basename(root) || root,
      path: root,
      hasMedia: false
    }));
    if (process.platform !== 'win32') {
      const extra = ['/mnt', '/media', '/data', '/srv']
        .filter((dir) => fs.existsSync(dir))
        .map((dir) => ({ name: path.basename(dir), path: dir, hasMedia: false }));
      const seen = new Set(entries.map((e) => e.path));
      for (const item of extra) {
        if (!seen.has(item.path)) entries.push(item);
      }
    }
    const result: BrowseResult = { isRoot: true, current: '', parent: null, entries };
    return c.json(result);
  }

  const current = normalizeExistingDir(requestedPath);
  if (!current) {
    return c.json({ error: 'Path not found or not accessible' }, 404);
  }

  const parent = path.dirname(current);
  const entries: FilesystemEntry[] = safeReadDir(current)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIR_NAMES.has(entry.name))
    .map((entry) => {
      const fullPath = path.join(current, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        hasMedia: directoryHasMedia(fullPath)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const result: BrowseResult = {
    isRoot: false,
    current,
    parent: parent === current ? null : parent,
    entries
  };
  return c.json(result);
});
