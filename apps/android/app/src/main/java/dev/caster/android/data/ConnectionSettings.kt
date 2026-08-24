package dev.caster.android.data

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class ConnectionSettings(
    val serverUrl: String = "",
    val adminToken: String = "",
) {
    val isConfigured: Boolean get() = serverUrl.isNotBlank()
}

fun normalizeServerUrl(input: String): String {
    var value = input.trim().trimEnd('/')
    if (value.isBlank()) return ""
    if (!value.startsWith("http://", true) && !value.startsWith("https://", true)) {
        value = "http://$value"
    }
    val parsed = value.toHttpUrlOrNull() ?: return value
    if (parsed.port == 80 && parsed.scheme == "http") {
        val likelyServeUrl = parsed.host.endsWith(".ts.net")
        if (!likelyServeUrl) {
            value = parsed.newBuilder().port(3001).build().toString().trimEnd('/')
        }
    }
    return value
}

fun isLikelyTailscaleEndpoint(url: String): Boolean {
    val parsed = normalizeServerUrl(url).toHttpUrlOrNull() ?: return false
    val host = parsed.host
    if (host.endsWith(".ts.net")) return true
    val octets = host.split('.').mapNotNull(String::toIntOrNull)
    return octets.size == 4 && octets[0] == 100 && octets[1] in 64..127
}
