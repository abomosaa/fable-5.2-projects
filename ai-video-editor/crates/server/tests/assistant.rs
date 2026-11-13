//! Editing assistant: shared tool execution, the rule-based fixture planner and the
//! live Pi SDK bridge (real sidecar process, mock model endpoint).
//!
//! No network and no secrets: live-mode tests point the sidecar's provider at a
//! local HTTP server that speaks the Anthropic Messages streaming format, and the
//! sidecar gets an empty environment plus a dummy key.

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::post;
use cutline_core::analysis::{timeline_silences, SilenceCandidate, SilenceOptions, Waveform};
use cutline_core::commands::Command;
use cutline_core::error::CommandError;
use cutline_core::history::{Change, History, Session};
use cutline_core::mapping::{timeline_transcript, TranscriptView};
use cutline_core::model::*;
use cutline_core::time::{FrameRate, SourceTime, TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::{Env, Transcript, Word};
use cutline_server::assistant::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const SEC: i64 = TICKS_PER_SECOND;
const PROJECT: &str = "p1";

// ---------------------------------------------------------------------------------
// In-memory host on a real core Session
// ---------------------------------------------------------------------------------

struct MemHost {
    session: Mutex<Session>,
    transcripts: BTreeMap<AssetId, Arc<Transcript>>,
    waveforms: BTreeMap<AssetId, Arc<Waveform>>,
    executed: Mutex<Vec<Command>>,
}

impl MemHost {
    fn project(&self) -> Project {
        self.session.lock().unwrap().project.clone()
    }
    fn revision(&self) -> u64 {
        self.session.lock().unwrap().project.revision
    }
    fn undo(&self) {
        let mut s = self.session.lock().unwrap();
        let rev = s.project.revision;
        s.undo(rev, 0).unwrap();
    }
    fn env(&self) -> Env {
        Env {
            transcripts: self.transcripts.clone(),
            ..Env::default()
        }
    }
    fn vid_end(&self) -> i64 {
        self.project()
            .clips
            .values()
            .filter(|c| c.asset_id() == Some("vid"))
            .map(|c| c.end().0)
            .max()
            .unwrap_or(0)
    }
}

impl AssistantHost for MemHost {
    fn project(&self, project_id: &str) -> Result<Project, String> {
        if project_id != PROJECT {
            return Err("Project not found".into());
        }
        Ok(MemHost::project(self))
    }
    fn transcript_view(&self, _project_id: &str) -> Result<TranscriptView, String> {
        Ok(timeline_transcript(
            &MemHost::project(self),
            &self.transcripts,
        ))
    }
    fn silences(
        &self,
        _project_id: &str,
        opts: SilenceOptions,
    ) -> Result<Vec<SilenceCandidate>, String> {
        Ok(timeline_silences(
            &MemHost::project(self),
            &self.waveforms,
            &self.transcripts,
            opts,
        ))
    }
    fn execute(&self, _project_id: &str, command: Command) -> Result<Change, CommandError> {
        let mut s = self.session.lock().unwrap();
        let rev = s.project.revision;
        let change = s.execute(rev, &command, &self.env(), 0)?;
        self.executed.lock().unwrap().push(command);
        Ok(change)
    }
}

fn word(index: u32, text: &str, start_ms: i64, end_ms: i64, speaker: &str) -> Word {
    Word {
        index,
        text: text.into(),
        start: SourceTime::from_ms(start_ms),
        end: SourceTime::from_ms(end_ms),
        speaker: Some(speaker.into()),
        language: Some("en".into()),
        confidence: Some(0.9),
        token_start: index,
        token_end: index + 1,
    }
}

/// A 20 s linked video+audio pair at 0. Speech in 1–5.8 s and 9–12 s with two
/// fillers; the audio is silent between 6 s and 8 s.
fn host_with(transcribed: bool) -> Arc<MemHost> {
    let mut p = Project::new(PROJECT, "Demo", 0);
    cutline_core::commands::add_asset(
        &mut p,
        AssetInfo {
            id: "vid".into(),
            name: "interview.mp4".into(),
            kind: AssetKind::Video,
            duration: 20 * SEC,
            has_video: true,
            has_audio: true,
            width: 1920,
            height: 1080,
            fps: Some(FrameRate::FPS_30),
            sample_rate: Some(48_000),
            channels: Some(2),
        },
    );
    let mut session = Session::new(p, History::default());
    session
        .execute(
            0,
            &Command::AddAssetClips {
                asset_id: "vid".into(),
                start: None,
                track_id: None,
                source_in: None,
                source_out: None,
                mode: Default::default(),
            },
            &Env::default(),
            0,
        )
        .unwrap();
    let words = vec![
        word(0, "Hello", 1000, 1400, "1"),
        word(1, "um", 1500, 1800, "1"),
        word(2, "world.", 2000, 2500, "1"),
        word(3, "Second", 4000, 4400, "2"),
        word(4, "uh,", 4500, 4700, "2"),
        word(5, "sentence", 4800, 5300, "2"),
        word(6, "here.", 5400, 5800, "2"),
        word(7, "After", 9000, 9400, "1"),
        word(8, "the", 9500, 9700, "1"),
        word(9, "pause.", 9800, 10400, "1"),
    ];
    let t = Transcript {
        asset_id: "vid".into(),
        provider: "fixture".into(),
        model: "test".into(),
        fixture: true,
        tokens: vec![],
        words,
        speakers: vec!["1".into(), "2".into()],
        languages: vec!["en".into()],
    };
    let mut transcripts = BTreeMap::new();
    if transcribed {
        transcripts.insert("vid".to_string(), Arc::new(t));
    }
    // 100 peaks per second, loud everywhere except 6 s..8 s
    let peaks: Vec<u16> = (0..2000)
        .map(|i| if (600..800).contains(&i) { 0 } else { 30_000 })
        .collect();
    let waveforms = BTreeMap::from([(
        "vid".to_string(),
        Arc::new(Waveform {
            peaks_per_second: 100,
            peaks,
        }),
    )]);
    Arc::new(MemHost {
        session: Mutex::new(session),
        transcripts,
        waveforms,
        executed: Mutex::new(Vec::new()),
    })
}

fn host() -> Arc<MemHost> {
    host_with(true)
}

fn fixture_cfg() -> AssistantConfig {
    AssistantConfig {
        fixture: true,
        node: "node".into(),
        sidecar_dir: "sidecar".into(),
        provider: None,
        model: None,
        max_tool_calls: 8,
        turn_timeout: Duration::from_secs(20),
    }
}

fn say(message: &str) -> TurnRequest {
    TurnRequest {
        message: message.into(),
        ..TurnRequest::default()
    }
}

async fn turn_env(
    host: &Arc<MemHost>,
    cfg: &AssistantConfig,
    req: TurnRequest,
    env: SidecarEnv,
    cancel: CancellationToken,
) -> Vec<AssistantEvent> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    let h: Arc<dyn AssistantHost> = host.clone();
    run_turn_with_env(h, cfg, PROJECT, req, tx, cancel, env).await;
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

async fn fixture_turn(host: &Arc<MemHost>, req: TurnRequest) -> Vec<AssistantEvent> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    let h: Arc<dyn AssistantHost> = host.clone();
    // the public entry point (inherits the environment; irrelevant in fixture mode)
    run_turn(
        h,
        &fixture_cfg(),
        PROJECT,
        req,
        tx,
        CancellationToken::new(),
    )
    .await;
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

fn kinds(events: &[AssistantEvent]) -> Vec<&'static str> {
    events
        .iter()
        .map(|e| match e {
            AssistantEvent::Started { .. } => "started",
            AssistantEvent::TextDelta { .. } => "text",
            AssistantEvent::ToolCall { .. } => "call",
            AssistantEvent::ToolResult { .. } => "result",
            AssistantEvent::Done { .. } => "done",
            AssistantEvent::Error { .. } => "error",
        })
        .collect()
}

