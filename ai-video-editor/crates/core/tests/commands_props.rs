//! Clip properties, links/groups, transitions, tracks, markers, project settings,
//! asset removal, batches and wire-format (serde) validation.

mod common;
use common::*;
use cutline_core::commands::{ClipMove, ClipPatch, Command, CueDraft, Edge, PlaceMode};
use cutline_core::error::ErrorCode;
use cutline_core::model::*;
use cutline_core::time::FrameRate;
use serde_json::{json, Value};

fn patch(
    p: &Project,
    ids: &[&ClipId],
    fields: Value,
) -> Result<Project, cutline_core::CommandError> {
    let c = cmd(json!({"type": "update_clips", "clip_ids": ids, "patch": fields}));
    try_run(p, c).map(|a| a.project)
}

fn patch_err(p: &Project, ids: &[&ClipId], fields: Value, field: &str) {
    let c = cmd(json!({"type": "update_clips", "clip_ids": ids, "patch": fields}));
    expect_err(p, c, ErrorCode::InvalidArgument, Some(field));
}

/// A linked video/audio pair, an image, a title and a caption.
struct Kit {
    p: Project,
    video: ClipId,
    audio: ClipId,
    image: ClipId,
    text: ClipId,
    caption: ClipId,
}

fn kit() -> Kit {
    let (p, pair) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, img) = add(&p, "img", Some(100));
    let p = run(
        &p,
        Command::AddText {
            text: "Title".into(),
            start: tl(0),
            duration: Some(fr(100)),
            track_id: None,
        },
    );
    let p = run(
        &p,
        Command::AddCaptions {
            cues: vec![CueDraft {
                start: tl(0),
                duration: fr(60),
                text: "Hello".into(),
                speaker: None,
                source: None,
            }],
            track_id: None,
        },
    );
    let text = on(&p, "V2")[0].id.clone();
    let caption = on(&p, "C1")[0].id.clone();
    Kit {
        p,
        video: pair[0].clone(),
        audio: pair[1].clone(),
        image: img[0].clone(),
        text,
        caption,
    }
}

fn abc() -> (Project, [ClipId; 3]) {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, b) = add_range(&p, "mute", Some(100), Some(100), Some(200));
    let (p, c) = add_range(&p, "mute", Some(200), Some(200), Some(300));
    (p, [a[0].clone(), b[0].clone(), c[0].clone()])
}

fn lock(p: &Project, track: &str) -> Project {
    let id = track_id(p, track);
    run_json(
        p,
        json!({"type": "update_track", "track_id": id, "locked": true}),
    )
}

// ---------------------------------------------------------------------------------
// UpdateClips
// ---------------------------------------------------------------------------------

#[test]
fn transform_and_colour_apply_to_pictures() {
    let k = kit();
    let q = patch(
        &k.p,
        &[&k.video],
        json!({"x": 0.25, "y": -0.1, "scale": 0.5, "rotation": 90.0, "opacity": 0.6, "crop_left": 0.1, "crop_top": 0.2, "crop_right": 0.3, "crop_bottom": 0.05, "flip_h": true, "flip_v": true,
               "brightness": 1.2, "contrast": 0.9, "saturation": 0.0, "temperature": -0.5}),
    )
    .unwrap();
    let c = &q.clips[&k.video];
    assert_eq!(
        c.transform,
        Transform {
            x: 0.25,
            y: -0.1,
            scale: 0.5,
            rotation: 90.0,
            opacity: 0.6,
            crop: Crop {
                left: 0.1,
                top: 0.2,
                right: 0.3,
                bottom: 0.05
            },
            flip_h: true,
            flip_v: true
        }
    );
    assert_eq!(
        c.color,
        ColorAdjust {
            brightness: 1.2,
            contrast: 0.9,
            saturation: 0.0,
            temperature: -0.5
        }
    );
    // untouched fields keep their values on a second patch
    let q = patch(&q, &[&k.video], json!({"x": 0.0})).unwrap();
    assert_eq!(q.clips[&k.video].transform.scale, 0.5);
    assert_eq!(q.clips[&k.video].transform.x, 0.0);
    // images take both too; text takes the transform (but has no crop / colour)
    let q = patch(
        &k.p,
        &[&k.image, &k.text],
        json!({"scale": 2.0, "crop_left": 0.2, "saturation": 0.5}),
    )
    .unwrap();
    assert_eq!(q.clips[&k.image].transform.scale, 2.0);
    assert_eq!(q.clips[&k.image].transform.crop.left, 0.2);
    assert_eq!(q.clips[&k.image].color.saturation, 0.5);
    assert_eq!(q.clips[&k.text].transform.scale, 2.0);
    assert_eq!(q.clips[&k.text].transform.crop, Crop::default());
    assert!(q.clips[&k.text].color.is_neutral());
}

#[test]
fn a_mixed_selection_applies_each_field_where_it_makes_sense() {
    let k = kit();
    let q = patch(
        &k.p,
        &[&k.video, &k.audio],
        json!({"opacity": 0.5, "gain_db": -6.0, "fade_in": fr(10), "enabled": false}),
    )
    .unwrap();
    let (v, a) = (&q.clips[&k.video], &q.clips[&k.audio]);
    assert_eq!(v.transform.opacity, 0.5);
    assert_eq!(v.gain_db, 0.0, "gain is an audio property");
    assert_eq!(a.gain_db, -6.0);
    assert_eq!(a.transform.opacity, 1.0);
    assert_eq!((v.fade_in, a.fade_in), (fr(10), fr(10)));
    assert!(!v.enabled && !a.enabled);
}

#[test]
fn fields_are_rejected_when_no_selected_clip_accepts_them() {
    let k = kit();
    patch_err(&k.p, &[&k.audio], json!({"opacity": 0.5}), "patch");
    patch_err(&k.p, &[&k.audio, &k.caption], json!({"x": 0.1}), "patch");
    patch_err(&k.p, &[&k.text], json!({"brightness": 1.1}), "patch");
    patch_err(&k.p, &[&k.audio], json!({"saturation": 1.1}), "patch");
    patch_err(
        &k.p,
        &[&k.video, &k.image, &k.text],
        json!({"gain_db": -3.0}),
        "gain_db",
    );
    patch_err(&k.p, &[&k.video, &k.audio], json!({"text": "nope"}), "text");
    patch_err(
        &k.p,
        &[&k.caption, &k.video],
        json!({"bold": false}),
        "patch",
    );
    patch_err(&k.p, &[&k.text], json!({"speaker": "Ann"}), "speaker");
    patch_err(&k.p, &[&k.video], json!({}), "patch");
    patch_err(&k.p, &[], json!({"x": 0.1}), "clip_ids");
    expect_err(
        &k.p,
        cmd(json!({"type": "update_clips", "clip_ids": ["ghost"], "patch": {"x": 0.1}})),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &lock(&k.p, "V1"),
        cmd(json!({"type": "update_clips", "clip_ids": [k.video], "patch": {"x": 0.1}})),
        ErrorCode::TrackLocked,
        None,
    );
}

