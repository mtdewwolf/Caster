package dev.caster.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionSettingsTest {
    @Test
    fun `bare MagicDNS name gets http and Caster port`() {
        assertEquals("http://caster-nas:3001", normalizeServerUrl("caster-nas"))
    }

    @Test
    fun `explicit Tailscale Serve URL is preserved`() {
        assertEquals(
            "https://caster-nas.example.ts.net",
            normalizeServerUrl("https://caster-nas.example.ts.net/"),
        )
    }

    @Test
    fun `recognizes CGNAT tailnet range but not arbitrary public addresses`() {
        assertTrue(isLikelyTailscaleEndpoint("100.64.0.1:3001"))
        assertTrue(isLikelyTailscaleEndpoint("http://100.127.255.254:3001"))
        assertFalse(isLikelyTailscaleEndpoint("100.128.0.1:3001"))
        assertFalse(isLikelyTailscaleEndpoint("8.8.8.8:3001"))
    }
}
