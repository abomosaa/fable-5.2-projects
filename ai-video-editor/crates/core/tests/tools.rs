//! Assistant tool surface: schema ⇄ parser agreement, argument validation,
//! tool → command mapping, read-only renderers and cut expansion helpers.

use cutline_core::analysis::{SilenceCandidate, SilenceOptions};
use cutline_core::captions::CaptionOptions;
use cutline_core::commands::{apply, ClipPatch, Command, Edge, SourceCut};
use cutline_core::mapping::timeline_transcript;
use cutline_core::model::*;
use cutline_core::time::{FrameRate, SourceTime, Ticks, TimelineTime, TICKS_PER_SECOND};
use cutline_core::tools::*;
use cutline_core::transcript::{Env, Transcript, Word};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

const SEC: Ticks = TICKS_PER_SECOND;

fn tl(seconds: f64) -> TimelineTime {
    TimelineTime((seconds * SEC as f64).round() as i64)
}

fn asset(id: &str, kind: AssetKind, seconds: i64) -> AssetInfo {
    AssetInfo {
        id: id.into(),
        name: format!("{id}.mp4"),
        kind,
        duration: seconds * SEC,
        has_video: kind == AssetKind::Video,
        has_audio: true,
        width: 1920,
        height: 1080,
        fps: Some(FrameRate::FPS_30),
        sample_rate: Some(48_000),
        channels: Some(2),
    }
}

fn run(p: &Project, c: Command) -> Project {
    apply(p, &c, &Env::default())
        .unwrap_or_else(|e| panic!("command failed: {e}"))
        .project
}

/// Project with one 60 s linked video+audio pair at 0 and a 30 s audio-only clip on A2.
fn project() -> Project {
    let mut p = Project::new("p1", "Demo", 0);
    cutline_core::commands::add_asset(&mut p, asset("vid", AssetKind::Video, 60));
    cutline_core::commands::add_asset(&mut p, asset("music", AssetKind::Audio, 30));
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: None,
            track_id: None,
            source_in: None,
            source_out: None,
            mode: Default::default(),
        },
    );
    let a2 = p.tracks_of_kind(TrackKind::Audio)[1].id.clone();
    run(
        &p,
        Command::AddAssetClips {
            asset_id: "music".into(),
            start: Some(TimelineTime(0)),
            track_id: Some(a2),
            source_in: None,
            source_out: None,
            mode: Default::default(),
        },
    )
}

fn video_clip(p: &Project) -> Clip {
    p.clips
        .values()
        .find(|c| matches!(c.content, ClipContent::Video { .. }))
        .unwrap()
        .clone()
}

