import fs from 'fs';
import path from 'path';

export const EXTERNAL_SUBTITLE_INDEX_BASE = 1000;

const SUBTITLE_EXTENSIONS = new Set(['.srt']);
const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i;
const FLAG_TAGS = new Set(['forced', 'default', 'sdh', 'cc', 'hi', 'foreign']);

export interface DiscoveredSidecar {
  path: string;
  filename: string;
  language?: string;
}

export function findExternalSubtitles(videoPath: string): DiscoveredSidecar[] {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const videoStem = path.basename(videoPath, ext);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: DiscoveredSidecar[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sidecarExt = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(sidecarExt)) continue;

    const stem = entry.name.slice(0, entry.name.length - sidecarExt.length);
    const lowerStem = stem.toLowerCase();
    const lowerVideoStem = videoStem.toLowerCase();
    if (lowerStem !== lowerVideoStem && !lowerStem.startsWith(`${lowerVideoStem}.`)) continue;

    const suffix = stem.slice(videoStem.length).replace(/^[.\s_-]+/, '');
    const tags = suffix ? suffix.split(/[.\s_-]+/).filter(Boolean) : [];
    const langTag = tags.find((tag) => LANGUAGE_TAG_RE.test(tag) && !FLAG_TAGS.has(tag.toLowerCase()));

    found.push({
      path: path.join(dir, entry.name),
      filename: entry.name,
      language: langTag ? langTag.toLowerCase().replace('_', '-') : undefined
    });
  }

  found.sort((a, b) => a.filename.localeCompare(b.filename));
  return found;
}

export function convertSrtToVtt(srtContent: string): string {
  let body = srtContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\uFEFF?WEBVTT/i.test(body)) {
    return body.replace(/(\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3}/g, (m) => m.replace(',', '.'));
  }
  body = body.replace(/(\d{1,2}:)?\d{2}:\d{2},\d{1,3}/g, (m) => m.replace(',', '.'));
  return `WEBVTT\n\n${body.replace(/^\n+/, '').trimEnd()}\n`;
}