fn calls(events: &[AssistantEvent]) -> Vec<(String, Value)> {
    events
        .iter()
        .filter_map(|e| {
            if let AssistantEvent::ToolCall {
                name, arguments, ..
            } = e
            {
                Some((name.clone(), arguments.clone()))
            } else {
                None
            }
        })
        .collect()
}

fn results(events: &[AssistantEvent]) -> Vec<(bool, String, Option<u64>)> {
    events
        .iter()
        .filter_map(|e| {
            if let AssistantEvent::ToolResult {
                ok,
                summary,
                revision,
                ..
            } = e
            {
                Some((*ok, summary.clone(), *revision))
            } else {
                None
            }
        })
        .collect()
}

/// (final text, tool_calls, edits) of a finished turn; checks stream invariants.
fn done(events: &[AssistantEvent]) -> (String, u32, u32) {
    let AssistantEvent::Done {
        text,
        tool_calls,
        edits,
    } = events.last().expect("no events")
    else {
        panic!("turn did not finish with done: {events:?}")
    };
    let streamed: String = events
        .iter()
        .filter_map(|e| {
            if let AssistantEvent::TextDelta { text } = e {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        &streamed, text,
        "streamed deltas must add up to the final text"
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(
                e,
                AssistantEvent::Done { .. } | AssistantEvent::Error { .. }
            ))
            .count(),
        1
    );
    (text.clone(), *tool_calls, *edits)
}

fn error(events: &[AssistantEvent]) -> (String, String) {
    let AssistantEvent::Error { code, message } = events.last().expect("no events") else {
        panic!("turn did not end with an error: {events:?}")
    };
    (code.clone(), message.clone())
}

// ---------------------------------------------------------------------------------
// Shared tool execution ("what a model can do to the project")
// ---------------------------------------------------------------------------------

#[test]
fn invalid_tool_arguments_are_rejected_without_touching_the_project() {
    let h = host();
    let before = h.project();
    for (name, args, needle) in [
        (
            "split_clips",
            json!({"time_seconds": "five"}),
            "time_seconds",
        ),
        (
            "split_clips",
            json!({}),
            "Missing required argument `time_seconds`",
        ),
        (
            "split_clips",
            json!({"time_seconds": 5, "force": true}),
            "Unknown argument `force`",
        ),
        (
            "delete_time_range",
            json!({"start_seconds": 9, "end_seconds": 3}),
            "greater than",
        ),
        (
            "set_clip_speed",
            json!({"clip_ids": ["c5"], "speed": 400}),
            "between 0.1 and 16",
        ),
        ("delete_clips", json!({"clip_ids": []}), "at least one id"),
        (
            "update_clips",
            json!({"clip_ids": ["c5"]}),
            "at least one property",
        ),
        (
            "add_transition",
            json!({"after_clip_id": "c5", "kind": "sparkle", "duration_seconds": 1}),
            "one of",
        ),
        ("split_clips", json!([5]), "JSON object"),
    ] {
        let out = execute_tool(h.as_ref(), PROJECT, name, &args);
        assert!(!out.ok, "{name} {args} must be rejected");
        assert_eq!(out.revision, None);
        assert!(out.summary.contains(needle), "{name}: {}", out.summary);
        // the model receives a structured, actionable error
        let v: Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "invalid_arguments");
        assert_eq!(v["error"]["message"].as_str().unwrap(), out.summary);
    }
    let out = execute_tool(h.as_ref(), PROJECT, "erase_everything", &json!({}));
    assert!(!out.ok);
    let v: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(v["error"]["code"], "unknown_tool");
    assert!(out.summary.contains("Available tools"));

    assert_eq!(
        h.project(),
        before,
        "rejected calls must not change anything"
    );
    assert!(h.executed.lock().unwrap().is_empty());
}

#[test]
fn command_errors_reach_the_model_and_change_nothing() {
    let h = host();
    let before = h.project();
    // stale / invented ids
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "delete_clips",
        &json!({"clip_ids": ["c999"]}),
    );
    assert!(!out.ok);
    let v: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(v["error"]["code"], "not_found");
    assert!(
        out.summary.contains("c999") && out.summary.contains("does not exist"),
        "{}",
        out.summary
    );
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "set_track",
        &json!({"track_id": "t999", "muted": true}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&out.content).unwrap()["error"]["code"],
        "not_found"
    );
    // well-formed but impossible edit
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "split_clips",
        &json!({"time_seconds": 500}),
    );
    assert!(!out.ok);
    assert_eq!(
        serde_json::from_str::<Value>(&out.content).unwrap()["error"]["code"],
        "conflict"
    );
    assert!(out.summary.contains("no clip to split"), "{}", out.summary);
    // wrong kind of clip for a property
    let video = h
        .project()
        .clips
        .values()
        .find(|c| matches!(c.content, ClipContent::Video { .. }))
        .unwrap()
        .id
        .clone();
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "update_clips",
        &json!({"clip_ids": [video], "gain_db": -6}),
    );
    assert!(!out.ok);
    assert!(out.summary.contains("audio clips"), "{}", out.summary);
    // unknown project
    let out = execute_tool(h.as_ref(), "nope", "get_timeline", &json!({}));
    assert!(!out.ok);

    assert_eq!(h.project(), before);
    assert_eq!(h.revision(), 1);
}