fn audio_of(p: &Project, asset: &str) -> Clip {
    p.clips
        .values()
        .find(|c| matches!(&c.content, ClipContent::Audio { asset_id } if asset_id == asset))
        .unwrap()
        .clone()
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

fn transcript(asset: &str, words: Vec<Word>) -> BTreeMap<AssetId, Arc<Transcript>> {
    let t = Transcript {
        asset_id: asset.into(),
        provider: "fixture".into(),
        model: "test".into(),
        fixture: true,
        tokens: vec![],
        words,
        speakers: vec!["1".into(), "2".into()],
        languages: vec!["en".into()],
    };
    BTreeMap::from([(asset.to_string(), Arc::new(t))])
}

fn speech() -> BTreeMap<AssetId, Arc<Transcript>> {
    transcript(
        "vid",
        vec![
            word(0, "Hello", 1000, 1400, "1"),
            word(1, "um", 1500, 1800, "1"),
            word(2, "world.", 2000, 2500, "1"),
            word(3, "Second", 4000, 4400, "2"),
            word(4, "uh,", 4500, 4700, "2"),
            word(5, "sentence", 4800, 5300, "2"),
            word(6, "here.", 5400, 5800, "2"),
        ],
    )
}

fn parse(name: &str, args: Value) -> Result<ToolAction, ToolError> {
    parse_tool_call(name, &args, &project())
}

fn command(name: &str, args: Value) -> Command {
    match parse(name, args.clone()) {
        Ok(ToolAction::Command(c)) => c,
        other => panic!("{name} {args} did not produce a command: {other:?}"),
    }
}

fn invalid(name: &str, args: Value, field: &str) -> ToolError {
    let err = parse(name, args.clone()).expect_err(&format!("{name} {args} should be rejected"));
    assert_eq!(
        err.code,
        ToolErrorCode::InvalidArguments,
        "{name} {args}: {err:?}"
    );
    assert_eq!(err.field.as_deref(), Some(field), "{name} {args}: {err:?}");
    assert!(!err.message.is_empty());
    err
}

// ---------------------------------------------------------------------------------
// schema ⇄ parser agreement
// ---------------------------------------------------------------------------------

/// A valid sample value for a schema property.
fn sample(name: &str, schema: &Value) -> Value {
    match schema["type"].as_str().unwrap() {
        "number" | "integer" => {
            let (min, max) = (
                schema["minimum"].as_f64().unwrap(),
                schema["maximum"].as_f64().unwrap(),
            );
            let want: f64 = match name {
                "start_seconds" => 1.0,
                "end_seconds" => 2.0,
                _ => 1.0,
            };
            let v = want.clamp(min, max);
            if schema["type"] == "integer" {
                json!(v as i64)
            } else {
                json!(v)
            }
        }
        "boolean" => json!(true),
        "string" => match schema.get("enum") {
            Some(e) => e[0].clone(),
            None => json!("c5"),
        },
        "array" => json!(["c5"]),
        other => panic!("unexpected schema type {other}"),
    }
}

fn sample_args(spec: &ToolSpec, required_only: bool) -> Map<String, Value> {
    let required: Vec<&str> = spec.parameters["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    spec.parameters["properties"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| !required_only || required.contains(&k.as_str()))
        .map(|(k, s)| (k.clone(), sample(k, s)))
        .collect()
}

#[test]
fn specs_are_well_formed() {
    let specs = tool_specs();
    let expected = [
        "get_timeline",
        "get_transcript",
        "get_project_info",
        "split_clips",
        "trim_clip",
        "move_clip",
        "delete_clips",
        "delete_time_range",
        "set_clip_speed",
        "update_clips",
        "add_text",
        "add_transition",
        "set_track",
        "remove_filler_words",
        "remove_silences",
        "remove_spoken_range",
        "generate_captions",
        "add_marker",
    ];
    let names: Vec<&str> = specs.iter().map(|s| s.name).collect();
    assert_eq!(names, expected);
    for s in &specs {
        assert!(
            s.description.len() > 20,
            "{} needs a real description",
            s.name
        );
        assert_eq!(s.parameters["type"], "object");
        assert_eq!(s.parameters["additionalProperties"], false);
        let props = s.parameters["properties"].as_object().unwrap();
        for r in s.parameters["required"].as_array().unwrap() {
            assert!(
                props.contains_key(r.as_str().unwrap()),
                "{}: required {r} is not a property",
                s.name
            );
        }
        for (k, p) in props {
            assert!(
                p["description"].as_str().is_some_and(|d| !d.is_empty()),
                "{}.{k} has no description",
                s.name
            );
        }
    }
}

#[test]
fn every_schema_agrees_with_the_parser() {
    let p = project();
    for spec in tool_specs() {
        let all = sample_args(&spec, false);
        // everything the schema advertises is accepted
        parse_tool_call(spec.name, &Value::Object(all.clone()), &p)
            .unwrap_or_else(|e| panic!("{}: schema-valid arguments rejected: {e:?}", spec.name));

        // required-only calls work, except where "at least one property" is documented
        let minimal = sample_args(&spec, true);
        let res = parse_tool_call(spec.name, &Value::Object(minimal.clone()), &p);
        if matches!(spec.name, "update_clips" | "set_track") {
            let e = res.unwrap_err();
            assert_eq!(e.code, ToolErrorCode::InvalidArguments);
            assert!(e.message.contains("at least one"), "{e:?}");
        } else {
            res.unwrap_or_else(|e| panic!("{}: minimal arguments rejected: {e:?}", spec.name));
        }

        // every required argument is really required
        for r in spec.parameters["required"].as_array().unwrap() {
            let r = r.as_str().unwrap();
            let mut m = all.clone();
            m.remove(r);
            let e = parse_tool_call(spec.name, &Value::Object(m), &p).unwrap_err();
            assert_eq!(
                (e.code, e.field.as_deref()),
                (ToolErrorCode::InvalidArguments, Some(r)),
                "{}: {e:?}",
                spec.name
            );
            assert!(e.message.contains("Missing required"), "{e:?}");
            // … and an explicit null does not satisfy it
            let mut m = all.clone();
            m.insert(r.to_string(), Value::Null);
            assert_eq!(
                parse_tool_call(spec.name, &Value::Object(m), &p)
                    .unwrap_err()
                    .field
                    .as_deref(),
                Some(r)
            );
        }

        // every property is type checked
        for k in spec.parameters["properties"].as_object().unwrap().keys() {
            for wrong in [json!({}), json!("not-a-valid-value-§"), json!([1, 2])] {
                // a string is legitimately valid for free-text / id properties
                let schema = &spec.parameters["properties"][k];
                if wrong.is_string() && schema["type"] == "string" && schema.get("enum").is_none() {
                    continue;
                }
                let mut m = all.clone();
                m.insert(k.clone(), wrong.clone());
                let e = parse_tool_call(spec.name, &Value::Object(m), &p).unwrap_err();
                assert_eq!(
                    (e.code, e.field.as_deref()),
                    (ToolErrorCode::InvalidArguments, Some(k.as_str())),
                    "{}.{k} = {wrong}: {e:?}",
                    spec.name
                );
            }
            // numeric bounds from the schema are enforced
            let schema = &spec.parameters["properties"][k];
            if let (Some(min), Some(max)) = (schema["minimum"].as_f64(), schema["maximum"].as_f64())
            {
                for out in [min - 1.0, max + 1.0] {
                    let mut m = all.clone();
                    m.insert(k.clone(), json!(out));
                    let e = parse_tool_call(spec.name, &Value::Object(m), &p).unwrap_err();
                    assert_eq!(
                        e.field.as_deref(),
                        Some(k.as_str()),
                        "{}.{k} = {out}: {e:?}",
                        spec.name
                    );
                }
            }
        }

        // nothing beyond the schema is accepted
        let mut m = all.clone();
        m.insert("bogus".into(), json!(1));
        let e = parse_tool_call(spec.name, &Value::Object(m), &p).unwrap_err();
        assert_eq!(
            (e.code, e.field.as_deref()),
            (ToolErrorCode::InvalidArguments, Some("bogus")),
            "{}",
            spec.name
        );

        // optional arguments may be null (models do this)
        let mut m = all.clone();
        let required: Vec<String> = spec.parameters["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let mut nulled = 0;
        for (k, v) in m.iter_mut() {
            if !required.contains(k) {
                *v = Value::Null;
                nulled += 1;
            }
        }
        if nulled > 0 && !matches!(spec.name, "update_clips" | "set_track") {
            parse_tool_call(spec.name, &Value::Object(m), &p)
                .unwrap_or_else(|e| panic!("{}: null optionals rejected: {e:?}", spec.name));
        }
    }
}

// ---------------------------------------------------------------------------------
// validation matrix
// ---------------------------------------------------------------------------------

#[test]
fn unknown_tools_and_non_object_arguments_are_rejected() {
    let e = parse("format_disk", json!({})).unwrap_err();
    assert_eq!(e.code, ToolErrorCode::UnknownTool);
    assert!(
        e.message.contains("split_clips"),
        "should list available tools: {}",
        e.message
    );
    assert_eq!(e.field, None);

    for bad in [json!("5"), json!([1]), json!(5), json!(true)] {
        let e = parse("split_clips", bad).unwrap_err();
        assert_eq!(e.code, ToolErrorCode::InvalidArguments);
        assert_eq!(e.field, None);
        assert!(e.message.contains("JSON object"));
    }
    // argument-less tools tolerate null / {}
    assert_eq!(
        parse("get_timeline", Value::Null).unwrap(),
        ToolAction::Query(ToolQuery::GetTimeline)
    );
    assert_eq!(
        parse("remove_filler_words", json!({})).unwrap(),
        ToolAction::RemoveFillers
    );
    invalid(
        "remove_filler_words",
        json!({"aggressive": true}),
        "aggressive",
    );
    // null is not acceptable where arguments are required
    invalid("split_clips", Value::Null, "time_seconds");
}

#[test]
fn numbers_are_strictly_validated() {
    invalid("split_clips", json!({"time_seconds": "5"}), "time_seconds");
    invalid(
        "split_clips",
        json!({"time_seconds": "NaN"}),
        "time_seconds",
    );
    invalid("split_clips", json!({"time_seconds": null}), "time_seconds");
    invalid("split_clips", json!({"time_seconds": -0.5}), "time_seconds");
    invalid("split_clips", json!({"time_seconds": 1e9}), "time_seconds");
    invalid("split_clips", json!({"time_seconds": true}), "time_seconds");
    invalid(
        "set_clip_speed",
        json!({"clip_ids": ["c5"], "speed": 0}),
        "speed",
    );
    invalid(
        "set_clip_speed",
        json!({"clip_ids": ["c5"], "speed": 64}),
        "speed",
    );
    invalid(
        "set_clip_speed",
        json!({"clip_ids": ["c5"], "speed": -1}),
        "speed",
    );
    invalid(
        "trim_clip",
        json!({"clip_id": "c5", "edge": "end", "delta_seconds": 0}),
        "delta_seconds",
    );
    invalid(
        "add_text",
        json!({"text": "Hi", "start_seconds": 0, "duration_seconds": 0}),
        "duration_seconds",
    );
    invalid(
        "add_text",
        json!({"text": "Hi", "start_seconds": 0, "duration_seconds": -3}),
        "duration_seconds",
    );
    invalid(
        "add_transition",
        json!({"after_clip_id": "c5", "kind": "cross_dissolve", "duration_seconds": 600}),
        "duration_seconds",
    );
    invalid(
        "remove_silences",
        json!({"min_duration_ms": 700.5}),
        "min_duration_ms",
    );
    invalid(
        "remove_silences",
        json!({"min_duration_ms": 5}),
        "min_duration_ms",
    );
    invalid(
        "remove_silences",
        json!({"threshold_db": 3}),
        "threshold_db",
    );
    invalid("generate_captions", json!({"max_lines": 9}), "max_lines");
    invalid(
        "generate_captions",
        json!({"max_chars_per_line": 2}),
        "max_chars_per_line",
    );
    invalid(
        "update_clips",
        json!({"clip_ids": ["c5"], "opacity": 1.5}),
        "opacity",
    );
    invalid(
        "update_clips",
        json!({"clip_ids": ["c5"], "gain_db": 99}),
        "gain_db",
    );
    invalid(
        "set_track",
        json!({"track_id": "t3", "gain_db": 40}),
        "gain_db",
    );
    // whole numbers written as floats are fine for integer arguments
    assert!(parse("remove_silences", json!({"min_duration_ms": 900.0})).is_ok());
}

#[test]
fn ranges_ids_enums_and_text_are_validated() {
    invalid(
        "delete_time_range",
        json!({"start_seconds": 5, "end_seconds": 5}),
        "end_seconds",
    );
    let e = invalid(
        "delete_time_range",
        json!({"start_seconds": 9, "end_seconds": 2}),
        "end_seconds",
    );
    assert!(e.message.contains("greater than"), "{}", e.message);
    invalid(
        "remove_spoken_range",
        json!({"start_seconds": 3, "end_seconds": 1}),
        "end_seconds",
    );
    invalid(
        "get_transcript",
        json!({"start_seconds": 3, "end_seconds": 1}),
        "end_seconds",
    );

    invalid("delete_clips", json!({"clip_ids": []}), "clip_ids");
    invalid("delete_clips", json!({"clip_ids": "c5"}), "clip_ids");
    invalid("delete_clips", json!({"clip_ids": [5]}), "clip_ids");
    invalid("delete_clips", json!({"clip_ids": [""]}), "clip_ids");
    invalid(
        "delete_clips",
        json!({"clip_ids": ["c5"], "ripple": "yes"}),
        "ripple",
    );
    invalid(
        "trim_clip",
        json!({"clip_id": 7, "edge": "end", "delta_seconds": 1}),
        "clip_id",
    );
    invalid(
        "trim_clip",
        json!({"clip_id": "", "edge": "end", "delta_seconds": 1}),
        "clip_id",
    );

    let e = invalid(
        "trim_clip",
        json!({"clip_id": "c5", "edge": "left", "delta_seconds": 1}),
        "edge",
    );
    assert!(e.message.contains("start, end"), "{}", e.message);
    invalid(
        "add_transition",
        json!({"after_clip_id": "c5", "kind": "star_wipe", "duration_seconds": 1}),
        "kind",
    );
    invalid(
        "add_transition",
        json!({"after_clip_id": "c5", "kind": 3, "duration_seconds": 1}),
        "kind",
    );

    invalid(
        "add_text",
        json!({"text": "   ", "start_seconds": 0}),
        "text",
    );
    invalid("add_text", json!({"text": 5, "start_seconds": 0}), "text");
    invalid(
        "add_text",
        json!({"text": "x".repeat(2001), "start_seconds": 0}),
        "text",
    );
    invalid(
        "add_marker",
        json!({"time_seconds": 1, "label": "x".repeat(81)}),
        "label",
    );

    // "at least one property"
    invalid("update_clips", json!({"clip_ids": ["c5"]}), "clip_ids");
    invalid("set_track", json!({"track_id": "t3"}), "track_id");
    // misspelled property names are caught, not ignored
    let e = invalid(
        "update_clips",
        json!({"clip_ids": ["c5"], "volume": -6}),
        "volume",
    );
    assert!(
        e.message.contains("gain_db"),
        "should list allowed arguments: {}",
        e.message
    );
}

// ---------------------------------------------------------------------------------
// tool → command mapping
// ---------------------------------------------------------------------------------

#[test]
fn queries_and_server_actions() {
    assert_eq!(
        parse("get_timeline", json!({})).unwrap(),
        ToolAction::Query(ToolQuery::GetTimeline)
    );
    assert_eq!(
        parse("get_project_info", json!({})).unwrap(),
        ToolAction::Query(ToolQuery::GetProjectInfo)
    );
    assert_eq!(
        parse("get_transcript", json!({})).unwrap(),
        ToolAction::Query(ToolQuery::GetTranscript {
            start: None,
            end: None
        })
    );
    assert_eq!(
        parse(
            "get_transcript",
            json!({"start_seconds": 1.5, "end_seconds": 60})
        )
        .unwrap(),
        ToolAction::Query(ToolQuery::GetTranscript {
            start: Some(TimelineTime(SEC * 3 / 2)),
            end: Some(TimelineTime(60 * SEC))
        })
    );
    assert_eq!(
        parse("remove_silences", json!({})).unwrap(),
        ToolAction::RemoveSilences(SilenceOptions::default())
    );
    assert_eq!(
        parse(
            "remove_silences",
            json!({"min_duration_ms": 400, "threshold_db": -45.5, "padding_ms": 0})
        )
        .unwrap(),
        ToolAction::RemoveSilences(SilenceOptions {
            threshold_db: -45.5,
            min_duration_ms: 400,
            padding_ms: 0
        })
    );
    assert_eq!(
        parse(
            "remove_spoken_range",
            json!({"start_seconds": 0.25, "end_seconds": 2})
        )
        .unwrap(),
        ToolAction::RemoveSpokenRange {
            start: TimelineTime(SEC / 4),
            end: TimelineTime(2 * SEC)
        }
    );
}

#[test]
fn seconds_become_exact_ticks() {
    assert_eq!(
        command("split_clips", json!({"time_seconds": 5})),
        Command::SplitClips {
            at: TimelineTime(5 * SEC),
            clip_ids: None
        }
    );
    assert_eq!(
        command("split_clips", json!({"time_seconds": 0.5})),
        Command::SplitClips {
            at: TimelineTime(SEC / 2),
            clip_ids: None
        }
    );
    assert_eq!(
        command(
            "delete_time_range",
            json!({"start_seconds": 1.25, "end_seconds": 3})
        ),
        Command::RippleDeleteRange {
            start: TimelineTime(SEC * 5 / 4),
            end: TimelineTime(3 * SEC)
        }
    );
    assert_eq!(
        command(
            "add_marker",
            json!({"time_seconds": 12, "label": "Intro ends"})
        ),
        Command::AddMarker {
            time: TimelineTime(12 * SEC),
            label: "Intro ends".into(),
            color: None
        }
    );
    assert_eq!(
        command("add_marker", json!({"time_seconds": 0})),
        Command::AddMarker {
            time: TimelineTime(0),
            label: String::new(),
            color: None
        }
    );
    assert_eq!(
        command(
            "add_text",
            json!({"text": "Hello\nWorld", "start_seconds": 2, "duration_seconds": 3.5})
        ),
        Command::AddText {
            text: "Hello\nWorld".into(),
            start: TimelineTime(2 * SEC),
            duration: Some(SEC * 7 / 2),
            track_id: None
        }
    );
    assert_eq!(
        command("add_text", json!({"text": "T", "start_seconds": 0})),
        Command::AddText {
            text: "T".into(),
            start: TimelineTime(0),
            duration: None,
            track_id: None
        }
    );
    assert_eq!(
        command(
            "add_transition",
            json!({"after_clip_id": "c9", "kind": "dip_to_black", "duration_seconds": 1})
        ),
        Command::AddTransitions {
            left_clip_ids: vec!["c9".into()],
            kind: TransitionKind::DipToBlack,
            duration: SEC
        }
    );
    for (name, kind) in [
        ("cross_dissolve", TransitionKind::CrossDissolve),
        ("slide", TransitionKind::Slide),
        ("push", TransitionKind::Push),
    ] {
        assert_eq!(
            command(
                "add_transition",
                json!({"after_clip_id": "c9", "kind": name, "duration_seconds": 0.5})
            ),
            Command::AddTransitions {
                left_clip_ids: vec!["c9".into()],
                kind,
                duration: SEC / 2
            }
        );
    }
    assert_eq!(
        command(
            "set_track",
            json!({"track_id": "t3", "muted": true, "gain_db": -6})
        ),
        Command::UpdateTrack {
            track_id: "t3".into(),
            name: None,
            muted: Some(true),
            solo: None,
            locked: None,
            hidden: None,
            gain_db: Some(-6.0)
        }
    );
    assert_eq!(
        command("generate_captions", json!({})),
        Command::GenerateCaptions {
            options: CaptionOptions::default()
        }
    );
    assert_eq!(
        command(
            "generate_captions",
            json!({"max_chars_per_line": 20, "max_lines": 1, "speaker_labels": true})
        ),
        Command::GenerateCaptions {
            options: CaptionOptions {
                max_chars_per_line: 20,
                max_lines: 1,
                speaker_labels: true,
                ..CaptionOptions::default()
            }
        }
    );
}

#[test]
fn update_clips_builds_a_partial_patch() {
    let c = command(
        "update_clips",
        json!({"clip_ids": ["c5", "c5", "c6"], "opacity": 0.5, "fade_in_seconds": 1, "fade_out_seconds": 0.5, "text": "New", "enabled": false, "gain_db": -3}),
    );
    let Command::UpdateClips { clip_ids, patch } = c else {
        panic!()
    };
    assert_eq!(
        clip_ids,
        vec!["c5".to_string(), "c6".to_string()],
        "duplicate ids are collapsed"
    );
    assert_eq!(
        patch,
        ClipPatch {
            opacity: Some(0.5),
            fade_in: Some(SEC),
            fade_out: Some(SEC / 2),
            text: Some("New".into()),
            enabled: Some(false),
            gain_db: Some(-3.0),
            ..ClipPatch::default()
        }
    );
    let Command::UpdateClips { patch, .. } = command(
        "update_clips",
        json!({"clip_ids": ["c5"], "x": 0.25, "y": -0.1, "scale": 0.5, "rotation": 90, "brightness": 1.1, "contrast": 0.9, "saturation": 0, "temperature": -0.3}),
    ) else {
        panic!()
    };
    assert_eq!(
        patch,
        ClipPatch {
            x: Some(0.25),
            y: Some(-0.1),
            scale: Some(0.5),
            rotation: Some(90.0),
            brightness: Some(1.1),
            contrast: Some(0.9),
            saturation: Some(0.0),
            temperature: Some(-0.3),
            ..ClipPatch::default()
        }
    );
}

#[test]
fn linked_clips_are_included_by_default() {
    let p = project();
    let v = video_clip(&p);
    let a = audio_of(&p, "vid");
    let music = audio_of(&p, "music");
    assert!(v.link_id.is_some() && v.link_id == a.link_id);

    // delete
    let c = parse_tool_call(
        "delete_clips",
        &json!({"clip_ids": [v.id], "ripple": true}),
        &p,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::DeleteClips {
            clip_ids: vec![v.id.clone(), a.id.clone()],
            ripple: true
        })
    );
    let c = parse_tool_call(
        "delete_clips",
        &json!({"clip_ids": [v.id], "include_linked": false}),
        &p,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::DeleteClips {
            clip_ids: vec![v.id.clone()],
            ripple: false
        })
    );

    // trim keeps A/V in sync and really applies
    let c = parse_tool_call(
        "trim_clip",
        &json!({"clip_id": a.id, "edge": "end", "delta_seconds": -10, "ripple": true}),
        &p,
    )
    .unwrap();
    let ToolAction::Command(cmd) = c else {
        panic!()
    };
    assert_eq!(
        cmd,
        Command::TrimClips {
            clip_ids: vec![a.id.clone(), v.id.clone()],
            edge: Edge::End,
            delta: -10 * SEC,
            ripple: true
        }
    );
    let after = run(&p, cmd);
    assert_eq!(after.clips[&v.id].duration, 50 * SEC);
    assert_eq!(after.clips[&a.id].duration, 50 * SEC);
    assert_eq!(
        after.clips[&music.id].duration,
        30 * SEC,
        "unrelated clips are untouched"
    );
    assert_eq!(
        parse_tool_call(
            "trim_clip",
            &json!({"clip_id": v.id, "edge": "start", "delta_seconds": 2.5}),
            &p
        )
        .unwrap(),
        ToolAction::Command(Command::TrimClips {
            clip_ids: vec![v.id.clone(), a.id.clone()],
            edge: Edge::Start,
            delta: SEC * 5 / 2,
            ripple: false
        })
    );

    // speed
    let c = parse_tool_call(
        "set_clip_speed",
        &json!({"clip_ids": [v.id], "speed": 2}),
        &p,
    )
    .unwrap();
    let ToolAction::Command(cmd) = c else {
        panic!()
    };
    assert_eq!(
        cmd,
        Command::SetSpeed {
            clip_ids: vec![v.id.clone(), a.id.clone()],
            speed: 2.0,
            ripple: true
        }
    );
    let after = run(&p, cmd);
    assert_eq!(
        (after.clips[&v.id].duration, after.clips[&a.id].duration),
        (30 * SEC, 30 * SEC)
    );

    // split with explicit ids
    let c = parse_tool_call(
        "split_clips",
        &json!({"time_seconds": 10, "clip_ids": [v.id]}),
        &p,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::SplitClips {
            at: TimelineTime(10 * SEC),
            clip_ids: Some(vec![v.id.clone(), a.id.clone()])
        })
    );

    // move: the companion moves by the same amount and stays on its own track
    let c = parse_tool_call(
        "move_clip",
        &json!({"clip_id": v.id, "start_seconds": 70}),
        &p,
    )
    .unwrap();
    let ToolAction::Command(Command::MoveClips { moves, .. }) = &c else {
        panic!()
    };
    assert_eq!(moves.len(), 2);
    assert_eq!(
        (
            moves[0].clip_id.as_str(),
            moves[0].start,
            moves[0].track_id.as_str()
        ),
        (v.id.as_str(), TimelineTime(70 * SEC), v.track_id.as_str())
    );
    assert_eq!(
        (
            moves[1].clip_id.as_str(),
            moves[1].start,
            moves[1].track_id.as_str()
        ),
        (a.id.as_str(), TimelineTime(70 * SEC), a.track_id.as_str())
    );
    let ToolAction::Command(cmd) = c else {
        panic!()
    };
    let after = run(&p, cmd);
    assert_eq!(after.clips[&a.id].start, TimelineTime(70 * SEC));

    // explicit target track for the moved clip
    let v2 = p.tracks_of_kind(TrackKind::Video)[1].id.clone();
    let c = parse_tool_call(
        "move_clip",
        &json!({"clip_id": v.id, "start_seconds": 0, "track_id": v2, "include_linked": false}),
        &p,
    )
    .unwrap();
    let ToolAction::Command(Command::MoveClips { moves, .. }) = c else {
        panic!()
    };
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0].track_id, v2);
}

