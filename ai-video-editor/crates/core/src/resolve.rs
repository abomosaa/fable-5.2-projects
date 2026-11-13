//! Resolved layers: the one place where clip fades and transitions are turned into
//! concrete, time-stamped behaviour.
//!
//! Both the browser preview and the FFmpeg export consume [`Layer`]s — neither
//! re-implements transition semantics — so what you see is what gets rendered.

use crate::model::*;
use crate::time::{SourceTime, Speed, TimelineTime};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A linear ramp between two timeline instants (0→1 for "in", 1→0 for "out").
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ramp {
    pub start: TimelineTime,
    pub end: TimelineTime,
}

impl Ramp {
    /// Progress 0..=1 at `t`.
    pub fn progress(&self, t: TimelineTime) -> f64 {
        if t <= self.start {
            0.0
        } else if t >= self.end {
            1.0
        } else {
            (t - self.start) as f64 / (self.end - self.start) as f64
        }
    }
}

/// Horizontal travel during a slide/push transition. `dx` is in frame widths:
/// a slide-in moves from `dx` to 0, a slide-out from 0 to `dx`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Slide {
    pub start: TimelineTime,
    pub end: TimelineTime,
    pub dx: f64,
}

/// One clip as it actually plays: its active extent (including transition
/// handles), where in the source it starts, and its opacity/gain/motion ramps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub clip_id: ClipId,
    pub track_id: TrackId,
    /// Paint rank of the layer's track (higher is on top). Layers of one track share
    /// it; within a track the later-starting layer paints on top (see
    /// [`paint_order`]). Deliberately *not* a dense per-layer index, so an edit only
    /// changes the layers it really affects.
    pub z: u32,
    /// First / last instant the layer contributes to the output. Transitions extend
    /// this beyond the clip's own `[start, end)`.
    pub start: TimelineTime,
    pub end: TimelineTime,
    /// Source time shown at `start`. Can lie outside the media when a transition
    /// handle runs out; consumers clamp (freeze frame / silence).
    pub source_start: SourceTime,
    pub speed: Speed,
    /// False for disabled clips and hidden / muted / non-soloed tracks.
    pub active: bool,
    /// Opacity (visual) or gain (audio) ramp 0→1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<Ramp>,
    /// Opacity or gain ramp 1→0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out: Option<Ramp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide_in: Option<Slide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide_out: Option<Slide>,
    /// Linear gain (clip gain × track gain) for audio layers; 1.0 otherwise.
    pub gain: f64,
}

impl Layer {
    /// Opacity / gain multiplier from the ramps at `t` (1.0 outside any ramp).
    pub fn envelope(&self, t: TimelineTime) -> f64 {
        let mut v = 1.0;
        if let Some(r) = &self.fade_in {
            v *= r.progress(t);
        }
        if let Some(r) = &self.fade_out {
            v *= 1.0 - r.progress(t);
        }
        v
    }

    /// Horizontal offset in frame widths at `t`.
    pub fn offset_x(&self, t: TimelineTime) -> f64 {
        let mut dx = 0.0;
        if let Some(s) = &self.slide_in {
            dx += s.dx
                * (1.0
                    - Ramp {
                        start: s.start,
                        end: s.end,
                    }
                    .progress(t));
        }
        if let Some(s) = &self.slide_out {
            dx += s.dx
                * Ramp {
                    start: s.start,
                    end: s.end,
                }
                .progress(t);
        }
        dx
    }

    /// Source time at timeline time `t` (unclamped).
    pub fn source_time_at(&self, t: TimelineTime) -> SourceTime {
        self.source_start + self.speed.output_to_source(t - self.start)
    }
}

/// Total paint order of layers: track rank, then start time, then id.
pub fn paint_order(a: &Layer, b: &Layer) -> std::cmp::Ordering {
    (a.z, a.start, &a.clip_id).cmp(&(b.z, b.start, &b.clip_id))
}