#[test]
fn queries_return_model_friendly_json_and_edits_report_revisions() {
    let h = host();
    let out = execute_tool(h.as_ref(), PROJECT, "get_timeline", &json!({}));
    assert!(out.ok && out.revision.is_none());
    assert_eq!(out.summary, "Read the timeline (2 clips on 4 tracks)");
    let v: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(v["project"]["duration_seconds"], 20.0);
    let clip = v["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["clips"].as_array().unwrap())
        .find(|c| c["kind"] == "video")
        .unwrap()
        .clone();
    assert_eq!(clip["label"], "interview.mp4");

    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "get_transcript",
        &json!({"start_seconds": 3, "end_seconds": 7}),
    );
    let v: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(v["sentences"][0]["text"], "Second [uh,] sentence here.");
    assert_eq!(out.summary, "Read the transcript (4 words)");
    assert!(execute_tool(h.as_ref(), PROJECT, "get_project_info", &Value::Null).ok);
    assert_eq!(h.revision(), 1, "queries never change the project");

    // an edit: uses the clip id the model just read, includes the linked audio
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "trim_clip",
        &json!({"clip_id": clip["id"], "edge": "end", "delta_seconds": -5}),
    );
    assert!(out.ok, "{}", out.summary);
    assert_eq!(out.revision, Some(2));
    let v: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(v["changed"], true);
    assert_eq!(v["revision"], 2);
    assert_eq!(v["timeline_duration_seconds"], 15.0);
    assert!(h.project().clips.values().all(|c| c.duration == 15 * SEC));
    // repeating a no-op edit is reported as "nothing changed", not as a failure
    execute_tool(
        h.as_ref(),
        PROJECT,
        "set_track",
        &json!({"track_id": h.project().tracks[0].id, "hidden": true}),
    );
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "set_track",
        &json!({"track_id": h.project().tracks[0].id, "hidden": true}),
    );
    assert!(out.ok);
    assert_eq!(out.revision, None);
    assert_eq!(
        serde_json::from_str::<Value>(&out.content).unwrap()["changed"],
        false
    );
}

#[test]
fn transcript_tools_expand_to_traceable_ripple_edits() {
    let h = host();
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "remove_spoken_range",
        &json!({"start_seconds": 3.9, "end_seconds": 6}),
    );
    assert!(out.ok, "{}", out.summary);
    let p = h.project();
    // "Second uh, sentence here." = source 4.0–5.8 s removed from picture and sound
    assert_eq!(h.vid_end(), 20 * SEC - SEC * 18 / 10);
    assert_eq!(p.transcript.removals.len(), 1);
    assert_eq!(p.transcript.removals[0].reason, RemovalReason::Assistant);
    assert_eq!(p.transcript.removals[0].text, "Second uh, sentence here.");
    assert_eq!(
        (
            p.transcript.removals[0].source_start,
            p.transcript.removals[0].source_end
        ),
        (SourceTime::from_ms(4000), SourceTime::from_ms(5800))
    );
    assert!(matches!(
        h.executed.lock().unwrap().last(),
        Some(Command::RippleDeleteSource {
            reason: RemovalReason::Assistant,
            ..
        })
    ));
    // nothing spoken there any more: a successful no-op
    let out = execute_tool(
        h.as_ref(),
        PROJECT,
        "remove_spoken_range",
        &json!({"start_seconds": 15, "end_seconds": 16}),
    );
    assert!(out.ok && out.revision.is_none());
    assert!(out.summary.contains("No spoken words"));
}

// ---------------------------------------------------------------------------------
// Fixture planner
// ---------------------------------------------------------------------------------

#[tokio::test]
async fn fixture_removes_filler_words_and_is_undoable() {
    let h = host();
    let before = h.project();
    let events = fixture_turn(&h, say("Please remove the filler words")).await;
    assert_eq!(
        events[0],
        AssistantEvent::Started {
            mode: "fixture".into(),
            provider: None,
            model: None,
            fixture: true
        }
    );
    assert_eq!(
        calls(&events),
        vec![("remove_filler_words".to_string(), json!({}))]
    );
    let r = results(&events);
    assert_eq!(r.len(), 1);
    assert!(r[0].0);
    assert_eq!(r[0].1, "Remove 2 filler words");
    assert_eq!(r[0].2, Some(2));
    let (text, tool_calls, edits) = done(&events);
    assert_eq!((tool_calls, edits), (1, 1));
    assert!(
        text.starts_with("Fixture assistant (rule-based, not an AI model):"),
        "{text}"
    );
    assert!(text.contains("Remove 2 filler words"));
    assert!(text.contains("undo"), "{text}");
    assert_eq!(&kinds(&events)[..3], ["started", "call", "result"]);

    // the session really changed: 0.3 s + 0.2 s of "um"/"uh," are gone from both clips
    assert_eq!(h.vid_end(), 20 * SEC - SEC / 2);
    let view = timeline_transcript(&h.project(), &h.transcripts);
    assert_eq!(view.filler_count, 0);
    assert_eq!(
        h.project()
            .transcript
            .removals
            .iter()
            .filter(|r| r.reason == RemovalReason::Filler)
            .count(),
        2
    );
    // … as one ordinary undo step
    h.undo();
    let after_undo = h.project();
    assert_eq!(after_undo.clips, before.clips);
    assert_eq!(after_undo.transcript, before.transcript);

    // asking again when there is nothing left is a friendly no-op
    execute_tool(h.as_ref(), PROJECT, "remove_filler_words", &json!({}));
    let rev = h.revision();
    let events = fixture_turn(&h, say("remove ums and uhs")).await;
    let r = results(&events);
    assert!(r[0].0 && r[0].2.is_none());
    assert!(r[0].1.contains("No filler words"));
    assert_eq!(done(&events).2, 0);
    assert_eq!(h.revision(), rev);
}

#[tokio::test]
async fn fixture_without_transcripts_explains_instead_of_failing() {
    let h = host_with(false);
    let events = fixture_turn(&h, say("remove filler words")).await;
    let r = results(&events);
    assert!(r[0].0 && r[0].2.is_none());
    assert!(r[0].1.contains("no transcribed speech"), "{}", r[0].1);
    // captions need a transcript: the command's own error is surfaced
    let events = fixture_turn(&h, say("add captions")).await;
    let r = results(&events);
    assert!(!r[0].0);
    assert!(r[0].1.contains("Enable transcript editing"), "{}", r[0].1);
    let (text, _, edits) = done(&events);
    assert_eq!(edits, 0);
    assert!(text.contains("I could not do that"));
    assert_eq!(h.revision(), 1);
}

