package dev.pocket3d.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Semantic colours beyond the Material scheme. Use these — never hard-code status colours. */
@Immutable
data class P3Colors(
    val good: Color,
    val onGood: Color,
    val warn: Color,
    val onWarn: Color,
    val bad: Color,
    val onBad: Color,
    /** Estimates / provisional data (e.g. viewpoint coverage estimate, sparse preview). */
    val provisional: Color,
    /** Things done by the companion computer rather than the phone. */
    val companion: Color,
    /** Neutral 3D viewport background tones. */
    val viewportDark: Color,
    val viewportMid: Color,
    val viewportLight: Color,
    val scrim: Color,
)

private val DarkP3 = P3Colors(
    good = Color(0xFF5BD6A0), onGood = Color(0xFF00210F),
    warn = Color(0xFFFFC857), onWarn = Color(0xFF2A1C00),
    bad = Color(0xFFFF7A70), onBad = Color(0xFF330704),
    provisional = Color(0xFFB8A6FF), companion = Color(0xFF7CC4FF),
    viewportDark = Color(0xFF14171A), viewportMid = Color(0xFF6E747A), viewportLight = Color(0xFFE9ECEF),
    scrim = Color(0xB3000000),
)

private val LightP3 = P3Colors(
    good = Color(0xFF137A4B), onGood = Color.White,
    warn = Color(0xFF8A5A00), onWarn = Color.White,
    bad = Color(0xFFB3261E), onBad = Color.White,
    provisional = Color(0xFF5B45C2), companion = Color(0xFF0B63A8),
    viewportDark = Color(0xFF14171A), viewportMid = Color(0xFF6E747A), viewportLight = Color(0xFFE9ECEF),
    scrim = Color(0x99000000),
)

val LocalP3Colors = staticCompositionLocalOf { DarkP3 }

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF6FE3D0), onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF12453D), onPrimaryContainer = Color(0xFFA8F5E7),
    secondary = Color(0xFFB4C8D4), onSecondary = Color(0xFF1E333D),
    secondaryContainer = Color(0xFF26343C), onSecondaryContainer = Color(0xFFD2E4EF),
    tertiary = Color(0xFFB8A6FF), onTertiary = Color(0xFF24135E),
    background = Color(0xFF0D1012), onBackground = Color(0xFFE3E6E8),
    surface = Color(0xFF0D1012), onSurface = Color(0xFFE3E6E8),
    surfaceVariant = Color(0xFF242A2F), onSurfaceVariant = Color(0xFFB3BCC3),
    surfaceContainerLowest = Color(0xFF090B0C), surfaceContainerLow = Color(0xFF14181B),
    surfaceContainer = Color(0xFF191E22), surfaceContainerHigh = Color(0xFF21272C),
    surfaceContainerHighest = Color(0xFF2B3238),
    outline = Color(0xFF7D878F), outlineVariant = Color(0xFF394148),
    error = Color(0xFFFF7A70), onError = Color(0xFF330704),
    errorContainer = Color(0xFF5A1A15), onErrorContainer = Color(0xFFFFDAD6),
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF006B5D), onPrimary = Color.White,
    primaryContainer = Color(0xFFB5F2E6), onPrimaryContainer = Color(0xFF00201B),
    secondary = Color(0xFF4A626E), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDCE8EF), onSecondaryContainer = Color(0xFF061E28),
    tertiary = Color(0xFF5B45C2), onTertiary = Color.White,
    background = Color(0xFFF7F9FA), onBackground = Color(0xFF171C1F),
    surface = Color(0xFFF7F9FA), onSurface = Color(0xFF171C1F),
    surfaceVariant = Color(0xFFDCE3E8), onSurfaceVariant = Color(0xFF40484D),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF0F3F5),
    surfaceContainer = Color(0xFFEAEEF0), surfaceContainerHigh = Color(0xFFE3E8EB),
    surfaceContainerHighest = Color(0xFFDDE2E5),
    outline = Color(0xFF6F797F), outlineVariant = Color(0xFFBFC8CD),
    error = Color(0xFFB3261E), onError = Color.White,
)

private val P3Typography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = t.labelSmall.copy(letterSpacing = 0.6.sp, fontWeight = FontWeight.Medium),
    )
}

/** Monospaced digits for counters, measurements and diagnostics. */
val NumericStyle = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 14.sp)

private val P3Shapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
)

object P3 {
    val colors: P3Colors @Composable get() = LocalP3Colors.current
}

@Composable
fun Pocket3DTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalP3Colors provides if (darkTheme) DarkP3 else LightP3) {
        MaterialTheme(colorScheme = if (darkTheme) DarkScheme else LightScheme, typography = P3Typography,
                      shapes = P3Shapes, content = content)
    }
}