pub fn db_to_linear(db: f64) -> f64 {
    if db <= -60.0 {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// Resolve every clip of the project into a [`Layer`], in [`paint_order`]
/// (audio tracks first — they are not painted — then V1, V2, …, captions last).
pub fn resolve_layers(p: &Project) -> Vec<Layer> {
    // paint rank per track: audio first (irrelevant visually), then V1, V2, …, then captions
    let mut rank: BTreeMap<&str, u32> = BTreeMap::new();
    let mut r = 0u32;
    for kind in [TrackKind::Audio, TrackKind::Video, TrackKind::Caption] {
        for t in p.tracks_of_kind(kind) {
            rank.insert(t.id.as_str(), r);
            r += 1;
        }
    }
    let into: BTreeMap<&str, &Transition> = p
        .transitions
        .values()
        .map(|t| (t.right.as_str(), t))
        .collect();
    let out_of: BTreeMap<&str, &Transition> = p
        .transitions
        .values()
        .map(|t| (t.left.as_str(), t))
        .collect();
    let tracks: BTreeMap<&str, &Track> = p.tracks.iter().map(|t| (t.id.as_str(), t)).collect();

    let mut clips: Vec<&Clip> = p.clips.values().collect();
    clips.sort_by_key(|c| {
        (
            rank.get(c.track_id.as_str()).copied().unwrap_or(0),
            c.start,
            c.id.clone(),
        )
    });

    let mut layers = Vec::with_capacity(clips.len());
    for c in clips.into_iter() {
        let track = tracks.get(c.track_id.as_str());
        let is_audio = matches!(c.content, ClipContent::Audio { .. });
        let mut start = c.start;
        let mut end = c.end();
        let (mut fade_in, mut fade_out, mut slide_in, mut slide_out) = (None, None, None, None);

        if c.fade_in > 0 {
            fade_in = Some(Ramp {
                start: c.start,
                end: c.start + c.fade_in,
            });
        }
        if c.fade_out > 0 {
            fade_out = Some(Ramp {
                start: c.end() - c.fade_out,
                end: c.end(),
            });
        }
        if let Some(t) = into.get(c.id.as_str()) {
            let (cut, h) = (c.start, t.duration / 2);
            match t.kind {
                TransitionKind::CrossDissolve => {
                    start = cut - h;
                    fade_in = Some(Ramp {
                        start: cut - h,
                        end: cut + h,
                    });
                }
                TransitionKind::DipToBlack => {
                    fade_in = Some(Ramp {
                        start: cut,
                        end: cut + h,
                    });
                }
                TransitionKind::Slide | TransitionKind::Push => {
                    start = cut - h;
                    fade_in = None;
                    slide_in = Some(Slide {
                        start: cut - h,
                        end: cut + h,
                        dx: 1.0,
                    });
                }
            }
        }
        if let Some(t) = out_of.get(c.id.as_str()) {
            let (cut, h) = (c.end(), t.duration / 2);
            match t.kind {
                TransitionKind::CrossDissolve => {
                    end = cut + h;
                    // Picture: the outgoing clip stays opaque underneath the incoming
                    // one (a true dissolve for full-frame clips). Sound: crossfade.
                    fade_out = if is_audio {
                        Some(Ramp {
                            start: cut - h,
                            end: cut + h,
                        })
                    } else {
                        None
                    };
                }
                TransitionKind::DipToBlack => {
                    fade_out = Some(Ramp {
                        start: cut - h,
                        end: cut,
                    });
                }
                TransitionKind::Slide => {
                    end = cut + h;
                    fade_out = None;
                }
                TransitionKind::Push => {
                    end = cut + h;
                    fade_out = None;
                    slide_out = Some(Slide {
                        start: cut - h,
                        end: cut + h,
                        dx: -1.0,
                    });
                }
            }
        }
        let source_start = if c.content.is_timed_media() {
            c.source_time_at(start)
        } else {
            SourceTime::ZERO
        };
        let gain = if is_audio {
            db_to_linear(c.gain_db + track.map(|t| t.gain_db).unwrap_or(0.0))
        } else {
            1.0
        };
        layers.push(Layer {
            clip_id: c.id.clone(),
            track_id: c.track_id.clone(),
            z: rank.get(c.track_id.as_str()).copied().unwrap_or(0),
            start,
            end,
            source_start,
            speed: c.speed,
            active: c.enabled && track.is_some_and(|t| p.track_active(t)),
            fade_in,
            fade_out,
            slide_in,
            slide_out,
            gain,
        });
    }
    layers
}
