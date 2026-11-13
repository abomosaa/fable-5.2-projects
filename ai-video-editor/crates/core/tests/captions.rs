//! Caption generation: wrapping, cue boundaries, speakers, fillers, provenance.

mod common;
use common::*;
use cutline_core::captions::{generate_cues, wrap_lines, CaptionOptions};
use cutline_core::commands::{Command, CueDraft, PlaceMode};
use cutline_core::model::*;
use cutline_core::transcript::{Env, Transcript};
use serde_json::json;

/// `vid` as a linked pair from frame 0 plus a transcript for it.
fn setup(words: &[(&str, i64, i64, &str)]) -> (Project, Env) {
    let (p, _) = add(&project(), "vid", Some(0));
    (p, env_with(vec![transcript("vid", words)]))
}

fn cues(p: &Project, env: &Env, opts: CaptionOptions) -> Vec<CueDraft> {
    let out = generate_cues(p, &env.transcripts, &opts);
    check_cues(p, &out);
    out
}

/// Structural guarantees every result must satisfy.
fn check_cues(p: &Project, cues: &[CueDraft]) {
    let fps = p.fps();
    for c in cues {
        assert!(
            fps.is_aligned(c.start.0) && fps.is_aligned(c.duration),
            "cue {:?} is off the frame grid",
            c.text
        );
        assert!(c.duration >= fps.frame_ticks());
        assert!(c.start.0 >= 0);
        assert!(!c.text.trim().is_empty());
        assert!(c.source.is_some());
    }
    for w in cues.windows(2) {
        assert!(
            w[1].start >= w[0].start + w[0].duration,
            "cues overlap: {:?} / {:?}",
            w[0].text,
            w[1].text
        );
    }
}

fn texts(cues: &[CueDraft]) -> Vec<String> {
    cues.iter().map(|c| c.text.replace('\n', " | ")).collect()
}

fn sentence(
    words: &str,
    step_ms: i64,
    len_ms: i64,
    speaker: &'static str,
) -> Vec<(String, i64, i64, &'static str)> {
    words
        .split_whitespace()
        .enumerate()
        .map(|(i, w)| {
            (
                w.to_string(),
                i as i64 * step_ms,
                i as i64 * step_ms + len_ms,
                speaker,
            )
        })
        .collect()
}

fn borrow<'a>(v: &'a [(String, i64, i64, &'static str)]) -> Vec<(&'a str, i64, i64, &'a str)> {
    v.iter()
        .map(|(t, s, e, sp)| (t.as_str(), *s, *e, *sp))
        .collect()
}

#[test]
fn wrap_lines_is_greedy_and_respects_the_line_budget() {
    assert_eq!(
        wrap_lines(&["hello", "world", "foo"], 11, 2),
        Some(vec!["hello world".to_string(), "foo".to_string()])
    );
    assert_eq!(wrap_lines(&["hello", "world", "foo"], 11, 1), None);
    assert_eq!(
        wrap_lines(&["hello", "world", "foo"], 15, 1),
        Some(vec!["hello world foo".to_string()])
    );
    assert_eq!(
        wrap_lines(&["hello", "world"], 10, 2),
        Some(vec!["hello".to_string(), "world".to_string()]),
        "11 characters do not fit in 10"
    );
    // a single over-long word still gets its own line rather than being dropped
    assert_eq!(
        wrap_lines(&["supercalifragilistic"], 5, 1),
        Some(vec!["supercalifragilistic".to_string()])
    );
    assert_eq!(wrap_lines(&["a", "supercalifragilistic"], 5, 1), None);
    assert_eq!(wrap_lines(&[], 10, 1), Some(vec![]));
    // length is measured in characters, not bytes
    assert_eq!(
        wrap_lines(&["żółć", "gęś"], 8, 1),
        Some(vec!["żółć gęś".to_string()])
    );
}

#[test]
fn every_cue_respects_the_character_and_line_limits_and_no_word_is_lost() {
    let text = "the quick brown fox jumps over the lazy dog and then keeps running through the forest until night falls";
    let words = sentence(text, 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    for (chars, lines) in [(20usize, 2usize), (12, 1), (36, 2), (42, 3), (8, 4)] {
        let opts = CaptionOptions {
            max_chars_per_line: chars as u32,
            max_lines: lines as u32,
            max_duration_ms: 20_000,
            ..Default::default()
        };
        let out = cues(&p, &env, opts);
        let mut all = Vec::new();
        for c in &out {
            let ls: Vec<&str> = c.text.split('\n').collect();
            assert!(
                ls.len() <= lines,
                "{chars}x{lines}: too many lines in {:?}",
                c.text
            );
            for l in &ls {
                assert!(
                    l.chars().count() <= chars,
                    "{chars}x{lines}: line too long: {l:?}"
                );
                assert_eq!(l.trim(), *l);
            }
            all.extend(c.text.split_whitespace().map(str::to_string));
        }
        assert_eq!(
            all.join(" "),
            text,
            "{chars}x{lines}: words must appear once, in order"
        );
    }
}

#[test]
fn a_long_pause_starts_a_new_caption() {
    // 300 ms words; a 1 s pause before "three", a 0.5 s pause before "five"
    let w = [
        ("one", 0, 300, "1"),
        ("two", 400, 700, "1"),
        ("three", 1700, 2000, "1"),
        ("four", 2100, 2400, "1"),
        ("five", 2900, 3200, "1"),
    ];
    let (p, env) = setup(&w);
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["one two", "three four five"]);
    assert_eq!((out[0].start, out[0].duration), (tl(0), fr(21)));
    assert_eq!((out[1].start, out[1].duration), (tl(51), fr(96 - 51)));
    // a shorter threshold splits at the smaller pause too
    let out = cues(
        &p,
        &env,
        CaptionOptions {
            pause_break_ms: 500,
            ..Default::default()
        },
    );
    assert_eq!(texts(&out), vec!["one two", "three four", "five"]);
}

#[test]
fn a_speaker_change_starts_a_new_caption() {
    let w = [
        ("hi", 0, 200, "1"),
        ("there", 250, 500, "1"),
        ("hello", 550, 800, "2"),
        ("back", 850, 1100, "2"),
        ("ok", 1150, 1300, "1"),
    ];
    let (p, env) = setup(&w);
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["hi there", "hello back", "ok"]);
    assert_eq!(
        out.iter()
            .map(|c| c.speaker.clone().unwrap())
            .collect::<Vec<_>>(),
        vec!["Speaker 1", "Speaker 2", "Speaker 1"]
    );
}

