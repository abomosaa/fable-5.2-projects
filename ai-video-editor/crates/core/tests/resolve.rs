//! Resolved layers: transition and fade semantics shared by preview and export.

mod common;
use common::*;
use cutline_core::commands::{Command, CueDraft, PlaceMode};
use cutline_core::model::*;
use cutline_core::resolve::*;
use cutline_core::time::{SourceTime, Speed};
use serde_json::json;

fn layer<'a>(layers: &'a [Layer], id: &ClipId) -> &'a Layer {
    layers
        .iter()
        .find(|l| &l.clip_id == id)
        .unwrap_or_else(|| panic!("no layer for {id}"))
}

fn ramp(a: i64, b: i64) -> Option<Ramp> {
    Some(Ramp {
        start: tl(a),
        end: tl(b),
    })
}

/// Two linked pairs meeting at frame 300: X shows source 100..400, Y shows 600..900.
fn two_pairs() -> (Project, Vec<ClipId>, Vec<ClipId>) {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(100), Some(400));
    let (p, y) = add_range(&p, "vid", Some(300), Some(600), Some(900));
    (p, x, y)
}

fn with_transition(p: &Project, left: &[ClipId], kind: TransitionKind, frames: i64) -> Project {
    run(
        p,
        Command::AddTransitions {
            left_clip_ids: left.to_vec(),
            kind,
            duration: fr(frames),
        },
    )
}

#[test]
fn plain_clips_resolve_to_their_own_extent() {
    let (p, x, y) = two_pairs();
    let layers = resolve_layers(&p);
    assert_eq!(layers.len(), 4);
    let l = layer(&layers, &x[0]);
    assert_eq!(
        (l.start, l.end, l.source_start, l.speed),
        (tl(0), tl(300), src(100), Speed::NORMAL)
    );
    assert_eq!(l.track_id, track_id(&p, "V1"));
    assert!(l.active);
    assert!(
        l.fade_in.is_none()
            && l.fade_out.is_none()
            && l.slide_in.is_none()
            && l.slide_out.is_none()
    );
    assert_eq!(l.gain, 1.0);
    assert_eq!(l.envelope(tl(0)), 1.0);
    assert_eq!(l.envelope(tl(150)), 1.0);
    assert_eq!(l.offset_x(tl(150)), 0.0);
    assert_eq!(l.source_time_at(tl(120)), src(220));
    let l = layer(&layers, &y[1]);
    assert_eq!(
        (l.start, l.end, l.source_start),
        (tl(300), tl(600), src(600))
    );
}

#[test]
fn clip_fades_become_ramps_at_the_clip_edges() {
    let (p, x, _y) = two_pairs();
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": x, "patch": {"fade_in": fr(30), "fade_out": fr(60)}}),
    );
    let layers = resolve_layers(&p);
    for id in &x {
        let l = layer(&layers, id);
        assert_eq!(l.fade_in, ramp(0, 30));
        assert_eq!(l.fade_out, ramp(240, 300));
        assert_eq!(
            (l.start, l.end),
            (tl(0), tl(300)),
            "fades do not change the extent"
        );
        assert_eq!(l.envelope(tl(0)), 0.0);
        assert_eq!(l.envelope(tl(15)), 0.5);
        assert_eq!(l.envelope(tl(30)), 1.0);
        assert_eq!(l.envelope(tl(200)), 1.0);
        assert_eq!(l.envelope(tl(270)), 0.5);
        assert_eq!(l.envelope(tl(300)), 0.0);
    }
    // overlapping fades multiply
    let short = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [x[0]], "patch": {"fade_in": fr(200), "fade_out": fr(100)}}),
    );
    let layers = resolve_layers(&short);
    let l = layer(&layers, &x[0]);
    assert_eq!((l.fade_in, l.fade_out), (ramp(0, 200), ramp(200, 300)));
    assert_eq!(l.envelope(tl(100)), 0.5);
    assert_eq!(l.envelope(tl(250)), 0.5);
}

