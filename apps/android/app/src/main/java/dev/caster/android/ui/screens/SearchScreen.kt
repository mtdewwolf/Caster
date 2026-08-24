package dev.caster.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.caster.android.data.MediaItem
import dev.caster.android.data.Series
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.components.MediaPosterCard
import kotlinx.coroutines.delay

@Composable
fun SearchScreen(
    state: LoadState<Pair<List<MediaItem>, List<Series>>>,
    thumbnailUrl: (String) -> String,
    onBack: () -> Unit,
    onSearch: (String) -> Unit,
    onMedia: (String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    LaunchedEffect(query) {
        delay(350)
        onSearch(query)
    }
    Column(Modifier.fillMaxSize()) {
        androidx.compose.foundation.layout.Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp),
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search movies, episodes, music…") },
                leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.weight(1f).focusRequester(focusRequester),
            )
        }
        if (query.isBlank()) {
            androidx.compose.foundation.layout.Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                Text("Start typing to search your Caster library", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LoadableContent(state, { onSearch(query) }, Modifier.weight(1f)) { (media, series) ->
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(142.dp),
                    contentPadding = PaddingValues(20.dp, 12.dp, 20.dp, 40.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                        Text(
                            if (series.isEmpty()) "${media.size} results" else "${media.size} media • ${series.size} series",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    items(media, key = { it.id }) { item ->
                        MediaPosterCard(item, thumbnailUrl(item.id), { onMedia(item.id) }, Modifier.fillMaxWidth(), compact = true)
                    }
                }
            }
        }
    }
}
