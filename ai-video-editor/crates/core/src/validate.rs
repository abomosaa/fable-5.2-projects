//! Document invariants.
//!
//! [`normalize`] repairs derived/secondary state after an edit (prunes transitions
//! whose clips no longer touch, dissolves single-member links, clamps fades).
//! [`validate`] then checks the hard invariants; a failure means a command had a bug
//! and its result is discarded.

use crate::commands::{is_color, MAX_TIMELINE_TICKS};
use crate::model::*;
use crate::time::{Speed, Ticks};
use std::collections::{BTreeMap, BTreeSet};

pub fn normalize(p: &mut Project) {
    let fps = p.fps();
    let frame = fps.frame_ticks();

    // Links / groups with fewer than two members dissolve.
    let mut link_count: BTreeMap<String, usize> = BTreeMap::new();
    let mut group_count: BTreeMap<String, usize> = BTreeMap::new();
    for c in p.clips.values() {
        if let Some(l) = &c.link_id {
            *link_count.entry(l.clone()).or_default() += 1;
        }
        if let Some(g) = &c.group_id {
            *group_count.entry(g.clone()).or_default() += 1;
        }
    }
    for c in p.clips.values_mut() {
        if c.link_id.as_ref().is_some_and(|l| link_count[l] < 2) {
            c.link_id = None;
        }
        if c.group_id.as_ref().is_some_and(|g| group_count[g] < 2) {
            c.group_id = None;
        }
        // Fades never exceed the clip.
        c.fade_in = c.fade_in.clamp(0, c.duration);
        c.fade_out = c.fade_out.clamp(0, c.duration - c.fade_in);
    }

    // Transitions must sit on a real cut between two touching clips of one track.
    let mut seen_left: BTreeSet<ClipId> = BTreeSet::new();
    let mut seen_right: BTreeSet<ClipId> = BTreeSet::new();
    let mut keep: BTreeMap<TransitionId, Transition> = BTreeMap::new();
    for (id, t) in &p.transitions {
        let (Some(l), Some(r)) = (p.clips.get(&t.left), p.clips.get(&t.right)) else {
            continue;
        };
        if l.track_id != r.track_id || l.end() != r.start {
            continue;
        }
        if !seen_left.insert(l.id.clone()) || !seen_right.insert(r.id.clone()) {
            continue;
        }
        let max = l.duration.min(r.duration);
        let frames = fps.ticks_to_frame_floor(t.duration.min(max));
        let d = fps.frame_to_ticks(frames - frames % 2);
        if d < 2 * frame {
            continue;
        }
        let mut t = t.clone();
        t.duration = d;
        keep.insert(id.clone(), t);
    }
    p.transitions = keep;

    p.markers
        .sort_by(|a, b| (a.time, &a.id).cmp(&(b.time, &b.id)));

    // Drop transcript overlays of assets that left the project.
    p.transcript
        .corrections
        .retain(|a, m| p.assets.contains_key(a) && !m.is_empty());
    p.transcript
        .speaker_names
        .retain(|a, m| p.assets.contains_key(a) && !m.is_empty());
}