#[test]
fn property_ranges_are_enforced() {
    let k = kit();
    let v = &k.video;
    for (fields, field) in [
        (json!({"opacity": 1.5}), "opacity"),
        (json!({"opacity": -0.1}), "opacity"),
        (json!({"scale": 0.0}), "scale"),
        (json!({"scale": 50.0}), "scale"),
        (json!({"x": 9.0}), "x"),
        (json!({"y": -9.0}), "y"),
        (json!({"rotation": 1e9}), "rotation"),
        (json!({"crop_left": 0.99}), "crop_left"),
        (json!({"crop_top": -0.1}), "crop_top"),
        (json!({"crop_left": 0.5, "crop_right": 0.5}), "crop"),
        (json!({"crop_top": 0.6, "crop_bottom": 0.4}), "crop"),
        (json!({"brightness": 2.5}), "brightness"),
        (json!({"contrast": -1.0}), "contrast"),
        (json!({"saturation": 3.0}), "saturation"),
        (json!({"temperature": 1.5}), "temperature"),
        (json!({"fade_in": -1}), "fade_in"),
        (json!({"fade_out": -1}), "fade_out"),
    ] {
        patch_err(&k.p, &[v], fields, field);
    }
    patch_err(&k.p, &[&k.audio], json!({"gain_db": 30.0}), "gain_db");
    patch_err(&k.p, &[&k.audio], json!({"gain_db": -100.0}), "gain_db");
    for (fields, field) in [
        (json!({"font_size": 0.9}), "font_size"),
        (json!({"font_size": 0.0}), "font_size"),
        (json!({"text_color": "red"}), "text_color"),
        (json!({"text_color": "#12345"}), "text_color"),
        (json!({"text_color": "#11223344"}), "text_color"),
        (json!({"outline_color": "#gggggg"}), "outline_color"),
        (json!({"outline_width": 0.5}), "outline_width"),
        (json!({"background": "blue"}), "background"),
        (json!({"text": "   "}), "text"),
        (json!({"text": "a\u{0}b"}), "text"),
    ] {
        patch_err(&k.p, &[&k.text], fields, field);
    }
    // boundary values are accepted
    assert!(patch(&k.p, &[v], json!({"opacity": 0.0, "scale": 20.0, "brightness": 2.0, "contrast": 0.0, "temperature": -1.0, "crop_left": 0.95})).is_ok());
    assert!(patch(&k.p, &[&k.audio], json!({"gain_db": 24.0})).is_ok());
}

#[test]
fn fades_snap_and_never_exceed_the_clip() {
    let k = kit(); // video is 100 frames long
    let v = &k.video;
    let q = patch(
        &k.p,
        &[v],
        json!({"fade_in": fr(10) + 7, "fade_out": fr(30)}),
    )
    .unwrap();
    assert_eq!((q.clips[v].fade_in, q.clips[v].fade_out), (fr(10), fr(30)));
    // a longer fade-in pushes the existing fade-out back
    let q2 = patch(&q, &[v], json!({"fade_in": fr(90)})).unwrap();
    assert_eq!(
        (q2.clips[v].fade_in, q2.clips[v].fade_out),
        (fr(90), fr(10))
    );
    // …and the other way round
    let q3 = patch(&q2, &[v], json!({"fade_out": fr(80)})).unwrap();
    assert_eq!(
        (q3.clips[v].fade_in, q3.clips[v].fade_out),
        (fr(20), fr(80))
    );
    // longer than the clip clamps to the clip
    let q4 = patch(&k.p, &[v], json!({"fade_in": fr(500)})).unwrap();
    assert_eq!((q4.clips[v].fade_in, q4.clips[v].fade_out), (fr(100), 0));
    let q5 = patch(&k.p, &[v], json!({"fade_in": fr(500), "fade_out": fr(500)})).unwrap();
    assert_eq!(q5.clips[v].fade_in + q5.clips[v].fade_out, fr(100));
    // trimming the clip afterwards keeps the fades legal
    let q6 = run(
        &q,
        Command::TrimClips {
            clip_ids: vec![v.clone()],
            edge: Edge::End,
            delta: fr(-75),
            ripple: false,
        },
    );
    let c = &q6.clips[v];
    assert!(c.fade_in + c.fade_out <= c.duration);
    assert_eq!(c.fade_in, fr(10));
    assert_eq!(c.fade_out, fr(15));
}

