//! Time model: frame/timebase conversion, rounding, speed and clip time mapping.

mod common;
use common::*;
use cutline_core::commands::Command;
use cutline_core::model::*;
use cutline_core::time::*;

const RATES: [FrameRate; 8] = [
    FrameRate::FPS_23_976,
    FrameRate::FPS_24,
    FrameRate::FPS_25,
    FrameRate::FPS_29_97,
    FrameRate::FPS_30,
    FrameRate::FPS_50,
    FrameRate::FPS_59_94,
    FrameRate::FPS_60,
];

#[test]
fn tick_base_divides_standard_frame_and_sample_rates() {
    for r in RATES {
        assert_eq!(
            (TICKS_PER_SECOND as i128 * r.den as i128) % r.num as i128,
            0,
            "{r:?} is not exact"
        );
    }
    for sr in [
        8_000i64, 16_000, 22_050, 44_100, 48_000, 88_200, 96_000, 192_000,
    ] {
        assert_eq!(TICKS_PER_SECOND % sr, 0, "{sr} Hz is not exact");
    }
    assert_eq!(TICKS_PER_MS * 1000, TICKS_PER_SECOND);
}

#[test]
fn frame_durations_are_exact_integers() {
    assert_eq!(FrameRate::FPS_24.frame_ticks(), 29_400_000);
    assert_eq!(FrameRate::FPS_25.frame_ticks(), 28_224_000);
    assert_eq!(FrameRate::FPS_30.frame_ticks(), 23_520_000);
    assert_eq!(FrameRate::FPS_60.frame_ticks(), 11_760_000);
    assert_eq!(FrameRate::FPS_29_97.frame_ticks(), 23_543_520);
    assert_eq!(FrameRate::FPS_23_976.frame_ticks(), 29_429_400);
    assert_eq!(FrameRate::FPS_59_94.frame_ticks(), 11_771_760);
}

#[test]
fn frame_tick_round_trip_over_hours_has_no_drift() {
    for r in RATES {
        let frame = r.frame_ticks();
        // 10 hours of frames, sampled; includes the exact one-hour marks
        let per_hour = (r.as_f64() * 3600.0).round() as i64;
        let mut rng = Rng(0x5EED ^ r.num as u64);
        let mut samples: Vec<i64> = (0..10).map(|h| h * per_hour).collect();
        samples.extend((0..2_000).map(|_| rng.range(0, 10 * per_hour)));
        for f in samples {
            let t = r.frame_to_ticks(f);
            assert_eq!(
                t,
                f * frame,
                "{r:?} frame {f}: grid must be an exact multiple"
            );
            assert_eq!(r.ticks_to_frame_floor(t), f);
            assert_eq!(r.ticks_to_frame_round(t), f);
            assert_eq!(r.ticks_to_frame_ceil(t), f);
            assert!(r.is_aligned(t));
            // just inside / outside the frame
            assert_eq!(r.ticks_to_frame_floor(t + frame - 1), f);
            assert_eq!(r.ticks_to_frame_ceil(t + 1), f + 1);
            assert_eq!(r.ticks_to_frame_floor(t - 1), f - 1);
            assert!(!r.is_aligned(t + 1));
        }
        // NTSC: 30000 frames last exactly 1001 seconds
        if r.den == 1001 {
            assert_eq!(r.frame_to_ticks(r.num as i64), 1001 * TICKS_PER_SECOND);
        } else {
            assert_eq!(r.frame_to_ticks(r.num as i64), TICKS_PER_SECOND);
        }
    }
}

#[test]
fn snapping_properties_hold_for_arbitrary_ticks() {
    let mut rng = Rng(42);
    for r in RATES {
        let frame = r.frame_ticks();
        for _ in 0..3_000 {
            let t = rng.range(0, 4 * 3600 * TICKS_PER_SECOND);
            let (lo, mid, hi) = (r.snap_floor(t), r.snap(t), r.snap_ceil(t));
            assert!(lo <= t && t <= hi);
            assert!(hi - lo == 0 || hi - lo == frame);
            assert!(mid == lo || mid == hi);
            assert!(
                (mid - t).abs() * 2 <= frame,
                "snap must pick the nearest boundary"
            );
            assert!(r.is_aligned(lo) && r.is_aligned(mid) && r.is_aligned(hi));
            // idempotent
            assert_eq!(r.snap(mid), mid);
            assert_eq!(r.snap_floor(lo), lo);
            assert_eq!(r.snap_ceil(hi), hi);
        }
        // ties round up
        assert_eq!(r.ticks_to_frame_round(frame / 2), 1);
        assert_eq!(r.ticks_to_frame_round(frame / 2 - 1), 0);
    }
}

