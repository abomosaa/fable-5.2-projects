//! Sessions: revision checks, transactional undo/redo, change payloads, persistence.

mod common;
use common::*;
use cutline_core::commands::{Command, Edge, PlaceMode};
use cutline_core::error::ErrorCode;
use cutline_core::history::{DocPatch, History, HistoryEntry, Session, HISTORY_MAX_ENTRIES};
use cutline_core::model::*;
use cutline_core::resolve::resolve_layers;
use cutline_core::time::FrameRate;
use cutline_core::transcript::Env;
use serde_json::json;

fn session() -> Session {
    Session::new(project(), History::default())
}

fn exec(s: &mut Session, c: Command) -> cutline_core::Change {
    let rev = s.project.revision;
    s.execute(rev, &c, &Env::default(), 5_000)
        .unwrap_or_else(|e| panic!("{c:?} failed: {e:?}"))
}

fn add_vid(s: &mut Session, start: i64) -> Vec<ClipId> {
    exec(
        s,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(tl(start)),
            track_id: None,
            source_in: Some(src(0)),
            source_out: Some(src(300)),
            mode: PlaceMode::Overwrite,
        },
    )
    .created
}

#[test]
fn stale_revisions_are_rejected_without_side_effects() {
    let mut s = session();
    add_vid(&mut s, 0);
    let before = s.project.clone();
    let history_before = s.history.clone();
    let split = Command::SplitClips {
        at: tl(100),
        clip_ids: None,
    };
    for stale in [0, before.revision - 1, before.revision + 1, u64::MAX] {
        if stale == before.revision {
            continue;
        }
        let e = s
            .execute(stale, &split, &Env::default(), 9_999)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::StaleRevision);
        assert!(
            e.message.contains(&before.revision.to_string()),
            "message should name the current revision: {}",
            e.message
        );
        assert_eq!(
            s.undo(stale, 9_999).unwrap_err().code,
            ErrorCode::StaleRevision
        );
        assert_eq!(
            s.redo(stale, 9_999).unwrap_err().code,
            ErrorCode::StaleRevision
        );
        assert_eq!(s.project, before);
        assert_eq!(s.history, history_before);
    }
    // the same command at the right revision goes through
    assert!(s
        .execute(before.revision, &split, &Env::default(), 9_999)
        .is_ok());
}

#[test]
fn every_committed_step_bumps_the_revision_and_timestamp() {
    let mut s = session();
    assert_eq!(s.project.revision, 0);
    let c = exec(
        &mut s,
        Command::AddMarker {
            time: tl(10),
            label: String::new(),
            color: None,
        },
    );
    assert_eq!((c.revision, s.project.revision), (1, 1));
    assert_eq!(s.project.updated_at_ms, 5_000);
    assert_eq!(s.project.created_at_ms, 1_000);
    let c = s.undo(1, 6_000).unwrap();
    assert_eq!(
        (c.revision, s.project.revision, s.project.updated_at_ms),
        (2, 2, 6_000)
    );
    let c = s.redo(2, 7_000).unwrap();
    assert_eq!(
        (c.revision, s.project.revision, s.project.updated_at_ms),
        (3, 3, 7_000)
    );
    // an undo is itself protected by the revision check
    assert_eq!(s.undo(2, 8_000).unwrap_err().code, ErrorCode::StaleRevision);
}

