package dev.caster.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.caster.android.data.ConnectionSettings
import dev.caster.android.data.ServerData
import dev.caster.android.ui.LoadState
import dev.caster.android.ui.components.LoadableContent
import dev.caster.android.ui.formatUptime

@Composable
fun ServerScreen(
    state: LoadState<ServerData>,
    settings: ConnectionSettings,
    authenticated: Boolean,
    onLoad: () -> Unit,
    onScanAll: () -> Unit,
    onSetAccel: (String) -> Unit,
    onDisconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmDisconnect by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { onLoad() }
    LoadableContent(state, onLoad, modifier) { data ->
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp).padding(bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Server", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.CloudDone, contentDescription = null)
                    Column(Modifier.padding(start = 12.dp).weight(1f)) {
                        Text("Connected over tailnet", fontWeight = FontWeight.Bold)
                        Text(settings.serverUrl, style = MaterialTheme.typography.bodySmall)
                    }
                    Icon(Icons.Rounded.CheckCircle, contentDescription = "Online")
                }
            }
            if (!authenticated) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Security, contentDescription = null)
                        Text("Read-only mode. Reconnect with ADMIN_TOKEN to sync progress or manage the server.", Modifier.padding(start = 12.dp))
                    }
                }
            }
            InfoCard("Caster status") {
                InfoRow("Version", data.status.version.ifBlank { "1.0" })
                InfoRow("Platform", "${data.status.platform} / ${data.status.arch}")
                InfoRow("Uptime", formatUptime(data.status.uptime))
                InfoRow("FFmpeg", data.status.hardware.ffmpegVersion)
                InfoRow("Active transcodes", data.status.hardware.activeTranscodes.toString())
            }
            InfoCard("Hardware acceleration") {
                Text("Current: ${data.status.hardware.accelType.uppercase()}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.fillMaxWidth()) {
                    listOf("none", "qsv", "nvenc", "vaapi").forEach { accel ->
                        val supported = when (accel) {
                            "qsv" -> data.status.hardware.qsvSupported
                            "nvenc" -> data.status.hardware.nvencSupported
                            "vaapi" -> data.status.hardware.vaapiSupported
                            else -> true
                        }
                        FilterChip(
                            selected = data.status.hardware.accelType == accel,
                            enabled = authenticated && supported,
                            onClick = { onSetAccel(accel) },
                            label = { Text(accel.uppercase()) },
                        )
                    }
                }
            }
            InfoCard("Libraries") {
                data.libraries.forEach { library -> InfoRow(library.name, "${library.itemCount} items") }
                if (data.scan.isScanning) {
                    Text("Scanning ${data.scan.currentFile}", maxLines = 1)
                    LinearProgressIndicator(
                        progress = { if (data.scan.totalFiles > 0) data.scan.processedFiles.toFloat() / data.scan.totalFiles else 0f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Button(onClick = onScanAll, enabled = authenticated && !data.scan.isScanning, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Refresh, contentDescription = null)
                    Text("Scan all libraries", Modifier.padding(start = 8.dp))
                }
            }
            OutlinedButton(onClick = { confirmDisconnect = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.AutoMirrored.Rounded.Logout, contentDescription = null)
                Text("Disconnect this server", Modifier.padding(start = 8.dp))
            }
        }
    }
    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect Caster?") },
            text = { Text("The server address and encrypted admin token will be removed from this device.") },
            confirmButton = { TextButton(onClick = onDisconnect) { Text("Disconnect") } },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun InfoCard(title: String, content: @Composable () -> Unit) {
    Card(shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            content()
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.Medium)
    }
}
