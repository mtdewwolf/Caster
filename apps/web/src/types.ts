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
  /** True for a sidecar file discovered next to the media, not an embedded track. */
  is_external?: boolean;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
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

export interface PlaybackMarker {
  type: 'intro' | 'credits';
  startSeconds: number;
  endSeconds: number;
  source: string;
  confidence?: number | null;
}

export interface PlaybackDescriptor {
  markers: PlaybackMarker[];
  nextEpisode: MediaItem | null;
}

export interface MediaItem {
  id: string;
  library_id: string;
  title: string;
  original_filename: string;
  relative_path: string;
  /** Only administrators receive the server's absolute filesystem path. */
  full_path?: string;
  type: MediaType;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  year?: number;
  duration: number;
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
  artist?: string;
  album_artist?: string;
  album?: string;
  track_number?: number;
  disc_number?: number;
  genre?: string;
  streams_json: string;
  poster_path?: string;
  created_at: string;
  updated_at: string;
  library_name?: string;
  progress?: WatchProgress;
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

export interface ArtistSummary {
  id: string;
  name: string;
  library_id: string;
  library_name?: string;
  album_count: number;
  track_count: number;
  total_duration: number;
  poster_path?: string;
}

export interface AlbumSummary {
  id: string;
  title: string;
  album_artist: string;
  library_id: string;
  library_name?: string;
  year?: number;
  track_count: number;
  total_duration: number;
  poster_path?: string;
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

export interface SystemHardwareStatus {
  accelType: 'qsv' | 'nvenc' | 'vaapi' | 'none';
  devicePath?: string;
  ffmpegVersion: string;
  qsvSupported: boolean;
  nvencSupported: boolean;
  vaapiSupported: boolean;
  activeTranscodes: number;
  /** Output codecs this FFmpeg build can produce at all. */
  outputCodecs?: { h264: boolean; hevc: boolean; av1: boolean };
  /** The subset of those a GPU can produce, which is what decides their use. */
  hardwareCodecs?: { h264: boolean; hevc: boolean; av1: boolean };
}

export interface ScanStatus {
  isScanning: boolean;
  libraryId: string | null;
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  errors: string[];
}

export interface FilesystemEntry {
  name: string;
  path: string;
  hasMedia: boolean;
}

export interface BrowseResult {
  isRoot: boolean;
  current: string;
  parent: string | null;
  entries: FilesystemEntry[];
}

export interface MetadataCredit {
  name: string;
  role?: string;
  character?: string;
  order?: number;
  profileUrl?: string;
}

export interface MetadataArtwork {
  providerId: string;
  kind: string;
  url: string;
  width: number | null;
  height: number | null;
  language: string | null;
}

/** Descriptive metadata from a provider, kept separate from scanner-derived fields. */
export interface MediaMetadata {
  subject: { type: 'media' | 'series'; id: string };
  providerId: string | null;
  externalId: string | null;
  title: string | null;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  releaseDate: string | null;
  genres: string[];
  studios: string[];
  networks: string[];
  rating: number | null;
  contentRating: string | null;
  cast: MetadataCredit[];
  crew: MetadataCredit[];
  externalIds: Array<{ providerId: string; externalId: string }>;
  matchConfidence: number | null;
  matchSource: 'provider' | 'manual';
  locked: boolean;
  refreshedAt: string;
  artwork: MetadataArtwork[];
}

/** The server's decision about how this file reaches this device. */
export interface PlaybackDecision {
  method: 'direct' | 'remux' | 'transcode';
  videoAction: 'copy' | 'transcode';
  audioAction: 'copy' | 'transcode';
  toneMap: boolean;
  reasons: string[];
  /** One sentence a person can act on. */
  summary: string;
}

/** One playable file under a logical title. */
export interface MediaVersion {
  mediaId: string;
  label: string;
  resolutionLabel: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannelLayout: string | null;
  isHdr: boolean;
  format: string;
  durationSeconds: number;
  sizeBytes: number;
  isPreferred: boolean;
}

export interface MetadataCandidate {
  providerId: string;
  externalId: string;
  entityType: string;
  title: string;
  originalTitle?: string;
  overview?: string;
  releaseDate?: string;
  year?: number;
  score?: number;
  poster?: MetadataArtwork;
}