#[test]
fn rejected_commands_leave_the_session_untouched() {
    let mut s = session();
    add_vid(&mut s, 0);
    let (project, history, layers) = (s.project.clone(), s.history.clone(), s.layers());
    let rev = project.revision;
    let bad = [
        Command::DeleteClips {
            clip_ids: vec!["ghost".into()],
            ripple: true,
        },
        Command::SplitClips {
            at: tl(5_000),
            clip_ids: None,
        },
        Command::AddText {
            text: String::new(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
        cmd(
            json!({"type": "batch", "commands": [{"type": "split_clips", "at": fr(100)}, {"type": "remove_marker", "marker_id": "nope"}]}),
        ),
    ];
    for c in bad {
        assert!(s.execute(rev, &c, &Env::default(), 9_000).is_err());
        assert_eq!(s.project, project);
        assert_eq!(s.history, history);
        assert_eq!(s.layers(), layers);
    }
}

#[test]
fn commands_that_change_nothing_are_not_recorded() {
    let mut s = session();
    let a1 = track_id(&s.project, "A1");
    let noop = [
        cmd(json!({"type": "update_track", "track_id": a1, "muted": false})),
        Command::SetTranscriptEditing { enabled: false },
        Command::UpdateSettings {
            width: Some(1920),
            height: None,
            fps: Some(FrameRate::FPS_30),
            background: None,
            caption_style: None,
        },
        Command::RippleDeleteRange {
            start: tl(100),
            end: tl(200),
        },
    ];
    for c in noop {
        let e = s.execute(0, &c, &Env::default(), 9_000).unwrap_err();
        assert_eq!(e.code, ErrorCode::NothingToDo, "{c:?}");
        assert_eq!(s.project.revision, 0);
        assert!(s.history.undo.is_empty());
    }
    assert_eq!(s.undo(0, 1).unwrap_err().code, ErrorCode::NothingToDo);
    assert_eq!(s.redo(0, 1).unwrap_err().code, ErrorCode::NothingToDo);
    assert_eq!(s.project.revision, 0);
}

#[test]
fn undo_and_redo_restore_the_exact_documents() {
    let mut s = session();
    let pair = add_vid(&mut s, 0);
    let pair2 = add_vid(&mut s, 300);
    let v1 = track_id(&s.project, "V1");
    let steps: Vec<Command> = vec![
        Command::SplitClips {
            at: tl(100),
            clip_ids: None,
        },
        Command::TrimClips {
            clip_ids: pair.clone(),
            edge: Edge::Start,
            delta: fr(20),
            ripple: true,
        },
        Command::AddTransitions {
            left_clip_ids: vec![pair[0].clone()],
            kind: TransitionKind::CrossDissolve,
            duration: fr(10),
        },
        Command::SetSpeed {
            clip_ids: pair2.clone(),
            speed: 2.0,
            ripple: true,
        },
        cmd(
            json!({"type": "update_clips", "clip_ids": [pair[0]], "patch": {"scale": 0.5, "opacity": 0.7, "fade_in": fr(5)}}),
        ),
        Command::AddText {
            text: "Title".into(),
            start: tl(30),
            duration: Some(fr(60)),
            track_id: None,
        },
        Command::AddTrack {
            kind: TrackKind::Video,
            name: None,
        },
        cmd(json!({"type": "update_track", "track_id": v1, "hidden": true})),
        Command::AddMarker {
            time: tl(45),
            label: "x".into(),
            color: None,
        },
        Command::UpdateSettings {
            width: Some(1280),
            height: Some(720),
            fps: Some(FrameRate::FPS_25),
            background: Some("#101010".into()),
            caption_style: None,
        },
        Command::DeleteClips {
            clip_ids: vec![pair2[0].clone(), pair2[1].clone()],
            ripple: true,
        },
        Command::RemoveAsset {
            asset_id: "vid".into(),
        },
        Command::SetTranscriptEditing { enabled: true },
    ];
    let mut snapshots = vec![s.project.clone()];
    for c in &steps {
        exec(&mut s, c.clone());
        snapshots.push(s.project.clone());
    }
    assert_eq!(s.history.undo.len(), steps.len() + 2);
    // walk all the way back…
    for i in (0..steps.len()).rev() {
        let rev = s.project.revision;
        let change = s.undo(rev, 1).unwrap();
        assert!(
            same_doc(&s.project, &snapshots[i]),
            "undo of step {i} ({:?}) did not restore the document",
            steps[i]
        );
        assert_eq!(change.revision, rev + 1);
        assert!(change.label.starts_with("Undo "), "{}", change.label);
        cutline_core::validate::validate(&s.project).unwrap();
        assert_eq!(s.layers(), resolve_layers(&s.project));
    }
    // …and forward again
    for i in 0..steps.len() {
        let rev = s.project.revision;
        let change = s.redo(rev, 1).unwrap();
        assert!(
            same_doc(&s.project, &snapshots[i + 1]),
            "redo of step {i} ({:?}) did not reproduce the document",
            steps[i]
        );
        assert!(change.label.starts_with("Redo "), "{}", change.label);
        assert_eq!(s.layers(), resolve_layers(&s.project));
    }
    assert!(s.history.redo.is_empty());
    // ids are never reused after an undo
    let next_before = s.project.next_id;
    let rev = s.project.revision;
    s.undo(rev, 1).unwrap();
    assert_eq!(s.project.next_id, next_before);
}

#[test]
fn transcript_edits_are_undoable_like_any_other_edit() {
    let texts: Vec<String> = (0..20).map(|i| format!("w{i}")).collect();
    let words: Vec<(&str, i64, i64, &str)> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| (t.as_str(), i as i64 * 500, i as i64 * 500 + 400, "1"))
        .collect();
    let env = env_with(vec![transcript("vid", &words)]);
    let mut s = session();
    let pair = add_vid(&mut s, 0);
    let run_env = |s: &mut Session, c: Command| {
        let rev = s.project.revision;
        s.execute(rev, &c, &env, 1)
            .unwrap_or_else(|e| panic!("{c:?}: {e:?}"))
    };
    let cut = |a: i64, b: i64| cutline_core::commands::SourceCut {
        clip_id: pair[1].clone(),
        source_start: src(a),
        source_end: src(b),
        text: "x".into(),
    };
    let steps = vec![
        Command::SetTranscriptEditing { enabled: true },
        Command::CorrectWord {
            asset_id: "vid".into(),
            word_index: 2,
            text: Some("two".into()),
        },
        Command::RenameSpeaker {
            asset_id: "vid".into(),
            speaker: "1".into(),
            name: Some("Ann".into()),
        },
        Command::RippleDeleteSource {
            cuts: vec![cut(60, 72), cut(150, 162)],
            reason: RemovalReason::Filler,
        },
        Command::GenerateCaptions {
            options: Default::default(),
        },
        Command::HealCuts {
            left_clip_ids: pair.clone(),
        },
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges: vec![cutline_core::commands::SourceRange {
                start: src(900),
                end: src(960),
            }],
            at: None,
        },
        Command::CorrectWord {
            asset_id: "vid".into(),
            word_index: 2,
            text: None,
        },
    ];
    let mut snapshots = vec![s.project.clone()];
    for c in &steps {
        let change = run_env(&mut s, c.clone());
        // transcript state travels in the patch whenever it changed
        let before = snapshots.last().unwrap();
        assert_eq!(
            change.patch.transcript.is_some(),
            before.transcript != s.project.transcript,
            "{c:?}"
        );
        snapshots.push(s.project.clone());
    }
    assert_eq!(
        s.project.transcript.removals.len(),
        1,
        "one cut was healed, one remains"
    );
    for i in (0..steps.len()).rev() {
        let rev = s.project.revision;
        s.undo(rev, 2).unwrap();
        assert!(
            same_doc(&s.project, &snapshots[i]),
            "undo of {:?}",
            steps[i]
        );
    }
    assert!(
        s.project.transcript.removals.is_empty()
            && s.project.transcript.corrections.is_empty()
            && !s.project.transcript.enabled
    );
    for i in 0..steps.len() {
        let rev = s.project.revision;
        s.redo(rev, 3).unwrap();
        assert!(
            same_doc(&s.project, &snapshots[i + 1]),
            "redo of {:?}",
            steps[i]
        );
    }
    // the audit trail records the revision that made the cut, and survives undo/redo unchanged
    assert_eq!(
        s.project.transcript.removals[0].revision,
        snapshots[4].revision
    );
}

