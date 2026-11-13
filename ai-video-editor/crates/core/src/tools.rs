//! Typed tool surface for the editing assistant.
//!
//! The assistant (whether the rule-based fixture planner or a real model driven
//! through the Pi SDK) never touches the project document. Every tool call is
//! validated here and turned into
//!
//! * a core [`Command`] — applied through `Session::execute`, so AI edits get exactly
//!   the same validation, revisioning, autosave and undo as UI edits,
//! * a read-only [`ToolQuery`], or
//! * a server-resolved action (filler / silence / spoken-range removal) that the
//!   host expands into a `RippleDeleteSource` command with the pure helpers below.
//!
//! Tools speak *seconds* (model friendly); commands speak ticks. The JSON Schemas
//! and the argument validator are generated from one declarative table, so what is
//! advertised to the model is by construction what is accepted.

use crate::analysis::{SilenceCandidate, SilenceOptions};
use crate::captions::CaptionOptions;
use crate::commands::{ClipMove, ClipPatch, Command, Edge, SourceCut};
use crate::mapping::{speaker_name, TranscriptView};
use crate::model::*;
use crate::time::{seconds_to_ticks, Ticks, TimelineTime, TICKS_PER_SECOND};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

/// Longest timeline position a tool accepts (24 h), in seconds.
pub const MAX_SECONDS: f64 = 86_400.0;

// ---------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------

/// A tool as advertised to the model.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema (object, `additionalProperties: false`).
    pub parameters: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolErrorCode {
    UnknownTool,
    InvalidArguments,
}