#[test]
fn companions_on_locked_tracks_and_offset_edges_are_left_alone() {
    let p = project();
    let v = video_clip(&p);
    let a = audio_of(&p, "vid");
    // lock the audio track: editing the picture must not be blocked by the companion
    let locked = run(
        &p,
        Command::UpdateTrack {
            track_id: a.track_id.clone(),
            name: None,
            muted: None,
            solo: None,
            locked: Some(true),
            hidden: None,
            gain_db: None,
        },
    );
    let c = parse_tool_call("delete_clips", &json!({"clip_ids": [v.id]}), &locked).unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::DeleteClips {
            clip_ids: vec![v.id.clone()],
            ripple: false
        })
    );

    // audio trimmed independently: the ends no longer coincide, so an end trim of the
    // picture does not drag the audio along
    let offset = run(
        &p,
        Command::TrimClips {
            clip_ids: vec![a.id.clone()],
            edge: Edge::End,
            delta: -5 * SEC,
            ripple: false,
        },
    );
    let c = parse_tool_call(
        "trim_clip",
        &json!({"clip_id": v.id, "edge": "end", "delta_seconds": -1}),
        &offset,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::TrimClips {
            clip_ids: vec![v.id.clone()],
            edge: Edge::End,
            delta: -SEC,
            ripple: false
        })
    );
    // … but a start trim still does
    let c = parse_tool_call(
        "trim_clip",
        &json!({"clip_id": v.id, "edge": "start", "delta_seconds": 1}),
        &offset,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::TrimClips {
            clip_ids: vec![v.id.clone(), a.id.clone()],
            edge: Edge::Start,
            delta: SEC,
            ripple: false
        })
    );
}