#[tokio::test]
async fn fixture_removes_silences() {
    let h = host();
    let events = fixture_turn(&h, say("Remove silences longer than 1s")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "remove_silences".to_string(),
            json!({"min_duration_ms": 1000})
        )]
    );
    let r = results(&events);
    assert!(r[0].0, "{}", r[0].1);
    assert_eq!(r[0].1, "Remove silence");
    // the 2 s pause minus 120 ms of breathing room on each side (6.12 s – 7.88 s),
    // snapped to the 30 fps frame grid: frames 184..236
    assert_eq!(h.vid_end(), 20 * SEC - FrameRate::FPS_30.frame_to_ticks(52));
    assert_eq!(
        h.project().transcript.removals[0].reason,
        RemovalReason::Silence
    );
    h.undo();
    assert_eq!(h.vid_end(), 20 * SEC);

    // "pauses" without a threshold uses the defaults; a very high threshold finds nothing
    let events = fixture_turn(&h, say("cut the pauses longer than 30 seconds")).await;
    assert_eq!(calls(&events)[0].1, json!({"min_duration_ms": 30000}));
    assert!(results(&events)[0].1.contains("No pauses"));
    let events = fixture_turn(&h, say("tighten the dead air")).await;
    assert_eq!(
        calls(&events),
        vec![("remove_silences".to_string(), json!({}))]
    );
    assert_eq!(done(&events).2, 1);
}

#[tokio::test]
async fn fixture_generates_captions() {
    let h = host();
    let events = fixture_turn(&h, say("Generate captions with speaker names")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "generate_captions".to_string(),
            json!({"speaker_labels": true})
        )]
    );
    assert!(results(&events)[0].0, "{:?}", results(&events));
    let p = h.project();
    let captions: Vec<&Clip> = p
        .clips
        .values()
        .filter(|c| matches!(c.content, ClipContent::Caption { .. }))
        .collect();
    assert!(
        captions.len() >= 3,
        "expected several captions, got {}",
        captions.len()
    );
    assert!(captions.iter().any(|c| matches!(&c.content, ClipContent::Caption { text, .. } if text.starts_with("Speaker 1:"))));
    assert!(p.tracks.iter().any(|t| t.kind == TrackKind::Caption));
    h.undo();
    assert!(!h
        .project()
        .clips
        .values()
        .any(|c| matches!(c.content, ClipContent::Caption { .. })));
    // "subtitles" is understood too
    let events = fixture_turn(&h, say("add subtitles")).await;
    assert_eq!(
        calls(&events),
        vec![("generate_captions".to_string(), json!({}))]
    );
    // deleting captions is not something the planner pretends to do
    let rev = h.revision();
    let events = fixture_turn(&h, say("delete the captions")).await;
    assert!(calls(&events).is_empty());
    assert!(done(&events).0.contains("not delete"));
    assert_eq!(h.revision(), rev);
}

#[tokio::test]
async fn fixture_splits_at_a_time_or_the_playhead() {
    for (message, playhead, expect) in [
        ("split at 5s", None, 5.0),
        ("Split the clips at 5.5 seconds.", None, 5.5),
        ("split at 0:07", None, 7.0),
        ("cut at 00:00:12", None, 12.0),
        ("split at 3", None, 3.0),
        ("split here", Some(4.0), 4.0),
        ("split at the playhead", Some(2.5), 2.5),
    ] {
        let h = host();
        let events = fixture_turn(
            &h,
            TurnRequest {
                message: message.into(),
                playhead_seconds: playhead,
                ..TurnRequest::default()
            },
        )
        .await;
        assert_eq!(
            calls(&events),
            vec![("split_clips".to_string(), json!({"time_seconds": expect}))],
            "{message}"
        );
        assert!(results(&events)[0].0, "{message}");
        let p = h.project();
        assert_eq!(p.clips.len(), 4, "{message}");
        let cut = TimelineTime((expect * SEC as f64) as i64);
        assert_eq!(
            p.clips.values().filter(|c| c.start == cut).count(),
            2,
            "{message}"
        );
        // right halves stay linked to each other
        let rights: Vec<&Clip> = p.clips.values().filter(|c| c.start == cut).collect();
        assert!(rights[0].link_id.is_some() && rights[0].link_id == rights[1].link_id);
        h.undo();
        assert_eq!(h.project().clips.len(), 2);
    }
    // no time and no playhead: ask, don't guess
    let h = host();
    let events = fixture_turn(&h, say("split it")).await;
    assert!(calls(&events).is_empty());
    assert!(done(&events).0.contains("where to split"));
    // a position outside every clip surfaces the command's explanation
    let events = fixture_turn(&h, say("split at 45s")).await;
    assert!(!results(&events)[0].0);
    assert!(done(&events).0.contains("no clip to split"));
    assert_eq!(h.revision(), 1);
}

#[tokio::test]
async fn fixture_deletes_a_time_range() {
    for message in [
        "Cut from 0:10 to 0:15",
        "delete between 10s and 15s",
        "remove 10s-15s",
        "remove everything from 15 to 10",
    ] {
        let h = host();
        let events = fixture_turn(&h, say(message)).await;
        assert_eq!(
            calls(&events),
            vec![(
                "delete_time_range".to_string(),
                json!({"start_seconds": 10.0, "end_seconds": 15.0})
            )],
            "{message}"
        );
        assert!(results(&events)[0].0, "{message}");
        assert_eq!(h.project().duration(), 15 * SEC, "{message}");
        let p = h.project();
        let resumed = p
            .clips
            .values()
            .filter(|c| c.start == TimelineTime(10 * SEC))
            .collect::<Vec<_>>();
        assert_eq!(resumed.len(), 2);
        assert!(
            resumed.iter().all(|c| c.source_in == SourceTime(15 * SEC)),
            "the cut removed source 10–15 s"
        );
        h.undo();
        assert_eq!(h.project().duration(), 20 * SEC);
    }
    // mentioning words makes it a transcript-based removal
    let h = host();
    let events = fixture_turn(&h, say("remove the words from 3.9s to 6s")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "remove_spoken_range".to_string(),
            json!({"start_seconds": 3.9, "end_seconds": 6.0})
        )]
    );
    assert_eq!(h.vid_end(), 20 * SEC - SEC * 18 / 10);
}