/// A rejected tool call. The message is written for the model: it says exactly what
/// was wrong and how to fix it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl ToolError {
    fn invalid(field: &str, message: impl Into<String>) -> ToolError {
        ToolError {
            code: ToolErrorCode::InvalidArguments,
            message: message.into(),
            field: Some(field.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ToolQuery {
    GetTimeline,
    GetTranscript {
        start: Option<TimelineTime>,
        end: Option<TimelineTime>,
    },
    GetProjectInfo,
}

/// What a validated tool call asks the host to do.
#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ToolAction {
    /// Apply via `Session::execute`.
    Command(Command),
    /// Read-only; render with [`describe_timeline`] / [`describe_transcript`] /
    /// [`describe_project`].
    Query(ToolQuery),
    /// Expand with [`filler_cuts`] over the timeline transcript.
    RemoveFillers,
    /// Expand with [`silence_cuts`] over `timeline_silences`.
    RemoveSilences(SilenceOptions),
    /// Expand with [`spoken_range_cuts`] over the timeline transcript.
    RemoveSpokenRange {
        start: TimelineTime,
        end: TimelineTime,
    },
}

// ---------------------------------------------------------------------------------
// Declarative tool table
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Ty {
    /// Inclusive range.
    Number {
        min: f64,
        max: f64,
    },
    Integer {
        min: i64,
        max: i64,
    },
    Bool,
    /// Non-blank string of at most `max_len` characters.
    Text {
        max_len: usize,
    },
    Enum(&'static [&'static str]),
    Id,
    /// 1..=max ids.
    IdList {
        max: usize,
    },
}

struct Param {
    name: &'static str,
    ty: Ty,
    required: bool,
    doc: &'static str,
}

const fn req(name: &'static str, ty: Ty, doc: &'static str) -> Param {
    Param {
        name,
        ty,
        required: true,
        doc,
    }
}

const fn opt(name: &'static str, ty: Ty, doc: &'static str) -> Param {
    Param {
        name,
        ty,
        required: false,
        doc,
    }
}

struct ToolDef {
    name: &'static str,
    description: &'static str,
    params: &'static [Param],
}

const TIME: Ty = Ty::Number {
    min: 0.0,
    max: MAX_SECONDS,
};
const IDS: Ty = Ty::IdList { max: 500 };
const EDGES: &[&str] = &["start", "end"];
const TRANSITIONS: &[&str] = &["cross_dissolve", "dip_to_black", "slide", "push"];
const LINKED_DOC: &str = "Also apply to clips linked to the given ones (a video clip and its audio). Default true; set false to edit only the listed clips.";

const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "get_timeline",
        description: "Read the current timeline: tracks, clips (ids, kind, start/end in seconds, source range, speed, linked clips), transitions and markers. Call this before editing so you use real ids and times.",
        params: &[],
    },
    ToolDef {
        name: "get_transcript",
        description: "Read the spoken words that are audible on the timeline, as sentences with timeline times in seconds and speaker names. Filler words appear in [brackets]. Optionally limit to a time range.",
        params: &[
            opt("start_seconds", TIME, "Only include speech from this timeline time."),
            opt("end_seconds", TIME, "Only include speech before this timeline time."),
        ],
    },
    ToolDef { name: "get_project_info", description: "Read project name, resolution, frame rate, duration and counts.", params: &[] },
    ToolDef {
        name: "split_clips",
        description: "Cut clips in two at a timeline time. Without clip_ids every clip under that time (on unlocked tracks) is split.",
        params: &[
            req("time_seconds", TIME, "Timeline time of the cut, in seconds."),
            opt("clip_ids", IDS, "Only split these clips."),
            opt("include_linked", Ty::Bool, LINKED_DOC),
        ],
    },
    ToolDef {
        name: "trim_clip",
        description: "Move the start or end edge of a clip by delta_seconds (negative = earlier, positive = later). With ripple, later clips follow so no gap or overwrite occurs.",
        params: &[
            req("clip_id", Ty::Id, "Clip to trim."),
            req("edge", Ty::Enum(EDGES), "Which edge to move."),
            req("delta_seconds", Ty::Number { min: -MAX_SECONDS, max: MAX_SECONDS }, "How far to move the edge, in seconds. Must not be 0."),
            opt("ripple", Ty::Bool, "Shift later material to follow the edit. Default false."),
            opt("include_linked", Ty::Bool, LINKED_DOC),
        ],
    },
    ToolDef {
        name: "move_clip",
        description: "Move a clip to a new start time and optionally another track of the same kind. Material under the new position is overwritten.",
        params: &[
            req("clip_id", Ty::Id, "Clip to move."),
            req("start_seconds", TIME, "New start time on the timeline, in seconds."),
            opt("track_id", Ty::Id, "Target track id (must match the clip kind). Default: stay on the same track."),
            opt("include_linked", Ty::Bool, LINKED_DOC),
        ],
    },
    ToolDef {
        name: "delete_clips",
        description: "Delete clips. ripple=false leaves a gap (lift); ripple=true closes the gap by pulling later clips left.",
        params: &[req("clip_ids", IDS, "Clips to delete."), opt("ripple", Ty::Bool, "Close the gap. Default false."), opt("include_linked", Ty::Bool, LINKED_DOC)],
    },
    ToolDef {
        name: "delete_time_range",
        description: "Remove a time range from every unlocked track and close the gap (ripple delete). Use for cutting out a section of the whole edit.",
        params: &[req("start_seconds", TIME, "Start of the range, in seconds."), req("end_seconds", TIME, "End of the range, in seconds. Must be greater than start_seconds.")],
    },
    ToolDef {
        name: "set_clip_speed",
        description: "Change playback speed of video/audio clips (1 = normal, 2 = double speed, 0.5 = slow motion). The clip keeps its source range, so its duration changes.",
        params: &[
            req("clip_ids", IDS, "Clips to change."),
            req("speed", Ty::Number { min: 0.1, max: 16.0 }, "Speed factor between 0.1 and 16."),
            opt("ripple", Ty::Bool, "Shift later clips so nothing overlaps or gaps. Default true."),
            opt("include_linked", Ty::Bool, LINKED_DOC),
        ],
    },
    ToolDef {
        name: "update_clips",
        description: "Change properties of clips. Give at least one property. Position/scale/rotation/opacity apply to video, image and text clips; colour to video and image clips; gain_db to audio clips; text to text and caption clips.",
        params: &[
            req("clip_ids", IDS, "Clips to change."),
            opt("opacity", Ty::Number { min: 0.0, max: 1.0 }, "0 (transparent) to 1 (opaque)."),
            opt("scale", Ty::Number { min: 0.01, max: 20.0 }, "1 = fitted to the frame."),
            opt("x", Ty::Number { min: -4.0, max: 4.0 }, "Horizontal offset from centre in frame widths (0.25 = a quarter frame right)."),
            opt("y", Ty::Number { min: -4.0, max: 4.0 }, "Vertical offset from centre in frame heights (positive = down)."),
            opt("rotation", Ty::Number { min: -3600.0, max: 3600.0 }, "Degrees clockwise."),
            opt("brightness", Ty::Number { min: 0.0, max: 2.0 }, "1 = unchanged."),
            opt("contrast", Ty::Number { min: 0.0, max: 2.0 }, "1 = unchanged."),
            opt("saturation", Ty::Number { min: 0.0, max: 2.0 }, "1 = unchanged, 0 = greyscale."),
            opt("temperature", Ty::Number { min: -1.0, max: 1.0 }, "Negative = cooler, positive = warmer."),
            opt("gain_db", Ty::Number { min: -60.0, max: 24.0 }, "Audio clip volume in dB (0 = unchanged, -60 = silent)."),
            opt("fade_in_seconds", Ty::Number { min: 0.0, max: 3600.0 }, "Fade-in length in seconds (0 removes it)."),
            opt("fade_out_seconds", Ty::Number { min: 0.0, max: 3600.0 }, "Fade-out length in seconds (0 removes it)."),
            opt("enabled", Ty::Bool, "false hides / silences the clip without deleting it."),
            opt("text", Ty::Text { max_len: 2000 }, "New text for text or caption clips."),
        ],
    },
    ToolDef {
        name: "add_text",
        description: "Add a text overlay (title) on a free video track above the main video.",
        params: &[
            req("text", Ty::Text { max_len: 2000 }, "The text to show. Use \\n for line breaks."),
            req("start_seconds", TIME, "When the text appears, in seconds."),
            opt("duration_seconds", Ty::Number { min: 0.05, max: 3600.0 }, "How long it stays. Default 5."),
        ],
    },
    ToolDef {
        name: "add_transition",
        description: "Add a transition on the cut directly after a clip (the next clip on the same track must touch it). Audio tracks always get a crossfade.",
        params: &[
            req("after_clip_id", Ty::Id, "The outgoing clip; the transition is placed on the cut at its end."),
            req("kind", Ty::Enum(TRANSITIONS), "Transition style."),
            req("duration_seconds", Ty::Number { min: 0.05, max: 10.0 }, "Total transition length in seconds."),
        ],
    },
    ToolDef {
        name: "set_track",
        description: "Change track switches. Give at least one of muted, solo, locked, hidden, gain_db.",
        params: &[
            req("track_id", Ty::Id, "Track to change."),
            opt("muted", Ty::Bool, "Silence an audio track."),
            opt("solo", Ty::Bool, "Solo an audio track."),
            opt("locked", Ty::Bool, "Protect the track from edits."),
            opt("hidden", Ty::Bool, "Hide a video or caption track."),
            opt("gain_db", Ty::Number { min: -60.0, max: 12.0 }, "Audio track gain in dB."),
        ],
    },
    ToolDef {
        name: "remove_filler_words",
        description: "Ripple-delete every filler word (um, uh, er …) that is audible on the timeline, using the transcript. Each removal is recorded and can be restored.",
        params: &[],
    },
    ToolDef {
        name: "remove_silences",
        description: "Ripple-delete pauses in the audible audio. Spoken words are never cut.",
        params: &[
            opt("min_duration_ms", Ty::Integer { min: 100, max: 60_000 }, "Only remove pauses at least this long. Default 700."),
            opt("threshold_db", Ty::Number { min: -80.0, max: -6.0 }, "Audio below this level (dBFS) counts as silence. Default -38."),
            opt("padding_ms", Ty::Integer { min: 0, max: 2_000 }, "Breathing room kept on each side of a removed pause. Default 120."),
        ],
    },
    ToolDef {
        name: "remove_spoken_range",
        description: "Ripple-delete the spoken words between two timeline times (transcript-based: cuts follow word boundaries). Use get_transcript first to find the times.",
        params: &[req("start_seconds", TIME, "Timeline time where the removed passage starts."), req("end_seconds", TIME, "Timeline time where it ends. Must be greater than start_seconds.")],
    },
    ToolDef {
        name: "generate_captions",
        description: "Create captions from the transcript of what is audible on the timeline, replacing previously generated captions.",
        params: &[
            opt("max_chars_per_line", Ty::Integer { min: 8, max: 80 }, "Default 36."),
            opt("max_lines", Ty::Integer { min: 1, max: 4 }, "Default 2."),
            opt("speaker_labels", Ty::Bool, "Prefix each speaker turn with the speaker name. Default false."),
        ],
    },
    ToolDef {
        name: "add_marker",
        description: "Add a marker at a timeline time.",
        params: &[req("time_seconds", TIME, "Marker position in seconds."), opt("label", Ty::Text { max_len: 80 }, "Optional label.")],
    },
];