#[test]
fn unknown_ids_are_left_for_the_command_to_reject() {
    let p = project();
    for (name, args) in [
        ("delete_clips", json!({"clip_ids": ["nope"]})),
        ("move_clip", json!({"clip_id": "nope", "start_seconds": 3})),
        (
            "trim_clip",
            json!({"clip_id": "nope", "edge": "end", "delta_seconds": 1}),
        ),
        ("set_clip_speed", json!({"clip_ids": ["nope"], "speed": 2})),
        (
            "add_transition",
            json!({"after_clip_id": "nope", "kind": "push", "duration_seconds": 1}),
        ),
        ("set_track", json!({"track_id": "nope", "muted": true})),
        (
            "update_clips",
            json!({"clip_ids": ["nope"], "opacity": 0.2}),
        ),
    ] {
        let ToolAction::Command(cmd) = parse_tool_call(name, &args, &p).unwrap() else {
            panic!("{name}")
        };
        let err = apply(&p, &cmd, &Env::default()).unwrap_err();
        assert_eq!(
            err.code,
            cutline_core::ErrorCode::NotFound,
            "{name}: {err:?}"
        );
    }
}

#[test]
fn grouped_clips_always_travel_together() {
    let p = project();
    let v = video_clip(&p);
    let music = audio_of(&p, "music");
    let grouped = run(
        &p,
        Command::GroupClips {
            clip_ids: vec![v.id.clone(), music.id.clone()],
        },
    );
    let c = parse_tool_call(
        "delete_clips",
        &json!({"clip_ids": [music.id], "include_linked": false}),
        &grouped,
    )
    .unwrap();
    assert_eq!(
        c,
        ToolAction::Command(Command::DeleteClips {
            clip_ids: vec![music.id.clone(), v.id.clone()],
            ripple: false
        })
    );
}

