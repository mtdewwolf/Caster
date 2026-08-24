package dev.caster.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    @Test
    fun `media response tolerates new server fields and parses progress`() {
        val response = CasterJson.decodeFromString<MediaResponse>(
            """
            {
              "items": [{
                "id": "media_1",
                "title": "Remote Movie",
                "type": "movie",
                "duration": 7200,
                "unknown_future_field": true,
                "progress": {
                  "position_seconds": 900,
                  "duration_seconds": 7200,
                  "progress_percent": 12.5,
                  "completed": false
                }
              }],
              "total": 1
            }
            """.trimIndent()
        )

        assertEquals(1, response.total)
        assertEquals("Remote Movie", response.items.single().title)
        assertEquals(12.5, response.items.single().progress?.progressPercent ?: 0.0, 0.001)
    }

    @Test
    fun `subtitle tracks are extracted from serialized ffprobe streams`() {
        val item = MediaItem(
            id = "episode_1",
            title = "Pilot",
            streamsJson = """[{"index":3,"codec_type":"subtitle","codec_name":"srt","language":"eng","is_default":true}]""",
        )

        val track = item.subtitleTracks().single()
        assertEquals(3, track.index)
        assertEquals("eng", track.language)
        assertTrue(track.isDefault)
    }
}