#[tokio::test]
async fn fixture_adds_text_overlays() {
    let h = host();
    let events = fixture_turn(&h, say("Add title \"Hello world\" at 2s for 4 seconds")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "add_text".to_string(),
            json!({"text": "Hello world", "start_seconds": 2.0, "duration_seconds": 4.0})
        )]
    );
    assert!(results(&events)[0].0);
    let p = h.project();
    let text = p
        .clips
        .values()
        .find(|c| matches!(c.content, ClipContent::Text { .. }))
        .expect("text clip");
    assert!(matches!(&text.content, ClipContent::Text { text, .. } if text == "Hello world"));
    assert_eq!(
        (text.start, text.duration),
        (TimelineTime(2 * SEC), 4 * SEC)
    );
    assert_eq!(p.track(&text.track_id).unwrap().kind, TrackKind::Video);
    h.undo();

    // defaults: playhead, then 0; default duration from the command
    let events = fixture_turn(
        &h,
        TurnRequest {
            message: "put the text “Chapter 1” on screen".into(),
            playhead_seconds: Some(6.0),
            ..TurnRequest::default()
        },
    )
    .await;
    assert_eq!(
        calls(&events),
        vec![(
            "add_text".to_string(),
            json!({"text": "Chapter 1", "start_seconds": 6.0})
        )]
    );
    let events = fixture_turn(&h, say("add a title 'It's a wrap'")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "add_text".to_string(),
            json!({"text": "It's a wrap", "start_seconds": 0.0})
        )]
    );
    // no quotes: ask for them
    let rev = h.revision();
    let events = fixture_turn(&h, say("add a title saying hello")).await;
    assert!(calls(&events).is_empty());
    assert!(done(&events).0.contains("in quotes"));
    assert_eq!(h.revision(), rev);
}

#[tokio::test]
async fn fixture_changes_speed() {
    for (message, speed, seconds) in [
        ("Speed up 2x", 2.0, 10),
        ("make it slow motion", 0.5, 40),
        ("play at 50% speed", 0.5, 40),
        ("double the speed", 2.0, 10),
        ("set speed x4", 4.0, 5),
    ] {
        let h = host();
        let events = fixture_turn(&h, say(message)).await;
        let c = calls(&events);
        assert_eq!(c.len(), 1, "{message}: {events:?}");
        assert_eq!(c[0].0, "set_clip_speed", "{message}");
        assert_eq!(c[0].1["speed"], json!(speed), "{message}");
        assert_eq!(
            c[0].1["clip_ids"].as_array().unwrap().len(),
            2,
            "{message}: all media clips by default"
        );
        assert!(results(&events)[0].0, "{message}: {:?}", results(&events));
        assert!(
            h.project()
                .clips
                .values()
                .all(|c| c.duration == seconds * SEC),
            "{message}"
        );
        h.undo();
        assert!(h.project().clips.values().all(|c| c.duration == 20 * SEC));
    }
    // the selection narrows the target (the linked audio follows through the tool)
    let h = host();
    execute_tool(
        h.as_ref(),
        PROJECT,
        "split_clips",
        &json!({"time_seconds": 10}),
    );
    let first_video = h
        .project()
        .clips
        .values()
        .find(|c| matches!(c.content, ClipContent::Video { .. }) && c.start == TimelineTime(0))
        .unwrap()
        .id
        .clone();
    let events = fixture_turn(
        &h,
        TurnRequest {
            message: "speed 2x".into(),
            selected_clip_ids: vec![first_video.clone()],
            ..TurnRequest::default()
        },
    )
    .await;
    assert_eq!(
        calls(&events)[0].1,
        json!({"clip_ids": [first_video], "speed": 2.0})
    );
    assert_eq!(
        h.project().duration(),
        15 * SEC,
        "first half now 5 s, second half rippled left"
    );
    // out-of-range speeds are rejected by validation, with the reason passed on
    let events = fixture_turn(&h, say("speed up 100x")).await;
    assert!(!results(&events)[0].0);
    assert!(done(&events).0.contains("between 0.1 and 16"));
    // speed without a number: ask
    let events = fixture_turn(&h, say("change the speed")).await;
    assert!(calls(&events).is_empty());
    assert!(done(&events).0.contains("Tell me the speed"));
}

#[tokio::test]
async fn fixture_switches_tracks() {
    let h = host();
    let a1 = h.project().tracks_of_kind(TrackKind::Audio)[0].id.clone();
    let a2 = h.project().tracks_of_kind(TrackKind::Audio)[1].id.clone();
    let events = fixture_turn(&h, say("Mute A1")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "set_track".to_string(),
            json!({"track_id": a1, "muted": true})
        )]
    );
    assert!(h.project().track(&a1).unwrap().muted);
    let events = fixture_turn(&h, say("unmute track a1 please")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "set_track".to_string(),
            json!({"track_id": a1, "muted": false})
        )]
    );
    assert!(!h.project().track(&a1).unwrap().muted);
    let events = fixture_turn(&h, say("lock a2")).await;
    assert_eq!(
        calls(&events),
        vec![(
            "set_track".to_string(),
            json!({"track_id": a2, "locked": true})
        )]
    );
    assert!(h.project().track(&a2).unwrap().locked);
    // "mute everything" targets the audio tracks; already-muted ones are no-ops
    let events = fixture_turn(&h, say("mute all")).await;
    assert_eq!(calls(&events).len(), 2);
    assert!(h
        .project()
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .all(|t| t.muted));
    // no track named: ask which one
    let rev = h.revision();
    let events = fixture_turn(&h, say("mute")).await;
    assert!(calls(&events).is_empty());
    let (text, _, _) = done(&events);
    assert!(
        text.contains("Which track") && text.contains("A1"),
        "{text}"
    );
    assert_eq!(h.revision(), rev);
}

#[tokio::test]
async fn fixture_combines_requests_and_orders_captions_last() {
    let h = host();
    let events = fixture_turn(
        &h,
        say("Remove filler words and silences, then add captions"),
    )
    .await;
    let names: Vec<String> = calls(&events).into_iter().map(|c| c.0).collect();
    assert_eq!(
        names,
        [
            "remove_filler_words",
            "remove_silences",
            "generate_captions"
        ]
    );
    let (text, tool_calls, edits) = done(&events);
    assert_eq!((tool_calls, edits), (3, 3));
    assert!(text.contains("3 separate undo steps"), "{text}");
    assert_eq!(
        kinds(&events)[..7],
        ["started", "call", "result", "call", "result", "call", "result"]
    );
    // captions were generated from the cleaned-up timeline: none mentions a filler
    let p = h.project();
    assert!(p.clips.values().all(|c| !matches!(&c.content, ClipContent::Caption { text, .. } if text.contains("um") || text.contains("uh"))));
    // three undos bring everything back
    for _ in 0..3 {
        h.undo();
    }
    assert_eq!(h.project().clips.len(), 2);
    assert_eq!(h.vid_end(), 20 * SEC);
}

