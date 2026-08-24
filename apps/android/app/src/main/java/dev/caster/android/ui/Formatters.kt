package dev.caster.android.ui

import java.util.Locale
import kotlin.math.roundToInt

fun formatDuration(seconds: Double): String {
    val total = seconds.roundToInt().coerceAtLeast(0)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    return if (hours > 0) "${hours}h ${minutes}m" else "${minutes}m"
}

fun formatUptime(seconds: Double): String {
    val days = (seconds / 86400).toInt()
    val hours = ((seconds % 86400) / 3600).toInt()
    return if (days > 0) "${days}d ${hours}h" else "${hours}h"
}

fun mediaSubtitle(item: dev.caster.android.data.MediaItem): String = buildList {
    item.episodeLabel?.let(::add)
    item.year?.let { add(it.toString()) }
    if (item.duration > 0) add(formatDuration(item.duration))
    item.resolutionLabel?.let(::add)
}.joinToString(" • ")

fun progressFraction(percent: Double): Float = (percent / 100.0).toFloat().coerceIn(0f, 1f)
