//! Filler-word detection, waveform encoding and silence detection.

mod common;
use common::*;
use cutline_core::analysis::*;
use cutline_core::commands::Command;
use cutline_core::model::*;
use cutline_core::time::{SourceTime, TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::Transcript;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

const LOUD: u16 = 30_000;
const QUIET: u16 = 10;

/// 100 peaks per second, loud everywhere except the given `[from, to)` second ranges.
fn wave(seconds: usize, quiet: &[(f64, f64)]) -> Waveform {
    let mut peaks = vec![LOUD; seconds * 100];
    for (a, b) in quiet {
        for p in peaks
            .iter_mut()
            .take((b * 100.0).round() as usize)
            .skip((a * 100.0).round() as usize)
        {
            *p = QUIET;
        }
    }
    Waveform {
        peaks_per_second: 100,
        peaks,
    }
}

fn secs(s: f64) -> SourceTime {
    SourceTime((s * TICKS_PER_SECOND as f64).round() as i64)
}

fn waves(w: Waveform) -> BTreeMap<AssetId, Arc<Waveform>> {
    BTreeMap::from([("vid".to_string(), Arc::new(w))])
}

fn no_transcripts() -> BTreeMap<AssetId, Arc<Transcript>> {
    BTreeMap::new()
}

#[test]
fn hesitation_sounds_are_fillers_regardless_of_case_and_punctuation() {
    for f in [
        "um", "Um", "UM", "um,", "Um.", "\"uh\"", "uh…", "Uhm", "erm", "hmm", "Hmm...", "mm",
        " mhm ", "ah", "Ah!", "(er)", "äh", "ähm",
    ] {
        assert!(is_filler(f), "{f:?} should be a filler");
    }
    for w in [
        "like", "so", "well", "you", "know", "umbrella", "hummus", "a", "I", "the", "summer",
        "ahead", "errand", "um-hum", "", "   ", "...", "—", "5", "uh2",
    ] {
        assert!(!is_filler(w), "{w:?} must not be flagged");
    }
    assert_eq!(normalize_word("  “Hello!”  "), "hello");
    assert_eq!(normalize_word("don't"), "don't");
    assert_eq!(normalize_word("..."), "");
    assert_eq!(normalize_word("ÉCOLE,"), "école");
}

#[test]
fn waveform_bytes_round_trip() {
    let w = Waveform {
        peaks_per_second: 100,
        peaks: vec![0, 1, 255, 256, 30_000, 65_535],
    };
    let b = w.to_bytes();
    assert_eq!(&b[0..4], b"CWF1");
    assert_eq!(b.len(), 12 + 6 * 2);
    assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 100);
    assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 6);
    assert_eq!(&b[12..14], &[0, 0]);
    assert_eq!(&b[16..18], &[255, 0], "little endian");
    assert_eq!(Waveform::from_bytes(&b), Some(w.clone()));
    // trailing bytes are ignored, truncation and bad headers are rejected
    let mut longer = b.clone();
    longer.extend_from_slice(&[1, 2, 3]);
    assert_eq!(Waveform::from_bytes(&longer), Some(w));
    assert_eq!(Waveform::from_bytes(&b[..b.len() - 1]), None);
    assert_eq!(Waveform::from_bytes(&b[..11]), None);
    assert_eq!(Waveform::from_bytes(b""), None);
    let mut bad_magic = b.clone();
    bad_magic[0] = b'X';
    assert_eq!(Waveform::from_bytes(&bad_magic), None);
    let mut zero_rate = b.clone();
    zero_rate[4..8].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(Waveform::from_bytes(&zero_rate), None);
    let mut huge_count = b;
    huge_count[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(Waveform::from_bytes(&huge_count), None);
    let empty = Waveform {
        peaks_per_second: 50,
        peaks: vec![],
    };
    assert_eq!(Waveform::from_bytes(&empty.to_bytes()), Some(empty));
}