#[test]
fn captions_never_exceed_the_maximum_duration() {
    // slow speech: one word per second
    let words = sentence("a b c d e f g h i j k l", 1000, 900, "1");
    let (p, env) = setup(&borrow(&words));
    let out = cues(
        &p,
        &env,
        CaptionOptions {
            max_duration_ms: 3000,
            pause_break_ms: 5000,
            ..Default::default()
        },
    );
    assert_eq!(texts(&out), vec!["a b c", "d e f", "g h i", "j k l"]);
    for c in &out {
        assert!(c.duration <= ms(3000));
    }
    // a single word longer than the limit is still captioned (once)
    let (p, env) = setup(&[("looooong", 0, 9000, "1"), ("x", 9100, 9300, "1")]);
    let out = cues(
        &p,
        &env,
        CaptionOptions {
            max_duration_ms: 3000,
            ..Default::default()
        },
    );
    assert_eq!(texts(&out), vec!["looooong", "x"]);
}

#[test]
fn sentence_ends_are_preferred_break_points_once_a_caption_is_reasonably_full() {
    let text = "alpha bravo delta gamma omega sigma theta kappa. Then more words follow.";
    let words = sentence(text, 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    let out = cues(
        &p,
        &env,
        CaptionOptions {
            max_duration_ms: 20_000,
            ..Default::default()
        },
    );
    assert_eq!(
        texts(&out),
        vec![
            "alpha bravo delta gamma omega sigma | theta kappa.",
            "Then more words follow."
        ]
    );
    // short sentences are kept together instead of flashing by one at a time
    let words = sentence("Yes. No. Maybe. Fine.", 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["Yes. No. Maybe. Fine."]);
}

#[test]
fn speaker_labels_mark_the_first_caption_of_each_turn() {
    let mut w = Vec::new();
    // speaker 1 talks long enough for two captions, then speaker 2, then 1 again
    for (i, t) in "one two three four five six seven eight nine ten eleven twelve"
        .split_whitespace()
        .enumerate()
    {
        w.push((t, i as i64 * 300, i as i64 * 300 + 250, "1"));
    }
    w.push(("really", 3700, 3950, "2"));
    w.push(("yes", 4050, 4300, "1"));
    let (p, env) = setup(&w);
    let p = run(
        &p,
        Command::RenameSpeaker {
            asset_id: "vid".into(),
            speaker: "1".into(),
            name: Some("Ann".into()),
        },
    );
    let opts = CaptionOptions {
        speaker_labels: true,
        max_chars_per_line: 24,
        max_lines: 1,
        ..Default::default()
    };
    let out = cues(&p, &env, opts);
    let t = texts(&out);
    assert!(t[0].starts_with("Ann: one"), "{t:?}");
    assert!(t.len() >= 4);
    let ann_turn: Vec<&String> = t.iter().take_while(|x| !x.contains("really")).collect();
    assert!(ann_turn.len() >= 2);
    assert!(
        ann_turn[1..].iter().all(|x| !x.contains(':')),
        "only the first caption of a turn is labelled: {t:?}"
    );
    assert_eq!(t[ann_turn.len()], "Speaker 2: really");
    assert_eq!(t[ann_turn.len() + 1], "Ann: yes");
    for (c, line) in out.iter().zip(&t) {
        assert!(
            line.chars().count() <= 24,
            "the label counts towards the line length: {line:?}"
        );
        assert!(c.speaker.is_some());
    }
    // labels off: no prefix, but the speaker is still recorded on the cue
    let out = cues(&p, &env, CaptionOptions::default());
    assert!(texts(&out).iter().all(|x| !x.contains(':')));
    assert_eq!(out[0].speaker.as_deref(), Some("Ann"));
}

#[test]
fn fillers_are_skipped_by_default_and_provenance_points_at_the_source_words() {
    let w = [
        ("Um,", 0, 200, "1"),
        ("so", 300, 500, "1"),
        ("uh", 600, 800, "1"),
        ("yes", 900, 1100, "1"),
        ("hmm.", 1200, 1400, "1"),
    ];
    let (p, env) = setup(&w);
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["so yes"]);
    let s = out[0].source.clone().unwrap();
    assert_eq!(
        (s.asset_id.as_str(), s.word_start, s.word_end),
        ("vid", 1, 4),
        "from the first to the last captioned word"
    );
    assert_eq!(
        (out[0].start, out[0].duration),
        (tl(9), fr(33 - 9)),
        "timing follows the captioned words, not the skipped fillers"
    );
    let out = cues(
        &p,
        &env,
        CaptionOptions {
            skip_fillers: false,
            ..Default::default()
        },
    );
    assert_eq!(texts(&out), vec!["Um, so uh yes hmm."]);
    let s = out[0].source.clone().unwrap();
    assert_eq!((s.word_start, s.word_end), (0, 5));
    // only fillers: nothing to caption
    let (p, env) = setup(&[("um", 0, 200, "1"), ("uh", 300, 500, "1")]);
    assert!(generate_cues(&p, &env.transcripts, &CaptionOptions::default()).is_empty());
}