#[test]
fn snapping_is_monotonic() {
    let r = FrameRate::FPS_29_97;
    let mut rng = Rng(7);
    for _ in 0..2_000 {
        let a = rng.range(0, 3600 * TICKS_PER_SECOND);
        let b = a + rng.range(0, 10 * r.frame_ticks());
        assert!(r.snap(a) <= r.snap(b));
        assert!(r.snap_floor(a) <= r.snap_floor(b));
        assert!(r.snap_ceil(a) <= r.snap_ceil(b));
    }
}

#[test]
fn negative_ticks_floor_towards_minus_infinity() {
    let r = FrameRate::FPS_30;
    assert_eq!(r.ticks_to_frame_floor(-1), -1);
    assert_eq!(r.ticks_to_frame_ceil(-1), 0);
    assert_eq!(r.ticks_to_frame_floor(-r.frame_ticks()), -1);
    assert_eq!(r.snap_floor(-1), -r.frame_ticks());
}

#[test]
fn frame_rate_construction_and_parsing() {
    assert_eq!(FrameRate::new(60, 2), Some(FrameRate::FPS_30));
    assert_eq!(FrameRate::new(60000, 2002), Some(FrameRate::FPS_29_97));
    assert_eq!(FrameRate::new(0, 1), None);
    assert_eq!(FrameRate::new(30, 0), None);
    assert_eq!(FrameRate::new(1000, 1), None, "absurd rates are rejected");
    assert_eq!(FrameRate::parse("30000/1001"), Some(FrameRate::FPS_29_97));
    assert_eq!(FrameRate::parse(" 25/1 "), Some(FrameRate::FPS_25));
    assert_eq!(FrameRate::parse("29.97"), Some(FrameRate::FPS_29_97));
    assert_eq!(FrameRate::parse("23.976"), Some(FrameRate::FPS_23_976));
    assert_eq!(FrameRate::parse("59.94"), Some(FrameRate::FPS_59_94));
    assert_eq!(FrameRate::parse("60"), Some(FrameRate::FPS_60));
    assert_eq!(FrameRate::parse("0/0"), None);
    assert_eq!(FrameRate::parse("abc"), None);
    assert_eq!(FrameRate::parse(""), None);
    assert_eq!(FrameRate::parse("-30"), None);
    assert_eq!(FrameRate::from_f64(f64::NAN), None);
    assert_eq!(
        FrameRate::from_f64(12.5),
        Some(FrameRate { num: 25, den: 2 })
    );
    assert_eq!(FrameRate::default(), FrameRate::FPS_30);
    assert!((FrameRate::FPS_29_97.as_f64() - 29.970_029_97).abs() < 1e-6);
}

#[test]
fn exotic_rates_stay_monotonic_and_invertible() {
    // 12.5 fps divides the tick base evenly, 11 and 13 fps do not: the grid must still round trip
    for r in [
        FrameRate::new(25, 2).unwrap(),
        FrameRate::new(11, 1).unwrap(),
        FrameRate::new(13, 1).unwrap(),
        FrameRate::new(10_000, 333).unwrap(),
    ] {
        let mut prev = -1;
        for f in 0..5_000 {
            let t = r.frame_to_ticks(f);
            assert!(t > prev);
            prev = t;
            assert_eq!(r.ticks_to_frame_floor(t), f, "{r:?} frame {f}");
            assert_eq!(r.ticks_to_frame_ceil(t), f);
            assert_eq!(r.ticks_to_frame_round(t), f);
        }
    }
}