#[test]
fn text_content_and_style() {
    let k = kit();
    let q = patch(
        &k.p,
        &[&k.text],
        json!({"text": "New\ntitle", "font_size": 0.12, "text_color": "#FFCC00", "bold": false, "align": "left", "background": "#00000080", "outline_color": "#112233", "outline_width": 0.08, "shadow": false}),
    )
    .unwrap();
    match &q.clips[&k.text].content {
        ClipContent::Text { text, style } => {
            assert_eq!(text, "New\ntitle");
            assert_eq!(
                *style,
                TextStyle {
                    font_size: 0.12,
                    color: "#ffcc00".into(),
                    bold: false,
                    align: TextAlign::Left,
                    background: Some("#00000080".into()),
                    outline_color: "#112233".into(),
                    outline_width: 0.08,
                    shadow: false
                }
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    // `null` clears the background box; absent leaves it alone
    let q2 = patch(&q, &[&k.text], json!({"bold": true})).unwrap();
    assert!(
        matches!(&q2.clips[&k.text].content, ClipContent::Text { style, .. } if style.background.is_some() && style.bold)
    );
    let q3 = patch(&q, &[&k.text], json!({"background": null})).unwrap();
    assert!(
        matches!(&q3.clips[&k.text].content, ClipContent::Text { style, .. } if style.background.is_none())
    );
}

#[test]
fn caption_text_and_speaker() {
    let k = kit();
    let q = patch(
        &k.p,
        &[&k.caption],
        json!({"text": "Hello world", "speaker": "Ann"}),
    )
    .unwrap();
    assert!(
        matches!(&q.clips[&k.caption].content, ClipContent::Caption { text, speaker, .. } if text == "Hello world" && speaker.as_deref() == Some("Ann"))
    );
    let q = patch(&q, &[&k.caption], json!({"speaker": null})).unwrap();
    assert!(matches!(
        &q.clips[&k.caption].content,
        ClipContent::Caption { speaker: None, .. }
    ));
    patch_err(&k.p, &[&k.caption], json!({"text": ""}), "text");
    patch_err(
        &k.p,
        &[&k.caption],
        json!({"text": "x".repeat(501)}),
        "text",
    );
    // captions and titles can be retitled together
    let q = patch(&k.p, &[&k.caption, &k.text], json!({"text": "Both"})).unwrap();
    assert!(
        matches!(&q.clips[&k.caption].content, ClipContent::Caption { text, .. } if text == "Both")
    );
    assert!(matches!(&q.clips[&k.text].content, ClipContent::Text { text, .. } if text == "Both"));
}

// ---------------------------------------------------------------------------------
// Links and groups
// ---------------------------------------------------------------------------------

#[test]
fn link_and_unlink() {
    let (p, [a, b, c]) = abc();
    let q = run(
        &p,
        Command::LinkClips {
            clip_ids: vec![a.clone(), b.clone()],
        },
    );
    assert!(q.clips[&a].link_id.is_some());
    assert_eq!(q.clips[&a].link_id, q.clips[&b].link_id);
    assert!(q.clips[&c].link_id.is_none());
    // relinking with a third clip forms one new set
    let q3 = run(
        &q,
        Command::LinkClips {
            clip_ids: vec![a.clone(), b.clone(), c.clone()],
        },
    );
    assert_eq!(q3.clips[&a].link_id, q3.clips[&c].link_id);
    assert_ne!(q3.clips[&a].link_id, q.clips[&a].link_id);
    // unlinking one member of three keeps the other two linked
    let q4 = run(
        &q3,
        Command::UnlinkClips {
            clip_ids: vec![c.clone()],
        },
    );
    assert!(q4.clips[&c].link_id.is_none());
    assert_eq!(q4.clips[&a].link_id, q4.clips[&b].link_id);
    assert!(q4.clips[&a].link_id.is_some());
    // unlinking one member of two dissolves the link entirely
    let q5 = run(
        &q,
        Command::UnlinkClips {
            clip_ids: vec![a.clone()],
        },
    );
    assert!(q5.clips[&a].link_id.is_none() && q5.clips[&b].link_id.is_none());
    expect_err(
        &p,
        Command::LinkClips {
            clip_ids: vec![a.clone()],
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::LinkClips {
            clip_ids: vec![a.clone(), a.clone()],
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::UnlinkClips {
            clip_ids: vec![a.clone(), b.clone()],
        },
        ErrorCode::Conflict,
        None,
    );
    expect_err(
        &lock(&p, "V1"),
        Command::LinkClips {
            clip_ids: vec![a, b],
        },
        ErrorCode::TrackLocked,
        None,
    );
}

#[test]
fn group_and_ungroup() {
    let (p, [a, b, c]) = abc();
    let q = run(
        &p,
        Command::GroupClips {
            clip_ids: vec![a.clone(), b.clone(), c.clone()],
        },
    );
    assert!(q.clips[&a].group_id.is_some());
    assert_eq!(q.clips[&a].group_id, q.clips[&b].group_id);
    assert_eq!(q.clips[&a].group_id, q.clips[&c].group_id);
    // ungrouping any member dissolves the whole group
    let q2 = run(
        &q,
        Command::UngroupClips {
            clip_ids: vec![b.clone()],
        },
    );
    assert!(q2.clips.values().all(|c| c.group_id.is_none()));
    // deleting members until one is left dissolves the group as well
    let q3 = run(
        &q,
        Command::DeleteClips {
            clip_ids: vec![a.clone(), b.clone()],
            ripple: false,
        },
    );
    assert!(q3.clips[&c].group_id.is_none());
    // groups and links are independent
    let q4 = run(
        &q,
        Command::LinkClips {
            clip_ids: vec![a.clone(), b.clone()],
        },
    );
    assert!(q4.clips[&a].group_id.is_some() && q4.clips[&a].link_id.is_some());
    expect_err(
        &p,
        Command::GroupClips {
            clip_ids: vec![a.clone()],
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::UngroupClips { clip_ids: vec![a] },
        ErrorCode::Conflict,
        None,
    );
}

// ---------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------

fn add_tr(left: &ClipId, kind: TransitionKind, frames: i64) -> Command {
    Command::AddTransitions {
        left_clip_ids: vec![left.clone()],
        kind,
        duration: fr(frames),
    }
}

fn only_transition(p: &Project) -> Transition {
    assert_eq!(p.transitions.len(), 1, "expected exactly one transition");
    p.transitions.values().next().unwrap().clone()
}

#[test]
fn transition_is_added_on_the_cut_after_the_clip() {
    let (p, [a, b, _c]) = abc();
    let q = run(&p, add_tr(&a, TransitionKind::Slide, 20));
    let t = only_transition(&q);
    assert_eq!(
        (t.left.clone(), t.right.clone(), t.kind, t.duration),
        (a.clone(), b.clone(), TransitionKind::Slide, fr(20))
    );
    // odd durations round down to an even number of frames so each half is frame aligned
    assert_eq!(
        only_transition(&run(&p, add_tr(&a, TransitionKind::CrossDissolve, 21))).duration,
        fr(20)
    );
    assert_eq!(
        only_transition(&run(
            &p,
            Command::AddTransitions {
                left_clip_ids: vec![a.clone()],
                kind: TransitionKind::Push,
                duration: fr(13) + 5
            }
        ))
        .duration,
        fr(12)
    );
    // longer than the clips: clamped to the shorter clip
    assert_eq!(
        only_transition(&run(&p, add_tr(&a, TransitionKind::DipToBlack, 5_000))).duration,
        fr(100)
    );
    // adding again on the same cut replaces the transition
    let q2 = run(&q, add_tr(&a, TransitionKind::Push, 40));
    let t2 = only_transition(&q2);
    assert_eq!((t2.kind, t2.duration), (TransitionKind::Push, fr(40)));
    // several cuts in one command
    let q3 = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![a, b],
            kind: TransitionKind::CrossDissolve,
            duration: fr(10),
        },
    );
    assert_eq!(q3.transitions.len(), 2);
}

#[test]
fn transition_rejections() {
    let (p, [a, _b, c]) = abc();
    expect_err(
        &p,
        add_tr(&c, TransitionKind::CrossDissolve, 20),
        ErrorCode::Conflict,
        None,
    ); // nothing after C
    expect_err(
        &p,
        add_tr(&a, TransitionKind::CrossDissolve, 0),
        ErrorCode::InvalidArgument,
        Some("duration"),
    );
    expect_err(
        &p,
        add_tr(&a, TransitionKind::CrossDissolve, -4),
        ErrorCode::InvalidArgument,
        Some("duration"),
    );
    expect_err(
        &p,
        add_tr(&a, TransitionKind::CrossDissolve, 1),
        ErrorCode::Conflict,
        None,
    ); // < 2 frames
    expect_err(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![],
            kind: TransitionKind::Slide,
            duration: fr(10),
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &lock(&p, "V1"),
        add_tr(&a, TransitionKind::CrossDissolve, 20),
        ErrorCode::TrackLocked,
        None,
    );
    // clips that do not touch
    let v1 = track_id(&p, "V1");
    let gap = run(
        &p,
        Command::MoveClips {
            moves: vec![ClipMove {
                clip_id: c.clone(),
                start: tl(400),
                track_id: v1,
            }],
            mode: PlaceMode::Overwrite,
        },
    );
    let b = on(&gap, "V1")[1].id.clone();
    expect_err(
        &gap,
        add_tr(&b, TransitionKind::CrossDissolve, 20),
        ErrorCode::Conflict,
        None,
    );
    // captions
    let cues = vec![
        CueDraft {
            start: tl(0),
            duration: fr(30),
            text: "a".into(),
            speaker: None,
            source: None,
        },
        CueDraft {
            start: tl(30),
            duration: fr(30),
            text: "b".into(),
            speaker: None,
            source: None,
        },
    ];
    let caps = run(
        &p,
        Command::AddCaptions {
            cues,
            track_id: None,
        },
    );
    let first = on(&caps, "C1")[0].id.clone();
    expect_err(
        &caps,
        add_tr(&first, TransitionKind::CrossDissolve, 10),
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn audio_transitions_are_always_crossfades() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, _y) = add_range(&p, "vid", Some(100), Some(300), Some(400));
    let q = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: x.clone(),
            kind: TransitionKind::Push,
            duration: fr(20),
        },
    );
    assert_eq!(q.transitions.len(), 2);
    let video_t = q.transitions.values().find(|t| t.left == x[0]).unwrap();
    let audio_t = q.transitions.values().find(|t| t.left == x[1]).unwrap();
    assert_eq!(video_t.kind, TransitionKind::Push);
    assert_eq!(audio_t.kind, TransitionKind::CrossDissolve);
    let q = run(
        &q,
        Command::UpdateTransition {
            transition_id: audio_t.id.clone(),
            kind: Some(TransitionKind::Slide),
            duration: None,
        },
    );
    assert_eq!(
        q.transitions[&audio_t.id].kind,
        TransitionKind::CrossDissolve
    );
}

#[test]
fn transitions_on_both_sides_of_a_short_clip_share_it() {
    // A 100, B 40, C 100
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, b) = add_range(&p, "mute", Some(100), Some(0), Some(40));
    let (p, _c) = add_range(&p, "mute", Some(140), Some(0), Some(100));
    let p = run(&p, add_tr(&a[0], TransitionKind::CrossDissolve, 100)); // clamped to B's length
    assert_eq!(only_transition(&p).duration, fr(40));
    // half of A|B already occupies 20 frames of B, leaving 20 frames (so a 40-frame transition) for B|C
    let q = run(&p, add_tr(&b[0], TransitionKind::CrossDissolve, 100));
    let bc = q.transitions.values().find(|t| t.left == b[0]).unwrap();
    assert_eq!(bc.duration, fr(40));
    // shrink B|C room by growing A|B is not possible: update is clamped the same way
    let ab = q
        .transitions
        .values()
        .find(|t| t.left == a[0])
        .unwrap()
        .id
        .clone();
    let q2 = run(
        &q,
        Command::UpdateTransition {
            transition_id: ab.clone(),
            kind: None,
            duration: Some(fr(10)),
        },
    );
    assert_eq!(q2.transitions[&ab].duration, fr(10));
    let q3 = run(
        &q2,
        Command::UpdateTransition {
            transition_id: bc.id.clone(),
            kind: None,
            duration: Some(fr(500)),
        },
    );
    assert_eq!(
        q3.transitions[&bc.id].duration,
        fr(40),
        "limited by the shorter clip"
    );
}

#[test]
fn update_and_remove_transitions() {
    let (p, [a, _b, _c]) = abc();
    let p = run(&p, add_tr(&a, TransitionKind::CrossDissolve, 20));
    let id = only_transition(&p).id;
    let q = run(
        &p,
        Command::UpdateTransition {
            transition_id: id.clone(),
            kind: Some(TransitionKind::DipToBlack),
            duration: Some(fr(31)),
        },
    );
    assert_eq!(
        (q.transitions[&id].kind, q.transitions[&id].duration),
        (TransitionKind::DipToBlack, fr(30))
    );
    let q = run(
        &p,
        Command::UpdateTransition {
            transition_id: id.clone(),
            kind: None,
            duration: Some(fr(1)),
        },
    );
    assert_eq!(q.transitions[&id].duration, fr(2), "minimum is two frames");
    expect_err(
        &p,
        Command::UpdateTransition {
            transition_id: id.clone(),
            kind: None,
            duration: Some(0),
        },
        ErrorCode::InvalidArgument,
        Some("duration"),
    );
    expect_err(
        &p,
        Command::UpdateTransition {
            transition_id: "ghost".into(),
            kind: None,
            duration: Some(fr(4)),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &lock(&p, "V1"),
        Command::UpdateTransition {
            transition_id: id.clone(),
            kind: Some(TransitionKind::Push),
            duration: None,
        },
        ErrorCode::TrackLocked,
        None,
    );
    let q = run(
        &p,
        Command::RemoveTransitions {
            transition_ids: vec![id.clone()],
        },
    );
    assert!(q.transitions.is_empty());
    expect_err(
        &q,
        Command::RemoveTransitions {
            transition_ids: vec![id],
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        Command::RemoveTransitions {
            transition_ids: vec![],
        },
        ErrorCode::InvalidArgument,
        Some("transition_ids"),
    );
}

#[test]
fn transitions_are_pruned_when_their_clips_stop_touching_and_clamped_when_they_shrink() {
    let (p, [a, b, c]) = abc();
    let p = run(&p, add_tr(&a, TransitionKind::CrossDissolve, 100));
    let v1 = track_id(&p, "V1");
    // moving the incoming clip away
    let q = run(
        &p,
        Command::MoveClips {
            moves: vec![ClipMove {
                clip_id: b.clone(),
                start: tl(500),
                track_id: v1.clone(),
            }],
            mode: PlaceMode::Overwrite,
        },
    );
    assert!(q.transitions.is_empty());
    // trimming a gap open
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: vec![a.clone()],
            edge: Edge::End,
            delta: fr(-10),
            ripple: false,
        },
    );
    assert!(q.transitions.is_empty());
    // a ripple trim keeps the clips touching: the transition stays but shrinks with the clip
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: vec![a.clone()],
            edge: Edge::End,
            delta: fr(-61),
            ripple: true,
        },
    );
    assert_eq!(q.clips[&a].duration, fr(39));
    assert_eq!(
        only_transition(&q).duration,
        fr(38),
        "clamped to an even number of frames inside the shorter clip"
    );
    // deleting an unrelated clip leaves it alone; deleting one side removes it
    assert_eq!(
        run(
            &p,
            Command::DeleteClips {
                clip_ids: vec![c.clone()],
                ripple: true
            }
        )
        .transitions
        .len(),
        1
    );
    assert!(run(
        &p,
        Command::DeleteClips {
            clip_ids: vec![a.clone()],
            ripple: true
        }
    )
    .transitions
    .is_empty());
    // ripple-deleting between two clips does not invent a transition for the new neighbours
    let p2 = run(&p, add_tr(&b, TransitionKind::Slide, 10));
    assert_eq!(p2.transitions.len(), 2);
    assert!(run(
        &p2,
        Command::DeleteClips {
            clip_ids: vec![b],
            ripple: true
        }
    )
    .transitions
    .is_empty());
}