#[test]
fn captions_never_straddle_a_cut_and_follow_trims_and_speed() {
    let words = sentence("one two three four five six seven eight", 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    // cut in the silence between "four" (ends 1150 ms) and "five" (starts 1200 ms)
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(35),
            clip_ids: None,
        },
    );
    let out = cues(&q, &env, CaptionOptions::default());
    assert_eq!(
        texts(&out),
        vec!["one two three four", "five six seven eight"]
    );
    assert!(out[0].start + out[0].duration <= tl(35));
    assert!(out[1].start >= tl(35));
    // at 2× the same words take half the time
    let ids: Vec<ClipId> = p.clips.keys().cloned().collect();
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: ids,
            speed: 2.0,
            ripple: true,
        },
    );
    let normal = cues(&p, &env, CaptionOptions::default());
    let out = cues(&fast, &env, CaptionOptions::default());
    assert_eq!(texts(&out), texts(&normal));
    let end_normal = normal[0].start + normal[0].duration;
    let end_fast = out[0].start + out[0].duration;
    assert_eq!(end_normal, tl(71)); // "eight" ends at 2350 ms = frame 70.5 → next frame
    assert_eq!(end_fast, tl(36)); // 1175 ms = frame 35.25 → next frame
                                  // captions stay inside the clip they describe even when the clip was trimmed mid-word
    let (t, ids) = add_range(&project(), "vid", Some(100), Some(4), Some(40));
    let out = cues(&t, &env, CaptionOptions::default());
    let clip_end = t.clips[&ids[1]].end();
    assert!(out
        .iter()
        .all(|c| c.start >= tl(100) && c.start + c.duration <= clip_end));
}