fn schema_of(p: &Param) -> Value {
    let mut s = match p.ty {
        Ty::Number { min, max } => json!({ "type": "number", "minimum": min, "maximum": max }),
        Ty::Integer { min, max } => json!({ "type": "integer", "minimum": min, "maximum": max }),
        Ty::Bool => json!({ "type": "boolean" }),
        Ty::Text { max_len } => json!({ "type": "string", "minLength": 1, "maxLength": max_len }),
        Ty::Enum(values) => json!({ "type": "string", "enum": values }),
        Ty::Id => json!({ "type": "string", "minLength": 1, "maxLength": 64 }),
        Ty::IdList { max } => {
            json!({ "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 64 }, "minItems": 1, "maxItems": max })
        }
    };
    s["description"] = Value::String(p.doc.to_string());
    s
}

/// Every tool with its JSON Schema.
pub fn tool_specs() -> Vec<ToolSpec> {
    TOOLS
        .iter()
        .map(|t| {
            let mut props = Map::new();
            for p in t.params {
                props.insert(p.name.to_string(), schema_of(p));
            }
            let required: Vec<&str> = t.params.iter().filter(|p| p.required).map(|p| p.name).collect();
            ToolSpec {
                name: t.name,
                description: t.description,
                parameters: json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false }),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------------

fn shown(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 60 {
        format!("{}…", s.chars().take(60).collect::<String>())
    } else {
        s
    }
}

fn fmt_num(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

fn check_id(field: &str, v: &Value) -> Result<(), ToolError> {
    match v.as_str() {
        Some(s) if !s.trim().is_empty() && s.len() <= 64 => Ok(()),
        Some(_) => Err(ToolError::invalid(field, format!("`{field}` must be a non-empty id of at most 64 characters. Use ids returned by get_timeline."))),
        None => Err(ToolError::invalid(field, format!("`{field}` must be a string id (got {}). Use ids returned by get_timeline.", shown(v)))),
    }
}

fn check_param(p: &Param, v: &Value) -> Result<(), ToolError> {
    let f = p.name;
    match p.ty {
        Ty::Number { min, max } => {
            let n = match v {
                Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
                _ => None,
            };
            let Some(n) = n else {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be a JSON number (got {}).", shown(v)),
                ));
            };
            if n < min || n > max {
                return Err(ToolError::invalid(
                    f,
                    format!(
                        "`{f}` must be between {} and {} (got {}).",
                        fmt_num(min),
                        fmt_num(max),
                        fmt_num(n)
                    ),
                ));
            }
        }
        Ty::Integer { min, max } => {
            let n = match v {
                Value::Number(n) => n.as_i64().or_else(|| {
                    n.as_f64()
                        .filter(|x| x.is_finite() && x.fract() == 0.0 && x.abs() < 9e15)
                        .map(|x| x as i64)
                }),
                _ => None,
            };
            let Some(n) = n else {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be a whole number (got {}).", shown(v)),
                ));
            };
            if n < min || n > max {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be between {min} and {max} (got {n})."),
                ));
            }
        }
        Ty::Bool => {
            if !v.is_boolean() {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be true or false (got {}).", shown(v)),
                ));
            }
        }
        Ty::Text { max_len } => {
            let Some(s) = v.as_str() else {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be a string (got {}).", shown(v)),
                ));
            };
            if s.trim().is_empty() {
                return Err(ToolError::invalid(f, format!("`{f}` must not be empty.")));
            }
            if s.chars().count() > max_len {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` is too long (max {max_len} characters)."),
                ));
            }
        }
        Ty::Enum(values) => {
            let ok = v.as_str().is_some_and(|s| values.contains(&s));
            if !ok {
                return Err(ToolError::invalid(
                    f,
                    format!(
                        "`{f}` must be one of: {} (got {}).",
                        values.join(", "),
                        shown(v)
                    ),
                ));
            }
        }
        Ty::Id => check_id(f, v)?,
        Ty::IdList { max } => {
            let Some(items) = v.as_array() else {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must be an array of id strings (got {}).", shown(v)),
                ));
            };
            if items.is_empty() {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` must contain at least one id."),
                ));
            }
            if items.len() > max {
                return Err(ToolError::invalid(
                    f,
                    format!("`{f}` may contain at most {max} ids."),
                ));
            }
            for item in items {
                check_id(f, item)?;
            }
        }
    }
    Ok(())
}