#[tokio::test]
async fn fixture_is_honest_about_what_it_cannot_do() {
    let h = host();
    for message in [
        "make it pop",
        "color grade this like a Wes Anderson film",
        "hello?",
    ] {
        let events = fixture_turn(&h, say(message)).await;
        assert_eq!(
            kinds(&events),
            ["started", "text", "text", "done"],
            "{message}"
        );
        let (text, tool_calls, edits) = done(&events);
        assert_eq!((tool_calls, edits), (0, 0));
        assert!(text.starts_with("Fixture assistant (rule-based, not an AI model):"));
        assert!(
            text.contains("remove filler words") && text.contains("--fixture"),
            "{text}"
        );
    }
    let events = fixture_turn(&h, say("undo that")).await;
    assert!(calls(&events).is_empty());
    assert!(done(&events).0.contains("Ctrl+Z"));
    let events = fixture_turn(&h, say("what's on the timeline?")).await;
    assert_eq!(
        calls(&events),
        vec![("get_timeline".to_string(), json!({}))]
    );
    assert!(
        done(&events)
            .0
            .contains("0:20.00 with 1 picture clip(s), 1 audio clip(s)"),
        "{}",
        done(&events).0
    );
    assert_eq!(h.revision(), 1);
    for example in FIXTURE_EXAMPLES {
        let h = host();
        let events = fixture_turn(&h, say(example)).await;
        assert!(
            !calls(&events).is_empty(),
            "advertised example \"{example}\" must do something"
        );
        assert!(
            results(&events).iter().all(|r| r.0),
            "advertised example \"{example}\" must succeed: {:?}",
            results(&events)
        );
    }
}

#[tokio::test]
async fn requests_are_validated_and_cancellable() {
    let h = host();
    let events = fixture_turn(&h, say("   ")).await;
    assert_eq!(error(&events).0, "invalid_request");
    let events = fixture_turn(&h, say(&"x".repeat(MAX_MESSAGE_CHARS + 1))).await;
    let (code, message) = error(&events);
    assert_eq!(code, "invalid_request");
    assert!(message.contains("too long"));
    let events = fixture_turn(
        &h,
        TurnRequest {
            message: "split here".into(),
            playhead_seconds: Some(f64::NAN),
            ..TurnRequest::default()
        },
    )
    .await;
    assert_eq!(error(&events).0, "invalid_request");

    let cancel = CancellationToken::new();
    cancel.cancel();
    let events = turn_env(
        &h,
        &fixture_cfg(),
        say("remove filler words"),
        SidecarEnv::Inherit,
        cancel,
    )
    .await;
    assert_eq!(error(&events).0, "aborted");
    assert_eq!(h.revision(), 1, "a cancelled turn makes no edits");

    // the wire format the browser receives
    let v = serde_json::to_value(AssistantEvent::ToolResult {
        id: "t1".into(),
        ok: true,
        summary: "Split".into(),
        revision: Some(3),
    })
    .unwrap();
    assert_eq!(
        v,
        json!({"type": "tool_result", "id": "t1", "ok": true, "summary": "Split", "revision": 3})
    );
    let req: TurnRequest = serde_json::from_value(json!({"message": "hi"})).unwrap();
    assert_eq!(req, say("hi"));
    let req: TurnRequest = serde_json::from_value(json!({"message": "hi", "history": [{"role": "user", "text": "a"}], "playhead_seconds": 1.5, "selected_clip_ids": ["c5"]})).unwrap();
    assert_eq!(req.history.len(), 1);
    assert_eq!(req.playhead_seconds, Some(1.5));
}

#[test]
fn status_describes_the_active_mode() {
    let s = assistant_status(&fixture_cfg());
    assert_eq!(s["mode"], "fixture");
    assert_eq!(s["available"], true);
    assert!(s["hint"].as_str().unwrap().contains("rule-based"));
    assert!(s["examples"].as_array().unwrap().len() >= 6);

    let dir = tempfile::tempdir().unwrap();
    let live = AssistantConfig {
        fixture: false,
        sidecar_dir: dir.path().to_path_buf(),
        provider: Some("anthropic".into()),
        ..fixture_cfg()
    };
    let s = assistant_status(&live);
    assert_eq!(s["mode"], "live");
    assert_eq!(s["sidecar_installed"], false);
    assert_eq!(s["provider"], "anthropic");
    if s["node_found"] == true {
        assert_eq!(s["available"], false);
        assert!(s["hint"].as_str().unwrap().contains("npm ci"));
    }
    let no_node = AssistantConfig {
        node: "definitely-not-node-xyz".into(),
        ..live
    };
    let s = assistant_status(&no_node);
    assert_eq!(s["node_found"], false);
    assert!(s["hint"].as_str().unwrap().contains("Node.js"));
    // the status never contains credentials
    assert!(!s.to_string().to_lowercase().contains("api_key"));
}

// ---------------------------------------------------------------------------------
// Live mode: real Pi SDK sidecar, mock model endpoint
// ---------------------------------------------------------------------------------

const FAKE_KEY: &str = "sk-test-not-a-real-key-0123456789";