#[test]
fn waveform_from_pcm_takes_the_peak_of_each_window() {
    // 8 kHz mono, 100 peaks/s → 80 samples per window
    let mut pcm = vec![0i16; 80 * 3 + 20];
    pcm[5] = 1000;
    pcm[79] = -2000; // window 0 peak = 2000
    pcm[80] = i16::MIN; // window 1 peak = full scale (clamped)
    pcm[200] = 7; // window 2
    pcm[250] = -123; // partial last window
    let w = Waveform::from_pcm_s16(&pcm, 8000, 100);
    assert_eq!(w.peaks_per_second, 100);
    assert_eq!(w.peaks, vec![4000, 65_534, 14, 246]);
    assert!(Waveform::from_pcm_s16(&[], 8000, 100).peaks.is_empty());
    // more peaks requested than samples available: one sample per peak, no division by zero
    assert_eq!(
        Waveform::from_pcm_s16(&[1, -2, 3], 10, 100).peaks,
        vec![2, 4, 6]
    );
}

#[test]
fn silences_are_runs_below_the_threshold_of_at_least_the_minimum_length() {
    let w = wave(5, &[(1.0, 2.0), (3.0, 3.25), (4.5, 5.0)]);
    // -40 dBFS ≈ 655/65535; QUIET (10) is far below, LOUD far above
    assert_eq!(
        detect_silences(&w, -40.0, 300),
        vec![(secs(1.0), secs(2.0)), (secs(4.5), secs(5.0))],
        "the trailing run counts; the 250 ms one is too short"
    );
    assert_eq!(
        detect_silences(&w, -40.0, 250).len(),
        3,
        "exactly the minimum length is enough"
    );
    assert_eq!(
        detect_silences(&w, -40.0, 1000),
        vec![(secs(1.0), secs(2.0))]
    );
    assert!(detect_silences(&w, -40.0, 1001).is_empty());
    // threshold below the noise floor: nothing is silent
    assert!(detect_silences(&w, -80.0, 300).is_empty());
    // threshold above everything: one run covering the whole file
    assert_eq!(detect_silences(&w, -1.0, 300), vec![(secs(0.0), secs(5.0))]);
    assert!(detect_silences(
        &Waveform {
            peaks_per_second: 100,
            peaks: vec![]
        },
        -40.0,
        300
    )
    .is_empty());
    // a peak exactly at the threshold is silent, one above is not
    let threshold = (10f64.powf(-40.0 / 20.0) * 65535.0).round() as u16;
    let edge = Waveform {
        peaks_per_second: 10,
        peaks: vec![LOUD, threshold, threshold, threshold + 1, threshold, LOUD],
    };
    assert_eq!(
        detect_silences(&edge, -40.0, 200),
        vec![(secs(0.1), secs(0.3))]
    );
}

#[test]
fn timeline_silences_are_padded_and_mapped_through_the_clip() {
    let (p, ids) = add(&project(), "vid", Some(0));
    let w = waves(wave(60, &[(2.0, 4.0), (10.0, 10.3), (20.0, 21.0)]));
    let opts = SilenceOptions {
        threshold_db: -38.0,
        min_duration_ms: 700,
        padding_ms: 120,
    };
    let found = timeline_silences(&p, &w, &no_transcripts(), opts);
    assert_eq!(found.len(), 2, "the 300 ms pause is too short: {found:?}");
    let s = &found[0];
    assert_eq!(
        (s.clip_id.as_str(), s.asset_id.as_str()),
        (ids[1].as_str(), "vid"),
        "reported against the audio clip"
    );
    assert_eq!((s.source_start, s.source_end), (secs(2.12), secs(3.88)));
    assert_eq!(
        (s.start, s.end),
        (TimelineTime(secs(2.12).0), TimelineTime(secs(3.88).0))
    );
    assert_eq!(
        (found[1].source_start, found[1].source_end),
        (secs(20.12), secs(20.88))
    );
    // after padding the second pause is 760 ms: a higher minimum drops it
    let found = timeline_silences(
        &p,
        &w,
        &no_transcripts(),
        SilenceOptions {
            min_duration_ms: 800,
            ..opts
        },
    );
    assert_eq!(found.len(), 1);
    // no padding: the raw ranges
    let found = timeline_silences(
        &p,
        &w,
        &no_transcripts(),
        SilenceOptions {
            padding_ms: 0,
            min_duration_ms: 250,
            ..opts
        },
    );
    assert_eq!(
        found
            .iter()
            .map(|s| (s.source_start, s.source_end))
            .collect::<Vec<_>>(),
        vec![
            (secs(2.0), secs(4.0)),
            (secs(10.0), secs(10.3)),
            (secs(20.0), secs(21.0))
        ]
    );
}

