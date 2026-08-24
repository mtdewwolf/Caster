package dev.caster.android.ui.screens

import android.app.Activity
import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import dev.caster.android.data.CasterApi
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@SuppressLint("UnsafeOptInUsageError")
@Composable
fun PlayerScreen(
    id: String,
    state: LoadState<dev.caster.android.data.MediaItem>,
    api: CasterApi,
    onLoad: (String) -> Unit,
    onBack: () -> Unit,
) {
    LaunchedEffect(id) { onLoad(id) }
    LoadableContent(state, { onLoad(id) }) { item ->
        val context = LocalContext.current
        val activity = context as? Activity
        val scope = rememberCoroutineScope()
        val httpFactory = remember(api) {
            DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setDefaultRequestProperties(api.authHeaders())
        }
        val player = remember(item.id, api.baseUrl) {
            ExoPlayer.Builder(context)
                .setMediaSourceFactory(DefaultMediaSourceFactory(context).setDataSourceFactory(httpFactory))
                .build()
                .apply {
                    val sourceUrl = if (item.type == "track") api.directStreamUrl(item.id) else api.hlsUrl(item.id)
                    val subtitles = item.subtitleTracks().map { track ->
                        MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(api.subtitleUrl(item.id, track.index)))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage(track.language)
                            .setLabel(track.title ?: track.language?.uppercase(Locale.ROOT) ?: "Subtitle ${track.index}")
                            .setSelectionFlags(
                                (if (track.isDefault) C.SELECTION_FLAG_DEFAULT else 0) or
                                    (if (track.isForced) C.SELECTION_FLAG_FORCED else 0)
                            )
                            .build()
                    }
                    setMediaItem(
                        MediaItem.Builder()
                            .setUri(sourceUrl)
                            .setMediaId(item.id)
                            .setMediaMetadata(
                                androidx.media3.common.MediaMetadata.Builder()
                                    .setTitle(item.title)
                                    .setArtist(item.seriesTitle ?: item.libraryName)
                                    .setArtworkUri(android.net.Uri.parse(api.thumbnailUrl(item.id)))
                                    .build()
                            )
                            .setSubtitleConfigurations(subtitles)
                            .build(),
                        item.progress?.positionSeconds?.times(1000)?.toLong()?.coerceAtLeast(0L) ?: 0L,
                    )
                    prepare()
                    playWhenReady = true
                }
        }

        DisposableEffect(activity, player) {
            activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val priorOrientation = activity?.requestedOrientation
            if (item.type != "track") activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            onDispose {
                val position = player.currentPosition.coerceAtLeast(0L) / 1000.0
                val duration = player.duration.takeIf { it > 0 && it != C.TIME_UNSET }?.div(1000.0) ?: item.duration
                scope.launch { runCatching { api.updateProgress(item.id, position, duration) } }
                player.release()
                activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                if (priorOrientation != null) activity.requestedOrientation = priorOrientation
            }
        }

        LaunchedEffect(player, item.id) {
            while (isActive) {
                delay(10_000)
                if (player.isPlaying) {
                    val position = player.currentPosition.coerceAtLeast(0L) / 1000.0
                    val duration = player.duration.takeIf { it > 0 && it != C.TIME_UNSET }?.div(1000.0) ?: item.duration
                    runCatching { api.updateProgress(item.id, position, duration) }
                }
            }
        }

        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                factory = { PlayerView(it).apply { this.player = player; useController = true } },
                update = { it.player = player },
                modifier = Modifier.fillMaxSize(),
            )
            IconButton(onClick = onBack, modifier = Modifier.align(Alignment.TopStart).padding(12.dp)) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Close player", tint = Color.White)
            }
        }
    }
}
