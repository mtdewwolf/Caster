package dev.caster.android.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.caster.android.data.ApiException
import dev.caster.android.data.CasterApi
import dev.caster.android.data.CasterRepository
import dev.caster.android.data.ConnectionSettings
import dev.caster.android.data.HomeData
import dev.caster.android.data.MediaItem
import dev.caster.android.data.SecureSettingsRepository
import dev.caster.android.data.SeriesEpisodesResponse
import dev.caster.android.data.ServerData
import java.io.IOException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

sealed interface AppConnectionState {
    data object Booting : AppConnectionState
    data class NeedsSetup(val initialSettings: ConnectionSettings = ConnectionSettings()) : AppConnectionState
    data class Connected(val settings: ConnectionSettings, val authenticated: Boolean) : AppConnectionState
}

sealed interface LoadState<out T> {
    data object Idle : LoadState<Nothing>
    data object Loading : LoadState<Nothing>
    data class Data<T>(val value: T) : LoadState<T>
    data class Error(val message: String) : LoadState<Nothing>
}

class CasterViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsRepository = SecureSettingsRepository(application)
    private var api: CasterApi? = null
    private var repository: CasterRepository? = null
    private var connectJob: Job? = null

    private val _connection = MutableStateFlow<AppConnectionState>(AppConnectionState.Booting)
    val connection: StateFlow<AppConnectionState> = _connection.asStateFlow()

    private val _setupState = MutableStateFlow<LoadState<Boolean>>(LoadState.Idle)
    val setupState: StateFlow<LoadState<Boolean>> = _setupState.asStateFlow()

    private val _home = MutableStateFlow<LoadState<HomeData>>(LoadState.Idle)
    val home: StateFlow<LoadState<HomeData>> = _home.asStateFlow()

    private val _history = MutableStateFlow<LoadState<List<MediaItem>>>(LoadState.Idle)
    val history: StateFlow<LoadState<List<MediaItem>>> = _history.asStateFlow()

    private val _server = MutableStateFlow<LoadState<ServerData>>(LoadState.Idle)
    val server: StateFlow<LoadState<ServerData>> = _server.asStateFlow()

    private val _search = MutableStateFlow<LoadState<Pair<List<MediaItem>, List<dev.caster.android.data.Series>>>>(LoadState.Idle)
    val search = _search.asStateFlow()

    private val _detail = MutableStateFlow<LoadState<MediaItem>>(LoadState.Idle)
    val detail = _detail.asStateFlow()

    private val _series = MutableStateFlow<LoadState<SeriesEpisodesResponse>>(LoadState.Idle)
    val series = _series.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    init {
        viewModelScope.launch {
            val saved = settingsRepository.settings.first()
            if (saved.isConfigured) connect(saved, persist = false)
            else _connection.value = AppConnectionState.NeedsSetup()
        }
    }

    fun connect(serverUrl: String, token: String) {
        connect(ConnectionSettings(serverUrl, token), persist = true)
    }

    private fun connect(settings: ConnectionSettings, persist: Boolean) {
        connectJob?.cancel()
        connectJob = viewModelScope.launch {
            _setupState.value = LoadState.Loading
            val candidate = CasterApi(settings)
            runCatching { candidate.testConnection() }
                .onSuccess { result ->
                    if (result.health.status.lowercase() != "ok") {
                        _setupState.value = LoadState.Error("Caster responded, but its health status is ${result.health.status}.")
                        return@onSuccess
                    }
                    val normalized = ConnectionSettings(candidate.baseUrl, settings.adminToken.trim())
                    if (persist) settingsRepository.save(normalized.serverUrl, normalized.adminToken)
                    api = candidate
                    repository = CasterRepository(candidate)
                    _connection.value = AppConnectionState.Connected(normalized, result.auth.authenticated)
                    _setupState.value = LoadState.Data(true)
                    loadHome()
                }
                .onFailure {
                    _connection.value = AppConnectionState.NeedsSetup(settings)
                    _setupState.value = LoadState.Error(readableError(it))
                }
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            settingsRepository.clear()
            api = null
            repository = null
            _connection.value = AppConnectionState.NeedsSetup()
            _setupState.value = LoadState.Idle
            _home.value = LoadState.Idle
        }
    }

    fun loadHome() = loadInto(_home) { requireRepository().home() }

    fun loadHistory(status: String? = null) = loadInto(_history) { requireRepository().history(status) }

    fun loadServer() = loadInto(_server) { requireRepository().server() }

    fun search(query: String, libraryId: String? = null) {
        if (query.isBlank()) {
            _search.value = LoadState.Idle
            return
        }
        loadInto(_search) { requireRepository().search(query.trim(), libraryId) }
    }

    fun loadMedia(id: String) = loadInto(_detail) { requireRepository().mediaItem(id) }

    fun loadSeries(id: String) = loadInto(_series) { requireRepository().series(id) }

    fun scanAll() = action("Library scan started") {
        requireRepository().scanAll()
        loadServer()
    }

    fun setHardwareAccel(accel: String) = action("Hardware acceleration updated") {
        requireRepository().setHardwareAccel(accel)
        loadServer()
    }

    fun markWatched(id: String) = action("Marked watched") {
        requireRepository().markWatched(id)
        loadHome()
    }

    fun markUnwatched(id: String) = action("Marked unwatched") {
        requireRepository().markUnwatched(id)
        loadHome()
    }

    fun currentApi(): CasterApi? = api

    fun clearMessage() { _message.value = null }

    private fun action(success: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { block() }
                .onSuccess { _message.value = success }
                .onFailure { _message.value = readableError(it) }
        }
    }

    private fun <T> loadInto(state: MutableStateFlow<LoadState<T>>, block: suspend () -> T) {
        viewModelScope.launch {
            state.value = LoadState.Loading
            state.value = runCatching { block() }
                .fold({ LoadState.Data(it) }, { LoadState.Error(readableError(it)) })
        }
    }

    private fun requireRepository(): CasterRepository = repository ?: error("Not connected")

    private fun readableError(error: Throwable): String = when (error) {
        is ApiException -> when (error.statusCode) {
            401 -> "Admin token rejected. Browsing still works, but this action needs a valid ADMIN_TOKEN."
            409 -> "Caster is already scanning a library."
            else -> error.message
        }
        is IOException -> "Could not reach Caster. Confirm Tailscale is connected and the server address is correct."
        else -> error.message ?: "Something went wrong"
    }
}