#[test]
fn candidates_are_usable_as_source_cuts() {
    let (p, _ids) = add(&project(), "vid", Some(0));
    let w = waves(wave(60, &[(2.0, 4.0), (20.0, 21.5)]));
    let found = timeline_silences(&p, &w, &no_transcripts(), SilenceOptions::default());
    assert_eq!(found.len(), 2);
    let cuts = found
        .iter()
        .map(|s| cutline_core::commands::SourceCut {
            clip_id: s.clip_id.clone(),
            source_start: s.source_start,
            source_end: s.source_end,
            text: String::new(),
        })
        .collect();
    let q = run(
        &p,
        Command::RippleDeleteSource {
            cuts,
            reason: RemovalReason::Silence,
        },
    );
    let removed: i64 = found
        .iter()
        .map(|s| FPS.snap(s.end.0) - FPS.snap(s.start.0))
        .sum();
    assert_eq!(q.duration(), p.duration() - removed);
    assert_eq!(spans(&q, "V1"), spans(&q, "A1"));
    assert_eq!(q.transcript.removals.len(), 2);
    // once removed they are no longer offered
    assert!(timeline_silences(&q, &w, &no_transcripts(), SilenceOptions::default()).is_empty());
}

#[test]
fn silences_are_clipped_to_what_each_clip_shows() {
    // the clip shows source 3 s .. 20.5 s, placed at frame 100
    let (p, ids) = add_range(&project(), "vid", Some(100), Some(90), Some(615));
    let w = waves(wave(60, &[(2.0, 4.0), (20.0, 21.0), (30.0, 32.0)]));
    let opts = SilenceOptions {
        threshold_db: -38.0,
        min_duration_ms: 300,
        padding_ms: 120,
    };
    let found = timeline_silences(&p, &w, &no_transcripts(), opts);
    assert_eq!(found.len(), 2, "{found:?}");
    let clip = &p.clips[&ids[1]];
    // head: starts at the clip edge (no padding there), padded at the far end
    assert_eq!(
        (found[0].source_start, found[0].source_end),
        (secs(3.0), secs(3.88))
    );
    assert_eq!(found[0].start, clip.start);
    assert_eq!(found[0].end, clip.timeline_time_of(secs(3.88)));
    // tail: padded at the near end, runs to the clip edge
    assert_eq!(
        (found[1].source_start, found[1].source_end),
        (secs(20.12), secs(20.5))
    );
    assert_eq!(found[1].end, clip.end());
    // the pause at 30 s is not on the timeline at all
    assert!(found.iter().all(|s| s.source_end <= clip.source_out()));
}

#[test]
fn spoken_words_are_protected_inside_a_quiet_stretch() {
    let (p, _ids) = add(&project(), "vid", Some(0));
    let w = waves(wave(60, &[(2.0, 4.0)]));
    // a softly spoken word in the middle of the "silence"
    let t = transcript(
        "vid",
        &[
            ("before", 1500, 1950, "1"),
            ("psst", 2900, 3100, "1"),
            ("after", 4050, 4500, "1"),
        ],
    );
    let ts = BTreeMap::from([("vid".to_string(), Arc::new(t))]);
    let opts = SilenceOptions {
        threshold_db: -38.0,
        min_duration_ms: 500,
        padding_ms: 120,
    };
    let found = timeline_silences(&p, &w, &ts, opts);
    assert_eq!(
        found
            .iter()
            .map(|s| (s.source_start, s.source_end))
            .collect::<Vec<_>>(),
        vec![(secs(2.12), secs(2.78)), (secs(3.22), secs(3.88))]
    );
    // with a larger minimum neither side of the word is long enough
    assert!(timeline_silences(
        &p,
        &w,
        &ts,
        SilenceOptions {
            min_duration_ms: 700,
            ..opts
        }
    )
    .is_empty());
    // without the transcript the whole stretch is one candidate
    assert_eq!(
        timeline_silences(
            &p,
            &w,
            &no_transcripts(),
            SilenceOptions {
                min_duration_ms: 700,
                ..opts
            }
        )
        .len(),
        1
    );
    // a word overlapping the edge of the quiet stretch trims it
    let t = transcript("vid", &[("trailing", 1800, 2400, "1")]);
    let ts = BTreeMap::from([("vid".to_string(), Arc::new(t))]);
    let found = timeline_silences(&p, &w, &ts, opts);
    assert_eq!(
        (found[0].source_start, found[0].source_end),
        (secs(2.52), secs(3.88))
    );
}

