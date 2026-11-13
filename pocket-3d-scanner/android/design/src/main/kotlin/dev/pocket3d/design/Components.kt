package dev.pocket3d.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

enum class Tone { Neutral, Good, Warn, Bad, Provisional, Companion }

@Composable
fun Tone.color(): Color = when (this) {
    Tone.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
    Tone.Good -> P3.colors.good
    Tone.Warn -> P3.colors.warn
    Tone.Bad -> P3.colors.bad
    Tone.Provisional -> P3.colors.provisional
    Tone.Companion -> P3.colors.companion
}

/** Small rounded label: status, honesty markers ("ESTIMATE", "PROVISIONAL", "ON COMPANION"). */
@Composable
fun StatusPill(text: String, tone: Tone = Tone.Neutral, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val c = tone.color()
    Surface(color = c.copy(alpha = 0.14f), contentColor = c, shape = RoundedCornerShape(50),
            border = BorderStroke(1.dp, c.copy(alpha = 0.35f)), modifier = modifier) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) { Icon(icon, null, Modifier.size(14.dp)); Spacer(Modifier.width(5.dp)) }
            Text(text, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Inline message with a tone, optional action. Used for warnings, limitations and guidance. */
@Composable
fun InfoBanner(
    title: String,
    modifier: Modifier = Modifier,
    body: String? = null,
    tone: Tone = Tone.Neutral,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(14.dp),
) {
    val c = tone.color()
    val icon = when (tone) {
        Tone.Good -> Icons.Outlined.CheckCircle
        Tone.Warn -> Icons.Outlined.WarningAmber
        Tone.Bad -> Icons.Outlined.ErrorOutline
        else -> Icons.Outlined.Info
    }
    Surface(color = c.copy(alpha = 0.10f), shape = MaterialTheme.shapes.medium,
            border = BorderStroke(1.dp, c.copy(alpha = 0.30f)), modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(contentPadding), verticalAlignment = Alignment.Top) {
            Icon(icon, null, tint = c, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                if (body != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (actionLabel != null && onAction != null) {
                    TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 0.dp)) { Text(actionLabel) }
                }
            }
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween) {
        Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
             fontWeight = FontWeight.SemiBold)
        trailing?.invoke()
    }
}

/** Key/value row for diagnostics. */
@Composable
fun LabeledValue(label: String, value: String, modifier: Modifier = Modifier, tone: Tone = Tone.Neutral) {
    Row(modifier.fillMaxWidth().padding(vertical = 5.dp).semantics(mergeDescendants = true) { contentDescription = "$label: $value" },
        horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
             modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        Text(value, style = NumericStyle, color = if (tone == Tone.Neutral) MaterialTheme.colorScheme.onSurface else tone.color())
    }
}

@Composable
fun Dot(tone: Tone, modifier: Modifier = Modifier) {
    Box(modifier.size(8.dp).clip(CircleShape).background(tone.color()))
}