#[test]
fn cross_dissolve_extends_both_clips_into_their_handles() {
    let (p, x, y) = two_pairs();
    let p = with_transition(&p, &x, TransitionKind::CrossDissolve, 40);
    let layers = resolve_layers(&p);
    // picture: outgoing stays opaque underneath, incoming fades in on top
    let (out_v, in_v) = (layer(&layers, &x[0]), layer(&layers, &y[0]));
    assert_eq!((out_v.start, out_v.end), (tl(0), tl(320)));
    assert!(out_v.fade_out.is_none() && out_v.fade_in.is_none());
    assert_eq!(out_v.source_start, src(100));
    assert_eq!(
        out_v.source_time_at(tl(320)),
        src(420),
        "plays 20 frames of handle past its out point"
    );
    assert_eq!((in_v.start, in_v.end), (tl(280), tl(600)));
    assert_eq!(in_v.fade_in, ramp(280, 320));
    assert_eq!(
        in_v.source_start,
        src(580),
        "starts 20 frames before its in point"
    );
    assert_eq!(
        in_v.source_time_at(tl(300)),
        src(600),
        "still shows its in point exactly on the cut"
    );
    assert!(
        cutline_core::resolve::paint_order(out_v, in_v).is_lt(),
        "the incoming clip is painted over the outgoing one"
    );
    assert_eq!(in_v.envelope(tl(280)), 0.0);
    assert_eq!(in_v.envelope(tl(300)), 0.5);
    assert_eq!(in_v.envelope(tl(320)), 1.0);
    assert_eq!(out_v.envelope(tl(310)), 1.0);
    // sound: a real crossfade
    let (out_a, in_a) = (layer(&layers, &x[1]), layer(&layers, &y[1]));
    assert_eq!((out_a.start, out_a.end), (tl(0), tl(320)));
    assert_eq!(out_a.fade_out, ramp(280, 320));
    assert_eq!((in_a.start, in_a.end), (tl(280), tl(600)));
    assert_eq!(in_a.fade_in, ramp(280, 320));
    for t in [280, 290, 300, 310, 320] {
        let sum = out_a.envelope(tl(t)) + in_a.envelope(tl(t));
        assert!(
            (sum - 1.0).abs() < 1e-12,
            "linear crossfade sums to unity at frame {t}"
        );
    }
    // clips not involved are unaffected
    let untouched = resolve_layers(&two_pairs().0);
    assert_eq!(layer(&layers, &y[1]).end, layer(&untouched, &y[1]).end);
}

#[test]
fn handles_may_run_outside_the_media_and_are_left_for_consumers_to_clamp() {
    // full clips have no handles: the incoming layer starts before source 0
    let (p, a) = add(&project(), "vid2", Some(0)); // 0..900, source 0..900 (all of it)
    let (p, b) = add(&p, "vid2", None);
    let p = with_transition(&p, &[a[0].clone()], TransitionKind::CrossDissolve, 20);
    let layers = resolve_layers(&p);
    assert_eq!(layer(&layers, &b[0]).source_start, SourceTime(-fr(10)));
    assert_eq!(
        layer(&layers, &a[0]).source_time_at(tl(910)),
        src(910),
        "10 frames past the 900-frame media"
    );
}

#[test]
fn dip_to_black_fades_each_side_within_its_own_clip() {
    let (p, x, y) = two_pairs();
    let p = with_transition(&p, &[x[0].clone()], TransitionKind::DipToBlack, 40);
    let layers = resolve_layers(&p);
    let (o, i) = (layer(&layers, &x[0]), layer(&layers, &y[0]));
    assert_eq!((o.start, o.end), (tl(0), tl(300)), "no handles needed");
    assert_eq!((i.start, i.end), (tl(300), tl(600)));
    assert_eq!(o.fade_out, ramp(280, 300));
    assert_eq!(i.fade_in, ramp(300, 320));
    assert_eq!(o.envelope(tl(290)), 0.5);
    assert_eq!(o.envelope(tl(300)), 0.0);
    assert_eq!(i.envelope(tl(300)), 0.0);
    assert_eq!(i.envelope(tl(310)), 0.5);
    assert!(o.slide_out.is_none() && i.slide_in.is_none());
}