#[test]
fn a_new_command_clears_the_redo_stack() {
    let mut s = session();
    add_vid(&mut s, 0);
    exec(
        &mut s,
        Command::SplitClips {
            at: tl(100),
            clip_ids: None,
        },
    );
    let rev = s.project.revision;
    s.undo(rev, 1).unwrap();
    assert!(s.history_state().can_redo);
    assert_eq!(s.history_state().redo_label.as_deref(), Some("Split"));
    exec(
        &mut s,
        Command::AddMarker {
            time: tl(1),
            label: String::new(),
            color: None,
        },
    );
    let h = s.history_state();
    assert!(!h.can_redo && h.redo_label.is_none());
    assert_eq!(h.redo_depth, 0);
    assert_eq!(h.undo_depth, 2);
    assert_eq!(h.undo_label.as_deref(), Some("Add marker"));
    let rev = s.project.revision;
    assert_eq!(s.redo(rev, 1).unwrap_err().code, ErrorCode::NothingToDo);
}

#[test]
fn change_payload_lets_a_client_reproduce_the_new_document() {
    let mut s = session();
    let pair = add_vid(&mut s, 0);
    // the client starts from a full snapshot, then only ever applies change payloads
    let mut client = s.project.clone();
    let mut client_layers: std::collections::BTreeMap<ClipId, cutline_core::resolve::Layer> = s
        .layers()
        .into_iter()
        .map(|l| (l.clip_id.clone(), l))
        .collect();
    let apply_change =
        |client: &mut Project,
         layers: &mut std::collections::BTreeMap<ClipId, cutline_core::resolve::Layer>,
         c: &cutline_core::Change| {
            c.patch.apply(client);
            client.revision = c.revision;
            for id in &c.patch.clips_remove {
                layers.remove(id);
            }
            for l in &c.layers_upsert {
                layers.insert(l.clip_id.clone(), l.clone());
            }
        };
    let cmds = vec![
        Command::AddAssetClips {
            asset_id: "vid2".into(),
            start: None,
            track_id: None,
            source_in: None,
            source_out: Some(src(200)),
            mode: PlaceMode::Overwrite,
        },
        Command::AddTransitions {
            left_clip_ids: pair.clone(),
            kind: TransitionKind::Push,
            duration: fr(20),
        },
        Command::SplitClips {
            at: tl(150),
            clip_ids: None,
        },
        Command::DeleteClips {
            clip_ids: pair.clone(),
            ripple: true,
        },
        Command::AddCaptions {
            cues: vec![cutline_core::commands::CueDraft {
                start: tl(0),
                duration: fr(30),
                text: "hi".into(),
                speaker: None,
                source: None,
            }],
            track_id: None,
        },
        Command::RippleDeleteRange {
            start: tl(10),
            end: tl(40),
        },
    ];
    for c in cmds {
        let before_layers = s.layers();
        let change = exec(&mut s, c.clone());
        apply_change(&mut client, &mut client_layers, &change);
        assert!(
            same_doc(&client, &s.project),
            "patch for {c:?} does not reproduce the document"
        );
        assert_eq!(change.duration, s.project.duration());
        assert_eq!(change.history, s.history_state());
        for id in &change.created {
            assert!(s.project.clips.contains_key(id));
        }
        // the client's layer table equals a full re-resolve
        let mut mine: Vec<_> = client_layers.values().cloned().collect();
        mine.sort_by(cutline_core::resolve::paint_order);
        assert_eq!(mine, resolve_layers(&s.project), "layers after {c:?}");
        // and only genuinely changed layers were sent
        for l in &change.layers_upsert {
            assert!(
                before_layers.iter().find(|b| b.clip_id == l.clip_id) != Some(l),
                "unchanged layer {} was re-sent for {c:?}",
                l.clip_id
            );
        }
    }
    // undo / redo produce equally usable payloads
    for _ in 0..3 {
        let rev = s.project.revision;
        let change = s.undo(rev, 1).unwrap();
        apply_change(&mut client, &mut client_layers, &change);
        assert!(same_doc(&client, &s.project));
        let mut mine: Vec<_> = client_layers.values().cloned().collect();
        mine.sort_by(cutline_core::resolve::paint_order);
        assert_eq!(mine, resolve_layers(&s.project));
    }
}

