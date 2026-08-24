package dev.caster.android.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val CasterJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = true
}

@Serializable
data class AuthSession(
    val authenticated: Boolean = false,
    val configured: Boolean = false,
)

@Serializable
data class HealthResponse(
    val status: String = "unknown",
    val service: String = "Caster",
    val time: String = "",
)

@Serializable
data class WatchProgress(
    val id: String = "",
    @SerialName("user_id") val userId: String = "",
    @SerialName("media_id") val mediaId: String = "",
    @SerialName("position_seconds") val positionSeconds: Double = 0.0,
    @SerialName("duration_seconds") val durationSeconds: Double = 0.0,
    @SerialName("progress_percent") val progressPercent: Double = 0.0,
    val completed: Boolean = false,
    @SerialName("last_watched_at") val lastWatchedAt: String = "",
)

@Serializable
data class MediaStreamTrack(
    val index: Int = 0,
    @SerialName("codec_type") val codecType: String = "",
    @SerialName("codec_name") val codecName: String = "",
    val language: String? = null,
    val title: String? = null,
    @SerialName("is_default") val isDefault: Boolean = false,
    @SerialName("is_forced") val isForced: Boolean = false,
)

@Serializable
data class MediaItem(
    val id: String,
    @SerialName("library_id") val libraryId: String = "",
    val title: String,
    @SerialName("original_filename") val originalFilename: String = "",
    @SerialName("relative_path") val relativePath: String = "",
    val type: String = "video",
    @SerialName("series_title") val seriesTitle: String? = null,
    @SerialName("season_number") val seasonNumber: Int? = null,
    @SerialName("episode_number") val episodeNumber: Int? = null,
    val year: Int? = null,
    val duration: Double = 0.0,
    @SerialName("size_bytes") val sizeBytes: Long = 0L,
    val format: String = "",
    @SerialName("video_codec") val videoCodec: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    @SerialName("resolution_label") val resolutionLabel: String? = null,
    @SerialName("is_hdr") val isHdr: Boolean = false,
    @SerialName("audio_codec") val audioCodec: String? = null,
    @SerialName("audio_channels") val audioChannels: Int? = null,
    @SerialName("audio_language") val audioLanguage: String? = null,
    @SerialName("streams_json") val streamsJson: String = "[]",
    @SerialName("poster_path") val posterPath: String? = null,
    @SerialName("library_name") val libraryName: String? = null,
    val progress: WatchProgress? = null,
) {
    val episodeLabel: String?
        get() = if (type == "episode") {
            "S${(seasonNumber ?: 0).toString().padStart(2, '0')}E${(episodeNumber ?: 0).toString().padStart(2, '0')}"
        } else null

    fun subtitleTracks(): List<MediaStreamTrack> = runCatching {
        CasterJson.decodeFromString<List<MediaStreamTrack>>(streamsJson)
            .filter { it.codecType == "subtitle" }
    }.getOrDefault(emptyList())
}

@Serializable
data class Series(
    val id: String,
    val title: String,
    @SerialName("library_id") val libraryId: String = "",
    @SerialName("library_name") val libraryName: String? = null,
    val year: Int? = null,
    @SerialName("episode_count") val episodeCount: Int = 0,
    @SerialName("season_count") val seasonCount: Int = 0,
    @SerialName("total_duration") val totalDuration: Double = 0.0,
    @SerialName("watched_count") val watchedCount: Int = 0,
    @SerialName("poster_path") val posterPath: String? = null,
)

@Serializable
data class SeriesSeason(
    @SerialName("season_number") val seasonNumber: Int,
    @SerialName("episode_count") val episodeCount: Int = 0,
    @SerialName("total_duration") val totalDuration: Double = 0.0,
    @SerialName("watched_count") val watchedCount: Int = 0,
)

@Serializable
data class Library(
    val id: String,
    val name: String,
    val path: String = "",
    val type: String = "movies",
    @SerialName("last_scanned_at") val lastScannedAt: String? = null,
    @SerialName("item_count") val itemCount: Int = 0,
)

@Serializable
data class HardwareStatus(
    @SerialName("accelType") val accelType: String = "none",
    @SerialName("ffmpegVersion") val ffmpegVersion: String = "Unknown",
    @SerialName("qsvSupported") val qsvSupported: Boolean = false,
    @SerialName("nvencSupported") val nvencSupported: Boolean = false,
    @SerialName("vaapiSupported") val vaapiSupported: Boolean = false,
    @SerialName("activeTranscodes") val activeTranscodes: Int = 0,
)

@Serializable
data class SystemStatus(
    val server: String = "Caster",
    val version: String = "",
    val platform: String = "",
    val arch: String = "",
    val uptime: Double = 0.0,
    val hardware: HardwareStatus = HardwareStatus(),
)

@Serializable
data class ScanStatus(
    @SerialName("isScanning") val isScanning: Boolean = false,
    @SerialName("libraryId") val libraryId: String? = null,
    @SerialName("totalFiles") val totalFiles: Int = 0,
    @SerialName("processedFiles") val processedFiles: Int = 0,
    @SerialName("currentFile") val currentFile: String = "",
    val errors: List<String> = emptyList(),
)

@Serializable data class LibrariesResponse(val libraries: List<Library> = emptyList())
@Serializable data class MediaResponse(val items: List<MediaItem> = emptyList(), val total: Int = 0)
@Serializable data class SeriesResponse(val items: List<Series> = emptyList())
@Serializable data class MediaListResponse(val items: List<MediaItem> = emptyList())
@Serializable data class MediaDetailResponse(val item: MediaItem)
@Serializable data class SeriesDetailResponse(val series: Series, val seasons: List<SeriesSeason> = emptyList())
@Serializable data class SeriesEpisodesResponse(val series: Series, val items: List<MediaItem> = emptyList())
@Serializable data class ErrorResponse(val error: String = "Request failed")
@Serializable data class SuccessResponse(val success: Boolean = false)
@Serializable data class ScanStartResponse(val status: String = "")
@Serializable data class HardwareRequest(val accel: String)
@Serializable data class ProgressRequest(val position: Double, val duration: Double)