#[test]
fn timecode_is_non_drop_frame() {
    let r = FrameRate::FPS_30;
    assert_eq!(r.timecode(0), "00:00:00:00");
    assert_eq!(r.timecode(r.frame_to_ticks(29)), "00:00:00:29");
    assert_eq!(r.timecode(r.frame_to_ticks(30)), "00:00:01:00");
    assert_eq!(
        r.timecode(r.frame_to_ticks(30 * 3600 * 2 + 30 * 60 * 3 + 30 * 4 + 5)),
        "02:03:04:05"
    );
    // within a frame the timecode does not change
    assert_eq!(r.timecode(r.frame_to_ticks(31) - 1), "00:00:01:00");
    assert_eq!(
        FrameRate::FPS_60.timecode(FrameRate::FPS_60.frame_to_ticks(119)),
        "00:00:01:59"
    );
    assert_eq!(
        FrameRate::FPS_25.timecode(FrameRate::FPS_25.frame_to_ticks(25 * 61)),
        "00:01:01:00"
    );
    // NTSC counts nominal 30 frames per timecode second
    let n = FrameRate::FPS_29_97;
    assert_eq!(n.timecode(n.frame_to_ticks(30 * 60)), "00:01:00:00");
    assert_eq!(r.timecode(-r.frame_to_ticks(45)), "-00:00:01:15");
}

#[test]
fn seconds_strings_are_deterministic_microseconds() {
    assert_eq!(ticks_to_seconds_string(0), "0.000000");
    assert_eq!(ticks_to_seconds_string(TICKS_PER_SECOND), "1.000000");
    assert_eq!(ticks_to_seconds_string(TICKS_PER_SECOND / 4), "0.250000");
    assert_eq!(
        ticks_to_seconds_string(3600 * TICKS_PER_SECOND + TICKS_PER_MS),
        "3600.001000"
    );
    assert_eq!(
        ticks_to_seconds_string(FrameRate::FPS_29_97.frame_to_ticks(1)),
        "0.033367"
    );
    assert_eq!(
        ticks_to_seconds_string(FrameRate::FPS_60.frame_to_ticks(1)),
        "0.016667"
    );
    assert_eq!(ticks_to_seconds_string(-TICKS_PER_SECOND / 2), "-0.500000");
    // rounding carries into the integer part
    assert_eq!(ticks_to_seconds_string(TICKS_PER_SECOND - 1), "1.000000");
}

#[test]
fn unit_conversions() {
    assert_eq!(ms_to_ticks(1), 705_600);
    assert_eq!(TimelineTime::from_ms(1500).0, TICKS_PER_SECOND * 3 / 2);
    assert_eq!(SourceTime::from_ms(1500).as_ms(), 1500);
    assert_eq!(
        TimelineTime(TICKS_PER_MS * 2 + TICKS_PER_MS / 2).as_ms(),
        3,
        "as_ms rounds half up"
    );
    assert_eq!(seconds_to_ticks(0.5), TICKS_PER_SECOND / 2);
    assert_eq!(TimelineTime::from_seconds_f64(2.0).0, 2 * TICKS_PER_SECOND);
    assert!((ClipTime(TICKS_PER_SECOND / 8).as_seconds_f64() - 0.125).abs() < 1e-12);
    assert_eq!(ticks_to_samples(TICKS_PER_SECOND, 48_000), 48_000);
    assert_eq!(
        ticks_to_samples(FrameRate::FPS_30.frame_to_ticks(1), 48_000),
        1_600
    );
    assert_eq!(
        ticks_to_samples(FrameRate::FPS_29_97.frame_to_ticks(30_000), 44_100),
        1001 * 44_100
    );
    // newtype arithmetic
    let t = TimelineTime(100);
    assert_eq!((t + 20).0, 120);
    assert_eq!((t - 20).0, 80);
    assert_eq!(TimelineTime(150) - t, 50);
    let mut u = t;
    u += 5;
    u -= 1;
    assert_eq!(u, TimelineTime(104));
}