#[test]
fn slide_and_push_move_layers_horizontally() {
    let (p, x, y) = two_pairs();
    let slide = with_transition(&p, &[x[0].clone()], TransitionKind::Slide, 40);
    let layers = resolve_layers(&slide);
    let (o, i) = (layer(&layers, &x[0]), layer(&layers, &y[0]));
    assert_eq!((o.start, o.end), (tl(0), tl(320)));
    assert_eq!((i.start, i.end), (tl(280), tl(600)));
    assert!(
        o.slide_out.is_none() && o.fade_out.is_none(),
        "the outgoing clip just sits there"
    );
    assert_eq!(
        i.slide_in,
        Some(Slide {
            start: tl(280),
            end: tl(320),
            dx: 1.0
        })
    );
    assert!(i.fade_in.is_none());
    assert_eq!(i.offset_x(tl(280)), 1.0);
    assert_eq!(i.offset_x(tl(300)), 0.5);
    assert_eq!(i.offset_x(tl(320)), 0.0);
    assert_eq!(i.offset_x(tl(500)), 0.0);
    assert_eq!(
        i.envelope(tl(281)),
        1.0,
        "a slide is fully opaque throughout"
    );

    let push = with_transition(&p, &[x[0].clone()], TransitionKind::Push, 40);
    let layers = resolve_layers(&push);
    let (o, i) = (layer(&layers, &x[0]), layer(&layers, &y[0]));
    assert_eq!(
        o.slide_out,
        Some(Slide {
            start: tl(280),
            end: tl(320),
            dx: -1.0
        })
    );
    assert_eq!(
        i.slide_in,
        Some(Slide {
            start: tl(280),
            end: tl(320),
            dx: 1.0
        })
    );
    assert_eq!(o.offset_x(tl(280)), 0.0);
    assert_eq!(o.offset_x(tl(300)), -0.5);
    assert_eq!(o.offset_x(tl(320)), -1.0);
    // the two pictures stay edge to edge: exactly one frame width apart
    for t in [280, 285, 300, 319, 320] {
        assert!((i.offset_x(tl(t)) - o.offset_x(tl(t)) - 1.0).abs() < 1e-12);
    }
}

#[test]
fn a_transition_replaces_the_clip_fade_on_its_side_only() {
    let (p, x, y) = two_pairs();
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [x[0], y[0]], "patch": {"fade_in": fr(10), "fade_out": fr(10)}}),
    );
    for kind in [
        TransitionKind::CrossDissolve,
        TransitionKind::DipToBlack,
        TransitionKind::Slide,
        TransitionKind::Push,
    ] {
        let q = with_transition(&p, &[x[0].clone()], kind, 40);
        let layers = resolve_layers(&q);
        let (o, i) = (layer(&layers, &x[0]), layer(&layers, &y[0]));
        assert_eq!(
            o.fade_in,
            ramp(0, 10),
            "{kind:?}: the far side keeps its own fade"
        );
        assert_eq!(i.fade_out, ramp(590, 600), "{kind:?}");
        match kind {
            TransitionKind::CrossDissolve => {
                assert_eq!(o.fade_out, None);
                assert_eq!(i.fade_in, ramp(280, 320));
            }
            TransitionKind::DipToBlack => {
                assert_eq!(o.fade_out, ramp(280, 300));
                assert_eq!(i.fade_in, ramp(300, 320));
            }
            TransitionKind::Slide | TransitionKind::Push => {
                assert_eq!(o.fade_out, None);
                assert_eq!(i.fade_in, None);
            }
        }
    }
}

#[test]
fn a_clip_can_have_a_transition_on_each_side() {
    let (p, x) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, y) = add_range(&p, "mute", Some(100), Some(200), Some(300));
    let (p, z) = add_range(&p, "mute", Some(200), Some(400), Some(500));
    let p = with_transition(&p, &[x[0].clone()], TransitionKind::CrossDissolve, 20);
    let p = with_transition(&p, &[y[0].clone()], TransitionKind::Push, 40);
    let layers = resolve_layers(&p);
    let m = layer(&layers, &y[0]);
    assert_eq!((m.start, m.end), (tl(90), tl(220)));
    assert_eq!(m.fade_in, ramp(90, 110));
    assert_eq!(
        m.slide_out,
        Some(Slide {
            start: tl(180),
            end: tl(220),
            dx: -1.0
        })
    );
    assert_eq!(m.source_start, src(190));
    assert_eq!(
        layer(&layers, &z[0]).slide_in,
        Some(Slide {
            start: tl(180),
            end: tl(220),
            dx: 1.0
        })
    );
}

