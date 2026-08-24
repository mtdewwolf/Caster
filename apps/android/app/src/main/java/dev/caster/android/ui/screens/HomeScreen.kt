package dev.caster.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.LiveTv
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.VideoLibrary
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import dev.caster.android.data.HomeData
import dev.caster.android.data.Library
import dev.caster.android.data.Series
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.components.MediaPosterCard
import dev.caster.android.ui.components.SectionHeader
import dev.caster.android.ui.theme.Cyan
import dev.caster.android.ui.theme.Indigo

@Composable
fun HomeScreen(
    state: LoadState<HomeData>,
    thumbnailUrl: (String) -> String,
    onRetry: () -> Unit,
    onSearch: () -> Unit,
    onMedia: (String) -> Unit,
    onSeries: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LoadableContent(state, onRetry, modifier) { data ->
        LazyColumn(
            contentPadding = PaddingValues(bottom = 104.dp),
            verticalArrangement = Arrangement.spacedBy(26.dp),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("CASTER", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black)
                        Text("Your media, anywhere", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    }
                    IconButton(onClick = onSearch) { Icon(Icons.Rounded.Search, contentDescription = "Search") }
                }
            }
            if (data.continueWatching.isNotEmpty()) {
                item {
                    MediaSection("Continue watching", data.continueWatching, thumbnailUrl, onMedia)
                }
            }
            if (data.libraries.isNotEmpty()) {
                item {
                    Column {
                        SectionHeader("Libraries", Modifier.padding(horizontal = 20.dp), "${data.libraries.size}")
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) { items(data.libraries, key = { it.id }) { LibraryPill(it) } }
                    }
                }
            }
            if (data.recentMedia.isNotEmpty()) {
                item { MediaSection("Recently added", data.recentMedia.take(24), thumbnailUrl, onMedia) }
            }
            if (data.series.isNotEmpty()) {
                item {
                    Column {
                        SectionHeader("Series", Modifier.padding(horizontal = 20.dp), "${data.series.size}")
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(data.series.take(24), key = { it.id }) { series ->
                                SeriesCard(series, series.posterPath?.let(thumbnailUrl).orEmpty()) { onSeries(series.id) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MediaSection(
    title: String,
    media: List<dev.caster.android.data.MediaItem>,
    thumbnailUrl: (String) -> String,
    onMedia: (String) -> Unit,
) {
    Column {
        SectionHeader(title, modifier = Modifier.padding(horizontal = 20.dp))
        LazyRow(
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(media, key = { it.id }) { item ->
                MediaPosterCard(item, thumbnailUrl(item.id), { onMedia(item.id) }, compact = true)
            }
        }
    }
}

@Composable
private fun LibraryPill(library: Library) {
    val icon = when (library.type) {
        "movies" -> Icons.Rounded.Movie
        "tv" -> Icons.Rounded.LiveTv
        "music" -> Icons.Rounded.MusicNote
        else -> Icons.Rounded.VideoLibrary
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(18.dp),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(10.dp))
            Column {
                Text(library.name, fontWeight = FontWeight.SemiBold)
                Text("${library.itemCount} items", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun SeriesCard(series: Series, artworkUrl: String, onClick: () -> Unit) {
    Column(Modifier.width(172.dp).clickable(onClick = onClick)) {
        Box(
            Modifier.fillMaxWidth().height(238.dp).clip(RoundedCornerShape(18.dp))
        ) {
            Box(Modifier.matchParentSize().clip(RoundedCornerShape(18.dp)), contentAlignment = Alignment.Center) {
                androidx.compose.foundation.layout.Box(
                    Modifier.matchParentSize().clip(RoundedCornerShape(18.dp))
                        .then(Modifier),
                )
                androidx.compose.foundation.Canvas(Modifier.matchParentSize()) {
                    drawRect(Brush.linearGradient(listOf(Indigo, Cyan)))
                }
                Icon(Icons.Rounded.LiveTv, contentDescription = null)
            }
            if (artworkUrl.isNotBlank()) {
                AsyncImage(artworkUrl, "Artwork for ${series.title}", Modifier.matchParentSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(series.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
        Text(
            "${series.seasonCount} seasons • ${series.episodeCount} episodes",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}