#[test]
fn layers_upsert_contains_exactly_the_layers_that_changed() {
    let mut s = session();
    let a = add_vid(&mut s, 0);
    let b = add_vid(&mut s, 300);
    let c = add_vid(&mut s, 600);
    // a property that does not affect the resolved layer of other clips
    let change = exec(
        &mut s,
        cmd(json!({"type": "update_clips", "clip_ids": [a[1]], "patch": {"gain_db": -6.0}})),
    );
    assert_eq!(
        change
            .layers_upsert
            .iter()
            .map(|l| l.clip_id.clone())
            .collect::<Vec<_>>(),
        vec![a[1].clone()]
    );
    // opacity lives on the clip, not the layer: nothing to resend
    let change = exec(
        &mut s,
        cmd(json!({"type": "update_clips", "clip_ids": [a[0]], "patch": {"opacity": 0.5}})),
    );
    assert!(change.layers_upsert.is_empty());
    assert_eq!(change.patch.clips_upsert.len(), 1);
    // a transition changes both neighbours
    let change = exec(
        &mut s,
        Command::AddTransitions {
            left_clip_ids: vec![a[0].clone()],
            kind: TransitionKind::CrossDissolve,
            duration: fr(20),
        },
    );
    let mut ids: Vec<_> = change
        .layers_upsert
        .iter()
        .map(|l| l.clip_id.clone())
        .collect();
    ids.sort();
    let mut expected = vec![a[0].clone(), b[0].clone()];
    expected.sort();
    assert_eq!(ids, expected);
    assert!(change.patch.clips_upsert.is_empty() && change.patch.transitions.is_some());
    // ripple delete of the middle pair: only the later pair moves
    let change = exec(
        &mut s,
        Command::DeleteClips {
            clip_ids: b.clone(),
            ripple: true,
        },
    );
    let mut ids: Vec<_> = change
        .layers_upsert
        .iter()
        .map(|l| l.clip_id.clone())
        .collect();
    ids.sort();
    // a[0] loses its transition extension, c shifts
    let mut expected = vec![a[0].clone(), c[0].clone(), c[1].clone()];
    expected.sort();
    assert_eq!(ids, expected);
    let mut removed = change.patch.clips_remove.clone();
    removed.sort();
    let mut b_sorted = b.clone();
    b_sorted.sort();
    assert_eq!(removed, b_sorted);
}

