package dev.caster.android.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Router
import androidx.compose.material.icons.rounded.VpnLock
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.caster.android.data.isLikelyTailscaleEndpoint
import dev.caster.android.data.ConnectionSettings
import dev.caster.android.ui.LoadState

@Composable
fun SetupScreen(
    state: LoadState<Boolean>,
    initialSettings: ConnectionSettings = ConnectionSettings(),
    onConnect: (String, String) -> Unit,
) {
    var address by rememberSaveable(initialSettings.serverUrl) { mutableStateOf(initialSettings.serverUrl) }
    var token by rememberSaveable(initialSettings.adminToken) { mutableStateOf(initialSettings.adminToken) }
    val context = LocalContext.current
    val looksLikeTailnet by remember(address) { mutableStateOf(isLikelyTailscaleEndpoint(address)) }

    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Rounded.VpnLock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text("Connect to Caster", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(
            "Stream your library through your private Tailscale network.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, bottom = 28.dp),
        )

        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SetupStep(Icons.Rounded.VpnLock, "1", "Connect this device in the Tailscale app")
                SetupStep(Icons.Rounded.Router, "2", "Enter your server's 100.x address, MagicDNS name, or Tailscale Serve URL")
                SetupStep(Icons.Rounded.Lock, "3", "Optionally add ADMIN_TOKEN to sync progress and manage Caster")
            }
        }

        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("Caster server") },
            placeholder = { Text("caster-nas:3001") },
            supportingText = {
                Text(if (looksLikeTailnet) "Recognized Tailscale endpoint" else "Example: http://100.100.10.20:3001")
            },
            leadingIcon = { Icon(Icons.Rounded.Router, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Admin token (optional)") },
            supportingText = { Text("Encrypted with Android Keystore on this device") },
            leadingIcon = { Icon(Icons.Rounded.Key, contentDescription = null) },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        )

        if (state is LoadState.Error) {
            Text(
                state.message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
        }

        Button(
            onClick = { onConnect(address, token) },
            enabled = address.isNotBlank() && state !is LoadState.Loading,
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
        ) {
            if (state is LoadState.Loading) CircularProgressIndicator(modifier = Modifier.padding(end = 10.dp))
            else Icon(Icons.Rounded.CheckCircle, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
            Text(if (state is LoadState.Loading) "Testing connection…" else "Connect securely")
        }
        OutlinedButton(
            onClick = {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://tailscale.com/download/android")))
            },
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        ) { Text("Get Tailscale for Android") }
        Spacer(Modifier.padding(bottom = 8.dp))
        Text(
            "Caster should not be exposed directly to the public internet. HTTP is supported only because Tailscale encrypts the private tunnel; prefer Tailscale Serve HTTPS when available.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SetupStep(icon: androidx.compose.ui.graphics.vector.ImageVector, number: String, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text(number, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 10.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}