#[test]
fn integer_rounding_helpers() {
    assert_eq!(div_round(7, 2), 4);
    assert_eq!(div_round(-7, 2), -4);
    assert_eq!(div_round(7, -2), -4);
    assert_eq!(div_round(6, 4), 2);
    assert_eq!(div_round(5, 4), 1);
    assert_eq!(mul_div_round(10, 3, 4), 8);
    assert_eq!(mul_div_round(-10, 3, 4), -8);
    assert_eq!(mul_div_floor(10, 3, 4), 7);
    assert_eq!(mul_div_floor(-10, 3, 4), -8);
    assert_eq!(mul_div_ceil(10, 3, 4), 8);
    assert_eq!(mul_div_ceil(8, 1, 4), 2);
    // no overflow with large operands
    let big = 24 * 3600 * TICKS_PER_SECOND;
    assert_eq!(mul_div_round(big, 60_000, 1001 * 60_000 / 1001), big);
    assert_eq!(mul_div_floor(big, TICKS_PER_SECOND, TICKS_PER_SECOND), big);
}

#[test]
fn speed_construction_bounds_and_reduction() {
    assert_eq!(Speed::new(2, 4), Some(Speed { num: 1, den: 2 }));
    assert_eq!(Speed::new(0, 1), None);
    assert_eq!(Speed::new(1, 0), None);
    assert_eq!(
        Speed::new(1, 10),
        Some(Speed { num: 1, den: 10 }),
        "0.1× is the minimum"
    );
    assert_eq!(Speed::new(99, 1000), None);
    assert_eq!(Speed::new(16, 1), Some(Speed { num: 16, den: 1 }));
    assert_eq!(Speed::new(17, 1), None);
    assert_eq!(Speed::from_f64(1.0), Some(Speed::NORMAL));
    assert_eq!(Speed::from_f64(1.5), Some(Speed { num: 3, den: 2 }));
    assert_eq!(Speed::from_f64(0.25), Some(Speed { num: 1, den: 4 }));
    assert_eq!(Speed::from_f64(1.25), Some(Speed { num: 5, den: 4 }));
    assert_eq!(Speed::from_f64(f64::NAN), None);
    assert_eq!(Speed::from_f64(f64::INFINITY), None);
    assert_eq!(Speed::from_f64(-1.0), None);
    assert_eq!(Speed::from_f64(0.0), None);
    assert!(Speed::NORMAL.is_normal());
    assert!(!Speed { num: 2, den: 1 }.is_normal());
    assert_eq!(Speed::default(), Speed::NORMAL);
}

#[test]
fn speed_maps_output_to_source_and_back() {
    let double = Speed::new(2, 1).unwrap();
    let half = Speed::new(1, 2).unwrap();
    let out = fr(90);
    assert_eq!(double.output_to_source(out), fr(180));
    assert_eq!(double.source_to_output(fr(180)), out);
    assert_eq!(half.output_to_source(out), fr(45));
    assert_eq!(half.source_to_output(fr(45)), out);
    // inverse within one tick for arbitrary rationals
    let mut rng = Rng(99);
    for _ in 0..2_000 {
        let s = Speed::new(rng.range(100, 16_000) as u32, 1000).unwrap();
        let t = rng.range(0, 3600 * TICKS_PER_SECOND);
        let back = s.source_to_output(s.output_to_source(t));
        assert!(
            (back - t).abs() <= (s.den as i64 / s.num as i64) + 1,
            "{s:?} {t} -> {back}"
        );
        // monotonic
        assert!(s.output_to_source(t + fr(1)) > s.output_to_source(t));
    }
}

// ---------------------------------------------------------------------------------
// Clip-local / source / timeline mapping
// ---------------------------------------------------------------------------------

fn clip_at(start: i64, dur: i64, source_in: i64, speed: Speed) -> Clip {
    Clip {
        id: "c".into(),
        track_id: "t".into(),
        start: tl(start),
        duration: fr(dur),
        source_in: src(source_in),
        speed,
        content: ClipContent::Video {
            asset_id: "vid".into(),
        },
        enabled: true,
        link_id: None,
        group_id: None,
        transform: Transform::default(),
        color: ColorAdjust::default(),
        gain_db: 0.0,
        fade_in: 0,
        fade_out: 0,
    }
}