#[test]
fn speed_scales_how_much_source_a_handle_consumes() {
    let (p, x, y) = two_pairs();
    let p = run(
        &p,
        Command::SetSpeed {
            clip_ids: y.clone(),
            speed: 2.0,
            ripple: true,
        },
    );
    let p = with_transition(&p, &[x[0].clone()], TransitionKind::CrossDissolve, 40);
    let layers = resolve_layers(&p);
    let i = layer(&layers, &y[0]);
    assert_eq!(i.speed, Speed::new(2, 1).unwrap());
    assert_eq!((i.start, i.end), (tl(280), tl(450)));
    assert_eq!(
        i.source_start,
        src(560),
        "20 output frames of handle are 40 source frames at 2×"
    );
    assert_eq!(i.source_time_at(tl(300)), src(600));
    assert_eq!(i.source_time_at(tl(450)), src(900));
}

#[test]
fn paint_order_is_v1_then_higher_video_tracks_then_captions() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let p = run(
        &p,
        Command::AddText {
            text: "Title".into(),
            start: tl(10),
            duration: Some(fr(50)),
            track_id: None,
        },
    ); // V2
    let (p, later) = add_range(&p, "mute", Some(1800), Some(0), Some(100)); // V1, after the first clip
    let p = run(
        &p,
        Command::AddCaptions {
            cues: vec![CueDraft {
                start: tl(0),
                duration: fr(30),
                text: "cap".into(),
                speaker: None,
                source: None,
            }],
            track_id: None,
        },
    );
    let v3 = run(
        &p,
        Command::AddTrack {
            kind: TrackKind::Video,
            name: None,
        },
    );
    let v3_id = track_id(&v3, "V3");
    let p = run(
        &v3,
        Command::AddAssetClips {
            asset_id: "img".into(),
            start: Some(tl(0)),
            track_id: Some(v3_id),
            source_in: None,
            source_out: None,
            mode: PlaceMode::Overwrite,
        },
    );
    let layers = resolve_layers(&p);
    assert!(
        layers
            .windows(2)
            .all(|w| cutline_core::resolve::paint_order(&w[0], &w[1]).is_lt()),
        "the list is in paint order"
    );
    let z = |name: &str, idx: usize| layer(&layers, &on(&p, name)[idx].id).z;
    assert!(
        z("A1", 0) < z("V1", 0),
        "audio sorts first (it is not painted)"
    );
    assert_eq!(
        z("V1", 0),
        z("V1", 1),
        "z is the track rank, shared by the clips of a track"
    );
    let pos = |name: &str, idx: usize| {
        layers
            .iter()
            .position(|l| l.clip_id == on(&p, name)[idx].id)
            .unwrap()
    };
    assert!(pos("V1", 0) < pos("V1", 1), "within a track: by time");
    assert!(z("V1", 1) < z("V2", 0));
    assert!(z("V2", 0) < z("V3", 0));
    assert!(z("V3", 0) < z("C1", 0), "captions are always on top");
    assert_eq!(layer(&layers, &pair[0]).track_id, track_id(&p, "V1"));
    let _ = later;
    // stills, text and captions have no source position
    for name in ["V2", "V3", "C1"] {
        assert_eq!(
            layer(&layers, &on(&p, name)[0].id).source_start,
            SourceTime::ZERO
        );
    }
    // reordering tracks changes the paint order
    let (old_v1, old_v2, old_v3) = (
        on(&p, "V1")[0].id.clone(),
        on(&p, "V2")[0].id.clone(),
        on(&p, "V3")[0].id.clone(),
    );
    let swapped = run(
        &p,
        Command::MoveTrack {
            track_id: track_id(&p, "V1"),
            ordinal: 2,
        },
    );
    let layers2 = resolve_layers(&swapped);
    let z2 = |clip: &String| layer(&layers2, clip).z;
    assert!(
        z2(&old_v2) < z2(&old_v3) && z2(&old_v3) < z2(&old_v1),
        "the track moved to the top now paints last"
    );
}