#[test]
fn corrected_text_is_what_gets_captioned() {
    let words = sentence("their going home", 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    let p = run_env(
        &p,
        Command::CorrectWord {
            asset_id: "vid".into(),
            word_index: 0,
            text: Some("They're".into()),
        },
        &env,
    );
    assert_eq!(
        texts(&cues(&p, &env, CaptionOptions::default())),
        vec!["They're going home"]
    );
}

#[test]
fn simultaneous_speech_on_two_tracks_yields_non_overlapping_cues() {
    let (p, _) = add(&project(), "vid", Some(0));
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(0)),
            track_id: Some(a2),
            source_in: None,
            source_out: Some(src(600)),
            mode: PlaceMode::Overwrite,
        },
    );
    // speaker on A1 talks 0..2 s, the one on A2 interrupts from 1 s to 3 s
    let one = sentence("first speaker keeps talking here", 400, 380, "1");
    let two: Vec<(String, i64, i64, &'static str)> =
        sentence("second voice cuts in loudly", 400, 380, "7")
            .into_iter()
            .map(|(t, s, e, sp)| (t, s + 1000, e + 1000, sp))
            .collect();
    let env = env_with(vec![
        transcript("vid", &borrow(&one)),
        transcript("aud", &borrow(&two)),
    ]);
    let out = cues(&p, &env, CaptionOptions::default()); // check_cues asserts no overlap
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].start, tl(0));
    assert_eq!(out[1].start, tl(30));
    assert_eq!(
        out[0].duration,
        fr(30),
        "the earlier caption yields when the next one starts"
    );
    // two voices starting on (almost) the same frame: the second waits its turn
    let two_b: Vec<(String, i64, i64, &'static str)> = sentence("me too", 400, 380, "7")
        .into_iter()
        .map(|(t, s, e, sp)| (t, s + 60, e + 60, sp))
        .collect();
    let one_b = sentence("hello", 400, 380, "1");
    let env = env_with(vec![
        transcript("vid", &borrow(&one_b)),
        transcript("aud", &borrow(&two_b)),
    ]);
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["hello", "me too"]);
    assert_eq!(out[1].start, out[0].start + out[0].duration);
}

#[test]
fn words_squeezed_into_one_frame_are_queued_not_dropped() {
    // three one-word turns inside a single frame (e.g. speech sped up a lot)
    let (p, env) = setup(&[
        ("a", 0, 10, "1"),
        ("b", 10, 20, "2"),
        ("c", 20, 30, "1"),
        ("later", 2000, 2300, "1"),
    ]);
    let out = cues(&p, &env, CaptionOptions::default());
    assert_eq!(texts(&out), vec!["a", "b", "c", "later"]);
    assert_eq!(
        out.iter()
            .take(3)
            .map(|c| (c.start, c.duration))
            .collect::<Vec<_>>(),
        vec![(tl(0), fr(1)), (tl(1), fr(1)), (tl(2), fr(1))]
    );
    assert_eq!(out[3].start, tl(60));
}

#[test]
fn only_audible_transcribed_audio_is_captioned() {
    let words = sentence("one two three", 300, 250, "1");
    let (p, env) = setup(&borrow(&words));
    assert!(generate_cues(&p, &Env::default().transcripts, &CaptionOptions::default()).is_empty());
    let a1 = track_id(&p, "A1");
    let muted = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "muted": true}),
    );
    assert!(generate_cues(&muted, &env.transcripts, &CaptionOptions::default()).is_empty());
    assert!(generate_cues(&project(), &env.transcripts, &CaptionOptions::default()).is_empty());
    // positions follow the clip on the timeline
    let ids: Vec<ClipId> = p.clips.keys().cloned().collect();
    let (v1, a1) = (track_id(&p, "V1"), track_id(&p, "A1"));
    let moves = ids
        .iter()
        .map(|id| cutline_core::commands::ClipMove {
            clip_id: id.clone(),
            start: tl(300),
            track_id: if p.clips[id].track_id == v1 {
                v1.clone()
            } else {
                a1.clone()
            },
        })
        .collect();
    let moved = run(
        &p,
        Command::MoveClips {
            moves,
            mode: PlaceMode::Overwrite,
        },
    );
    let out = cues(&moved, &env, CaptionOptions::default());
    assert_eq!(out[0].start, tl(300));
}

