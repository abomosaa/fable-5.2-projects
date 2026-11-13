//! Subtitle parsing (SRT / WebVTT) and caption export.

use cutline_core::commands::{apply, ClipPatch, Command, CueDraft};
use cutline_core::model::{Project, TrackKind};
use cutline_core::subtitles::{export_srt, export_vtt, parse_subtitles};
use cutline_core::time::{TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::{Env, SubtitleCue};

fn cue(start_ms: i64, end_ms: i64, text: &str) -> SubtitleCue {
    SubtitleCue {
        start_ms,
        end_ms,
        text: text.to_string(),
    }
}

#[test]
fn parses_plain_srt() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nHello there.\n\n2\n00:00:05,500 --> 00:00:07,250\nSecond cue\non two lines\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![
            cue(1000, 4000, "Hello there."),
            cue(5500, 7250, "Second cue\non two lines")
        ]
    );
}

#[test]
fn tolerates_bom_crlf_missing_indices_and_dot_millis() {
    let srt = "\u{feff}00:00:01.000 --> 00:00:02.000\r\nNo index here\r\n\r\n\r\n7\r\n01:00:00,5 --> 01:00:01,50\r\nShort fractions\r\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![
            cue(1000, 2000, "No index here"),
            cue(3_600_500, 3_601_500, "Short fractions")
        ]
    );
}

#[test]
fn strips_markup_and_decodes_entities() {
    let srt = "1\n00:00:00,000 --> 00:00:01,000\n{\\an8}<i>Italic</i> &amp; <font color=\"#fff\">coloured</font>\n<b>bold</b> a &lt; b\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![cue(0, 1000, "Italic & coloured\nbold a < b")]
    );
}

#[test]
fn parses_webvtt_with_headers_notes_styles_and_settings() {
    let vtt = "WEBVTT - Some title\nKind: captions\nLanguage: en\n\nNOTE\nThis is a comment\nspanning lines\n\nSTYLE\n::cue { color: yellow }\n\nintro\n00:01.000 --> 00:03.500 align:start position:10% line:0\n<v Roger>Hello <c.loud>world</c>\n\nNOTE inline comment\n\n00:00:04.000 --> 00:00:05.000\n<00:00:04.200>Karaoke <00:00:04.600>timing\n";
    assert_eq!(
        parse_subtitles(vtt).unwrap(),
        vec![
            cue(1000, 3500, "Hello world"),
            cue(4000, 5000, "Karaoke timing")
        ]
    );
}

#[test]
fn sorts_cues_and_skips_empty_or_inverted_ones() {
    let srt = "1\n00:00:05,000 --> 00:00:06,000\nLater\n\n2\n00:00:01,000 --> 00:00:02,000\nEarlier\n\n3\n00:00:03,000 --> 00:00:03,000\nZero length\n\n4\n00:00:08,000 --> 00:00:07,000\nBackwards\n\n5\n00:00:09,000 --> 00:00:10,000\n<i></i>\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![cue(1000, 2000, "Earlier"), cue(5000, 6000, "Later")]
    );
}

#[test]
fn handles_missing_blank_lines_between_cues() {
    let srt = "1\n00:00:01,000 --> 00:00:02,000\nFirst\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![cue(1000, 2000, "First"), cue(3000, 4000, "Second")]
    );
    // a number that is the cue's only line is text, not an index
    let srt = "1\n00:00:01,000 --> 00:00:02,000\n42\n\n2\n00:00:03,000 --> 00:00:04,000\nAnswer\n";
    assert_eq!(parse_subtitles(srt).unwrap()[0], cue(1000, 2000, "42"));
}

#[test]
fn arrow_in_text_is_not_a_timing_line() {
    let srt = "1\n00:00:01,000 --> 00:00:02,000\nA --> B\n";
    assert_eq!(
        parse_subtitles(srt).unwrap(),
        vec![cue(1000, 2000, "A --> B")]
    );
}

#[test]
fn reports_helpful_errors() {
    let e = parse_subtitles("just some text\nwithout timings").unwrap_err();
    assert!(e.contains(".srt") && e.contains("-->"), "{e}");
    let e = parse_subtitles("").unwrap_err();
    assert!(e.contains("No subtitle cues"), "{e}");
    let e = parse_subtitles("1\n00:00:02,000 --> 00:00:01,000\nBackwards\n").unwrap_err();
    assert!(e.contains("no usable cues"), "{e}");
    assert!(parse_subtitles("WEBVTT\n\nNOTE nothing else\n").is_err());
}

fn project_with_captions() -> Project {
    let p = Project::new("p1", "Test", 0);
    let s = TICKS_PER_SECOND;
    let draft = |start: i64, dur: i64, text: &str| CueDraft {
        start: TimelineTime(start),
        duration: dur,
        text: text.to_string(),
        speaker: None,
        source: None,
    };
    let cmd = Command::AddCaptions {
        cues: vec![
            draft(5 * s, s, "Third"),
            draft(s, 2 * s, "First line\nsecond line"),
            draft(3 * s + s / 2, s, "Second --> arrow"),
        ],
        track_id: None,
    };
    apply(&p, &cmd, &Env::default()).unwrap().project
}

#[test]
fn exports_srt_and_vtt_in_timeline_order() {
    let p = project_with_captions();
    let srt = export_srt(&p);
    assert_eq!(
        srt,
        "1\n00:00:01,000 --> 00:00:03,000\nFirst line\nsecond line\n\n2\n00:00:03,500 --> 00:00:04,500\nSecond --> arrow\n\n3\n00:00:05,000 --> 00:00:06,000\nThird\n\n"
    );
    let vtt = export_vtt(&p);
    assert!(vtt.starts_with("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst line\nsecond line\n\n"));
    assert!(vtt.contains("00:00:03.500 --> 00:00:04.500\nSecond → arrow\n"));
    // both exports parse back to the same cues
    let from_srt = parse_subtitles(&srt).unwrap();
    assert_eq!(
        from_srt,
        vec![
            cue(1000, 3000, "First line\nsecond line"),
            cue(3500, 4500, "Second --> arrow"),
            cue(5000, 6000, "Third")
        ]
    );
    let from_vtt = parse_subtitles(&vtt).unwrap();
    assert_eq!(from_vtt.len(), 3);
    assert_eq!((from_vtt[2].start_ms, from_vtt[2].end_ms), (5000, 6000));
}

#[test]
fn export_skips_hidden_tracks_and_disabled_captions() {
    let p = project_with_captions();
    let env = Env::default();
    // disable the first caption
    let first = p.clips.values().min_by_key(|c| c.start).unwrap().id.clone();
    let p2 = apply(
        &p,
        &Command::UpdateClips {
            clip_ids: vec![first],
            patch: ClipPatch {
                enabled: Some(false),
                ..Default::default()
            },
        },
        &env,
    )
    .unwrap()
    .project;
    let srt = export_srt(&p2);
    assert!(!srt.contains("First line"));
    assert!(srt.starts_with("1\n00:00:03,500"));
    // hide the caption track
    let track = p
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Caption)
        .unwrap()
        .id
        .clone();
    let p3 = apply(
        &p,
        &Command::UpdateTrack {
            track_id: track,
            name: None,
            muted: None,
            solo: None,
            locked: None,
            hidden: Some(true),
            gain_db: None,
        },
        &env,
    )
    .unwrap()
    .project;
    assert_eq!(export_srt(&p3), "");
    assert_eq!(export_vtt(&p3), "WEBVTT\n\n");
    // a project without captions exports nothing
    assert_eq!(export_srt(&Project::new("p", "n", 0)), "");
}