// ---------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------

#[test]
fn new_tracks_are_placed_and_named_by_kind() {
    let p = project();
    assert_eq!(track_names(&p), vec!["V2", "V1", "A1", "A2"]);
    let q = run(
        &p,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: None,
        },
    );
    assert_eq!(track_names(&q), vec!["V3", "V2", "V1", "A1", "A2"]);
    let q = run(
        &q,
        Command::AddTrack {
            kind: TrackKind::Audio,
            name: None,
        },
    );
    assert_eq!(track_names(&q), vec!["V3", "V2", "V1", "A1", "A2", "A3"]);
    let q = run(
        &q,
        Command::AddTrack {
            kind: TrackKind::Caption,
            name: None,
        },
    );
    assert_eq!(
        track_names(&q),
        vec!["C1", "V3", "V2", "V1", "A1", "A2", "A3"]
    );
    // video tracks go below captions, above the other video tracks
    let q = run(
        &q,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: Some("  B-roll ".into()),
        },
    );
    assert_eq!(
        track_names(&q),
        vec!["C1", "B-roll", "V3", "V2", "V1", "A1", "A2", "A3"]
    );
    assert_eq!(q.track_ordinal(&track_id(&q, "V1")), Some(0));
    assert_eq!(q.track_ordinal(&track_id(&q, "B-roll")), Some(3));
    assert_eq!(q.track_ordinal(&track_id(&q, "A3")), Some(2));
    let ids: std::collections::BTreeSet<_> = q.tracks.iter().map(|t| t.id.clone()).collect();
    assert_eq!(ids.len(), q.tracks.len());
    expect_err(
        &p,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: Some("   ".into()),
        },
        ErrorCode::InvalidArgument,
        Some("name"),
    );
    expect_err(
        &p,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: Some("x".repeat(41)),
        },
        ErrorCode::InvalidArgument,
        Some("name"),
    );
    // there is an upper bound
    let mut big = p.clone();
    while big.tracks.len() < MAX_TRACKS {
        big = run(
            &big,
            Command::AddTrack {
                kind: TrackKind::Audio,
                name: None,
            },
        );
    }
    expect_err(
        &big,
        Command::AddTrack {
            kind: TrackKind::Audio,
            name: None,
        },
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn removing_a_track_removes_its_clips() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let a1 = track_id(&p, "A1");
    let q = run(
        &p,
        Command::RemoveTrack {
            track_id: a1.clone(),
        },
    );
    assert_eq!(
        track_names(&q),
        vec!["V2", "V1", "A1"],
        "automatic names follow the track order: the old A2 is now A1"
    );
    assert_eq!(q.clips.len(), 1);
    assert!(
        q.clips[&pair[0]].link_id.is_none(),
        "the surviving half of the pair is unlinked"
    );
    // a track the user renamed keeps its name
    let named = run_json(
        &p,
        json!({"type": "update_track", "track_id": track_id(&p, "A2"), "name": "Music"}),
    );
    let named = run(
        &named,
        Command::RemoveTrack {
            track_id: a1.clone(),
        },
    );
    assert_eq!(track_names(&named), vec!["V2", "V1", "Music"]);
    // the last audio / video track cannot go
    let last_audio = track_id(&q, "A1");
    expect_err(
        &q,
        Command::RemoveTrack {
            track_id: last_audio,
        },
        ErrorCode::Conflict,
        None,
    );
    let v2 = track_id(&p, "V2");
    let one_video = run(&p, Command::RemoveTrack { track_id: v2 });
    expect_err(
        &one_video,
        Command::RemoveTrack {
            track_id: track_id(&p, "V1"),
        },
        ErrorCode::Conflict,
        None,
    );
    // caption tracks can always be removed
    let caps = run(
        &p,
        Command::AddTrack {
            kind: TrackKind::Caption,
            name: None,
        },
    );
    let q = run(
        &caps,
        Command::RemoveTrack {
            track_id: track_id(&caps, "C1"),
        },
    );
    assert_eq!(track_names(&q), track_names(&p));
    expect_err(
        &p,
        Command::RemoveTrack {
            track_id: "ghost".into(),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &lock(&p, "A1"),
        Command::RemoveTrack { track_id: a1 },
        ErrorCode::TrackLocked,
        None,
    );
}

#[test]
fn track_flags_and_gain() {
    let p = project();
    let a1 = track_id(&p, "A1");
    let q = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "name": " Dialogue ", "muted": true, "solo": true, "locked": true, "hidden": true, "gain_db": -4.5}),
    );
    let t = q.track(&a1).unwrap();
    assert_eq!(
        (
            t.name.as_str(),
            t.muted,
            t.solo,
            t.locked,
            t.hidden,
            t.gain_db
        ),
        ("Dialogue", true, true, true, true, -4.5)
    );
    // a locked track can still be unlocked
    let q = run_json(
        &q,
        json!({"type": "update_track", "track_id": a1, "locked": false}),
    );
    assert!(!q.track(&a1).unwrap().locked);
    assert!(q.track(&a1).unwrap().muted, "other flags are untouched");
    for (v, field) in [
        (json!({"gain_db": 20.0}), "gain_db"),
        (json!({"gain_db": -80.0}), "gain_db"),
        (json!({"name": ""}), "name"),
    ] {
        let mut c = v;
        c["type"] = json!("update_track");
        c["track_id"] = json!(a1);
        expect_err(&p, cmd(c), ErrorCode::InvalidArgument, Some(field));
    }
    expect_err(
        &p,
        cmd(json!({"type": "update_track", "track_id": "ghost", "muted": true})),
        ErrorCode::NotFound,
        None,
    );
}