/// Validated arguments of one tool call (explicit `null`s of optional arguments are
/// treated as absent).
struct Args<'a> {
    map: &'a Map<String, Value>,
}

impl<'a> Args<'a> {
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|v| !v.is_null())
    }
    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    fn num(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.as_f64())
    }
    fn int(&self, key: &str) -> Option<i64> {
        self.get(key)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
    }
    fn boolean(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(|v| v.as_bool())
    }
    fn text(&self, key: &str) -> Option<String> {
        self.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }
    fn ids(&self, key: &str) -> Option<Vec<String>> {
        self.get(key).and_then(|v| v.as_array()).map(|a| {
            let mut seen = BTreeSet::new();
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| seen.insert(s.to_string()))
                .map(|s| s.to_string())
                .collect()
        })
    }
    fn time(&self, key: &str) -> Option<TimelineTime> {
        self.num(key).map(|s| TimelineTime(seconds_to_ticks(s)))
    }
    fn ticks(&self, key: &str) -> Option<Ticks> {
        self.num(key).map(seconds_to_ticks)
    }
}

fn validate_args<'a>(def: &ToolDef, arguments: &'a Value) -> Result<Args<'a>, ToolError> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    let map = match arguments {
        Value::Object(m) => m,
        // tools without arguments are often called with `null`
        Value::Null => EMPTY.get_or_init(Map::new),
        other => {
            return Err(ToolError {
                code: ToolErrorCode::InvalidArguments,
                message: format!(
                    "Arguments for `{}` must be a JSON object (got {}).",
                    def.name,
                    shown(other)
                ),
                field: None,
            })
        }
    };
    for key in map.keys() {
        if !def.params.iter().any(|p| p.name == key) {
            let allowed: Vec<&str> = def.params.iter().map(|p| p.name).collect();
            let hint = if allowed.is_empty() {
                "This tool takes no arguments.".to_string()
            } else {
                format!("Allowed arguments: {}.", allowed.join(", "))
            };
            return Err(ToolError::invalid(
                key,
                format!("Unknown argument `{key}` for tool `{}`. {hint}", def.name),
            ));
        }
    }
    for p in def.params {
        match map.get(p.name) {
            None | Some(Value::Null) => {
                if p.required {
                    return Err(ToolError::invalid(
                        p.name,
                        format!(
                            "Missing required argument `{}` for tool `{}`.",
                            p.name, def.name
                        ),
                    ));
                }
            }
            Some(v) => check_param(p, v)?,
        }
    }
    Ok(Args { map })
}