enum Block {
    Text(&'static str),
    ToolUse(&'static str, &'static str, Value),
}

enum Reply {
    Message(Vec<Block>, &'static str),
    Hang,
}

type Responder = Box<dyn Fn(&Value, usize) -> Reply + Send + Sync>;

struct Mock {
    requests: Mutex<Vec<Value>>,
    responder: Responder,
}

fn sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

async fn messages(
    State(mock): State<Arc<Mock>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let index = {
        let mut r = mock.requests.lock().unwrap();
        r.push(body.clone());
        r.len() - 1
    };
    let (blocks, stop_reason) = match (mock.responder)(&body, index) {
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(120)).await;
            return axum::http::StatusCode::GATEWAY_TIMEOUT.into_response();
        }
        Reply::Message(b, s) => (b, s),
    };
    let mut out = sse(
        "message_start",
        json!({"type": "message_start", "message": {"id": format!("msg_test_{index}"), "type": "message", "role": "assistant", "model": body["model"], "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    );
    for (i, block) in blocks.iter().enumerate() {
        match block {
            Block::Text(text) => {
                out += &sse(
                    "content_block_start",
                    json!({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}),
                );
                let mid = text.len() / 2;
                for piece in [&text[..mid], &text[mid..]] {
                    if !piece.is_empty() {
                        out += &sse(
                            "content_block_delta",
                            json!({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": piece}}),
                        );
                    }
                }
            }
            Block::ToolUse(id, name, input) => {
                out += &sse(
                    "content_block_start",
                    json!({"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}}),
                );
                out += &sse(
                    "content_block_delta",
                    json!({"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": input.to_string()}}),
                );
            }
        }
        out += &sse(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": i}),
        );
    }
    out += &sse(
        "message_delta",
        json!({"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": null}, "usage": {"output_tokens": 5}}),
    );
    out += &sse("message_stop", json!({"type": "message_stop"}));
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/event-stream"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        out,
    )
        .into_response()
}

async fn mock_model(responder: Responder) -> (Arc<Mock>, String) {
    let mock = Arc::new(Mock {
        requests: Mutex::new(Vec::new()),
        responder,
    });
    let app = axum::Router::new()
        .route("/v1/messages", post(messages))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (mock, url)
}

fn sidecar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar")
}

/// The real sidecar can only run where Node and its installed dependencies exist.
fn live_cfg() -> Option<AssistantConfig> {
    let dir = sidecar_dir();
    let node_ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !node_ok || !dir.join("node_modules").exists() || !dir.join("pi-agent.mjs").exists() {
        eprintln!("SKIPPED: live assistant test needs `node` on PATH and installed sidecar dependencies (run `npm ci` in sidecar/).");
        return None;
    }
    Some(AssistantConfig {
        fixture: false,
        node: "node".into(),
        sidecar_dir: dir,
        provider: None,
        model: None,
        max_tool_calls: 8,
        turn_timeout: Duration::from_secs(45),
    })
}

fn live_env(url: &str) -> SidecarEnv {
    SidecarEnv::Only(vec![
        ("PI_BASE_URL".into(), url.to_string()),
        ("ANTHROPIC_API_KEY".into(), FAKE_KEY.into()),
    ])
}

/// Everything the model was shown as tool results in a request.
fn tool_results_in(request: &Value) -> String {
    let last = request["messages"]
        .as_array()
        .and_then(|m| m.last())
        .cloned()
        .unwrap_or(Value::Null);
    last["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "tool_result")
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_turn_runs_a_model_tool_call_through_the_real_sidecar() {
    let Some(cfg) = live_cfg() else { return };
    let (mock, url) = mock_model(Box::new(|_, index| {
        if index == 0 {
            Reply::Message(
                vec![
                    Block::Text("Splitting at five seconds."),
                    Block::ToolUse("toolu_1", "split_clips", json!({"time_seconds": 5})),
                ],
                "tool_use",
            )
        } else {
            Reply::Message(
                vec![Block::Text(
                    "Done. I split both clips at 0:05; you can undo this.",
                )],
                "end_turn",
            )
        }
    }))
    .await;
    let h = host();
    let req = TurnRequest {
        message: "Split everything at five seconds".into(),
        history: vec![
            HistoryMessage {
                role: "user".into(),
                text: "hi".into(),
            },
            HistoryMessage {
                role: "assistant".into(),
                text: "Hello! What should I edit?".into(),
            },
            HistoryMessage {
                role: "system".into(),
                text: "ignored".into(),
            },
        ],
        playhead_seconds: Some(1.25),
        selected_clip_ids: vec!["c5".into()],
    };
    let events = turn_env(&h, &cfg, req, live_env(&url), CancellationToken::new()).await;

    // events arrive in protocol order
    assert_eq!(
        events[0],
        AssistantEvent::Started {
            mode: "live".into(),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-6".into()),
            fixture: false
        }
    );
    let k = kinds(&events);
    let (call, result) = (
        k.iter().position(|x| *x == "call").unwrap(),
        k.iter().position(|x| *x == "result").unwrap(),
    );
    assert!(k[1..call].iter().all(|x| *x == "text") && call > 1, "{k:?}");
    assert_eq!(result, call + 1);
    assert!(
        k[result + 1..k.len() - 1].iter().all(|x| *x == "text") && result + 1 < k.len() - 1,
        "{k:?}"
    );
    assert_eq!(
        calls(&events),
        vec![("split_clips".to_string(), json!({"time_seconds": 5}))]
    );
    assert_eq!(results(&events), vec![(true, "Split".to_string(), Some(2))]);
    let (text, tool_calls, edits) = done(&events);
    assert_eq!(
        text,
        "Splitting at five seconds.\n\nDone. I split both clips at 0:05; you can undo this."
    );
    assert_eq!((tool_calls, edits), (1, 1));

    // the tool really ran against the host, through the normal command path
    assert_eq!(h.project().clips.len(), 4);
    assert_eq!(
        h.executed.lock().unwrap().as_slice(),
        &[Command::SplitClips {
            at: TimelineTime(5 * SEC),
            clip_ids: None
        }]
    );
    h.undo();
    assert_eq!(h.project().clips.len(), 2);

    // what the model was given
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first = &requests[0];
    assert!(first["system"].to_string().contains("Cutline"));
    let tool_names: Vec<&str> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(tool_names.len(), cutline_core::tools::tool_specs().len());
    assert!(tool_names.contains(&"remove_filler_words") && tool_names.contains(&"get_timeline"));
    let split = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "split_clips")
        .unwrap();
    assert_eq!(split["input_schema"]["required"], json!(["time_seconds"]));
    let roles: Vec<&str> = first["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(
        roles,
        ["user", "assistant", "user"],
        "history is passed on, unknown roles dropped"
    );
    let prompt = first["messages"][2].to_string();
    assert!(prompt.contains("Split everything at five seconds"));
    assert!(
        prompt.contains("playhead at 1.250 s") && prompt.contains("selected clips: c5"),
        "{prompt}"
    );
    // the tool result went back to the model
    let shown = tool_results_in(&requests[1]);
    assert!(
        shown.contains("created_clip_ids") && shown.contains("revision"),
        "{shown}"
    );
    // the key stays between sidecar and provider
    assert!(!format!("{events:?}").contains(FAKE_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_model_sees_server_side_validation_errors_and_can_correct_itself() {
    let Some(cfg) = live_cfg() else { return };
    let (mock, url) = mock_model(Box::new(|_, index| match index {
        // passes the JSON Schema, fails server-side validation (end before start)
        0 => Reply::Message(
            vec![Block::ToolUse(
                "toolu_1",
                "delete_time_range",
                json!({"start_seconds": 15, "end_seconds": 10}),
            )],
            "tool_use",
        ),
        // an invented clip id: rejected by the command itself
        1 => Reply::Message(
            vec![Block::ToolUse(
                "toolu_2",
                "delete_clips",
                json!({"clip_ids": ["c4242"]}),
            )],
            "tool_use",
        ),
        2 => Reply::Message(
            vec![Block::ToolUse(
                "toolu_3",
                "delete_time_range",
                json!({"start_seconds": 10, "end_seconds": 15}),
            )],
            "tool_use",
        ),
        _ => Reply::Message(vec![Block::Text("Removed 0:10–0:15.")], "end_turn"),
    }))
    .await;
    let h = host();
    let events = turn_env(
        &h,
        &cfg,
        say("cut ten to fifteen"),
        live_env(&url),
        CancellationToken::new(),
    )
    .await;
    let r = results(&events);
    assert_eq!(r.len(), 3, "{events:?}");
    assert!(!r[0].0 && r[0].1.contains("greater than") && r[0].2.is_none());
    assert!(!r[1].0 && r[1].1.contains("c4242") && r[1].2.is_none());
    assert_eq!(r[2], (true, "Ripple delete range".to_string(), Some(2)));
    let (_, tool_calls, edits) = done(&events);
    assert_eq!((tool_calls, edits), (3, 1));
    // only the valid call changed the project
    assert_eq!(h.project().duration(), 15 * SEC);
    assert_eq!(h.revision(), 2);
    assert_eq!(h.executed.lock().unwrap().len(), 1);
    // the error texts reached the model as tool errors
    let requests = mock.requests.lock().unwrap();
    let first_error = tool_results_in(&requests[1]);
    assert!(
        first_error.contains("greater than") && first_error.contains("invalid_arguments"),
        "{first_error}"
    );
    assert!(first_error.contains("\"is_error\":true"), "{first_error}");
    let second_error = tool_results_in(&requests[2]);
    assert!(
        second_error.contains("c4242") && second_error.contains("not_found"),
        "{second_error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_mode_reports_missing_credentials_actionably() {
    let Some(cfg) = live_cfg() else { return };
    let (mock, url) = mock_model(Box::new(|_, _| {
        Reply::Message(vec![Block::Text("never reached")], "end_turn")
    }))
    .await;
    let h = host();
    // no key in the sidecar's environment
    let env = SidecarEnv::Only(vec![("PI_BASE_URL".into(), url)]);
    let events = turn_env(
        &h,
        &cfg,
        say("remove filler words"),
        env,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(kinds(&events), ["error"], "{events:?}");
    let (code, message) = error(&events);
    assert_eq!(code, "not_configured");
    assert!(message.contains("ANTHROPIC_API_KEY"), "{message}");
    assert!(
        message.contains(".env") && message.contains("--fixture"),
        "{message}"
    );
    assert!(mock.requests.lock().unwrap().is_empty());
    assert_eq!(h.revision(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_mode_cancels_and_times_out_promptly() {
    let Some(cfg) = live_cfg() else { return };
    let (_mock, url) = mock_model(Box::new(|_, _| Reply::Hang)).await;
    let h = host();

    // cancellation while the model request is in flight
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        c2.cancel();
    });
    let started = std::time::Instant::now();
    let events = turn_env(&h, &cfg, say("split at 5s"), live_env(&url), cancel).await;
    assert_eq!(error(&events).0, "aborted", "{events:?}");
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "cancel took {:?}",
        started.elapsed()
    );

    // turn timeout
    let quick = AssistantConfig {
        turn_timeout: Duration::from_millis(2500),
        ..cfg
    };
    let started = std::time::Instant::now();
    let events = turn_env(
        &h,
        &quick,
        say("split at 5s"),
        live_env(&url),
        CancellationToken::new(),
    )
    .await;
    let (code, message) = error(&events);
    assert_eq!(code, "timeout", "{events:?}");
    assert!(message.contains("did not finish"));
    assert!(started.elapsed() < Duration::from_secs(12));
    assert_eq!(h.revision(), 1);
}

#[tokio::test]
async fn live_mode_without_node_or_sidecar_explains_how_to_fix_it() {
    let h = host();
    // sidecar not installed
    let empty = tempfile::tempdir().unwrap();
    let cfg = AssistantConfig {
        fixture: false,
        node: "node".into(),
        sidecar_dir: empty.path().to_path_buf(),
        provider: None,
        model: None,
        max_tool_calls: 8,
        turn_timeout: Duration::from_secs(5),
    };
    let events = turn_env(
        &h,
        &cfg,
        say("split at 5s"),
        SidecarEnv::Only(vec![]),
        CancellationToken::new(),
    )
    .await;
    let (code, message) = error(&events);
    assert_eq!(code, "sidecar_missing");
    assert!(
        message.contains("npm ci") && message.contains("--fixture"),
        "{message}"
    );

    // node binary missing (the sidecar files exist)
    let fake = tempfile::tempdir().unwrap();
    std::fs::write(fake.path().join("pi-agent.mjs"), "// placeholder").unwrap();
    std::fs::create_dir(fake.path().join("node_modules")).unwrap();
    let cfg = AssistantConfig {
        node: "definitely-not-node-xyz".into(),
        sidecar_dir: fake.path().to_path_buf(),
        ..cfg
    };
    let events = turn_env(
        &h,
        &cfg,
        say("split at 5s"),
        SidecarEnv::Only(vec![]),
        CancellationToken::new(),
    )
    .await;
    let (code, message) = error(&events);
    assert_eq!(code, "node_missing");
    assert!(
        message.contains("Node.js") && message.contains("NODE_PATH_BIN"),
        "{message}"
    );

    // a sidecar that dies without speaking the protocol
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        std::fs::write(
            fake.path().join("pi-agent.mjs"),
            "console.error('boom: cannot start'); process.exit(3);",
        )
        .unwrap();
        let cfg = AssistantConfig {
            node: "node".into(),
            ..cfg
        };
        let events = turn_env(
            &h,
            &cfg,
            say("split at 5s"),
            SidecarEnv::Only(vec![]),
            CancellationToken::new(),
        )
        .await;
        let (code, message) = error(&events);
        assert_eq!(code, "sidecar_failed");
        assert!(message.contains("boom: cannot start"), "{message}");
    }
    assert_eq!(h.revision(), 1);
}