#[test]
fn reordering_tracks_changes_stacking_but_not_clips() {
    let (p, ids) = add(&project(), "mute", Some(0));
    let (v1, v2) = (track_id(&p, "V1"), track_id(&p, "V2"));
    let ids_in_order = |p: &Project| p.tracks.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    let (a1, a2) = (track_id(&p, "A1"), track_id(&p, "A2"));
    let q = run(
        &p,
        Command::MoveTrack {
            track_id: v1.clone(),
            ordinal: 1,
        },
    );
    assert_eq!(
        ids_in_order(&q),
        vec![v1.clone(), v2.clone(), a1.clone(), a2.clone()],
        "the old V1 is now the upper video track"
    );
    assert_eq!(
        track_names(&q),
        vec!["V2", "V1", "A1", "A2"],
        "automatic names are renumbered to match the new order"
    );
    assert_eq!(q.track_ordinal(&v1), Some(1));
    assert_eq!(q.track_ordinal(&v2), Some(0));
    assert_eq!(q.clips[&ids[0]].track_id, v1);
    let q = run(
        &p,
        Command::MoveTrack {
            track_id: a1.clone(),
            ordinal: 1,
        },
    );
    assert_eq!(
        ids_in_order(&q),
        vec![v2.clone(), v1.clone(), a2.clone(), a1.clone()]
    );
    assert_eq!(track_names(&q), vec!["V2", "V1", "A1", "A2"]);
    // user-chosen names travel with their track
    let named = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "name": "Dialogue"}),
    );
    let q = run(
        &named,
        Command::MoveTrack {
            track_id: a1.clone(),
            ordinal: 1,
        },
    );
    assert_eq!(track_names(&q), vec!["V2", "V1", "A1", "Dialogue"]);
    // three tracks: move the top one to the bottom
    let p3 = run(
        &p,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: None,
        },
    );
    let v3 = track_id(&p3, "V3");
    let q = run(
        &p3,
        Command::MoveTrack {
            track_id: v3.clone(),
            ordinal: 0,
        },
    );
    assert_eq!(
        ids_in_order(&q),
        vec![v2.clone(), v1.clone(), v3, a1.clone(), a2]
    );
    assert_eq!(track_names(&q), vec!["V3", "V2", "V1", "A1", "A2"]);
    expect_err(
        &p,
        Command::MoveTrack {
            track_id: v1,
            ordinal: 2,
        },
        ErrorCode::InvalidArgument,
        Some("ordinal"),
    );
    expect_err(
        &p,
        Command::MoveTrack {
            track_id: "ghost".into(),
            ordinal: 0,
        },
        ErrorCode::NotFound,
        None,
    );
}

// ---------------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------------

