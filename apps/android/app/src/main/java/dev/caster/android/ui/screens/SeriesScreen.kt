package dev.caster.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import dev.caster.android.data.SeriesEpisodesResponse
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.mediaSubtitle
import dev.caster.android.ui.progressFraction

@Composable
fun SeriesScreen(
    id: String,
    state: LoadState<SeriesEpisodesResponse>,
    thumbnailUrl: (String) -> String,
    onLoad: (String) -> Unit,
    onBack: () -> Unit,
    onPlay: (String) -> Unit,
) {
    LaunchedEffect(id) { onLoad(id) }
    LoadableContent(state, { onLoad(id) }) { result ->
        LazyColumn(contentPadding = PaddingValues(bottom = 40.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") }
                    Column {
                        Text(result.series.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Text(
                            "${result.series.seasonCount} seasons • ${result.series.episodeCount} episodes",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            val grouped = result.items.groupBy { it.seasonNumber ?: 0 }.toSortedMap()
            grouped.forEach { (season, episodes) ->
                item {
                    Text(
                        if (season == 0) "Specials" else "Season $season",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
                    )
                }
                items(episodes, key = { it.id }) { episode ->
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 5.dp).clickable { onPlay(episode.id) },
                        shape = RoundedCornerShape(16.dp),
                    ) {
                        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.foundation.layout.Box(Modifier.width(128.dp).height(76.dp)) {
                                AsyncImage(
                                    thumbnailUrl(episode.id),
                                    "Thumbnail for ${episode.title}",
                                    Modifier.fillMaxSize(),
                                    contentScale = ContentScale.Crop,
                                )
                                Icon(Icons.Rounded.PlayArrow, "Play", Modifier.align(Alignment.Center))
                                episode.progress?.takeIf { !it.completed }?.let {
                                    LinearProgressIndicator(
                                        progress = { progressFraction(it.progressPercent) },
                                        modifier = Modifier.fillMaxWidth().height(3.dp).align(Alignment.BottomCenter),
                                    )
                                }
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(episode.episodeLabel.orEmpty(), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                    if (episode.progress?.completed == true) {
                                        Spacer(Modifier.width(6.dp))
                                        Icon(Icons.Rounded.CheckCircle, "Watched", tint = MaterialTheme.colorScheme.primary)
                                    }
                                }
                                Text(episode.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(mediaSubtitle(episode), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}
