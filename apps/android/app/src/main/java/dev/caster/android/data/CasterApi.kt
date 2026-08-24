package dev.caster.android.data

import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApiException(
    override val message: String,
    val statusCode: Int,
) : IOException(message)

data class ConnectionTestResult(
    val health: HealthResponse,
    val auth: AuthSession,
)

class CasterApi(
    private val settings: ConnectionSettings,
    val client: OkHttpClient = defaultClient(),
) {
    val baseUrl: String = normalizeServerUrl(settings.serverUrl)
    private val json = CasterJson

    suspend fun testConnection(): ConnectionTestResult {
        val health = execute<HealthResponse>("/health", apiRoute = false)
        val auth = execute<AuthSession>("/auth/session")
        // A healthy server may still reject catalog reads from remote networks.
        // Validate the first screen's actual capability before persisting it.
        execute<LibrariesResponse>("/libraries")
        return ConnectionTestResult(health, auth)
    }

    suspend fun libraries(): List<Library> = execute<LibrariesResponse>("/libraries").libraries

    suspend fun media(
        libraryId: String? = null,
        type: String? = null,
        search: String? = null,
        sort: String? = null,
        limit: Int = 100,
        offset: Int = 0,
    ): MediaResponse {
        val query = queryOf(
            "libraryId" to libraryId,
            "type" to type,
            "search" to search,
            "sort" to sort,
            "limit" to limit.toString(),
            "offset" to offset.toString(),
        )
        return execute("/media?$query")
    }

    suspend fun continueWatching(): List<MediaItem> =
        execute<MediaListResponse>("/media/continue-watching").items

    suspend fun progress(status: String? = null): List<MediaItem> {
        val suffix = status?.let { "?status=${encode(it)}" }.orEmpty()
        return execute<MediaListResponse>("/media/progress$suffix").items
    }

    suspend fun series(libraryId: String? = null, search: String? = null): List<Series> {
        val query = queryOf("libraryId" to libraryId, "search" to search)
        return execute<SeriesResponse>("/series${if (query.isBlank()) "" else "?$query"}").items
    }

    suspend fun mediaItem(id: String): MediaItem =
        execute<MediaDetailResponse>("/media/${encode(id)}").item

    suspend fun seriesDetail(id: String): SeriesDetailResponse =
        execute("/series/${encode(id)}")

    suspend fun seriesEpisodes(id: String): SeriesEpisodesResponse =
        execute("/series/${encode(id)}/episodes")

    suspend fun systemStatus(): SystemStatus = execute("/system/status")

    suspend fun scanStatus(): ScanStatus = execute("/libraries/scan/status")

    suspend fun scanAll() {
        execute<ScanStartResponse>("/libraries/scan-all", "POST")
    }

    suspend fun setHardwareAccel(accel: String) {
        execute<JsonObject>("/system/hardware/accel", "POST", json.encodeToString(HardwareRequest(accel)))
    }

    suspend fun updateProgress(id: String, position: Double, duration: Double) {
        if (duration <= 0.0) return
        execute<JsonObject>(
            "/media/${encode(id)}/progress",
            "POST",
            json.encodeToString(ProgressRequest(position.coerceAtLeast(0.0), duration)),
        )
    }

    suspend fun markWatched(id: String) {
        execute<JsonObject>("/media/${encode(id)}/progress/watched", "POST")
    }

    suspend fun markUnwatched(id: String) {
        execute<SuccessResponse>("/media/${encode(id)}/progress/unwatched", "POST")
    }

    fun thumbnailUrl(idOrPath: String): String = when {
        idOrPath.startsWith("http://") || idOrPath.startsWith("https://") -> idOrPath
        idOrPath.startsWith("/") -> "$baseUrl$idOrPath"
        else -> "$baseUrl/api/media/${encode(idOrPath)}/thumbnail"
    }
    fun directStreamUrl(id: String): String = "$baseUrl/api/media/${encode(id)}/stream"
    fun hlsUrl(id: String): String = "$baseUrl/api/media/${encode(id)}/hls/master.m3u8"
    fun subtitleUrl(id: String, index: Int): String = "$baseUrl/api/media/${encode(id)}/subtitles/$index"

    fun authHeaders(): Map<String, String> = if (settings.adminToken.isBlank()) emptyMap()
    else mapOf("Authorization" to "Bearer ${settings.adminToken}")

    private suspend inline fun <reified T> execute(
        path: String,
        method: String = "GET",
        body: String? = null,
        apiRoute: Boolean = true,
    ): T = withContext(Dispatchers.IO) {
        val prefix = if (apiRoute) "/api" else ""
        val url = "$baseUrl$prefix$path"
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (settings.adminToken.isNotBlank()) {
            builder.header("Authorization", "Bearer ${settings.adminToken}")
        }
        val requestBody = body?.toRequestBody(JSON_MEDIA_TYPE)
        when (method) {
            "POST" -> builder.post(requestBody ?: EMPTY_BODY)
            "DELETE" -> builder.delete(requestBody)
            else -> builder.get()
        }
        client.newCall(builder.build()).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val apiMessage = runCatching { json.decodeFromString<ErrorResponse>(responseBody).error }.getOrNull()
                throw ApiException(apiMessage ?: "Request failed (${response.code})", response.code)
            }
            runCatching { json.decodeFromString<T>(responseBody) }.getOrElse { cause ->
                throw IOException("Caster returned an unexpected response", cause)
            }
        }
    }

    private fun queryOf(vararg pairs: Pair<String, String?>): String = pairs
        .filter { !it.second.isNullOrBlank() }
        .joinToString("&") { (key, value) -> "${encode(key)}=${encode(value!!)}" }

    private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.toString())

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_BODY = ByteArray(0).toRequestBody(null)

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
