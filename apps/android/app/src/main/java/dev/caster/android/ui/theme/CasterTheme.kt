package dev.caster.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Cyan = Color(0xFF38BDF8)
val Indigo = Color(0xFF6366F1)
val Violet = Color(0xFFA855F7)
val Slate950 = Color(0xFF020617)
val Slate900 = Color(0xFF0B0F19)
val Slate800 = Color(0xFF172033)
val Slate300 = Color(0xFFCBD5E1)

private val DarkColors = darkColorScheme(
    primary = Cyan,
    onPrimary = Color(0xFF002F3F),
    primaryContainer = Color(0xFF123B56),
    onPrimaryContainer = Color(0xFFBDE9FF),
    secondary = Color(0xFFBFC2FF),
    onSecondary = Color(0xFF292C68),
    secondaryContainer = Color(0xFF3F437F),
    tertiary = Color(0xFFE0B6FF),
    background = Slate950,
    onBackground = Color(0xFFE2E8F0),
    surface = Slate900,
    onSurface = Color(0xFFE2E8F0),
    surfaceVariant = Slate800,
    onSurfaceVariant = Slate300,
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF00658A),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFC4E7FF),
    secondary = Color(0xFF4F52A3),
    tertiary = Color(0xFF7542A1),
    background = Color(0xFFF7F9FF),
    surface = Color.White,
    surfaceVariant = Color(0xFFE7ECF5),
)

@Composable
fun CasterTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = MaterialTheme.typography,
        content = content,
    )
}
