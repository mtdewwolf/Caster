package dev.caster.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import dev.caster.android.data.MediaItem
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.formatDuration
import dev.caster.android.ui.mediaSubtitle

@Composable
fun DetailScreen(
    id: String,
    state: LoadState<MediaItem>,
    thumbnailUrl: (String) -> String,
    onLoad: (String) -> Unit,
    onBack: () -> Unit,
    onPlay: (String) -> Unit,
    onWatched: (String) -> Unit,
    onUnwatched: (String) -> Unit,
) {
    LaunchedEffect(id) { onLoad(id) }
    LoadableContent(state, { onLoad(id) }) { item ->
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 10f)) {
                AsyncImage(
                    model = thumbnailUrl(item.id),
                    contentDescription = "Artwork for ${item.title}",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(androidx.compose.ui.graphics.Color(0x22000000), MaterialTheme.colorScheme.background))))
                IconButton(onClick = onBack, modifier = Modifier.padding(8.dp).align(Alignment.TopStart)) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
                }
            }
            Column(Modifier.padding(horizontal = 22.dp).padding(bottom = 48.dp)) {
                item.episodeLabel?.let {
                    Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                }
                Text(item.title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                if (item.seriesTitle != null) {
                    Text(item.seriesTitle, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(mediaSubtitle(item), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = { onPlay(item.id) }, modifier = Modifier.weight(1f)) {
                        Icon(Icons.Rounded.PlayArrow, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text(if (item.progress?.positionSeconds ?: 0.0 > 0) "Resume" else "Play")
                    }
                    val watched = item.progress?.completed == true
                    FilledTonalButton(onClick = { if (watched) onUnwatched(item.id) else onWatched(item.id) }) {
                        Icon(if (watched) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text(if (watched) "Watched" else "Mark watched")
                    }
                }
                Spacer(Modifier.height(26.dp))
                Text("Media details", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                DetailRows(item)
            }
        }
    }
}

@Composable
private fun DetailRows(item: MediaItem) {
    val details = buildList {
        add("Library" to (item.libraryName ?: "Unknown"))
        add("Format" to item.format.uppercase())
        item.videoCodec?.let { add("Video" to it.uppercase()) }
        item.resolutionLabel?.let { add("Resolution" to it + if (item.isHdr) " HDR" else "") }
        item.audioCodec?.let { add("Audio" to it.uppercase() + item.audioChannels?.let { count -> " • $count channels" }.orEmpty()) }
        if (item.duration > 0) add("Runtime" to formatDuration(item.duration))
        if (item.subtitleTracks().isNotEmpty()) add("Subtitles" to "${item.subtitleTracks().size} tracks")
    }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            details.forEach { (label, value) ->
                Row(Modifier.fillMaxWidth()) {
                    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Text(value, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}