#[test]
fn clip_maps_between_timeline_clip_and_source_time() {
    let c = clip_at(100, 60, 30, Speed::NORMAL);
    assert_eq!(c.end(), tl(160));
    assert_eq!(c.source_duration(), fr(60));
    assert_eq!(c.source_out(), src(90));
    assert_eq!(c.clip_time(tl(130)), ClipTime(fr(30)));
    assert_eq!(c.clip_to_source(ClipTime(fr(30))), src(60));
    assert_eq!(c.source_time_at(tl(130)), src(60));
    assert_eq!(c.timeline_time_of(src(60)), tl(130));
    assert!(
        c.contains(tl(100)) && c.contains(tl(159)) && !c.contains(tl(160)) && !c.contains(tl(99))
    );
    assert!(
        c.overlaps(tl(159), tl(200))
            && !c.overlaps(tl(160), tl(200))
            && !c.overlaps(tl(0), tl(100))
    );
    // extrapolates outside the clip (used by transition handles)
    assert_eq!(c.source_time_at(tl(90)), src(20));
    assert_eq!(c.source_time_at(tl(170)), src(100));
}

#[test]
fn clip_mapping_respects_speed() {
    let fast = clip_at(100, 60, 30, Speed::new(2, 1).unwrap());
    assert_eq!(fast.source_duration(), fr(120));
    assert_eq!(fast.source_out(), src(150));
    assert_eq!(fast.source_time_at(tl(110)), src(50));
    assert_eq!(fast.timeline_time_of(src(50)), tl(110));
    let slow = clip_at(100, 60, 30, Speed::new(1, 2).unwrap());
    assert_eq!(slow.source_duration(), fr(30));
    assert_eq!(slow.source_time_at(tl(120)), src(40));
    assert_eq!(slow.timeline_time_of(src(40)), tl(120));
    // 1.5× with a non-divisible position still round trips to the same frame
    let odd = clip_at(0, 100, 0, Speed::new(3, 2).unwrap());
    for f in 0..100 {
        let s = odd.source_time_at(tl(f));
        assert_eq!(FPS.snap(odd.timeline_time_of(s).0), fr(f));
    }
}

#[test]
fn sync_anchor_is_shared_by_in_sync_linked_clips() {
    let v = clip_at(100, 60, 30, Speed::NORMAL);
    let mut a = v.clone();
    assert_eq!(v.sync_anchor(), fr(70));
    assert_eq!(v.sync_anchor(), a.sync_anchor());
    // trimming the head of one clip keeps the anchor (start and source_in move together)
    a.start = tl(110);
    a.source_in = src(40);
    assert_eq!(v.sync_anchor(), a.sync_anchor());
    // moving it does not
    a.start = tl(113);
    assert_eq!(a.sync_anchor() - v.sync_anchor(), fr(3));
}

#[test]
fn split_halves_are_exactly_source_contiguous_at_any_speed() {
    let (p, ids) = add(&project(), "vid", Some(0));
    for speed in [1.0, 2.0, 0.5, 1.5, 0.3, 3.7, 1.001] {
        let p = run(
            &p,
            Command::SetSpeed {
                clip_ids: ids.clone(),
                speed,
                ripple: true,
            },
        );
        let dur = p.clips[&ids[0]].duration;
        let total = FPS.ticks_to_frame_floor(dur);
        for at in [1, 7, total / 3, total / 2, total - 1] {
            let q = run(
                &p,
                Command::SplitClips {
                    at: tl(at),
                    clip_ids: None,
                },
            );
            for track in ["V1", "A1"] {
                let clips = on(&q, track);
                assert_eq!(clips.len(), 2);
                let (l, r) = (&clips[0], &clips[1]);
                assert_eq!(l.end(), r.start);
                assert_eq!(
                    l.source_out(),
                    r.source_in,
                    "speed {speed} split at {at}: halves must be source-contiguous"
                );
                assert_eq!(l.duration + r.duration, dur);
                assert_eq!(l.speed, r.speed);
                assert_eq!(l.source_in, SourceTime::ZERO);
            }
        }
    }
}
