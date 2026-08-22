import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { MediaMetadata, MediaStreamTrack, MediaType } from '../types';

export function parseFilename(filename: string, libraryType: 'movies' | 'tv' | 'music' | 'home_videos'): {
  title: string;
  year?: number;
  type: MediaType;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
} {
  const baseName = path.parse(filename).name;

  if (libraryType === 'tv') {
    // Matches: Show.Name.S01E02, Show Name - S01E02 - Episode Name, Show Name 1x02
    const sxxExxMatch = baseName.match(/^(.*?)[ ._-]+[sS](\d{1,2})[eE](\d{1,3})(?:[ ._-]+(.*))?$/i) ||
                        baseName.match(/^(.*?)[ ._-]+(\d{1,2})x(\d{1,3})(?:[ ._-]+(.*))?$/i);

    if (sxxExxMatch) {
      const rawSeries = sxxExxMatch[1].replace(/[._]/g, ' ').trim();
      const seasonNumber = parseInt(sxxExxMatch[2], 10);
      const episodeNumber = parseInt(sxxExxMatch[3], 10);
      const episodeTitle = sxxExxMatch[4] ? cleanTitle(sxxExxMatch[4]) : `Episode ${episodeNumber}`;

      return {
        title: episodeTitle,
        seriesTitle: cleanTitle(rawSeries),
        seasonNumber,
        episodeNumber,
        type: 'episode'
      };
    }

    return {
      title: cleanTitle(baseName),
      type: 'episode'
    };
  }

  if (libraryType === 'music') {
    return {
      title: cleanTitle(baseName),
      type: 'track'
    };
  }

  // Movie or home video: extract Year if present, e.g., "Inception.2010.1080p"
  const yearMatch = baseName.match(/[ ._(\[]((?:19|20)\d{2})[ ._)\]]/);
  let year: number | undefined;
  let rawTitle = baseName;

  if (yearMatch && yearMatch.index !== undefined) {
    year = parseInt(yearMatch[1], 10);
    rawTitle = baseName.substring(0, yearMatch.index);
  }

  return {
    title: cleanTitle(rawTitle),
    year,
    type: libraryType === 'home_videos' ? 'video' : 'movie'
  };
}

function cleanTitle(str: string): string {
  return str
    .replace(/[._]/g, ' ')
    .replace(/\[.*?\]/g, '') // remove brackets
    .replace(/\(.*?\)/g, '') // remove parens
    .replace(/\b(1080p|720p|480p|2160p|4k|uhd|hdr|bluray|web-dl|webrip|x264|x265|hevc|aac|dts|remux)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function extractMediaMetadata(filePath: string): Promise<MediaMetadata | null> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);

    let output = '';
    ffprobe.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0 || !output) {
        // Fallback for missing ffprobe or unreadable file
        try {
          const stats = fs.statSync(filePath);
          resolve({
            duration: 0,
            size: stats.size,
            format_name: path.extname(filePath).replace('.', ''),
            streams: []
          });
        } catch {
          resolve(null);
        }
        return;
      }

      try {
        const data = JSON.parse(output);
        const format = data.format || {};
        const rawStreams = data.streams || [];

        const duration = parseFloat(format.duration || '0');
        const size = parseInt(format.size || '0', 10);
        const bit_rate = parseInt(format.bit_rate || '0', 10);

        const streams: MediaStreamTrack[] = rawStreams.map((s: any) => ({
          index: s.index,
          codec_type: s.codec_type,
          codec_name: s.codec_name,
          codec_long_name: s.codec_long_name,
          profile: s.profile,
          width: s.width,
          height: s.height,
          r_frame_rate: s.r_frame_rate,
          bit_rate: s.bit_rate,
          channels: s.channels,
          channel_layout: s.channel_layout,
          sample_rate: s.sample_rate,
          language: s.tags?.language || s.tags?.LANGUAGE,
          title: s.tags?.title || s.tags?.TITLE,
          is_default: s.disposition?.default === 1,
          is_forced: s.disposition?.forced === 1,
          color_space: s.color_space,
          color_transfer: s.color_transfer,
          color_primaries: s.color_primaries
        }));

        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');

        let videoMeta: MediaMetadata['video'];
        if (videoStream && videoStream.width && videoStream.height) {
          const width = videoStream.width;
          const height = videoStream.height;

          let label = 'SD';
          if (width >= 3800 || height >= 2100) label = '4K UHD';
          else if (width >= 1900 || height >= 1000) label = '1080p FHD';
          else if (width >= 1200 || height >= 700) label = '720p HD';
          else if (width >= 800 || height >= 450) label = '480p';

          let fps = 24;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            if (num && den) fps = Math.round((num / den) * 100) / 100;
          }

          const isHdr = (videoStream.color_transfer && /smpte2084|arib-std-b67/i.test(videoStream.color_transfer)) ||
                        (videoStream.color_primaries && /bt2020/i.test(videoStream.color_primaries)) || false;

          videoMeta = {
            codec: videoStream.codec_name,
            width,
            height,
            frame_rate: fps,
            bit_rate: typeof videoStream.bit_rate === 'number' ? videoStream.bit_rate : parseInt(videoStream.bit_rate || '0', 10),
            resolution_label: label,
            is_hdr: isHdr,
            color_space: videoStream.color_space
          };
        }

        let audioMeta: MediaMetadata['audio'];
        if (audioStream) {
          audioMeta = {
            codec: audioStream.codec_name,
            channels: audioStream.channels || 2,
            channel_layout: audioStream.channel_layout || (audioStream.channels === 6 ? '5.1' : 'stereo'),
            sample_rate: audioStream.sample_rate ? parseInt(audioStream.sample_rate, 10) : 48000,
            language: audioStream.language
          };
        }

        resolve({
          duration,
          size,
          bit_rate,
          format_name: format.format_name,
          video: videoMeta,
          audio: audioMeta,
          streams
        });
      } catch (err) {
        console.error('Error parsing ffprobe output:', err);
        resolve(null);
      }
    });

    ffprobe.on('error', () => {
      resolve(null);
    });
  });
}

export async function generateThumbnail(videoPath: string, outputPath: string, atSeconds: number = 30): Promise<boolean> {
  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-ss', atSeconds.toString(),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=640:-1',
      '-q:v', '3',
      outputPath
    ]);

    ffmpeg.on('close', (code) => {
      resolve(code === 0 && fs.existsSync(outputPath));
    });

    ffmpeg.on('error', () => {
      resolve(false);
    });
  });
}