#[test]
fn inactive_layers_are_flagged_not_dropped() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(0)),
            track_id: Some(track_id(&p, "A2")),
            source_in: None,
            source_out: Some(src(300)),
            mode: PlaceMode::Overwrite,
        },
    );
    let music = on(&p, "A2")[0].id.clone();
    let (v1, a1, a2) = (track_id(&p, "V1"), track_id(&p, "A1"), track_id(&p, "A2"));
    let active = |q: &Project| {
        let layers = resolve_layers(q);
        assert_eq!(layers.len(), 3, "every clip always has a layer");
        (
            layer(&layers, &pair[0]).active,
            layer(&layers, &pair[1]).active,
            layer(&layers, &music).active,
        )
    };
    assert_eq!(active(&p), (true, true, true));
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": a1, "muted": true})
        )),
        (true, false, true)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": a2, "solo": true})
        )),
        (true, false, true)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": v1, "hidden": true})
        )),
        (false, true, true)
    );
    // mute beats solo on the same track; "hidden" means nothing for audio, "muted" nothing for video
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": a2, "solo": true, "muted": true})
        )),
        (true, false, false)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": a1, "hidden": true})
        )),
        (true, true, true)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_track", "track_id": v1, "muted": true, "solo": true})
        )),
        (true, true, true)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_clips", "clip_ids": [pair[0]], "patch": {"enabled": false}})
        )),
        (false, true, true)
    );
    assert_eq!(
        active(&run_json(
            &p,
            json!({"type": "update_clips", "clip_ids": [music], "patch": {"enabled": false}})
        )),
        (true, true, false)
    );
}

#[test]
fn audio_gain_combines_clip_and_track_in_decibels() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let a1 = track_id(&p, "A1");
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [pair[1]], "patch": {"gain_db": -6.0}}),
    );
    let layers = resolve_layers(&p);
    assert!((layer(&layers, &pair[1]).gain - 10f64.powf(-6.0 / 20.0)).abs() < 1e-12);
    assert_eq!(
        layer(&layers, &pair[0]).gain,
        1.0,
        "video layers carry unity gain"
    );
    let p = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "gain_db": -6.0}),
    );
    let layers = resolve_layers(&p);
    assert!((layer(&layers, &pair[1]).gain - 10f64.powf(-12.0 / 20.0)).abs() < 1e-12);
    // boost and the silence floor
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [pair[1]], "patch": {"gain_db": 12.0}}),
    );
    assert!((layer(&resolve_layers(&p), &pair[1]).gain - 10f64.powf(6.0 / 20.0)).abs() < 1e-12);
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [pair[1]], "patch": {"gain_db": -60.0}}),
    );
    assert_eq!(
        layer(&resolve_layers(&p), &pair[1]).gain,
        0.0,
        "-60 dB and below is silence"
    );
    assert_eq!(db_to_linear(0.0), 1.0);
    assert_eq!(db_to_linear(-60.0), 0.0);
    assert_eq!(db_to_linear(-1000.0), 0.0);
    assert!((db_to_linear(20.0) - 10.0).abs() < 1e-12);
    assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-12);
}

#[test]
fn ramp_progress_is_clamped_and_linear() {
    let r = Ramp {
        start: tl(10),
        end: tl(30),
    };
    assert_eq!(r.progress(tl(0)), 0.0);
    assert_eq!(r.progress(tl(10)), 0.0);
    assert_eq!(r.progress(tl(15)), 0.25);
    assert_eq!(r.progress(tl(20)), 0.5);
    assert_eq!(r.progress(tl(30)), 1.0);
    assert_eq!(r.progress(tl(99)), 1.0);
    // degenerate ramps do not divide by zero
    let z = Ramp {
        start: tl(10),
        end: tl(10),
    };
    assert_eq!(z.progress(tl(9)), 0.0);
    assert_eq!(z.progress(tl(10)), 0.0);
    assert_eq!(z.progress(tl(11)), 1.0);
}

#[test]
fn layers_serialise_compactly() {
    let (p, x, _y) = two_pairs();
    let layers = resolve_layers(&p);
    let v = serde_json::to_value(layer(&layers, &x[0])).unwrap();
    for absent in ["fade_in", "fade_out", "slide_in", "slide_out"] {
        assert!(
            v.get(absent).is_none(),
            "{absent} should be omitted when unset"
        );
    }
    assert_eq!(v["speed"], json!({"num": 1, "den": 1}));
    assert!(v["start"].is_i64() && v["source_start"].is_i64());
    let p = with_transition(&p, &[x[0].clone()], TransitionKind::Push, 40);
    let layers = resolve_layers(&p);
    let v = serde_json::to_value(layer(&layers, &x[0])).unwrap();
    assert_eq!(v["slide_out"]["dx"], -1.0);
    let back: Layer = serde_json::from_value(v).unwrap();
    assert_eq!(&back, layer(&layers, &x[0]));
}