#[test]
fn markers_are_kept_sorted_and_validated() {
    let p = project();
    let q = run(
        &p,
        Command::AddMarker {
            time: tl(90),
            label: " Intro ".into(),
            color: None,
        },
    );
    let q = run(
        &q,
        Command::AddMarker {
            time: tl(30),
            label: String::new(),
            color: Some("#FF0000".into()),
        },
    );
    let q = run(
        &q,
        Command::AddMarker {
            time: cutline_core::TimelineTime(fr(60) + 9),
            label: "mid".into(),
            color: None,
        },
    );
    assert_eq!(
        q.markers
            .iter()
            .map(|m| frames(m.time.0))
            .collect::<Vec<_>>(),
        vec![30, 60, 90]
    );
    assert_eq!(q.markers[0].color, "#ff0000");
    assert_eq!(q.markers[2].label, "Intro");
    let id = q.markers[2].id.clone();
    let q2 = run(
        &q,
        Command::UpdateMarker {
            marker_id: id.clone(),
            time: Some(tl(10)),
            label: Some("Start".into()),
            color: Some("#00ff00".into()),
        },
    );
    assert_eq!(q2.markers[0].id, id);
    assert_eq!(
        (q2.markers[0].label.as_str(), q2.markers[0].color.as_str()),
        ("Start", "#00ff00")
    );
    let q3 = run(
        &q2,
        Command::RemoveMarker {
            marker_id: id.clone(),
        },
    );
    assert_eq!(q3.markers.len(), 2);
    expect_err(
        &q3,
        Command::RemoveMarker {
            marker_id: id.clone(),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &q3,
        Command::UpdateMarker {
            marker_id: id,
            time: None,
            label: Some("x".into()),
            color: None,
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        Command::AddMarker {
            time: tl(-1),
            label: String::new(),
            color: None,
        },
        ErrorCode::InvalidArgument,
        Some("time"),
    );
    expect_err(
        &p,
        Command::AddMarker {
            time: tl(0),
            label: "x".repeat(81),
            color: None,
        },
        ErrorCode::InvalidArgument,
        Some("label"),
    );
    expect_err(
        &p,
        Command::AddMarker {
            time: tl(0),
            label: String::new(),
            color: Some("red".into()),
        },
        ErrorCode::InvalidArgument,
        Some("color"),
    );
}

// ---------------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------------

fn settings(v: Value) -> Command {
    let mut c = v;
    c["type"] = json!("update_settings");
    cmd(c)
}

#[test]
fn resolution_and_frame_rate_limits() {
    let p = project();
    let q = run(
        &p,
        settings(json!({"width": 3840, "height": 2160, "fps": {"num": 60, "den": 1}})),
    );
    assert_eq!(
        (q.settings.width, q.settings.height, q.settings.fps),
        (3840, 2160, FrameRate::FPS_60)
    );
    assert!(try_run(&p, settings(json!({"width": 4096, "height": 2160}))).is_ok());
    assert!(
        try_run(&p, settings(json!({"width": 1080, "height": 1920}))).is_ok(),
        "vertical video"
    );
    assert!(try_run(&p, settings(json!({"fps": {"num": 60000, "den": 1001}}))).is_ok());
    assert!(try_run(&p, settings(json!({"fps": {"num": 24000, "den": 1001}}))).is_ok());
    // unreduced rates are normalised
    assert_eq!(
        run(&p, settings(json!({"fps": {"num": 50, "den": 2}})))
            .settings
            .fps,
        FrameRate::FPS_25
    );
    for (v, field) in [
        (json!({"width": 1921}), "width"),
        (json!({"width": 4098}), "width"),
        (json!({"width": 14}), "width"),
        (json!({"height": 1081}), "height"),
        (json!({"height": 5000}), "height"),
        (json!({"fps": {"num": 61, "den": 1}}), "fps"),
        (json!({"fps": {"num": 120, "den": 1}}), "fps"),
        (json!({"fps": {"num": 0, "den": 1}}), "fps"),
        (json!({"fps": {"num": 30, "den": 0}}), "fps"),
        (json!({"background": "black"}), "background"),
        (json!({"background": "#00000000"}), "background"),
    ] {
        expect_err(&p, settings(v), ErrorCode::InvalidArgument, Some(field));
    }
    assert_eq!(
        run(&p, settings(json!({"background": "#1A2B3C"})))
            .settings
            .background,
        "#1a2b3c"
    );
}

#[test]
fn caption_style_is_a_validated_project_setting() {
    let p = project();
    let mut style = CaptionStyle::default();
    style.text.font_size = 0.06;
    style.text.color = "#ffee00".into();
    style.y = -0.3;
    let q = run(
        &p,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: None,
            background: None,
            caption_style: Some(style.clone()),
        },
    );
    assert_eq!(q.settings.caption_style, style);
    let mut bad = style.clone();
    bad.y = 0.9;
    expect_err(
        &p,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: None,
            background: None,
            caption_style: Some(bad),
        },
        ErrorCode::InvalidArgument,
        Some("caption_style.y"),
    );
    let mut bad = style;
    bad.text.font_size = 2.0;
    expect_err(
        &p,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: None,
            background: None,
            caption_style: Some(bad),
        },
        ErrorCode::InvalidArgument,
        Some("font_size"),
    );
}

#[test]
fn changing_the_frame_rate_conforms_every_edit_point_to_the_new_grid() {
    // clips at awkward 30 fps frames: 0..7, 7..15, 15..31, plus a linked pair and a marker
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(7));
    let (p, _) = add_range(&p, "mute", Some(7), Some(0), Some(8));
    let (p, _) = add_range(&p, "mute", Some(15), Some(0), Some(16));
    let v2 = track_id(&p, "V2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(tl(3)),
            track_id: Some(v2),
            source_in: None,
            source_out: Some(src(101)),
            mode: PlaceMode::Overwrite,
        },
    );
    let p = run(
        &p,
        Command::AddMarker {
            time: tl(13),
            label: String::new(),
            color: None,
        },
    );
    let p = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: a.clone(),
            kind: TransitionKind::CrossDissolve,
            duration: fr(6),
        },
    );
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [a[0]], "patch": {"fade_in": fr(3)}}),
    );

    for target in [
        FrameRate::FPS_24,
        FrameRate::FPS_25,
        FrameRate::FPS_29_97,
        FrameRate::FPS_60,
        FrameRate::FPS_23_976,
    ] {
        let q = run(
            &p,
            Command::UpdateSettings {
                width: None,
                height: None,
                fps: Some(target),
                background: None,
                caption_style: None,
            },
        );
        let f = |t: i64| target.ticks_to_frame_floor(t);
        for c in q.clips.values() {
            assert!(
                target.is_aligned(c.start.0) && target.is_aligned(c.duration),
                "{target:?}: clip {} off grid",
                c.id
            );
            assert!(target.is_aligned(c.fade_in) && target.is_aligned(c.fade_out));
        }
        let v1 = q.track_clips(&track_id(&q, "V1"));
        assert_eq!(v1.len(), 3);
        assert_eq!(v1[0].start.0, 0);
        assert_eq!(
            v1[0].end(),
            v1[1].start,
            "{target:?}: adjacent clips stay adjacent"
        );
        assert_eq!(v1[1].end(), v1[2].start);
        // each boundary is the nearest new frame to the old position
        for (clip, old_end) in v1.iter().zip([7, 15, 31]) {
            assert_eq!(clip.end().0, target.snap(fr(old_end)));
        }
        // linked pair stays identical on both tracks
        let (lv, la) = (
            q.track_clips(&track_id(&q, "V2"))[0],
            q.track_clips(&track_id(&q, "A2"))[0],
        );
        assert_eq!((lv.start, lv.duration), (la.start, la.duration));
        assert!(target.is_aligned(q.markers[0].time.0));
        for t in q.transitions.values() {
            assert!(f(t.duration) % 2 == 0 && t.duration >= 2 * target.frame_ticks());
        }
    }
    // 24 fps exact expectations: 7/30 s → frame 6, 15/30 → 12, 31/30 → 25
    let q = run(
        &p,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: Some(FrameRate::FPS_24),
            background: None,
            caption_style: None,
        },
    );
    let ends: Vec<i64> = q
        .track_clips(&track_id(&q, "V1"))
        .iter()
        .map(|c| FrameRate::FPS_24.ticks_to_frame_floor(c.end().0))
        .collect();
    assert_eq!(ends, vec![6, 12, 25]);
}