fn range_of(a: &Args) -> Result<(TimelineTime, TimelineTime), ToolError> {
    let (s, e) = (
        a.num("start_seconds").unwrap_or(0.0),
        a.num("end_seconds").unwrap_or(0.0),
    );
    if e <= s {
        return Err(ToolError::invalid(
            "end_seconds",
            format!(
                "`end_seconds` ({}) must be greater than `start_seconds` ({}).",
                fmt_num(e),
                fmt_num(s)
            ),
        ));
    }
    Ok((
        TimelineTime(seconds_to_ticks(s)),
        TimelineTime(seconds_to_ticks(e)),
    ))
}

/// The given clips plus the members of their groups and — when `linked` — their
/// A/V-linked companions accepted by `keep` (never companions on locked tracks).
fn expand(
    project: &Project,
    ids: Vec<String>,
    linked: bool,
    keep: impl Fn(&Clip, &Clip) -> bool,
) -> Vec<String> {
    let mut out = ids.clone();
    let mut seen: BTreeSet<String> = ids.iter().cloned().collect();
    for id in &ids {
        let Some(c) = project.clips.get(id) else {
            continue;
        };
        for other in project.clips.values() {
            if seen.contains(&other.id) || project.track(&other.track_id).is_some_and(|t| t.locked)
            {
                continue;
            }
            let same_group = c.group_id.is_some() && other.group_id == c.group_id;
            let same_link =
                linked && c.link_id.is_some() && other.link_id == c.link_id && keep(c, other);
            if same_group || same_link {
                seen.insert(other.id.clone());
                out.push(other.id.clone());
            }
        }
    }
    out
}