// ---------------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------------

#[test]
fn timeline_description_is_compact_and_complete() {
    let mut p = project();
    let v = video_clip(&p);
    let a = audio_of(&p, "vid");
    p = run(
        &p,
        Command::SplitClips {
            at: TimelineTime(20 * SEC),
            clip_ids: Some(vec![v.id.clone(), a.id.clone()]),
        },
    );
    p = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![v.id.clone()],
            kind: TransitionKind::CrossDissolve,
            duration: SEC,
        },
    );
    p = run(
        &p,
        Command::AddText {
            text: "Title\ncard".into(),
            start: TimelineTime(0),
            duration: Some(4 * SEC),
            track_id: None,
        },
    );
    p = run(
        &p,
        Command::AddMarker {
            time: TimelineTime(3 * SEC),
            label: "Hook".into(),
            color: None,
        },
    );
    p = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![v.id.clone(), a.id.clone()],
            speed: 2.0,
            ripple: true,
        },
    );

    let d = describe_timeline(&p);
    assert_eq!(d["project"]["name"], "Demo");
    assert_eq!(d["project"]["fps"], 30.0);
    assert_eq!(d["project"]["width"], 1920);
    let tracks = d["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), p.tracks.len());
    assert_eq!(tracks[0]["kind"], "video");
    let all: Vec<&Value> = tracks
        .iter()
        .flat_map(|t| t["clips"].as_array().unwrap())
        .collect();
    assert_eq!(all.len(), p.clips.len());
    let dv = all.iter().find(|c| c["id"] == json!(v.id)).unwrap();
    assert_eq!(dv["kind"], "video");
    assert_eq!(dv["label"], "vid.mp4");
    assert_eq!(dv["start"], 0.0);
    assert_eq!(dv["end"], 10.0);
    assert_eq!(dv["source_in"], 0.0);
    assert_eq!(dv["source_out"], 20.0);
    assert_eq!(dv["speed"], 2.0);
    assert_eq!(dv["linked"], json!([a.id]));
    let text = all.iter().find(|c| c["kind"] == "text").unwrap();
    assert_eq!(text["label"], "Title / card");
    assert!(text.get("source_in").is_none());
    assert_eq!(d["transitions"][0]["kind"], "cross_dissolve");
    assert_eq!(d["transitions"][0]["after_clip_id"], json!(v.id));
    assert_eq!(d["transitions"][0]["duration"], 1.0);
    assert_eq!(d["markers"][0]["label"], "Hook");
    assert!(d.get("truncated").is_none());

    let info = describe_project(&p);
    assert_eq!(info["clip_count"], p.clips.len());
    assert_eq!(info["duration_seconds"], secs(p.duration()));
}