#[test]
fn frame_rate_change_that_would_collapse_clips_is_refused_cleanly() {
    let p = run(
        &project(),
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: Some(FrameRate::FPS_60),
            background: None,
            caption_style: None,
        },
    );
    let f60 = FrameRate::FPS_60;
    // two one-frame clips back to back at 60 fps
    let add_at = |p: &Project, frame: i64| {
        run(
            p,
            Command::AddAssetClips {
                asset_id: "mute".into(),
                start: Some(cutline_core::TimelineTime(f60.frame_to_ticks(frame))),
                track_id: None,
                source_in: Some(cutline_core::SourceTime(0)),
                source_out: Some(cutline_core::SourceTime(f60.frame_to_ticks(1))),
                mode: PlaceMode::Overwrite,
            },
        )
    };
    let p = add_at(&add_at(&p, 0), 1);
    assert_eq!(p.clips.len(), 2);
    let e = expect_err(
        &p,
        Command::UpdateSettings {
            width: None,
            height: None,
            fps: Some(FrameRate::FPS_24),
            background: None,
            caption_style: None,
        },
        ErrorCode::Conflict,
        None,
    );
    assert!(e.message.contains("frame"));
}

// ---------------------------------------------------------------------------------
// RemoveAsset
// ---------------------------------------------------------------------------------