#[test]
fn imported_assets_are_outside_the_undo_history() {
    let mut s = session();
    add_vid(&mut s, 0);
    let rev = s.project.revision;
    let patch = s.add_asset(asset("new", AssetKind::Video, 10, true, true), 7_777);
    assert_eq!(
        s.project.revision, rev,
        "imports commute with edits and do not bump the revision"
    );
    assert_eq!(patch.assets_upsert.len(), 1);
    assert!(patch.clips_upsert.is_empty());
    assert_eq!(s.history.undo.len(), 1);
    assert_eq!(s.project.updated_at_ms, 7_777);
    // a client that has not heard about the import yet can still edit
    exec(
        &mut s,
        Command::SplitClips {
            at: tl(100),
            clip_ids: None,
        },
    );
    // undoing everything keeps the imported asset in the bin
    while s.history_state().can_undo {
        let rev = s.project.revision;
        let change = s.undo(rev, 1).unwrap();
        assert!(change.patch.assets_remove.is_empty());
    }
    assert!(s.project.assets.contains_key("new"));
    assert!(s.project.clips.is_empty());
    // the new asset is usable and redo still works around it
    let rev = s.project.revision;
    s.redo(rev, 1).unwrap();
    exec(
        &mut s,
        Command::AddAssetClips {
            asset_id: "new".into(),
            start: None,
            track_id: None,
            source_in: None,
            source_out: None,
            mode: PlaceMode::Overwrite,
        },
    );
    // removing an asset *is* an edit and can be undone, clips and all
    let before = s.project.clone();
    exec(
        &mut s,
        Command::RemoveAsset {
            asset_id: "new".into(),
        },
    );
    assert!(!s.project.assets.contains_key("new"));
    let rev = s.project.revision;
    s.undo(rev, 1).unwrap();
    assert!(same_doc(&s.project, &before));
}

