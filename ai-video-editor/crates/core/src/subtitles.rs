//! Subtitle file parsing (SubRip `.srt`, WebVTT `.vtt`) and caption export.

use crate::model::{ClipContent, Project, TrackKind};
use crate::transcript::SubtitleCue;

/// Parse `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm` (and sloppy variants with 1–3
/// fractional digits or none) into milliseconds.
fn parse_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (clock, frac) = match s.rfind([',', '.']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    if !frac.chars().all(|c| c.is_ascii_digit()) || frac.len() > 6 {
        return None;
    }
    let ms = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().chain("000".chars()).take(3).collect();
        digits.parse::<i64>().ok()?
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() < 2
        || parts.len() > 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 6 || !p.trim().chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let nums: Vec<i64> = parts
        .iter()
        .map(|p| p.trim().parse::<i64>().ok())
        .collect::<Option<_>>()?;
    let (h, m, sec) = if nums.len() == 3 {
        (nums[0], nums[1], nums[2])
    } else {
        (0, nums[0], nums[1])
    };
    if m > 59 || sec > 59 {
        return None;
    }
    Some(((h * 60 + m) * 60 + sec) * 1000 + ms)
}

/// Parse a cue timing line `start --> end [settings…]`.
fn parse_timing(line: &str) -> Option<(i64, i64)> {
    let (a, b) = line.split_once("-->")?;
    let start = parse_timestamp(a)?;
    let end_token = b.split_whitespace().next()?;
    let end = parse_timestamp(end_token)?;
    Some((start, end))
}

/// Strip simple markup (`<i>`, `<c.yellow>`, `<00:00:01.000>`, `{\an8}`) and decode
/// the handful of entities that occur in subtitle files.
fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                // drop up to the closing '>' (on the same line); keep a lone '<'
                let rest: String = chars.clone().take_while(|c| *c != '\n').collect();
                match rest.find('>') {
                    Some(end) => {
                        for _ in 0..rest[..=end].chars().count() {
                            chars.next();
                        }
                    }
                    None => out.push(c),
                }
            }
            '{' if chars.peek() == Some(&'\\') => {
                let rest: String = chars.clone().take_while(|c| *c != '\n').collect();
                match rest.find('}') {
                    Some(end) => {
                        for _ in 0..rest[..=end].chars().count() {
                            chars.next();
                        }
                    }
                    None => out.push(c),
                }
            }
            _ => out.push(c),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&lrm;", "")
        .replace("&rlm;", "")
        .replace("&amp;", "&");
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse SubRip or WebVTT text into cues sorted by start time.
///
/// Tolerates a BOM, CRLF line endings, missing cue numbers, `,` or `.` millisecond
/// separators, WebVTT headers / `NOTE` / `STYLE` / `REGION` blocks, cue settings and
/// missing blank lines between cues. Cues without text or with `end <= start` are
/// skipped.
pub fn parse_subtitles(text: &str) -> Result<Vec<SubtitleCue>, String> {
    let text = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut cues: Vec<SubtitleCue> = Vec::new();
    let mut current: Option<(i64, i64, Vec<&str>)> = None;
    let mut skipping_block = false; // inside NOTE / STYLE / REGION
    let mut saw_timing = false;

    fn finish(current: &mut Option<(i64, i64, Vec<&str>)>, cues: &mut Vec<SubtitleCue>) {
        if let Some((start, end, lines)) = current.take() {
            let text = clean_text(&lines.join("\n"));
            if !text.is_empty() && end > start {
                cues.push(SubtitleCue {
                    start_ms: start,
                    end_ms: end,
                    text,
                });
            }
        }
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            finish(&mut current, &mut cues);
            skipping_block = false;
            continue;
        }
        if skipping_block {
            continue;
        }
        if let Some((start, end)) = if trimmed.contains("-->") {
            parse_timing(trimmed)
        } else {
            None
        } {
            saw_timing = true;
            // A cue number glued to the previous cue (no blank line) is not text.
            if let Some((_, _, lines)) = current.as_mut() {
                if lines.len() > 1
                    && lines
                        .last()
                        .is_some_and(|l| l.trim().chars().all(|c| c.is_ascii_digit()))
                {
                    lines.pop();
                }
            }
            finish(&mut current, &mut cues);
            current = Some((start, end, Vec::new()));
            continue;
        }
        match current.as_mut() {
            Some((_, _, lines)) => lines.push(line),
            None => {
                let upper = trimmed.to_ascii_uppercase();
                if upper.starts_with("NOTE")
                    || upper == "STYLE"
                    || upper == "REGION"
                    || upper.starts_with("STYLE ")
                    || upper.starts_with("REGION ")
                {
                    skipping_block = true;
                }
                // otherwise: WEBVTT header, cue number or cue identifier — ignored
            }
        }
    }
    finish(&mut current, &mut cues);

    if cues.is_empty() {
        return Err(if saw_timing {
            "The subtitle file has timing lines but no usable cues (every cue is empty or ends before it starts).".to_string()
        } else {
            "No subtitle cues found. Expected a SubRip (.srt) or WebVTT (.vtt) file with timing lines like “00:00:01,000 --> 00:00:04,000”.".to_string()
        });
    }
    cues.sort_by_key(|c| (c.start_ms, c.end_ms));
    Ok(cues)
}

fn format_timestamp(ms: i64, sep: char) -> String {
    let ms = ms.max(0);
    format!(
        "{:02}:{:02}:{:02}{}{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        sep,
        ms % 1000
    )
}

/// Caption cues of the project in output order: enabled caption clips on caption
/// tracks that are not hidden.
fn caption_cues(p: &Project) -> Vec<(i64, i64, String)> {
    let mut v: Vec<(i64, i64, String)> = p
        .clips
        .values()
        .filter(|c| {
            c.enabled
                && p.track(&c.track_id)
                    .is_some_and(|t| t.kind == TrackKind::Caption && !t.hidden)
        })
        .filter_map(|c| match &c.content {
            ClipContent::Caption { text, .. } => {
                // blank lines would terminate the cue in both formats
                let text = text
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.is_empty() {
                    None
                } else {
                    Some((c.start.as_ms(), c.end().as_ms(), text))
                }
            }
            _ => None,
        })
        .collect();
    v.sort();
    v
}

/// Export the project's captions as SubRip.
pub fn export_srt(p: &Project) -> String {
    let mut out = String::new();
    for (i, (start, end, text)) in caption_cues(p).into_iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            format_timestamp(start, ','),
            format_timestamp(end, ','),
            text
        ));
    }
    out
}

/// Export the project's captions as WebVTT.
pub fn export_vtt(p: &Project) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (start, end, text) in caption_cues(p) {
        // "-->" inside cue text is not allowed in WebVTT
        let text = text.replace("-->", "→");
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_timestamp(start, '.'),
            format_timestamp(end, '.'),
            text
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(parse_timestamp("00:00:01,000"), Some(1000));
        assert_eq!(parse_timestamp("01:02:03.45"), Some(3_723_450));
        assert_eq!(parse_timestamp("02:03.5"), Some(123_500));
        assert_eq!(parse_timestamp("00:61:00,000"), None);
        assert_eq!(parse_timestamp("abc"), None);
        assert_eq!(format_timestamp(3_723_450, ','), "01:02:03,450");
    }
}