#[test]
fn removing_an_asset_removes_its_clips_everywhere() {
    let (p, _) = add(&project(), "vid", Some(0));
    let (p, other) = add(&p, "mute", None);
    let (p, _) = add_range(&p, "vid", None, Some(0), Some(50));
    let mut p = p;
    p.transcript
        .corrections
        .entry("vid".into())
        .or_default()
        .insert(3, "fixed".into());
    p.transcript
        .speaker_names
        .entry("vid".into())
        .or_default()
        .insert("1".into(), "Ann".into());
    let q = run(
        &p,
        Command::RemoveAsset {
            asset_id: "vid".into(),
        },
    );
    assert!(!q.assets.contains_key("vid"));
    assert_eq!(q.clips.len(), 1);
    assert!(q.clips.contains_key(&other[0]));
    assert_eq!(
        q.clips[&other[0]].start,
        tl(1800),
        "lift semantics: nothing ripples"
    );
    assert!(q.transcript.corrections.is_empty() && q.transcript.speaker_names.is_empty());
    expect_err(
        &p,
        Command::RemoveAsset {
            asset_id: "ghost".into(),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &lock(&p, "A1"),
        Command::RemoveAsset {
            asset_id: "vid".into(),
        },
        ErrorCode::TrackLocked,
        None,
    );
    // an unused asset just leaves the bin
    let q = run(
        &p,
        Command::RemoveAsset {
            asset_id: "img".into(),
        },
    );
    assert_eq!(q.clips.len(), p.clips.len());
}

// ---------------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------------

#[test]
fn batch_applies_steps_in_order_as_one_edit() {
    let p = project();
    let res = try_run(
        &p,
        cmd(json!({"type": "batch", "label": "Assemble", "commands": [
            {"type": "add_asset_clips", "asset_id": "mute", "start": 0},
            {"type": "split_clips", "at": fr(300)},
            {"type": "add_marker", "time": fr(300), "label": "cut"}
        ]})),
    )
    .unwrap();
    assert_eq!(res.label, "Assemble");
    assert_eq!(spans(&res.project, "V1"), vec![(0, 300), (300, 600)]);
    assert_eq!(res.project.markers.len(), 1);
    assert_eq!(
        res.project.revision,
        p.revision + 1,
        "a batch is a single revision"
    );
    assert_eq!(
        res.created.len(),
        2,
        "the added clip and the split's right half"
    );
    // default labels
    let one = try_run(
        &p,
        cmd(json!({"type": "batch", "commands": [{"type": "add_marker", "time": 0}]})),
    )
    .unwrap();
    assert_eq!(one.label, "Add marker");
    let two = try_run(&p, cmd(json!({"type": "batch", "commands": [{"type": "add_marker", "time": 0}, {"type": "add_marker", "time": fr(5)}]}))).unwrap();
    assert_eq!(two.label, "2 edits");
}

#[test]
fn batch_is_atomic_and_cannot_be_nested() {
    let (p, ids) = add(&project(), "mute", Some(0));
    let failing = cmd(json!({"type": "batch", "commands": [
        {"type": "split_clips", "at": fr(300)},
        {"type": "delete_clips", "clip_ids": [ids[0]], "ripple": true},
        {"type": "delete_clips", "clip_ids": ["ghost"]}
    ]}));
    let e = expect_err(&p, failing, ErrorCode::NotFound, None);
    assert!(
        e.message.contains("Step 3"),
        "the failing step is named: {}",
        e.message
    );
    // (expect_err already asserted that `p` is untouched)
    assert_eq!(spans(&p, "V1"), vec![(0, 600)]);
    expect_err(
        &p,
        cmd(json!({"type": "batch", "commands": []})),
        ErrorCode::InvalidArgument,
        Some("commands"),
    );
    expect_err(
        &p,
        cmd(
            json!({"type": "batch", "commands": [{"type": "batch", "commands": [{"type": "add_marker", "time": 0}]}]}),
        ),
        ErrorCode::InvalidArgument,
        Some("commands"),
    );
    let many: Vec<Value> = (0..2001)
        .map(|i| json!({"type": "add_marker", "time": fr(i)}))
        .collect();
    expect_err(
        &p,
        cmd(json!({"type": "batch", "commands": many})),
        ErrorCode::InvalidArgument,
        Some("commands"),
    );
}

// ---------------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------------

fn rejects(v: Value) {
    assert!(
        serde_json::from_value::<Command>(v.clone()).is_err(),
        "should not deserialise: {v}"
    );
}

#[test]
fn malformed_commands_are_rejected_at_the_boundary() {
    rejects(json!({"type": "explode_timeline"}));
    rejects(json!({"at": 100}));
    rejects(json!("split_clips"));
    rejects(json!(null));
    // unknown fields
    rejects(json!({"type": "split_clips", "at": 100, "bogus": true}));
    rejects(json!({"type": "delete_clips", "clip_ids": ["c1"], "riple": true}));
    rejects(json!({"type": "update_clips", "clip_ids": ["c1"], "patch": {"colour": "#fff"}}));
    rejects(
        json!({"type": "move_clips", "moves": [{"clip_id": "c1", "start": 0, "track_id": "t1", "extra": 1}]}),
    );
    rejects(
        json!({"type": "ripple_delete_source", "reason": "manual", "cuts": [{"clip_id": "c1", "source_start": 0, "source_end": 5, "word": 3}]}),
    );
    rejects(json!({"type": "generate_captions", "options": {"max_lines": 2, "font": "x"}}));
    // missing required fields
    rejects(json!({"type": "split_clips"}));
    rejects(json!({"type": "delete_clips"}));
    rejects(json!({"type": "trim_clips", "clip_ids": ["c1"], "delta": 10}));
    rejects(json!({"type": "add_transitions", "left_clip_ids": ["c1"], "duration": 10}));
    // wrong types
    rejects(json!({"type": "split_clips", "at": "soon"}));
    rejects(json!({"type": "split_clips", "at": 1.5}));
    rejects(json!({"type": "delete_clips", "clip_ids": "c1"}));
    rejects(json!({"type": "delete_clips", "clip_ids": [1, 2]}));
    rejects(json!({"type": "delete_clips", "clip_ids": ["c1"], "ripple": "yes"}));
    rejects(json!({"type": "trim_clips", "clip_ids": ["c1"], "edge": "middle", "delta": 10}));
    rejects(json!({"type": "add_track", "kind": "subtitle"}));
    rejects(
        json!({"type": "add_transitions", "left_clip_ids": ["c1"], "kind": "star_wipe", "duration": 10}),
    );
    rejects(json!({"type": "update_settings", "width": -1920}));
    rejects(json!({"type": "update_settings", "fps": 30}));
    rejects(json!({"type": "set_speed", "clip_ids": ["c1"], "speed": "fast"}));
    rejects(json!({"type": "correct_word", "asset_id": "a", "word_index": -1}));
    rejects(json!({"type": "ripple_delete_source", "cuts": [], "reason": "because"}));
    rejects(json!({"type": "update_clips", "clip_ids": ["c1"], "patch": {"opacity": "half"}}));
    rejects(json!({"type": "update_clips", "clip_ids": ["c1"], "patch": {"align": "justify"}}));
}

#[test]
fn defaults_and_optional_fields_on_the_wire() {
    assert_eq!(
        cmd(json!({"type": "delete_clips", "clip_ids": ["c1"]})),
        Command::DeleteClips {
            clip_ids: vec!["c1".into()],
            ripple: false
        }
    );
    assert_eq!(
        cmd(json!({"type": "set_speed", "clip_ids": ["c1"], "speed": 2})),
        Command::SetSpeed {
            clip_ids: vec!["c1".into()],
            speed: 2.0,
            ripple: true
        }
    );
    assert_eq!(
        cmd(json!({"type": "split_clips", "at": 10})),
        Command::SplitClips {
            at: cutline_core::TimelineTime(10),
            clip_ids: None
        }
    );
    assert_eq!(
        cmd(json!({"type": "add_asset_clips", "asset_id": "a"})),
        Command::AddAssetClips {
            asset_id: "a".into(),
            start: None,
            track_id: None,
            source_in: None,
            source_out: None,
            mode: PlaceMode::Overwrite
        }
    );
    assert_eq!(
        cmd(json!({"type": "move_clips", "moves": [], "mode": "insert"})),
        Command::MoveClips {
            moves: vec![],
            mode: PlaceMode::Insert
        }
    );
    // explicit null and absence differ for clearable fields
    let with_null: ClipPatch =
        serde_json::from_value(json!({"background": null, "speaker": null})).unwrap();
    assert_eq!(with_null.background, Some(None));
    assert_eq!(with_null.speaker, Some(None));
    let absent: ClipPatch = serde_json::from_value(json!({})).unwrap();
    assert_eq!(absent.background, None);
    assert_eq!(absent, ClipPatch::default());
}

#[test]
fn commands_round_trip_through_json() {
    let samples = vec![
        json!({"type": "update_settings", "width": 1280, "height": 720, "fps": {"num": 30000, "den": 1001}}),
        json!({"type": "add_track", "kind": "caption", "name": "Subs"}),
        json!({"type": "add_asset_clips", "asset_id": "vid", "start": 0, "track_id": "t2", "source_in": 5, "source_out": 50, "mode": "insert"}),
        json!({"type": "append_source_ranges", "asset_id": "vid", "ranges": [{"start": 0, "end": 10}], "at": 4}),
        json!({"type": "add_text", "text": "Hi", "start": 0, "duration": 100}),
        json!({"type": "add_captions", "cues": [{"start": 0, "duration": 10, "text": "x", "speaker": "A", "source": {"asset_id": "vid", "word_start": 0, "word_end": 2}}]}),
        json!({"type": "generate_captions", "options": {"max_chars_per_line": 30, "speaker_labels": true}}),
        json!({"type": "move_clips", "moves": [{"clip_id": "c1", "start": 10, "track_id": "t1"}], "mode": "overwrite"}),
        json!({"type": "trim_clips", "clip_ids": ["c1"], "edge": "start", "delta": -10, "ripple": true}),
        json!({"type": "slip_clips", "clip_ids": ["c1"], "delta": 5}),
        json!({"type": "ripple_delete_range", "start": 0, "end": 10}),
        json!({"type": "close_gap", "track_id": "t1", "at": 10}),
        json!({"type": "update_clips", "clip_ids": ["c1"], "patch": {"x": 0.5, "background": null, "align": "right"}}),
        json!({"type": "add_transitions", "left_clip_ids": ["c1"], "kind": "dip_to_black", "duration": 20}),
        json!({"type": "update_transition", "transition_id": "x1", "kind": "cross_dissolve"}),
        json!({"type": "correct_word", "asset_id": "vid", "word_index": 3, "text": "fixed"}),
        json!({"type": "rename_speaker", "asset_id": "vid", "speaker": "1", "name": "Ann"}),
        json!({"type": "ripple_delete_source", "reason": "filler", "cuts": [{"clip_id": "c1", "source_start": 1, "source_end": 2, "text": "um"}]}),
        json!({"type": "heal_cuts", "left_clip_ids": ["c1"]}),
        json!({"type": "set_transcript_editing", "enabled": true}),
        json!({"type": "batch", "commands": [{"type": "remove_marker", "marker_id": "m1"}], "label": "x"}),
    ];
    for v in samples {
        let c = cmd(v.clone());
        let again: Command = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(c, again, "round trip changed {v}");
    }
}

#[test]
fn error_payload_shape_is_stable() {
    let p = project();
    let e = expect_err(
        &p,
        Command::AddText {
            text: String::new(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], "invalid_argument");
    assert_eq!(v["field"], "text");
    assert!(v["message"].is_string());
    let e = expect_err(
        &p,
        Command::DeleteClips {
            clip_ids: vec!["ghost".into()],
            ripple: false,
        },
        ErrorCode::NotFound,
        None,
    );
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], "not_found");
    assert!(v.get("field").is_none(), "absent fields are omitted");
    let s: &'static str = ErrorCode::StaleRevision.into();
    assert_eq!(s, "stale_revision");
}