#[test]
fn rename_is_validated_and_not_undoable() {
    let mut s = session();
    s.rename("  My film  ", 4_242).unwrap();
    assert_eq!(s.project.name, "My film");
    assert_eq!(s.project.updated_at_ms, 4_242);
    assert_eq!(s.project.revision, 0);
    assert!(s.history.undo.is_empty());
    for bad in ["", "   ", &"x".repeat(121), "a\nb"] {
        assert_eq!(
            s.rename(bad, 1).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(s.project.name, "My film");
    // undoing an edit made before the rename keeps the new name
    exec(
        &mut s,
        Command::AddMarker {
            time: tl(0),
            label: String::new(),
            color: None,
        },
    );
    s.rename("Final", 1).unwrap();
    s.undo(1, 1).unwrap();
    assert_eq!(s.project.name, "Final");
}

#[test]
fn history_is_bounded() {
    let mut s = session();
    for i in 0..(HISTORY_MAX_ENTRIES as i64 + 25) {
        exec(
            &mut s,
            Command::AddMarker {
                time: tl(i),
                label: String::new(),
                color: None,
            },
        );
    }
    assert_eq!(s.history.undo.len(), HISTORY_MAX_ENTRIES);
    assert_eq!(s.history_state().undo_depth, HISTORY_MAX_ENTRIES);
    // the oldest entries were dropped: undoing everything leaves the first 25 markers
    while s.history_state().can_undo {
        let rev = s.project.revision;
        s.undo(rev, 1).unwrap();
    }
    assert_eq!(s.project.markers.len(), 25);
}

#[test]
fn project_and_history_survive_a_json_round_trip() {
    let mut s = session();
    let pair = add_vid(&mut s, 0);
    exec(
        &mut s,
        Command::SplitClips {
            at: tl(100),
            clip_ids: None,
        },
    );
    exec(
        &mut s,
        Command::AddTransitions {
            left_clip_ids: vec![pair[0].clone()],
            kind: TransitionKind::Slide,
            duration: fr(10),
        },
    );
    exec(
        &mut s,
        cmd(
            json!({"type": "update_clips", "clip_ids": [pair[0]], "patch": {"x": 0.123456789, "rotation": -33.3, "brightness": 1.1}}),
        ),
    );
    exec(
        &mut s,
        Command::AddText {
            text: "Zażółć \"quoted\" 🎬\nline two".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
    );
    exec(
        &mut s,
        Command::AddCaptions {
            cues: vec![cutline_core::commands::CueDraft {
                start: tl(0),
                duration: fr(30),
                text: "cap".into(),
                speaker: Some("Ann".into()),
                source: None,
            }],
            track_id: None,
        },
    );
    exec(
        &mut s,
        Command::SetSpeed {
            clip_ids: pair.clone(),
            speed: 1.5,
            ripple: true,
        },
    );
    exec(
        &mut s,
        Command::AddMarker {
            time: tl(5),
            label: "m".into(),
            color: None,
        },
    );
    exec(
        &mut s,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: Some(FrameRate::FPS_29_97),
            background: None,
            caption_style: None,
        },
    );
    let rev = s.project.revision;
    s.undo(rev, 1).unwrap(); // leave something on the redo stack too
    let rev = s.project.revision;
    s.undo(rev, 1).unwrap();

    let project_json = serde_json::to_string(&s.project).unwrap();
    let history_json = serde_json::to_string(&s.history).unwrap();
    let project: Project = serde_json::from_str(&project_json).unwrap();
    let history: History = serde_json::from_str(&history_json).unwrap();
    assert_eq!(project, s.project);
    assert_eq!(history, s.history);
    // byte-stable: serialising again gives the same text (deterministic key order)
    assert_eq!(serde_json::to_string(&project).unwrap(), project_json);

    // a session restored from disk behaves exactly like the live one
    let mut restored = Session::new(project, history);
    assert_eq!(restored.layers(), s.layers());
    assert_eq!(restored.history_state(), s.history_state());
    loop {
        let rev = s.project.revision;
        let (a, b) = (s.undo(rev, 1), restored.undo(rev, 1));
        match (a, b) {
            (Ok(x), Ok(y)) => assert_eq!(x, y),
            (Err(x), Err(y)) => {
                assert_eq!(x.code, ErrorCode::NothingToDo);
                assert_eq!(y.code, ErrorCode::NothingToDo);
                break;
            }
            other => panic!("live and restored sessions diverged: {other:?}"),
        }
        assert_eq!(restored.project, s.project);
    }
    loop {
        let rev = s.project.revision;
        match (s.redo(rev, 1), restored.redo(rev, 1)) {
            (Ok(x), Ok(y)) => assert_eq!(x, y),
            (Err(_), Err(_)) => break,
            other => panic!("live and restored sessions diverged: {other:?}"),
        }
    }
    assert_eq!(restored.project, s.project);
    // new edits allocate ids that do not clash with anything restored
    let change = exec(
        &mut restored,
        Command::AddText {
            text: "after restart".into(),
            start: tl(900),
            duration: None,
            track_id: None,
        },
    );
    assert_eq!(change.created.len(), 1);
}

#[test]
fn old_documents_without_optional_fields_still_load() {
    // a minimal hand-written document: optional collections and flags are omitted
    let doc = json!({
        "schema_version": 1, "id": "p", "name": "Old", "revision": 7, "created_at_ms": 1, "updated_at_ms": 2,
        "settings": {"width": 1920, "height": 1080, "fps": {"num": 30, "den": 1}, "sample_rate": 48000, "background": "#000000"},
        "assets": {"a": {"id": "a", "name": "a.mp4", "kind": "video", "duration": 7056000000i64, "has_video": true, "has_audio": false}},
        "tracks": [{"id": "t1", "kind": "video", "name": "V1"}, {"id": "t2", "kind": "audio", "name": "A1"}],
        "clips": {"c1": {"id": "c1", "track_id": "t1", "start": 0, "duration": 2352000000i64, "source_in": 0, "content": {"kind": "video", "asset_id": "a"}}},
        "next_id": 10
    });
    let p: Project = serde_json::from_value(doc).unwrap();
    cutline_core::validate::validate(&p).unwrap();
    let c = &p.clips["c1"];
    assert!(c.enabled && c.transform.is_identity() && c.color.is_neutral());
    assert_eq!(p.settings.caption_style, CaptionStyle::default());
    assert!(p.transitions.is_empty() && p.markers.is_empty() && !p.transcript.enabled);
    let mut s = Session::new(p, History::default());
    let change = s
        .execute(
            7,
            &Command::SplitClips {
                at: tl(50),
                clip_ids: None,
            },
            &Env::default(),
            3,
        )
        .unwrap();
    assert_eq!(change.revision, 8);
    assert_eq!(change.created, vec!["c11".to_string()]);
}

#[test]
fn doc_patch_diff_and_apply_are_inverse() {
    let a = project();
    let (b, _) = add(&a, "vid", Some(0));
    let b = run(
        &b,
        Command::AddMarker {
            time: tl(3),
            label: String::new(),
            color: None,
        },
    );
    let b = run(
        &b,
        Command::AddTrack {
            kind: TrackKind::Caption,
            name: None,
        },
    );
    let forward = DocPatch::diff(&a, &b);
    let backward = DocPatch::diff(&b, &a);
    assert!(!forward.is_empty());
    assert_eq!(forward.clips_upsert.len(), 2);
    assert_eq!(backward.clips_remove.len(), 2);
    assert!(forward.tracks.is_some() && forward.markers.is_some());
    assert!(
        forward.settings.is_none()
            && forward.transcript.is_none()
            && forward.transitions.is_none()
            && forward.name.is_none()
    );
    let mut x = a.clone();
    forward.apply(&mut x);
    assert!(same_doc(&x, &b));
    backward.apply(&mut x);
    assert!(same_doc(&x, &a));
    assert!(DocPatch::diff(&a, &a).is_empty());
    assert!(forward.weight() > DocPatch::default().weight());
    // empty patches serialise to an empty object (cheap on the wire)
    assert_eq!(serde_json::to_string(&DocPatch::default()).unwrap(), "{}");
    let entry = HistoryEntry {
        label: "x".into(),
        forward: forward.clone(),
        backward,
        at_ms: 1,
    };
    let again: HistoryEntry =
        serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
    assert_eq!(again, entry);
}