/// Check every structural invariant of the document.
pub fn validate(p: &Project) -> Result<(), String> {
    let fps = p.fps();
    let frame = fps.frame_ticks();
    if p.settings.width < MIN_DIMENSION
        || p.settings.width > MAX_DIMENSION
        || p.settings.height < MIN_DIMENSION
        || p.settings.height > MAX_DIMENSION
    {
        return Err("project resolution out of range".into());
    }
    if !p.settings.width.is_multiple_of(2) || !p.settings.height.is_multiple_of(2) {
        return Err("project resolution must be even".into());
    }
    if fps.as_f64() > MAX_FPS + 1e-6 || fps.num == 0 || fps.den == 0 {
        return Err("project frame rate out of range".into());
    }
    if !is_color(&p.settings.background, false) {
        return Err("invalid background colour".into());
    }
    if p.tracks.len() > MAX_TRACKS {
        return Err("too many tracks".into());
    }
    let mut track_ids = BTreeSet::new();
    for t in &p.tracks {
        if !track_ids.insert(t.id.as_str()) {
            return Err(format!("duplicate track id {}", t.id));
        }
        if !t.gain_db.is_finite() {
            return Err(format!("track {} has a non-finite gain", t.id));
        }
    }
    let kinds: BTreeMap<&str, TrackKind> =
        p.tracks.iter().map(|t| (t.id.as_str(), t.kind)).collect();

    let mut per_track: BTreeMap<&str, Vec<(Ticks, Ticks, &str)>> = BTreeMap::new();
    for (id, c) in &p.clips {
        if id != &c.id {
            return Err(format!("clip key {id} does not match its id {}", c.id));
        }
        let Some(kind) = kinds.get(c.track_id.as_str()) else {
            return Err(format!("clip {id} references missing track {}", c.track_id));
        };
        if *kind != c.content.track_kind() {
            return Err(format!(
                "clip {id} ({}) is on a track of the wrong kind",
                c.content.kind_name()
            ));
        }
        if c.start.0 < 0 || c.duration <= 0 || c.end().0 > MAX_TIMELINE_TICKS + frame {
            return Err(format!("clip {id} has an invalid time range"));
        }
        if !fps.is_aligned(c.start.0) || !fps.is_aligned(c.end().0) {
            return Err(format!("clip {id} is not aligned to the frame grid"));
        }
        if Speed::new(c.speed.num, c.speed.den).is_none() {
            return Err(format!("clip {id} has an invalid speed"));
        }
        if c.fade_in < 0 || c.fade_out < 0 || c.fade_in + c.fade_out > c.duration {
            return Err(format!("clip {id} has invalid fades"));
        }
        if !c.gain_db.is_finite() {
            return Err(format!("clip {id} has a non-finite gain"));
        }
        let t = &c.transform;
        if ![
            t.x,
            t.y,
            t.scale,
            t.rotation,
            t.opacity,
            t.crop.left,
            t.crop.top,
            t.crop.right,
            t.crop.bottom,
        ]
        .iter()
        .all(|v| v.is_finite())
            || t.scale <= 0.0
        {
            return Err(format!("clip {id} has an invalid transform"));
        }
        if let Some(asset_id) = c.asset_id() {
            let Some(asset) = p.assets.get(asset_id) else {
                return Err(format!("clip {id} references missing asset {asset_id}"));
            };
            if c.content.is_timed_media() {
                if c.source_in.0 < 0 {
                    return Err(format!("clip {id} starts before its source media"));
                }
                // One output frame of tolerance: media durations are not frame aligned.
                let tolerance = c.speed.output_to_source(frame) + 1;
                if c.source_out().0 > asset.duration + tolerance {
                    return Err(format!("clip {id} runs past the end of its source media"));
                }
            }
        }
        per_track
            .entry(c.track_id.as_str())
            .or_default()
            .push((c.start.0, c.end().0, id.as_str()));
    }
    for (track, spans) in per_track.iter_mut() {
        spans.sort();
        for w in spans.windows(2) {
            if w[1].0 < w[0].1 {
                return Err(format!(
                    "clips {} and {} overlap on track {track}",
                    w[0].2, w[1].2
                ));
            }
        }
    }
    for (id, t) in &p.transitions {
        let (Some(l), Some(r)) = (p.clips.get(&t.left), p.clips.get(&t.right)) else {
            return Err(format!("transition {id} references a missing clip"));
        };
        if l.track_id != r.track_id || l.end() != r.start {
            return Err(format!("transition {id} is not on a cut"));
        }
        if t.duration < 2 * frame
            || t.duration > l.duration.min(r.duration)
            || !fps.is_aligned(t.duration / 2)
        {
            return Err(format!("transition {id} has an invalid duration"));
        }
    }
    for m in &p.markers {
        if m.time.0 < 0 {
            return Err(format!("marker {} has a negative time", m.id));
        }
    }
    Ok(())
}
