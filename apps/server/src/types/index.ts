export type MediaType = 'movie' | 'episode' | 'track' | 'video';
export type LibraryType = 'movies' | 'tv' | 'music' | 'home_videos';

export interface MediaStreamTrack {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle';
  codec_name: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  bit_rate?: string | number;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  language?: string;
  title?: string;
   is_default?: boolean;
   is_forced?: boolean;
   is_external?: boolean;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
}

export interface MediaMetadata {
  duration: number; // in seconds
  size: number; // in bytes
  bit_rate?: number;
  format_name?: string;
  video?: {
    codec: string;
    width: number;
    height: number;
    frame_rate: number;
    bit_rate?: number;
    resolution_label: string; // '4K UHD' | '1080p FHD' | '720p HD' | '480p' | 'SD'
    is_hdr: boolean;
    color_space?: string;
  };
  audio?: {
    codec: string;
    channels: number;
    channel_layout?: string;
    sample_rate?: number;
    language?: string;
  };
  streams: MediaStreamTrack[];
}

export interface MediaItem {
  id: string;
  library_id: string;
  title: string;
  original_filename: string;
  relative_path: string;
  full_path: string;
  type: MediaType;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  year?: number;
  duration: number; // seconds
  size_bytes: number;
  format: string;
  video_codec?: string;
  width?: number;
  height?: number;
  resolution_label?: string;
  frame_rate?: number;
  bit_rate?: number;
  is_hdr: boolean;
  audio_codec?: string;
  audio_channels?: number;
  audio_channel_layout?: string;
  audio_language?: string;
  streams_json: string; // JSON of MediaStreamTrack[]
  poster_path?: string;
  created_at: string;
  updated_at: string;
  
  // Dynamic join fields
  progress?: WatchProgress;
  library_name?: string;
}

export interface Library {
  id: string;
  name: string;
  path: string;
  type: LibraryType;
  last_scanned_at?: string;
  item_count: number;
  created_at: string;
}

export interface Series {
  id: string;
  title: string;
  library_id: string;
  library_name?: string;
  year?: number;
  episode_count: number;
  season_count: number;
  total_duration: number;
  watched_count: number;
  poster_path?: string;
}

export interface SeriesSeason {
  season_number: number;
  episode_count: number;
  total_duration: number;
  watched_count: number;
}

export interface WatchProgress {
  id: string;
  user_id: string;
  media_id: string;
  position_seconds: number;
  duration_seconds: number;
  progress_percent: number;
  completed: boolean;
  last_watched_at: string;
}

export type TranscodeQuality = 'original' | '1080p' | '720p' | '480p' | '360p';
export type HardwareAccelType = 'qsv' | 'nvenc' | 'vaapi' | 'none';

export interface QualityProfile {
  name: TranscodeQuality;
  width: number;
  height: number;
  videoBitrate: string;
  maxBitrate: string;
  audioBitrate: string;
  bufsize: string;
}

export interface SystemHardwareStatus {
  accelType: HardwareAccelType;
  devicePath?: string;
  ffmpegVersion: string;
  qsvSupported: boolean;
  nvencSupported: boolean;
  vaapiSupported: boolean;
  activeTranscodes: number;
}

export interface TranscodeCacheStatus {
  cacheDir: string;
  fileCount: number;
  totalSizeBytes: number;
  totalSizeMb: number;
  maxAgeHours: number;
  maxSizeMb: number;
}

export interface CacheCleanResult {
  deletedCount: number;
  bytesFreed: number;
  remainingCount: number;
  remainingBytes: number;
}

