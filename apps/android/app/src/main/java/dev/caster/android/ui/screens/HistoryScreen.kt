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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.caster.android.data.MediaItem
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.components.MediaPosterCard

@Composable
fun HistoryScreen(
    state: LoadState<List<MediaItem>>,
    thumbnailUrl: (String) -> String,
    onLoad: (String?) -> Unit,
    onMedia: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var selected by remember { mutableIntStateOf(0) }
    val choices = listOf("All" to null, "In progress" to "in_progress", "Watched" to "completed")
    LaunchedEffect(selected) { onLoad(choices[selected].second) }
    Column(modifier.fillMaxSize()) {
        Text(
            "Watch history",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 18.dp),
        )
        androidx.compose.foundation.layout.Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            choices.forEachIndexed { index, choice ->
                FilterChip(selected = selected == index, onClick = { selected = index }, label = { Text(choice.first) })
            }
        }
        LoadableContent(state, { onLoad(choices[selected].second) }, Modifier.weight(1f)) { items ->
            if (items.isEmpty()) {
                androidx.compose.foundation.layout.Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                    Text("Nothing here yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(142.dp),
                    contentPadding = PaddingValues(20.dp, 18.dp, 20.dp, 104.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    items(items, key = { it.id }) { item ->
                        MediaPosterCard(item, thumbnailUrl(item.id), { onMedia(item.id) }, Modifier.fillMaxWidth(), compact = true)
                    }
                }
            }
        }
    }
}