#[test]
fn caption_options_defaults_validation_and_wire_format() {
    let d = CaptionOptions::default();
    assert_eq!(
        (
            d.max_chars_per_line,
            d.max_lines,
            d.max_duration_ms,
            d.pause_break_ms,
            d.speaker_labels,
            d.skip_fillers
        ),
        (36, 2, 5000, 800, false, true)
    );
    assert!(d.validate().is_ok());
    let from_empty: CaptionOptions = serde_json::from_value(json!({})).unwrap();
    assert_eq!(from_empty, d);
    let partial: CaptionOptions =
        serde_json::from_value(json!({"max_lines": 1, "speaker_labels": true})).unwrap();
    assert_eq!(
        (
            partial.max_lines,
            partial.speaker_labels,
            partial.max_chars_per_line
        ),
        (1, true, 36)
    );
    assert!(serde_json::from_value::<CaptionOptions>(json!({"max_line": 1})).is_err());
    for (opts, field) in [
        (
            CaptionOptions {
                max_chars_per_line: 7,
                ..d
            },
            "options.max_chars_per_line",
        ),
        (
            CaptionOptions {
                max_chars_per_line: 81,
                ..d
            },
            "options.max_chars_per_line",
        ),
        (CaptionOptions { max_lines: 0, ..d }, "options.max_lines"),
        (CaptionOptions { max_lines: 5, ..d }, "options.max_lines"),
        (
            CaptionOptions {
                max_duration_ms: 499,
                ..d
            },
            "options.max_duration_ms",
        ),
        (
            CaptionOptions {
                max_duration_ms: 20_001,
                ..d
            },
            "options.max_duration_ms",
        ),
        (
            CaptionOptions {
                pause_break_ms: 99,
                ..d
            },
            "options.pause_break_ms",
        ),
        (
            CaptionOptions {
                pause_break_ms: 10_001,
                ..d
            },
            "options.pause_break_ms",
        ),
    ] {
        let e = opts.validate().unwrap_err();
        assert_eq!(e.field.as_deref(), Some(field));
        assert_eq!(e.code, cutline_core::ErrorCode::InvalidArgument);
    }
    for ok in [
        CaptionOptions {
            max_chars_per_line: 8,
            ..d
        },
        CaptionOptions {
            max_chars_per_line: 80,
            max_lines: 4,
            max_duration_ms: 20_000,
            pause_break_ms: 100,
            ..d
        },
    ] {
        assert!(ok.validate().is_ok());
    }
}

#[test]
fn random_transcripts_always_produce_well_formed_cues() {
    let mut rng = Rng(31337);
    for round in 0..300 {
        let n = rng.range(1, 80);
        let mut t = 0i64;
        let mut raw: Vec<(String, i64, i64, &'static str)> = Vec::new();
        for i in 0..n {
            t += rng.range(0, 1500);
            let len = rng.range(40, 900);
            let text = format!(
                "{}{}",
                "x".repeat(rng.range(1, 14) as usize),
                if rng.chance(15) { "." } else { "" }
            );
            raw.push((text, t, t + len, if (i / 7) % 2 == 0 { "1" } else { "2" }));
            t += len;
        }
        let tr: Transcript = transcript("vid", &borrow(&raw));
        let (mut p, _) = add(&project(), "vid", Some(rng.range(0, 50)));
        for _ in 0..rng.range(0, 6) {
            if let Ok(a) = try_run(
                &p,
                Command::SplitClips {
                    at: tl(rng.range(1, 1500)),
                    clip_ids: None,
                },
            ) {
                p = a.project;
            }
        }
        let env = env_with(vec![tr]);
        let opts = CaptionOptions {
            max_chars_per_line: rng.range(8, 50) as u32,
            max_lines: rng.range(1, 3) as u32,
            max_duration_ms: rng.range(800, 8000),
            pause_break_ms: rng.range(100, 2000),
            speaker_labels: rng.chance(50),
            skip_fillers: rng.chance(50),
        };
        let out = cues(&p, &env, opts);
        // each cue's words are a contiguous, increasing run of the transcript
        let mut next = 0u32;
        for c in &out {
            let s = c.source.as_ref().unwrap();
            assert!(
                s.word_start >= next && s.word_end > s.word_start,
                "round {round}: provenance out of order"
            );
            next = s.word_end;
        }
        // every audible word ends up in exactly one caption
        let view = cutline_core::mapping::timeline_transcript(&p, &env.transcripts);
        let audible: usize = view.segments.iter().map(|s| s.words.len()).sum();
        let captioned: u32 = out
            .iter()
            .map(|c| {
                c.source
                    .as_ref()
                    .map(|s| s.word_end - s.word_start)
                    .unwrap()
            })
            .sum();
        assert_eq!(
            captioned as usize, audible,
            "round {round}: words were dropped or duplicated"
        );
        // and the command accepts them as-is
        if out.is_empty() {
            assert!(try_run_env(&p, Command::GenerateCaptions { options: opts }, &env).is_err());
        } else {
            let placed = run_env(&p, Command::GenerateCaptions { options: opts }, &env);
            assert_eq!(
                placed
                    .clips
                    .values()
                    .filter(|c| matches!(c.content, ClipContent::Caption { .. }))
                    .count(),
                out.len(),
                "round {round}"
            );
        }
    }
}