#[test]
fn huge_timelines_are_truncated_with_a_note() {
    let mut p = Project::new("big", "Big", 0);
    cutline_core::commands::add_asset(&mut p, asset("vid", AssetKind::Video, 3600));
    let ranges = (0..300)
        .map(|i| cutline_core::commands::SourceRange {
            start: SourceTime(i * SEC),
            end: SourceTime(i * SEC + SEC),
        })
        .collect();
    let p = run(
        &p,
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges,
            at: None,
        },
    );
    assert_eq!(p.clips.len(), 600);
    let d = describe_timeline(&p);
    let listed: usize = d["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["clips"].as_array().unwrap().len())
        .sum();
    assert_eq!(listed, MAX_DESCRIBED_CLIPS);
    assert!(d["truncated"].as_str().unwrap().contains("200 more clips"));
    assert!(d.to_string().len() < 120_000);
}

#[test]
fn transcript_description_groups_sentences_and_marks_fillers() {
    let mut p = project();
    p = run(
        &p,
        Command::RenameSpeaker {
            asset_id: "vid".into(),
            speaker: "2".into(),
            name: Some("Dana".into()),
        },
    );
    let view = timeline_transcript(&p, &speech());
    let d = describe_transcript(&view, &p, None);
    let s = d["sentences"].as_array().unwrap();
    assert_eq!(s.len(), 2);
    assert_eq!(s[0]["text"], "Hello [um] world.");
    assert_eq!(s[0]["speaker"], "Speaker 1");
    assert_eq!(
        (s[0]["start"].as_f64(), s[0]["end"].as_f64()),
        (Some(1.0), Some(2.5))
    );
    assert_eq!(s[1]["text"], "Second [uh,] sentence here.");
    assert_eq!(s[1]["speaker"], "Dana");
    assert_eq!(s[1]["clip_id"], json!(audio_of(&p, "vid").id));
    assert_eq!(d["word_count"], 7);
    assert_eq!(d["filler_count"], 2);
    assert!(d.get("truncated").is_none());

    // range filter uses word midpoints
    let d = describe_transcript(&view, &p, Some((tl(3.0), tl(5.0))));
    let s = d["sentences"].as_array().unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["text"], "Second [uh,]");
    assert_eq!(d["word_count"], 2);

    // nothing transcribed
    let empty = describe_transcript(&timeline_transcript(&p, &BTreeMap::new()), &p, None);
    assert_eq!(empty["sentences"].as_array().unwrap().len(), 0);
    assert!(empty["empty"].is_string());
    assert!(empty["untranscribed_media"]
        .as_str()
        .unwrap()
        .starts_with("2 audible"));
}