/// Validate a tool call and turn it into an action. Ids are *not* checked for
/// existence here — the command does that and its error is returned to the model.
pub fn parse_tool_call(
    name: &str,
    arguments: &Value,
    project: &Project,
) -> Result<ToolAction, ToolError> {
    let Some(def) = TOOLS.iter().find(|t| t.name == name) else {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        return Err(ToolError {
            code: ToolErrorCode::UnknownTool,
            message: format!(
                "Unknown tool `{name}`. Available tools: {}.",
                names.join(", ")
            ),
            field: None,
        });
    };
    let a = validate_args(def, arguments)?;
    let linked = a.boolean("include_linked").unwrap_or(true);
    Ok(match def.name {
        "get_timeline" => ToolAction::Query(ToolQuery::GetTimeline),
        "get_project_info" => ToolAction::Query(ToolQuery::GetProjectInfo),
        "get_transcript" => {
            if a.has("start_seconds") && a.has("end_seconds") {
                range_of(&a)?;
            }
            ToolAction::Query(ToolQuery::GetTranscript {
                start: a.time("start_seconds"),
                end: a.time("end_seconds"),
            })
        }
        "split_clips" => {
            let clip_ids = a
                .ids("clip_ids")
                .map(|ids| expand(project, ids, linked, |_, _| true));
            ToolAction::Command(Command::SplitClips {
                at: a.time("time_seconds").unwrap(),
                clip_ids,
            })
        }
        "trim_clip" => {
            let delta = a.num("delta_seconds").unwrap();
            if delta == 0.0 {
                return Err(ToolError::invalid("delta_seconds", "`delta_seconds` must not be 0 (negative moves the edge earlier, positive later)."));
            }
            let edge = if a.text("edge").as_deref() == Some("start") {
                Edge::Start
            } else {
                Edge::End
            };
            // only companions that share the trimmed edge stay in sync when trimmed together
            let ids = expand(
                project,
                vec![a.text("clip_id").unwrap()],
                linked,
                |c, o| match edge {
                    Edge::Start => o.start == c.start,
                    Edge::End => o.end() == c.end(),
                },
            );
            ToolAction::Command(Command::TrimClips {
                clip_ids: ids,
                edge,
                delta: seconds_to_ticks(delta),
                ripple: a.boolean("ripple").unwrap_or(false),
            })
        }
        "move_clip" => {
            let id = a.text("clip_id").unwrap();
            let start = a.time("start_seconds").unwrap();
            let track_id = a.text("track_id");
            let moves = match project.clips.get(&id) {
                Some(c) => {
                    let delta = start - c.start;
                    expand(project, vec![id.clone()], linked, |_, _| true)
                        .into_iter()
                        .filter_map(|cid| project.clips.get(&cid))
                        .map(|o| {
                            if o.id == id {
                                ClipMove {
                                    clip_id: o.id.clone(),
                                    start,
                                    track_id: track_id
                                        .clone()
                                        .unwrap_or_else(|| o.track_id.clone()),
                                }
                            } else {
                                ClipMove {
                                    clip_id: o.id.clone(),
                                    start: o.start + delta,
                                    track_id: o.track_id.clone(),
                                }
                            }
                        })
                        .collect()
                }
                // unknown id: let the command report it
                None => vec![ClipMove {
                    clip_id: id,
                    start,
                    track_id: track_id.unwrap_or_default(),
                }],
            };
            ToolAction::Command(Command::MoveClips {
                moves,
                mode: Default::default(),
            })
        }
        "delete_clips" => ToolAction::Command(Command::DeleteClips {
            clip_ids: expand(project, a.ids("clip_ids").unwrap(), linked, |_, _| true),
            ripple: a.boolean("ripple").unwrap_or(false),
        }),
        "delete_time_range" => {
            let (start, end) = range_of(&a)?;
            ToolAction::Command(Command::RippleDeleteRange { start, end })
        }
        "set_clip_speed" => ToolAction::Command(Command::SetSpeed {
            clip_ids: expand(project, a.ids("clip_ids").unwrap(), linked, |c, o| {
                o.start == c.start && o.end() == c.end() && o.content.is_timed_media()
            }),
            speed: a.num("speed").unwrap(),
            ripple: a.boolean("ripple").unwrap_or(true),
        }),
        "update_clips" => {
            let patch = ClipPatch {
                opacity: a.num("opacity"),
                scale: a.num("scale"),
                x: a.num("x"),
                y: a.num("y"),
                rotation: a.num("rotation"),
                brightness: a.num("brightness"),
                contrast: a.num("contrast"),
                saturation: a.num("saturation"),
                temperature: a.num("temperature"),
                gain_db: a.num("gain_db"),
                fade_in: a.ticks("fade_in_seconds"),
                fade_out: a.ticks("fade_out_seconds"),
                enabled: a.boolean("enabled"),
                text: a.text("text"),
                ..ClipPatch::default()
            };
            if patch == ClipPatch::default() {
                return Err(ToolError::invalid(
                    "clip_ids",
                    "`update_clips` needs at least one property to change (opacity, scale, x, y, rotation, brightness, contrast, saturation, temperature, gain_db, fade_in_seconds, fade_out_seconds, enabled or text).",
                ));
            }
            ToolAction::Command(Command::UpdateClips {
                clip_ids: a.ids("clip_ids").unwrap(),
                patch,
            })
        }
        "add_text" => ToolAction::Command(Command::AddText {
            text: a.text("text").unwrap(),
            start: a.time("start_seconds").unwrap(),
            duration: a.ticks("duration_seconds"),
            track_id: None,
        }),
        "add_transition" => {
            let kind = match a.text("kind").as_deref() {
                Some("dip_to_black") => TransitionKind::DipToBlack,
                Some("slide") => TransitionKind::Slide,
                Some("push") => TransitionKind::Push,
                _ => TransitionKind::CrossDissolve,
            };
            ToolAction::Command(Command::AddTransitions {
                left_clip_ids: vec![a.text("after_clip_id").unwrap()],
                kind,
                duration: a.ticks("duration_seconds").unwrap(),
            })
        }
        "set_track" => {
            if !["muted", "solo", "locked", "hidden", "gain_db"]
                .iter()
                .any(|k| a.has(k))
            {
                return Err(ToolError::invalid(
                    "track_id",
                    "`set_track` needs at least one of muted, solo, locked, hidden or gain_db.",
                ));
            }
            ToolAction::Command(Command::UpdateTrack {
                track_id: a.text("track_id").unwrap(),
                name: None,
                muted: a.boolean("muted"),
                solo: a.boolean("solo"),
                locked: a.boolean("locked"),
                hidden: a.boolean("hidden"),
                gain_db: a.num("gain_db"),
            })
        }
        "remove_filler_words" => ToolAction::RemoveFillers,
        "remove_silences" => {
            let d = SilenceOptions::default();
            ToolAction::RemoveSilences(SilenceOptions {
                threshold_db: a.num("threshold_db").unwrap_or(d.threshold_db),
                min_duration_ms: a.int("min_duration_ms").unwrap_or(d.min_duration_ms),
                padding_ms: a.int("padding_ms").unwrap_or(d.padding_ms),
            })
        }
        "remove_spoken_range" => {
            let (start, end) = range_of(&a)?;
            ToolAction::RemoveSpokenRange { start, end }
        }
        "generate_captions" => {
            let d = CaptionOptions::default();
            ToolAction::Command(Command::GenerateCaptions {
                options: CaptionOptions {
                    max_chars_per_line: a
                        .int("max_chars_per_line")
                        .map(|v| v as u32)
                        .unwrap_or(d.max_chars_per_line),
                    max_lines: a.int("max_lines").map(|v| v as u32).unwrap_or(d.max_lines),
                    speaker_labels: a.boolean("speaker_labels").unwrap_or(d.speaker_labels),
                    ..d
                },
            })
        }
        "add_marker" => ToolAction::Command(Command::AddMarker {
            time: a.time("time_seconds").unwrap(),
            label: a.text("label").unwrap_or_default(),
            color: None,
        }),
        other => unreachable!("tool `{other}` is in the table but has no handler"),
    })
}

// ---------------------------------------------------------------------------------
// Read-only renderers
// ---------------------------------------------------------------------------------

/// Ticks → seconds rounded to milliseconds.
pub fn secs(t: Ticks) -> f64 {
    (t as f64 / TICKS_PER_SECOND as f64 * 1000.0).round() / 1000.0
}

