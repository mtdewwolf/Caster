package dev.caster.android.data

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

data class HomeData(
    val libraries: List<Library>,
    val continueWatching: List<MediaItem>,
    val recentMedia: List<MediaItem>,
    val series: List<Series>,
)

data class ServerData(
    val status: SystemStatus,
    val scan: ScanStatus,
    val libraries: List<Library>,
)

class CasterRepository(private val api: CasterApi) {
    suspend fun home(): HomeData = coroutineScope {
        val libraries = async { api.libraries() }
        val continuing = async { api.continueWatching() }
        val recent = async { api.media(sort = "created", limit = 100).items }
        val series = async { api.series() }
        HomeData(libraries.await(), continuing.await(), recent.await(), series.await())
    }

    suspend fun search(query: String, libraryId: String? = null): Pair<List<MediaItem>, List<Series>> =
        coroutineScope {
            val media = async { api.media(libraryId = libraryId, search = query, limit = 200).items }
            val series = async { api.series(libraryId, query) }
            media.await() to series.await()
        }

    suspend fun server(): ServerData = coroutineScope {
        val status = async { api.systemStatus() }
        val scan = async { api.scanStatus() }
        val libraries = async { api.libraries() }
        ServerData(status.await(), scan.await(), libraries.await())
    }

    suspend fun history(status: String?): List<MediaItem> = api.progress(status)
    suspend fun mediaItem(id: String): MediaItem = api.mediaItem(id)
    suspend fun series(id: String): SeriesEpisodesResponse = api.seriesEpisodes(id)
    suspend fun scanAll() = api.scanAll()
    suspend fun setHardwareAccel(accel: String) = api.setHardwareAccel(accel)
    suspend fun markWatched(id: String) = api.markWatched(id)
    suspend fun markUnwatched(id: String) = api.markUnwatched(id)
}