#[test]
fn long_transcripts_are_bounded_and_resumable() {
    let p = project();
    // 5 words per second for 60 s, no punctuation
    let words: Vec<Word> = (0..300)
        .map(|i| word(i, "wordy", i as i64 * 200, i as i64 * 200 + 150, "1"))
        .collect();
    let mut t = transcript("vid", words);
    // make it much longer than the bound by lengthening the words
    let tr = Arc::get_mut(t.get_mut("vid").unwrap()).unwrap();
    for w in tr.words.iter_mut() {
        w.text = "x".repeat(120);
    }
    let view = timeline_transcript(&p, &t);
    let d = describe_transcript(&view, &p, None);
    let total: usize = d["sentences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["text"].as_str().unwrap().len())
        .sum();
    assert!(
        total <= MAX_TRANSCRIPT_CHARS + 40 * 125,
        "bounded output, got {total}"
    );
    assert!((d["word_count"].as_u64().unwrap() as usize) < 300);
    let note = d["truncated"].as_str().unwrap();
    assert!(note.contains("start_seconds="), "{note}");
    // continuing from the advertised position yields the following words
    let resume: f64 = note
        .split("start_seconds=")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let rest = describe_transcript(&view, &p, Some((tl(resume), TimelineTime(i64::MAX))));
    let first = d["sentences"].as_array().unwrap().last().unwrap()["end"]
        .as_f64()
        .unwrap();
    assert!(rest["sentences"][0]["start"].as_f64().unwrap() >= first - 0.2);
}

// ---------------------------------------------------------------------------------
// cut expansion
// ---------------------------------------------------------------------------------

#[test]
fn filler_cuts_remove_exactly_the_fillers() {
    let p = project();
    let ts = speech();
    let view = timeline_transcript(&p, &ts);
    let a = audio_of(&p, "vid");
    let cuts = filler_cuts(&view);
    assert_eq!(
        cuts,
        vec![
            SourceCut {
                clip_id: a.id.clone(),
                source_start: SourceTime::from_ms(1500),
                source_end: SourceTime::from_ms(1800),
                text: "um".into()
            },
            SourceCut {
                clip_id: a.id.clone(),
                source_start: SourceTime::from_ms(4500),
                source_end: SourceTime::from_ms(4700),
                text: "uh,".into()
            },
        ]
    );
    let after = run(
        &p,
        Command::RippleDeleteSource {
            cuts,
            reason: RemovalReason::Filler,
        },
    );
    // 0.3 s + 0.2 s removed from the 60 s pair (music on A2 spans, later clips shift)
    assert_eq!(
        after
            .clips
            .values()
            .filter(|c| c.asset_id() == Some("vid"))
            .map(|c| c.end().0)
            .max()
            .unwrap(),
        60 * SEC - SEC / 2
    );
    let view = timeline_transcript(&after, &ts);
    assert_eq!(view.filler_count, 0);
    assert_eq!(view.word_count, 5);
    assert!(filler_cuts(&view).is_empty());
    assert_eq!(after.transcript.removals.len(), 2);
}

#[test]
fn spoken_range_cuts_follow_word_midpoints_across_segments_and_speeds() {
    let mut p = project();
    let ts = speech();
    let v = video_clip(&p);
    let a = audio_of(&p, "vid");
    // split at 3 s (between the sentences) and play the second part at 2× speed
    p = run(
        &p,
        Command::SplitClips {
            at: TimelineTime(3 * SEC),
            clip_ids: Some(vec![v.id.clone(), a.id.clone()]),
        },
    );
    let right_audio = p
        .clips
        .values()
        .find(|c| {
            matches!(c.content, ClipContent::Audio { .. })
                && c.asset_id() == Some("vid")
                && c.start == TimelineTime(3 * SEC)
        })
        .unwrap()
        .clone();
    let right_video = p
        .clips
        .values()
        .find(|c| {
            matches!(c.content, ClipContent::Video { .. }) && c.start == TimelineTime(3 * SEC)
        })
        .unwrap()
        .clone();
    p = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![right_video.id.clone(), right_audio.id.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    let view = timeline_transcript(&p, &ts);
    assert_eq!(view.segments.len(), 2);
    // second segment: source 4.0 s plays at timeline 3 + (4-3)/2 = 3.5 s
    assert_eq!(view.segments[1].words[0].start, tl(3.5));

    // timeline 1.9 s .. 3.8 s covers "world." (mid 2.25) in segment 1 and
    // "Second" (mid 3.6) + "uh," (mid 3.8 → excluded: 3.8 is not < 3.8)
    let cuts = spoken_range_cuts(&view, tl(1.9), tl(3.8));
    assert_eq!(
        cuts,
        vec![
            SourceCut {
                clip_id: a.id.clone(),
                source_start: SourceTime::from_ms(2000),
                source_end: SourceTime::from_ms(2500),
                text: "world.".into()
            },
            SourceCut {
                clip_id: right_audio.id.clone(),
                source_start: SourceTime::from_ms(4000),
                source_end: SourceTime::from_ms(4400),
                text: "Second".into()
            },
        ]
    );
    // consecutive words merge into one cut including the pause between them
    let cuts = spoken_range_cuts(&view, tl(0.0), tl(3.0));
    assert_eq!(
        cuts,
        vec![SourceCut {
            clip_id: a.id.clone(),
            source_start: SourceTime::from_ms(1000),
            source_end: SourceTime::from_ms(2500),
            text: "Hello um world.".into()
        }]
    );
    // the cuts really apply, also on the sped-up clip
    let cuts = spoken_range_cuts(&view, tl(3.0), tl(100.0));
    assert_eq!(cuts.len(), 1);
    assert_eq!(
        (cuts[0].source_start, cuts[0].source_end),
        (SourceTime::from_ms(4000), SourceTime::from_ms(5800))
    );
    let before = p.duration();
    let after = run(
        &p,
        Command::RippleDeleteSource {
            cuts,
            reason: RemovalReason::Assistant,
        },
    );
    // 1.8 s of source at 2× is 0.9 s of timeline; the vid pair ends 0.9 s earlier
    let end = |p: &Project| {
        p.clips
            .values()
            .filter(|c| c.asset_id() == Some("vid"))
            .map(|c| c.end().0)
            .max()
            .unwrap()
    };
    assert_eq!(end(&p) - end(&after), SEC * 9 / 10);
    assert!(after.duration() <= before);
    assert_eq!(
        timeline_transcript(&after, &ts)
            .segments
            .iter()
            .map(|s| s.words.len())
            .sum::<usize>(),
        3
    );

    // empty and out-of-range selections
    assert!(spoken_range_cuts(&view, tl(50.0), tl(55.0)).is_empty());
    assert!(spoken_range_cuts(&view, tl(2.6), tl(3.4)).is_empty());
}

#[test]
fn silence_cuts_mirror_the_candidates() {
    let c = vec![
        SilenceCandidate {
            clip_id: "c6".into(),
            asset_id: "vid".into(),
            source_start: SourceTime::from_ms(2600),
            source_end: SourceTime::from_ms(3900),
            start: tl(2.6),
            end: tl(3.9),
        },
        SilenceCandidate {
            clip_id: "c9".into(),
            asset_id: "vid".into(),
            source_start: SourceTime::from_ms(9000),
            source_end: SourceTime::from_ms(9800),
            start: tl(7.0),
            end: tl(7.8),
        },
    ];
    let cuts = silence_cuts(&c);
    assert_eq!(cuts.len(), 2);
    assert_eq!(
        cuts[0],
        SourceCut {
            clip_id: "c6".into(),
            source_start: SourceTime::from_ms(2600),
            source_end: SourceTime::from_ms(3900),
            text: String::new()
        }
    );
    assert_eq!(cuts[1].clip_id, "c9");
    assert!(silence_cuts(&[]).is_empty());
}

#[test]
fn tool_errors_serialize_for_the_model() {
    let e = parse("split_clips", json!({"time_seconds": -1})).unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], "invalid_arguments");
    assert_eq!(v["field"], "time_seconds");
    assert!(v["message"]
        .as_str()
        .unwrap()
        .contains("between 0 and 86400"));
    assert_eq!(e.to_string(), e.message);
    let v = serde_json::to_value(parse("nope", json!({})).unwrap_err()).unwrap();
    assert_eq!(v["code"], "unknown_tool");
    assert!(v.get("field").is_none());
}