fn clip_label(p: &Project, c: &Clip) -> String {
    match &c.content {
        ClipContent::Text { text, .. } | ClipContent::Caption { text, .. } => {
            let flat = text.replace('\n', " / ");
            if flat.chars().count() > 80 {
                format!("{}…", flat.chars().take(80).collect::<String>())
            } else {
                flat
            }
        }
        other => other
            .asset_id()
            .and_then(|a| p.assets.get(a))
            .map(|a| a.name.clone())
            .unwrap_or_else(|| "missing media".into()),
    }
}

/// Most clips listed by [`describe_timeline`] (the rest is summarised).
pub const MAX_DESCRIBED_CLIPS: usize = 400;
/// Upper bound for the transcript text returned by [`describe_transcript`].
pub const MAX_TRANSCRIPT_CHARS: usize = 12_000;

pub fn describe_project(p: &Project) -> Value {
    json!({
        "name": p.name,
        "width": p.settings.width,
        "height": p.settings.height,
        "fps": (p.fps().as_f64() * 1000.0).round() / 1000.0,
        "duration_seconds": secs(p.duration()),
        "track_count": p.tracks.len(),
        "clip_count": p.clips.len(),
        "media_count": p.assets.len(),
        "transcript_editing_enabled": p.transcript.enabled,
        "revision": p.revision,
    })
}

/// Compact, model-friendly description of the whole timeline.
pub fn describe_timeline(p: &Project) -> Value {
    let mut remaining = MAX_DESCRIBED_CLIPS;
    let mut omitted = 0usize;
    let mut tracks = Vec::new();
    for t in &p.tracks {
        let mut clips = Vec::new();
        for c in p.track_clips(&t.id) {
            if remaining == 0 {
                omitted += 1;
                continue;
            }
            remaining -= 1;
            let mut o = Map::new();
            o.insert("id".into(), json!(c.id));
            o.insert("kind".into(), json!(c.content.kind_name()));
            o.insert("label".into(), json!(clip_label(p, c)));
            o.insert("start".into(), json!(secs(c.start.0)));
            o.insert("end".into(), json!(secs(c.end().0)));
            if c.content.is_timed_media() {
                o.insert("source_in".into(), json!(secs(c.source_in.0)));
                o.insert("source_out".into(), json!(secs(c.source_out().0)));
                if !c.speed.is_normal() {
                    o.insert(
                        "speed".into(),
                        json!((c.speed.as_f64() * 1000.0).round() / 1000.0),
                    );
                }
            }
            if let Some(link) = &c.link_id {
                let linked: Vec<&str> = p
                    .clips
                    .values()
                    .filter(|o| o.id != c.id && o.link_id.as_ref() == Some(link))
                    .map(|o| o.id.as_str())
                    .collect();
                if !linked.is_empty() {
                    o.insert("linked".into(), json!(linked));
                }
            }
            if let Some(g) = &c.group_id {
                o.insert("group".into(), json!(g));
            }
            if !c.enabled {
                o.insert("enabled".into(), json!(false));
            }
            if matches!(c.content, ClipContent::Audio { .. }) && c.gain_db != 0.0 {
                o.insert("gain_db".into(), json!(c.gain_db));
            }
            clips.push(Value::Object(o));
        }
        let kind = match t.kind {
            TrackKind::Video => "video",
            TrackKind::Audio => "audio",
            TrackKind::Caption => "caption",
        };
        let mut o = Map::new();
        o.insert("id".into(), json!(t.id));
        o.insert("name".into(), json!(t.name));
        o.insert("kind".into(), json!(kind));
        for (k, v) in [
            ("muted", t.muted),
            ("solo", t.solo),
            ("locked", t.locked),
            ("hidden", t.hidden),
        ] {
            if v {
                o.insert(k.into(), json!(true));
            }
        }
        o.insert("clips".into(), Value::Array(clips));
        tracks.push(Value::Object(o));
    }
    let transitions: Vec<Value> = p
        .transitions
        .values()
        .map(|t| {
            let kind = serde_json::to_value(t.kind).unwrap_or(Value::Null);
            json!({ "id": t.id, "kind": kind, "after_clip_id": t.left, "before_clip_id": t.right, "duration": secs(t.duration) })
        })
        .collect();
    let markers: Vec<Value> = p
        .markers
        .iter()
        .take(100)
        .map(|m| json!({ "id": m.id, "time": secs(m.time.0), "label": m.label }))
        .collect();
    let mut out = json!({
        "note": "All times are timeline seconds. Tracks are listed top to bottom; the first video track is drawn on top.",
        "project": describe_project(p),
        "tracks": tracks,
        "transitions": transitions,
        "markers": markers,
    });
    if omitted > 0 {
        out["truncated"] = json!(format!(
            "{omitted} more clips are not listed (only the first {MAX_DESCRIBED_CLIPS} are shown)."
        ));
    }
    out
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['"', '\'', ')', '”', '’'])
        .ends_with(['.', '!', '?', '。', '！', '？', '…'])
}