#[test]
fn silences_scale_with_speed_and_respect_audibility() {
    let (p, ids) = add(&project(), "vid", Some(0));
    let w = waves(wave(60, &[(2.0, 4.0)]));
    let opts = SilenceOptions {
        threshold_db: -38.0,
        min_duration_ms: 700,
        padding_ms: 0,
    };
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: ids.clone(),
            speed: 2.0,
            ripple: true,
        },
    );
    let found = timeline_silences(&fast, &w, &no_transcripts(), opts);
    assert_eq!(
        (found[0].source_start, found[0].source_end),
        (secs(2.0), secs(4.0)),
        "thresholds are judged in source time"
    );
    assert_eq!(
        (found[0].start, found[0].end),
        (TimelineTime(secs(1.0).0), TimelineTime(secs(2.0).0))
    );
    // muted, disabled or missing waveform: nothing
    let a1 = track_id(&p, "A1");
    let muted = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "muted": true}),
    );
    assert!(timeline_silences(&muted, &w, &no_transcripts(), opts).is_empty());
    let off = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [ids[1]], "patch": {"enabled": false}}),
    );
    assert!(timeline_silences(&off, &w, &no_transcripts(), opts).is_empty());
    assert!(timeline_silences(&p, &BTreeMap::new(), &no_transcripts(), opts).is_empty());
    // the same asset used twice is reported once per clip, in timeline order
    let (twice, _) = add_range(&p, "vid", None, Some(30), Some(300));
    let found = timeline_silences(&twice, &w, &no_transcripts(), opts);
    assert_eq!(found.len(), 2);
    assert!(found[0].start < found[1].start);
    assert_ne!(found[0].clip_id, found[1].clip_id);
    assert_eq!(found[1].start, tl(1800 + 60 - 30));
}

#[test]
fn tiny_ranges_on_the_timeline_are_not_offered() {
    // at 16× a 700 ms pause lasts 44 ms ≈ 1.3 frames: too small to cut cleanly
    let (p, ids) = add(&project(), "vid", Some(0));
    let w = waves(wave(60, &[(2.0, 2.7), (10.0, 14.0)]));
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: ids,
            speed: 16.0,
            ripple: true,
        },
    );
    let found = timeline_silences(
        &fast,
        &w,
        &no_transcripts(),
        SilenceOptions {
            threshold_db: -38.0,
            min_duration_ms: 700,
            padding_ms: 0,
        },
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source_start, secs(10.0));
    assert!(found[0].end.0 - found[0].start.0 >= 2 * FPS.frame_ticks());
}

#[test]
fn silence_options_defaults_sanitising_and_wire_format() {
    let d = SilenceOptions::default();
    assert_eq!(
        (d.threshold_db, d.min_duration_ms, d.padding_ms),
        (-38.0, 700, 120)
    );
    assert_eq!(d.sanitized(), d);
    let wild = SilenceOptions {
        threshold_db: f64::NAN,
        min_duration_ms: -5,
        padding_ms: 1_000_000,
    }
    .sanitized();
    assert_eq!(
        (wild.threshold_db, wild.min_duration_ms, wild.padding_ms),
        (-38.0, 100, 2000)
    );
    let wild = SilenceOptions {
        threshold_db: 12.0,
        min_duration_ms: i64::MAX,
        padding_ms: -1,
    }
    .sanitized();
    assert_eq!(
        (wild.threshold_db, wild.min_duration_ms, wild.padding_ms),
        (-6.0, 60_000, 0)
    );
    assert_eq!(
        SilenceOptions {
            threshold_db: -200.0,
            ..d
        }
        .sanitized()
        .threshold_db,
        -80.0
    );
    let partial: SilenceOptions = serde_json::from_value(json!({"min_duration_ms": 400})).unwrap();
    assert_eq!((partial.min_duration_ms, partial.padding_ms), (400, 120));
    assert!(serde_json::from_value::<SilenceOptions>(json!({"threshold": -40})).is_err());
    // hostile options never panic
    let (p, _) = add(&project(), "vid", Some(0));
    let w = waves(wave(10, &[(2.0, 4.0)]));
    let _ = timeline_silences(
        &p,
        &w,
        &no_transcripts(),
        SilenceOptions {
            threshold_db: f64::INFINITY,
            min_duration_ms: 0,
            padding_ms: i64::MAX,
        },
    );
}