/// The audible speech as sentences with timeline times. `range` keeps only words
/// whose midpoint lies inside it. Output is bounded; when cut short a `truncated`
/// note says where to continue.
pub fn describe_transcript(
    view: &TranscriptView,
    p: &Project,
    range: Option<(TimelineTime, TimelineTime)>,
) -> Value {
    const MAX_WORDS_PER_LINE: usize = 40;
    let mut lines: Vec<Value> = Vec::new();
    let mut chars = 0usize;
    let mut words_listed = 0usize;
    let mut truncated_at: Option<f64> = None;

    'segments: for seg in &view.segments {
        let mut cur: Vec<&crate::mapping::TimelineWord> = Vec::new();
        let flush = |cur: &mut Vec<&crate::mapping::TimelineWord>,
                     lines: &mut Vec<Value>,
                     chars: &mut usize| {
            if cur.is_empty() {
                return;
            }
            let text = cur
                .iter()
                .map(|w| {
                    if w.filler {
                        format!("[{}]", w.text)
                    } else {
                        w.text.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            *chars += text.chars().count();
            let mut o = Map::new();
            o.insert("start".into(), json!(secs(cur[0].start.0)));
            o.insert("end".into(), json!(secs(cur[cur.len() - 1].end.0)));
            if let Some(s) = &cur[0].speaker {
                o.insert("speaker".into(), json!(speaker_name(p, &seg.asset_id, s)));
            }
            o.insert("clip_id".into(), json!(seg.clip_id));
            o.insert("text".into(), json!(text));
            lines.push(Value::Object(o));
            cur.clear();
        };
        for w in &seg.words {
            if let Some((s, e)) = range {
                let mid = TimelineTime((w.start.0 + w.end.0) / 2);
                if mid < s || mid >= e {
                    continue;
                }
            }
            if cur.first().is_some_and(|f| f.speaker != w.speaker) {
                flush(&mut cur, &mut lines, &mut chars);
            }
            if chars >= MAX_TRANSCRIPT_CHARS {
                truncated_at = Some(secs(w.start.0));
                break 'segments;
            }
            cur.push(w);
            words_listed += 1;
            if ends_sentence(&w.text) || cur.len() >= MAX_WORDS_PER_LINE {
                flush(&mut cur, &mut lines, &mut chars);
            }
        }
        flush(&mut cur, &mut lines, &mut chars);
    }
    let mut out = json!({
        "note": "Times are timeline seconds. Words in [brackets] are filler words.",
        "sentences": lines,
        "word_count": words_listed,
        "filler_count": view.filler_count,
    });
    if !view.untranscribed_assets.is_empty() {
        out["untranscribed_media"] = json!(format!(
            "{} audible media item(s) have no completed transcript yet.",
            view.untranscribed_assets.len()
        ));
    }
    if view.segments.is_empty() {
        out["empty"] = json!("No transcribed speech is audible on the timeline. Transcript editing may not be enabled or transcription has not finished.");
    }
    if let Some(t) = truncated_at {
        out["truncated"] = json!(format!(
            "The transcript continues. Call get_transcript with start_seconds={t} to read on."
        ));
    }
    out
}

// ---------------------------------------------------------------------------------
// Cut expansion helpers
// ---------------------------------------------------------------------------------

/// One cut per filler word that is audible on the timeline.
pub fn filler_cuts(view: &TranscriptView) -> Vec<SourceCut> {
    view.segments
        .iter()
        .flat_map(|seg| {
            seg.words
                .iter()
                .filter(|w| w.filler)
                .map(move |w| SourceCut {
                    clip_id: seg.clip_id.clone(),
                    source_start: w.source_start,
                    source_end: w.source_end,
                    text: w.text.clone(),
                })
        })
        .collect()
}

pub fn silence_cuts(candidates: &[SilenceCandidate]) -> Vec<SourceCut> {
    candidates
        .iter()
        .map(|c| SourceCut {
            clip_id: c.clip_id.clone(),
            source_start: c.source_start,
            source_end: c.source_end,
            text: String::new(),
        })
        .collect()
}

/// Cuts for the words whose timeline midpoint lies in `[start, end)`. Consecutive
/// selected words of one clip become a single cut (pauses between them go too).
pub fn spoken_range_cuts(
    view: &TranscriptView,
    start: TimelineTime,
    end: TimelineTime,
) -> Vec<SourceCut> {
    let mut cuts: Vec<SourceCut> = Vec::new();
    for seg in &view.segments {
        let mut open: Option<SourceCut> = None;
        for w in &seg.words {
            let mid = TimelineTime((w.start.0 + w.end.0) / 2);
            if mid >= start && mid < end {
                match open.as_mut() {
                    Some(c) => {
                        c.source_end = c.source_end.max(w.source_end);
                        c.text.push(' ');
                        c.text.push_str(&w.text);
                    }
                    None => {
                        open = Some(SourceCut {
                            clip_id: seg.clip_id.clone(),
                            source_start: w.source_start,
                            source_end: w.source_end,
                            text: w.text.clone(),
                        })
                    }
                }
            } else if let Some(c) = open.take() {
                cuts.push(c);
            }
        }
        if let Some(c) = open.take() {
            cuts.push(c);
        }
    }
    cuts
}
