//! End-to-end export tests: real FFmpeg, generated media, real pixels and samples.
//!
//! Media is synthesised with lavfi into a temp dir at tiny resolutions so the whole
//! file runs in a few seconds. The tests are skipped (with a message) only when
//! FFmpeg / ffprobe are not installed.

use cutline_core::commands::{apply, ClipPatch, Command, CueDraft};
use cutline_core::model::*;
use cutline_core::render::{ExportSettings, MediaSource, Quality, RenderEnv, VideoCodec};
use cutline_core::resolve::resolve_layers;
use cutline_core::time::{FrameRate, SourceTime, TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::Env;
use cutline_server::render::{RenderConfig, RenderJob, RenderManager, RenderState};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const S: i64 = TICKS_PER_SECOND;

fn ffmpeg_available() -> bool {
    let ok = |bin: &str| {
        Proc::new(bin)
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    let ok = ok("ffmpeg") && ok("ffprobe");
    if !ok {
        eprintln!("SKIPPED: ffmpeg/ffprobe not found on PATH — export tests need a real FFmpeg");
    }
    ok
}

fn has_encoder(name: &str) -> bool {
    Proc::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(name))
        .unwrap_or(false)
}

fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/fonts")
        .canonicalize()
        .unwrap_or_else(|_| {
            // when this file is compiled from a scratch crate, fall back to the repo checkout
            PathBuf::from(option_env!("CUTLINE_FONTS_DIR").unwrap_or("web/fonts"))
        })
}

fn run(args: &[&str]) {
    let out = Proc::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .output()
        .expect("run ffmpeg");
    assert!(
        out.status.success(),
        "ffmpeg {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Generated source media + a project that knows about it.
struct Fixture {
    dir: tempfile::TempDir,
    project: Project,
    sources: BTreeMap<AssetId, MediaSource>,
}

impl Fixture {
    fn new(width: u32, height: u32, fps: FrameRate) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mut project = Project::new("p1", "Render Test", 0);
        project.settings.width = width;
        project.settings.height = height;
        project.settings.fps = fps;
        Fixture {
            dir,
            project,
            sources: BTreeMap::new(),
        }
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).to_string_lossy().to_string()
    }

    #[allow(clippy::too_many_arguments)]
    fn register(
        &mut self,
        id: &str,
        file: &str,
        kind: AssetKind,
        has_video: bool,
        has_audio: bool,
        w: u32,
        h: u32,
        seconds: f64,
        fps: Option<FrameRate>,
        channels: Option<u32>,
    ) {
        let duration = (seconds * S as f64).round() as i64;
        self.project.assets.insert(
            id.to_string(),
            AssetInfo {
                id: id.to_string(),
                name: file.to_string(),
                kind,
                duration,
                has_video,
                has_audio,
                width: w,
                height: h,
                fps,
                sample_rate: has_audio.then_some(48_000),
                channels,
            },
        );
        self.sources.insert(
            id.to_string(),
            MediaSource {
                path: self.path(file),
                kind,
                has_video,
                has_audio,
                width: w,
                height: h,
                duration,
                fps,
                channels,
            },
        );
    }

    /// 4 s, 160×120 @ 30: red, green, blue, white for one second each. No audio.
    fn add_rgbw(&mut self) {
        let p = self.path("rgbw.mp4");
        run(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=0xff0000:s=160x120:r=30:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x00ff00:s=160x120:r=30:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x0000ff:s=160x120:r=30:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=c=0xffffff:s=160x120:r=30:d=1",
            "-filter_complex",
            "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
            "-map",
            "[v]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "10",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "15",
            &p,
        ]);
        self.register(
            "rgbw",
            "rgbw.mp4",
            AssetKind::Video,
            true,
            false,
            160,
            120,
            4.0,
            Some(FrameRate::FPS_30),
            None,
        );
    }

    /// 6 s moving test pattern with a mono 440 Hz tone.
    fn add_pattern(&mut self) {
        let p = self.path("pattern.mp4");
        run(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=30:d=6",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:r=48000:d=6",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            &p,
        ]);
        self.register(
            "pattern",
            "pattern.mp4",
            AssetKind::Video,
            true,
            true,
            320,
            180,
            6.0,
            Some(FrameRate::FPS_30),
            Some(1),
        );
    }

    /// 3 s stereo 880 Hz tone (WAV).
    fn add_tone(&mut self) {
        let p = self.path("tone.wav");
        run(&[
            "-f",
            "lavfi",
            "-i",
            "sine=f=880:r=48000:d=3",
            "-af",
            "pan=stereo|c0=c0|c1=c0",
            "-c:a",
            "pcm_s16le",
            &p,
        ]);
        self.register(
            "tone",
            "tone.wav",
            AssetKind::Audio,
            false,
            true,
            0,
            0,
            3.0,
            None,
            Some(2),
        );
    }

    /// 200×200 solid yellow PNG.
    fn add_image(&mut self) {
        let p = self.path("yellow.png");
        run(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=0xffff00:s=200x200:d=1",
            "-frames:v",
            "1",
            &p,
        ]);
        self.register(
            "yellow",
            "yellow.png",
            AssetKind::Image,
            true,
            false,
            200,
            200,
            0.0,
            None,
            None,
        );
    }

    fn cmd(&mut self, c: Command) -> Vec<ClipId> {
        let applied = apply(&self.project, &c, &Env::default())
            .unwrap_or_else(|e| panic!("command {c:?} rejected: {e:?}"));
        self.project = applied.project;
        applied.created
    }

    fn track(&self, name: &str) -> TrackId {
        self.project
            .tracks
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("no track {name}"))
            .id
            .clone()
    }
}

fn t(seconds: f64) -> TimelineTime {
    TimelineTime((seconds * S as f64).round() as i64)
}
fn st(seconds: f64) -> SourceTime {
    SourceTime((seconds * S as f64).round() as i64)
}

struct Harness {
    manager: RenderManager,
    events: Arc<Mutex<Vec<RenderJob>>>,
    exports: PathBuf,
}

fn harness_with(exports: &Path, ffmpeg: &str, parallel: usize) -> Harness {
    let events: Arc<Mutex<Vec<RenderJob>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let fonts = fonts_dir();
    let manager = RenderManager::new(
        RenderConfig {
            ffmpeg: PathBuf::from(ffmpeg),
            ffprobe: PathBuf::from("ffprobe"),
            exports_dir: exports.to_path_buf(),
            env: RenderEnv {
                font_regular: fonts
                    .join("Inter-Regular.ttf")
                    .to_string_lossy()
                    .to_string(),
                font_bold: fonts.join("Inter-Bold.ttf").to_string_lossy().to_string(),
            },
            max_parallel_chunks: parallel,
        },
        Arc::new(move |job: &RenderJob| sink.lock().unwrap().push(job.clone())),
    );
    Harness {
        manager,
        events,
        exports: exports.to_path_buf(),
    }
}

async fn wait_done(m: &RenderManager, id: &str) -> RenderJob {
    for _ in 0..2400 {
        let job = m.get(id).expect("job exists");
        if job.state.is_terminal() {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("export did not finish in time");
}

fn settings(f: &Fixture) -> ExportSettings {
    ExportSettings {
        quality: Quality::Draft,
        ..ExportSettings::from_project(&f.project)
    }
}

fn start(h: &Harness, f: &Fixture, s: ExportSettings) -> RenderJob {
    let layers = resolve_layers(&f.project);
    h.manager
        .start(&f.project, &layers, f.sources.clone(), s)
        .expect("plan")
}

/// Set `CUTLINE_KEEP_RENDERS=/some/dir` to keep the rendered files for inspection.
fn keep(out: &Path, name: &str) {
    if let Ok(dir) = std::env::var("CUTLINE_KEEP_RENDERS") {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::copy(out, Path::new(&dir).join(name));
    }
}

// ---- probing helpers ----------------------------------------------------------------

fn probe(path: &Path) -> serde_json::Value {
    let out = Proc::new("ffprobe")
        .args(["-v", "error", "-count_packets", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,duration,sample_rate,channels", "-of", "json"])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn stream<'a>(p: &'a serde_json::Value, kind: &str) -> &'a serde_json::Value {
    p["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["codec_type"] == kind)
        .unwrap_or_else(|| panic!("no {kind} stream"))
}

fn num(v: &serde_json::Value) -> f64 {
    v.as_str()
        .map(|s| s.parse::<f64>().unwrap())
        .or_else(|| v.as_f64())
        .unwrap()
}

/// Decode output frame `n` to RGB.
fn frame_rgb(path: &Path, n: i64, w: u32, h: u32) -> Vec<u8> {
    let out = Proc::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vf",
            &format!("select=eq(n\\,{n})"),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .output()
        .unwrap();
    assert_eq!(
        out.stdout.len(),
        (w * h * 3) as usize,
        "frame {n} could not be decoded: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn px(frame: &[u8], w: u32, x: u32, y: u32) -> (i32, i32, i32) {
    let i = ((y * w + x) * 3) as usize;
    (frame[i] as i32, frame[i + 1] as i32, frame[i + 2] as i32)
}

fn near(a: (i32, i32, i32), b: (i32, i32, i32), tol: i32) -> bool {
    (a.0 - b.0).abs() <= tol && (a.1 - b.1).abs() <= tol && (a.2 - b.2).abs() <= tol
}

#[track_caller]
fn assert_px(frame: &[u8], w: u32, x: u32, y: u32, want: (i32, i32, i32), tol: i32, what: &str) {
    let got = px(frame, w, x, y);
    assert!(
        near(got, want, tol),
        "{what}: pixel ({x},{y}) is {got:?}, expected ≈{want:?}"
    );
}

/// RMS (0..1) of the output audio in `[start, start+len)` seconds.
fn rms(path: &Path, start: f64, len: f64) -> f64 {
    let out = Proc::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vn",
            "-af",
            &format!("atrim=start={start}:duration={len}"),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .unwrap();
    let samples: Vec<f64> = out
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0)
        .collect();
    assert!(
        !samples.is_empty(),
        "no audio decoded in [{start}, {}): {}",
        start + len,
        String::from_utf8_lossy(&out.stderr)
    );
    (samples.iter().map(|s| s * s).sum::<f64>() / samples.len() as f64).sqrt()
}

/// Strength of one frequency in a window (Goertzel), to tell the tones apart.
fn tone(path: &Path, start: f64, len: f64, freq: f64) -> f64 {
    let out = Proc::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vn",
            "-af",
            &format!("atrim=start={start}:duration={len}"),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .unwrap();
    let samples: Vec<f64> = out
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0)
        .collect();
    let w = 2.0 * std::f64::consts::PI * freq / 16000.0;
    let (mut re, mut im) = (0.0, 0.0);
    for (i, s) in samples.iter().enumerate() {
        re += s * (w * i as f64).cos();
        im += s * (w * i as f64).sin();
    }
    2.0 * (re * re + im * im).sqrt() / samples.len().max(1) as f64
}

#[cfg(target_os = "linux")]
fn processes_in(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return 0;
    };
    rd.flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .filter(|e| {
            std::fs::read_link(e.path().join("cwd"))
                .map(|p| p.starts_with(dir))
                .unwrap_or(false)
        })
        .count()
}

// ---- the composite timeline used by several tests ----------------------------------

struct Composite {
    f: Fixture,
}

/// 320×180 @ 30, 5 s:
///
/// * V1: rgbw[1s..3s] (green, blue) at 0–2 s · rgbw[0s..2s] at 2× (red, green) at 2–3 s ·
///   pattern[0s..2s] at 3–5 s; cross dissolve (0.4 s) on the cut at 2 s
/// * V2: yellow still as a small picture-in-picture, top right, 0.5–1.5 s, fading in;
///   a big text title with a red box at 3–4 s
/// * C1: a caption at 0–1 s
/// * A1: pattern's own (linked) audio at 3–5 s · A2: 880 Hz tone at 3.5–4.5 s, −6 dB
/// * A3 (muted): the tone again at 0–1 s — must stay silent
fn composite() -> Composite {
    let mut f = Fixture::new(320, 180, FrameRate::FPS_30);
    f.add_rgbw();
    f.add_pattern();
    f.add_tone();
    f.add_image();
    let v1 = f.track("V1");
    let v2 = f.track("V2");
    let a2 = f.track("A2");
    let c1 = f.cmd(Command::AddAssetClips {
        asset_id: "rgbw".into(),
        start: Some(t(0.0)),
        track_id: Some(v1.clone()),
        source_in: Some(st(1.0)),
        source_out: Some(st(3.0)),
        mode: Default::default(),
    });
    let c2 = f.cmd(Command::AddAssetClips {
        asset_id: "rgbw".into(),
        start: Some(t(2.0)),
        track_id: Some(v1.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(2.0)),
        mode: Default::default(),
    });
    f.cmd(Command::SetSpeed {
        clip_ids: c2.clone(),
        speed: 2.0,
        ripple: true,
    });
    f.cmd(Command::AddAssetClips {
        asset_id: "pattern".into(),
        start: Some(t(3.0)),
        track_id: Some(v1.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(2.0)),
        mode: Default::default(),
    });
    f.cmd(Command::AddTransitions {
        left_clip_ids: c1.clone(),
        kind: TransitionKind::CrossDissolve,
        duration: S * 4 / 10,
    });
    // picture in picture
    let pip = f.cmd(Command::AddAssetClips {
        asset_id: "yellow".into(),
        start: Some(t(0.5)),
        track_id: Some(v2.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(1.0)),
        mode: Default::default(),
    });
    f.cmd(Command::UpdateClips {
        clip_ids: pip,
        patch: ClipPatch {
            scale: Some(0.25),
            x: Some(0.3),
            y: Some(-0.3),
            fade_in: Some(S / 2),
            ..Default::default()
        },
    });
    // title
    let before: Vec<ClipId> = f.project.clips.keys().cloned().collect();
    f.cmd(Command::AddText {
        text: "HELLO".into(),
        start: t(3.0),
        duration: Some(S),
        track_id: Some(v2.clone()),
    });
    let title: Vec<ClipId> = f
        .project
        .clips
        .keys()
        .filter(|k| !before.contains(k))
        .cloned()
        .collect();
    f.cmd(Command::UpdateClips {
        clip_ids: title,
        patch: ClipPatch {
            font_size: Some(0.2),
            background: Some(Some("#ff0000".into())),
            shadow: Some(false),
            ..Default::default()
        },
    });
    // caption
    f.cmd(Command::AddCaptions {
        cues: vec![CueDraft {
            start: t(0.0),
            duration: S,
            text: "Caption one".into(),
            speaker: None,
            source: None,
        }],
        track_id: None,
    });
    // audio
    let tone = f.cmd(Command::AddAssetClips {
        asset_id: "tone".into(),
        start: Some(t(3.5)),
        track_id: Some(a2.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(1.0)),
        mode: Default::default(),
    });
    f.cmd(Command::UpdateClips {
        clip_ids: tone,
        patch: ClipPatch {
            gain_db: Some(-6.0),
            ..Default::default()
        },
    });
    f.cmd(Command::AddTrack {
        kind: TrackKind::Audio,
        name: Some("A3".into()),
    });
    let a3 = f.track("A3");
    f.cmd(Command::AddAssetClips {
        asset_id: "tone".into(),
        start: Some(t(0.0)),
        track_id: Some(a3.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(1.0)),
        mode: Default::default(),
    });
    f.cmd(Command::UpdateTrack {
        track_id: a3,
        name: None,
        muted: Some(true),
        solo: None,
        locked: None,
        hidden: None,
        gain_db: None,
    });
    assert_eq!(f.project.duration(), 5 * S);
    Composite { f }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn renders_a_real_composite_with_mixed_audio() {
    if !ffmpeg_available() {
        return;
    }
    let c = composite();
    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 2);
    let job = start(&h, &c.f, settings(&c.f));
    assert_eq!(job.state, RenderState::Queued);
    assert_eq!(job.total_frames, 150);
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(
        done.state,
        RenderState::Completed,
        "export failed: {:?}",
        done.error
    );
    assert_eq!(done.progress, 1.0);
    assert_eq!(done.frames_done, 150);
    assert_eq!(done.file_name.as_deref(), Some("Render Test.mp4"));
    let out = h
        .manager
        .output_path(&job.id)
        .expect("completed job has an output");
    assert!(out.is_file());
    keep(&out, "composite.mp4");
    assert_eq!(done.file_size, Some(std::fs::metadata(&out).unwrap().len()));
    assert!(done.file_size.unwrap() > 10_000);
    assert!(
        (done.output_duration_ms.unwrap() - 5000).abs() <= 45,
        "probed duration {:?}",
        done.output_duration_ms
    );

    // container facts
    let p = probe(&out);
    let v = stream(&p, "video");
    let a = stream(&p, "audio");
    assert_eq!(v["codec_name"], "h264");
    assert_eq!(
        (v["width"].as_i64(), v["height"].as_i64()),
        (Some(320), Some(180))
    );
    assert_eq!(v["avg_frame_rate"], "30/1");
    assert_eq!(v["nb_read_packets"], "150");
    assert!(
        (num(&v["duration"]) - 5.0).abs() <= 1.0 / 30.0 + 1e-6,
        "video duration {}",
        v["duration"]
    );
    assert_eq!(a["codec_name"], "aac");
    assert_eq!(a["sample_rate"], "48000");
    assert_eq!(a["channels"], 2);
    assert!(
        (num(&a["duration"]) - 5.0).abs() <= 0.05,
        "audio duration {}",
        a["duration"]
    );
    assert!((num(&p["format"]["duration"]) - 5.0).abs() <= 0.05);

    // --- pixels: it is really composited ---
    let (w, hh) = (320, 180);
    // 0.25 s: V1 shows rgbw from source 1.25 s = green, pillarboxed 240×180 at x=40
    let f = frame_rgb(&out, 7, w, hh);
    assert_px(
        &f,
        w,
        160,
        60,
        (0, 255, 0),
        22,
        "trimmed clip starts at the right source time (green)",
    );
    assert_px(
        &f,
        w,
        10,
        60,
        (0, 0, 0),
        12,
        "pillarbox shows the project background",
    );
    // caption box near the bottom (0–1 s)
    let cap = px(&f, w, 160, 151);
    assert!(cap.1 < 120, "caption box darkens the picture, got {cap:?}");
    // PIP not there yet at 0.25 s
    assert_px(
        &f,
        w,
        256,
        36,
        (0, 255, 0),
        22,
        "picture-in-picture has not started yet",
    );
    // 0.75 s: PIP is fading in (half-way) over green → between green and yellow
    let f = frame_rgb(&out, 22, w, hh);
    let mid = px(&f, w, 256, 36);
    assert!(
        mid.0 > 70 && mid.0 < 200 && mid.1 > 200 && mid.2 < 40,
        "PIP half faded in over green, got {mid:?}"
    );
    // 1.25 s: source 2.25 s = blue; PIP fully opaque yellow in the top right only
    let f = frame_rgb(&out, 37, w, hh);
    assert_px(
        &f,
        w,
        160,
        100,
        (0, 0, 255),
        22,
        "second half of the first clip is blue",
    );
    assert_px(
        &f,
        w,
        256,
        36,
        (255, 255, 0),
        22,
        "picture-in-picture is yellow",
    );
    assert_px(
        &f,
        w,
        256,
        70,
        (0, 0, 255),
        22,
        "PIP is 45 px tall (scaled), not full frame",
    );
    assert_px(
        &f,
        w,
        220,
        36,
        (0, 0, 255),
        22,
        "PIP is 45 px wide (scaled), not full frame",
    );
    // caption gone after 1 s
    assert_px(&f, w, 160, 151, (0, 0, 255), 22, "caption ended");
    // 2.0 s: middle of the dissolve — incoming red (held first frame) 50 % over the
    // outgoing clip's handle (white)
    let f = frame_rgb(&out, 60, w, hh);
    let d = px(&f, w, 160, 90);
    assert!(
        d.0 > 225 && (95..=165).contains(&d.1) && (95..=165).contains(&d.2),
        "cross dissolve mixes red over white, got {d:?}"
    );
    // 2.3 s: 2× clip, source 0.6 s → red;  2.8 s: source 1.6 s → green
    let f = frame_rgb(&out, 69, w, hh);
    assert_px(&f, w, 160, 90, (255, 0, 0), 22, "2× clip shows red first");
    let f = frame_rgb(&out, 84, w, hh);
    assert_px(
        &f,
        w,
        160,
        90,
        (0, 255, 0),
        22,
        "2× clip reaches green twice as fast",
    );
    // 3.5 s: title box (red) over the test pattern; text is white inside it
    let f = frame_rgb(&out, 105, w, hh);
    assert_px(&f, w, 160, 61, (255, 0, 0), 30, "title background box");
    let whites = (60..120)
        .flat_map(|y| (100..220).map(move |x| (x, y)))
        .filter(|&(x, y)| near(px(&f, w, x, y), (255, 255, 255), 40))
        .count();
    assert!(
        whites > 150,
        "title glyphs are drawn in white ({whites} px)"
    );
    // 4.5 s: title gone, the pattern is visible there instead
    let f = frame_rgb(&out, 135, w, hh);
    assert!(
        !near(px(&f, w, 160, 61), (255, 0, 0), 30),
        "title ended at 4 s"
    );

    // --- audio: really mixed ---
    assert!(rms(&out, 0.1, 0.8) < 0.002, "muted track must be silent");
    assert!(rms(&out, 1.2, 1.6) < 0.002, "nothing audible before 3 s");
    let only_a1 = rms(&out, 3.05, 0.4);
    assert!(
        only_a1 > 0.05,
        "A1 (pattern audio) audible from 3 s, rms {only_a1}"
    );
    let both = rms(&out, 3.6, 0.8);
    assert!(
        both > only_a1 * 1.08 && both < only_a1 * 1.2,
        "A2 (at −6 dB) adds to the mix ({both} vs {only_a1})"
    );
    assert!(
        tone(&out, 3.6, 0.8, 440.0) > 0.05 && tone(&out, 3.6, 0.8, 880.0) > 0.03,
        "both tones present while they overlap"
    );
    assert!(
        tone(&out, 3.05, 0.4, 880.0) < 0.01,
        "the 880 Hz tone only plays on its clip"
    );
    assert!(tone(&out, 4.6, 0.35, 880.0) < 0.01 && tone(&out, 4.6, 0.35, 440.0) > 0.05);
    // mono source is spread at unity: 0.125 amplitude sine → rms ≈ 0.088
    assert!(
        (only_a1 - 0.088).abs() < 0.02,
        "mono audio keeps its level, rms {only_a1}"
    );
    // −6 dB clip gain: 880 Hz component ≈ 0.125 × 0.5
    let t880 = tone(&out, 3.6, 0.8, 880.0);
    assert!(
        (t880 - 0.0625).abs() < 0.02,
        "clip gain applied, 880 Hz amplitude {t880}"
    );

    // --- progress events ---
    let events = h.events.lock().unwrap().clone();
    assert!(
        events.len() >= 4,
        "queued, rendering, finalizing, completed (+progress)"
    );
    for w in events.windows(2) {
        assert!(
            w[1].progress >= w[0].progress,
            "progress went backwards: {} → {}",
            w[0].progress,
            w[1].progress
        );
        assert!(w[1].frames_done >= w[0].frames_done);
    }
    assert!(events.iter().any(|e| e.state == RenderState::Rendering));
    assert!(events.iter().any(|e| e.state == RenderState::Finalizing));
    assert_eq!(events.last().unwrap().state, RenderState::Completed);
    assert_eq!(events.last().unwrap().progress, 1.0);

    // --- job dir is tidy and persisted ---
    let mut names: Vec<String> = std::fs::read_dir(h.exports.join(&job.id))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["job.json", "output.mp4"]);
    assert_eq!(h.manager.list("p1").len(), 1);
    assert!(h.manager.list("other").is_empty());

    // --- without the overlays the same frames differ (they were not baked into sources) ---
    let mut plain = settings(&c.f);
    plain.burn_captions = false;
    let job2 = start(&h, &c.f, plain);
    let done2 = wait_done(&h.manager, &job2.id).await;
    assert_eq!(done2.state, RenderState::Completed, "{:?}", done2.error);
    let out2 = h.manager.output_path(&job2.id).unwrap();
    let f2 = frame_rgb(&out2, 7, w, hh);
    assert_px(
        &f2,
        w,
        160,
        151,
        (0, 255, 0),
        22,
        "with burn_captions off the caption area shows the clip",
    );
    assert_eq!(h.manager.list("p1").len(), 2);
    assert_eq!(h.manager.list("p1")[0].id, job2.id, "newest first");

    // --- a restart keeps finished exports and fails interrupted ones ---
    let ghost = h.exports.join("ghost");
    std::fs::create_dir_all(&ghost).unwrap();
    let mut running = done.clone();
    running.id = "ghost".into();
    running.state = RenderState::Rendering;
    running.progress = 0.4;
    std::fs::write(
        ghost.join("job.json"),
        serde_json::to_vec(&running).unwrap(),
    )
    .unwrap();
    std::fs::write(ghost.join("chunk_0000.nut"), b"partial").unwrap();
    let h2 = harness_with(exports.path(), "ffmpeg", 2);
    let again = h2.manager.get(&job.id).expect("completed job reloaded");
    assert_eq!(again.state, RenderState::Completed);
    assert!(h2.manager.output_path(&job.id).is_some());
    let g = h2.manager.get("ghost").unwrap();
    assert_eq!(g.state, RenderState::Failed);
    assert_eq!(g.error.as_ref().unwrap().code, "interrupted");
    assert!(
        !ghost.join("chunk_0000.nut").exists(),
        "partial files of an interrupted export are removed"
    );
    assert!(h2.manager.output_path("ghost").is_none());

    // --- delete removes files ---
    assert!(h2.manager.delete(&job.id).await);
    assert!(!h.exports.join(&job.id).exists());
    assert!(h2.manager.get(&job.id).is_none());
    assert!(!h2.manager.delete("nope").await);
    h2.manager.delete_project("p1").await;
    assert!(h2.manager.list("p1").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multi_chunk_export_is_seamless_and_frame_exact() {
    if !ffmpeg_available() {
        return;
    }
    // 47 s at 29.97 fps: three chunks, a clip crossing both chunk boundaries with a
    // long fade that also crosses a boundary, and continuous audio.
    let mut f = Fixture::new(160, 90, FrameRate::FPS_29_97);
    f.add_image();
    f.add_tone();
    let fps = FrameRate::FPS_29_97;
    let frames = 1408; // ≈ 46.98 s
    let dur = fps.frame_to_ticks(frames);
    let v1 = f.track("V1");
    let a1 = f.track("A1");
    let img = f.cmd(Command::AddAssetClips {
        asset_id: "yellow".into(),
        start: Some(t(0.0)),
        track_id: Some(v1),
        source_in: Some(st(0.0)),
        source_out: Some(SourceTime(dur)),
        mode: Default::default(),
    });
    // fade out over the last 30 s: crosses the chunk boundary at ~40 s mid-ramp
    f.cmd(Command::UpdateClips {
        clip_ids: img,
        patch: ClipPatch {
            fade_out: Some(fps.frame_to_ticks(900)),
            ..Default::default()
        },
    });
    // loop the 3 s tone back to back so audio is continuous across chunk boundaries
    let mut at = 0i64;
    while at < dur {
        let len = (3 * S).min(dur - at);
        f.cmd(Command::AddAssetClips {
            asset_id: "tone".into(),
            start: Some(TimelineTime(fps.snap(at))),
            track_id: Some(a1.clone()),
            source_in: Some(st(0.0)),
            source_out: Some(SourceTime(len.max(fps.frame_ticks()))),
            mode: Default::default(),
        });
        at = f
            .project
            .clips
            .values()
            .filter(|c| c.track_id == a1)
            .map(|c| c.end().0)
            .max()
            .unwrap();
    }
    assert_eq!(f.project.duration(), dur);

    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 3);
    let job = start(&h, &f, settings(&f));
    assert_eq!(job.total_frames, frames);
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
    let out = h.manager.output_path(&job.id).unwrap();
    let p = probe(&out);
    let v = stream(&p, "video");
    assert_eq!(
        v["nb_read_packets"],
        frames.to_string(),
        "exact frame count across chunks"
    );
    assert_eq!(
        v["avg_frame_rate"], "30000/1001",
        "constant frame rate after concatenation"
    );
    assert!((num(&v["duration"]) - frames as f64 * 1001.0 / 30000.0).abs() < 0.002);

    // every frame is exactly one frame after the previous one (no gap at chunk joins)
    let pts = Proc::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_entries",
            "packet=pts",
            "-of",
            "csv=p=0",
        ])
        .arg(&out)
        .output()
        .unwrap();
    let mut pts: Vec<i64> = String::from_utf8_lossy(&pts.stdout)
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').parse().ok())
        .collect();
    pts.sort();
    assert_eq!(pts.len() as i64, frames);
    let deltas: std::collections::BTreeSet<i64> = pts.windows(2).map(|w| w[1] - w[0]).collect();
    assert_eq!(
        deltas.len(),
        1,
        "uniform frame spacing, got deltas {deltas:?}"
    );

    // the fade is continuous through the chunk boundary (frames 1198/1199 | 1200/1201)
    let lum = |n: i64| px(&frame_rgb(&out, n, 160, 90), 160, 80, 45).0;
    let (before, after) = (lum(1198), lum(1201));
    assert!(
        before > after && before - after <= 4,
        "fade continues smoothly across the chunk join: {before} → {after}"
    );
    let expect = |n: i64| 255.0 * (1.0 - (n - 508) as f64 / 900.0);
    for n in [600, 1000, 1198, 1201, 1350] {
        assert!(
            (lum(n) as f64 - expect(n)).abs() < 12.0,
            "fade level at frame {n}: {} vs {:.0}",
            lum(n),
            expect(n)
        );
    }
    assert!(lum(300) > 240, "fully visible before the fade starts");

    // audio is continuous through the joins: no silent hole around 20.02 s / 40.04 s
    for join in [20.02, 40.04] {
        let r = rms(&out, join - 0.05, 0.1);
        assert!(
            r > 0.06,
            "audio continues across the chunk join at {join} s (rms {r})"
        );
    }
    let a = stream(&p, "audio");
    assert!(
        (num(&a["duration"]) - num(&v["duration"])).abs() < 0.05,
        "audio and video have the same length"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_stops_ffmpeg_and_leaves_no_output() {
    if !ffmpeg_available() {
        return;
    }
    // heavy enough to still be running when we cancel
    let mut f = Fixture::new(1920, 1080, FrameRate::FPS_60);
    f.add_pattern();
    let v1 = f.track("V1");
    for i in 0..10 {
        f.cmd(Command::AddAssetClips {
            asset_id: "pattern".into(),
            start: Some(t(i as f64 * 6.0)),
            track_id: Some(v1.clone()),
            source_in: None,
            source_out: None,
            mode: Default::default(),
        });
    }
    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 2);
    let mut s = settings(&f);
    s.quality = Quality::High;
    let job = start(&h, &f, s);
    // wait until FFmpeg is really producing frames
    for _ in 0..400 {
        if h.manager.get(&job.id).unwrap().frames_done > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let running = h.manager.get(&job.id).unwrap();
    assert_eq!(running.state, RenderState::Rendering);
    assert!(running.frames_done > 0 && running.progress > 0.0 && running.progress < 1.0);
    let dir = h.exports.join(&job.id);
    #[cfg(target_os = "linux")]
    assert!(
        processes_in(&dir) >= 1,
        "ffmpeg children are running in the job dir"
    );

    let cancelled = h.manager.cancel(&job.id).await.unwrap();
    assert_eq!(cancelled.state, RenderState::Cancelled);
    assert!(cancelled.error.is_none());
    assert!(h.manager.output_path(&job.id).is_none());
    assert!(!dir.join("output.mp4").exists());
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        vec!["job.json"],
        "cancelled export leaves only its record"
    );
    #[cfg(target_os = "linux")]
    {
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(processes_in(&dir), 0, "no ffmpeg process survives a cancel");
    }
    // cancelling again is a no-op; state stays cancelled and no more events arrive
    let n = h.events.lock().unwrap().len();
    assert_eq!(
        h.manager.cancel(&job.id).await.unwrap().state,
        RenderState::Cancelled
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.events.lock().unwrap().len(), n);
    assert_eq!(
        h.events.lock().unwrap().last().unwrap().state,
        RenderState::Cancelled
    );
    assert!(h.manager.cancel("unknown").await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failures_are_actionable() {
    if !ffmpeg_available() {
        return;
    }
    let mut f = Fixture::new(320, 180, FrameRate::FPS_30);
    f.add_rgbw();
    let v1 = f.track("V1");
    f.cmd(Command::AddAssetClips {
        asset_id: "rgbw".into(),
        start: Some(t(0.0)),
        track_id: Some(v1),
        source_in: None,
        source_out: None,
        mode: Default::default(),
    });
    let exports = tempfile::tempdir().unwrap();

    // 1. planning errors are returned synchronously, no job is created
    let h = harness_with(exports.path(), "ffmpeg", 1);
    let layers = resolve_layers(&f.project);
    let mut odd = settings(&f);
    odd.width = 321;
    let err = h
        .manager
        .start(&f.project, &layers, f.sources.clone(), odd)
        .unwrap_err();
    assert_eq!(err.code(), "invalid_settings");
    let err = h
        .manager
        .start(&f.project, &layers, BTreeMap::new(), settings(&f))
        .unwrap_err();
    assert_eq!(err.code(), "missing_source");
    assert!(err.to_string().contains("rgbw.mp4"), "{err}");
    let empty = Project::new("p2", "Empty", 0);
    assert_eq!(
        h.manager
            .start(
                &empty,
                &[],
                BTreeMap::new(),
                ExportSettings::from_project(&empty)
            )
            .unwrap_err()
            .code(),
        "empty_timeline"
    );
    assert!(h.manager.list("p1").is_empty());

    // 2. the source file vanished from disk
    let mut gone = f.sources.clone();
    gone.get_mut("rgbw").unwrap().path = f.path("deleted.mp4");
    let job = h
        .manager
        .start(&f.project, &layers, gone, settings(&f))
        .unwrap();
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Failed);
    let e = done.error.unwrap();
    assert_eq!(e.code, "source_missing");
    assert!(
        e.message.contains("rgbw.mp4"),
        "names the asset: {}",
        e.message
    );
    assert!(e.hint.unwrap().to_lowercase().contains("re-import"));
    assert!(h.manager.output_path(&job.id).is_none());

    // 3. a file that is not media at all
    std::fs::write(f.path("garbage.mp4"), b"this is not a video").unwrap();
    let mut garbage = f.sources.clone();
    garbage.get_mut("rgbw").unwrap().path = f.path("garbage.mp4");
    let job = h
        .manager
        .start(&f.project, &layers, garbage, settings(&f))
        .unwrap();
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Failed);
    let e = done.error.unwrap();
    assert_eq!(e.code, "source_unreadable", "{e:?}");
    assert!(e.log_tail.is_some() && e.hint.is_some());

    // 4. FFmpeg itself is missing
    let h_bad = harness_with(exports.path(), "/nonexistent/bin/ffmpeg", 1);
    let job = start(&h_bad, &f, settings(&f));
    let done = wait_done(&h_bad.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Failed);
    let e = done.error.unwrap();
    assert_eq!(e.code, "ffmpeg_not_found");
    assert!(e.message.contains("/nonexistent/bin/ffmpeg"));
    assert!(e.hint.unwrap().contains("Install FFmpeg"));
    let names: Vec<String> = std::fs::read_dir(h_bad.exports.join(&job.id))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["job.json"]);
    assert_eq!(
        h_bad.events.lock().unwrap().last().unwrap().state,
        RenderState::Failed
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exports_4k_at_60_fps() {
    if !ffmpeg_available() {
        return;
    }
    let mut f = Fixture::new(3840, 2160, FrameRate::FPS_60);
    f.add_pattern();
    f.add_image();
    let v1 = f.track("V1");
    let v2 = f.track("V2");
    f.cmd(Command::AddAssetClips {
        asset_id: "pattern".into(),
        start: Some(t(0.0)),
        track_id: Some(v1),
        source_in: Some(st(1.0)),
        source_out: Some(st(1.4)),
        mode: Default::default(),
    });
    let pip = f.cmd(Command::AddAssetClips {
        asset_id: "yellow".into(),
        start: Some(t(0.0)),
        track_id: Some(v2.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(0.4)),
        mode: Default::default(),
    });
    f.cmd(Command::UpdateClips {
        clip_ids: pip,
        patch: ClipPatch {
            scale: Some(0.2),
            x: Some(-0.35),
            y: Some(0.3),
            rotation: Some(15.0),
            ..Default::default()
        },
    });
    f.cmd(Command::AddText {
        text: "4K60".into(),
        start: t(0.0),
        duration: Some(S * 4 / 10),
        track_id: None,
    });
    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 1);
    let job = start(&h, &f, settings(&f));
    assert_eq!(job.total_frames, 24);
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
    let out = h.manager.output_path(&job.id).unwrap();
    let p = probe(&out);
    let v = stream(&p, "video");
    assert_eq!(
        (v["width"].as_i64(), v["height"].as_i64()),
        (Some(3840), Some(2160))
    );
    assert_eq!(v["avg_frame_rate"], "60/1");
    assert_eq!(v["nb_read_packets"], "24");
    // rotated PIP: its centre is yellow
    let fr = frame_rgb(&out, 12, 3840, 2160);
    assert_px(
        &fr,
        3840,
        (1920.0 - 0.35 * 3840.0) as u32,
        (1080.0 + 0.3 * 2160.0) as u32,
        (255, 255, 0),
        25,
        "rotated picture-in-picture centre",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn other_codecs_and_transforms() {
    if !ffmpeg_available() {
        return;
    }
    // slide + push transitions, crop, flip, colour, opacity, rotated text, dip to black
    let mut f = Fixture::new(320, 180, FrameRate::FPS_30);
    f.add_rgbw();
    f.add_pattern();
    let v1 = f.track("V1");
    let v2 = f.track("V2");
    let add = |f: &mut Fixture, at: f64, a: f64, b: f64, track: &TrackId| {
        f.cmd(Command::AddAssetClips {
            asset_id: "rgbw".into(),
            start: Some(t(at)),
            track_id: Some(track.clone()),
            source_in: Some(st(a)),
            source_out: Some(st(b)),
            mode: Default::default(),
        })
    };
    // 0.6 s from the middle of each colour second, so transition handles keep the colour
    let red = add(&mut f, 0.0, 0.2, 0.8, &v1);
    let green = add(&mut f, 0.6, 1.2, 1.8, &v1);
    let blue = add(&mut f, 1.2, 2.2, 2.8, &v1);
    let white = add(&mut f, 1.8, 3.2, 3.8, &v1);
    f.cmd(Command::AddTransitions {
        left_clip_ids: red.clone(),
        kind: TransitionKind::Slide,
        duration: S * 4 / 10,
    });
    f.cmd(Command::AddTransitions {
        left_clip_ids: green.clone(),
        kind: TransitionKind::Push,
        duration: S * 4 / 10,
    });
    f.cmd(Command::AddTransitions {
        left_clip_ids: blue.clone(),
        kind: TransitionKind::DipToBlack,
        duration: S * 4 / 10,
    });
    assert_eq!(f.project.transitions.len(), 3);
    // desaturate + darken the white clip → mid grey
    f.cmd(Command::UpdateClips {
        clip_ids: white,
        patch: ClipPatch {
            brightness: Some(0.5),
            saturation: Some(0.0),
            ..Default::default()
        },
    });
    // semi-transparent, cropped, mirrored overlay of red on V2 at 1.4–1.8 s
    let over = add(&mut f, 1.4, 0.2, 0.6, &v2);
    f.cmd(Command::UpdateClips {
        clip_ids: over,
        patch: ClipPatch {
            opacity: Some(0.5),
            crop_left: Some(0.5),
            flip_h: Some(true),
            scale: Some(0.5),
            ..Default::default()
        },
    });
    // rotated title during the first 0.4 s
    let before: Vec<ClipId> = f.project.clips.keys().cloned().collect();
    f.cmd(Command::AddText {
        text: "TILTED".into(),
        start: t(0.0),
        duration: Some(S * 4 / 10),
        track_id: Some(v2.clone()),
    });
    let title: Vec<ClipId> = f
        .project
        .clips
        .keys()
        .filter(|k| !before.contains(k))
        .cloned()
        .collect();
    f.cmd(Command::UpdateClips {
        clip_ids: title,
        patch: ClipPatch {
            rotation: Some(90.0),
            font_size: Some(0.2),
            text_color: Some("#00ffff".into()),
            shadow: Some(false),
            ..Default::default()
        },
    });
    assert_eq!(f.project.duration(), S * 24 / 10);

    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 2);
    let job = start(&h, &f, settings(&f));
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
    let out = h.manager.output_path(&job.id).unwrap();
    keep(&out, "transforms.mp4");
    let (w, hh) = (320, 180);
    // rotated cyan text is visible at 0.2 s on the red clip
    let fr = frame_rgb(&out, 6, w, hh);
    let cyan = (0..hh)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| near(px(&fr, w, x, y), (0, 255, 255), 70))
        .collect::<Vec<_>>();
    assert!(cyan.len() > 200, "rotated title drawn ({} px)", cyan.len());
    let (min_x, max_x) = (
        cyan.iter().map(|p| p.0).min().unwrap(),
        cyan.iter().map(|p| p.0).max().unwrap(),
    );
    let (min_y, max_y) = (
        cyan.iter().map(|p| p.1).min().unwrap(),
        cyan.iter().map(|p| p.1).max().unwrap(),
    );
    assert!(
        max_y - min_y > 2 * (max_x - min_x),
        "90° rotation turns the wide title upright ({min_x}..{max_x} × {min_y}..{max_y})"
    );
    assert!(
        (min_x + max_x) / 2 > 140
            && (min_x + max_x) / 2 < 180
            && (min_y + max_y) / 2 > 70
            && (min_y + max_y) / 2 < 110,
        "rotated about its centre"
    );
    // slide, half way at the 0.6 s cut: incoming green covers the right, red stays put
    let fr = frame_rgb(&out, 18, w, hh);
    assert_px(
        &fr,
        w,
        100,
        90,
        (255, 0, 0),
        25,
        "slide: outgoing clip stays put",
    );
    assert_px(
        &fr,
        w,
        250,
        90,
        (0, 255, 0),
        25,
        "slide: incoming clip half way in from the right",
    );
    // exactly half way: the incoming clip's left edge is at 40 + 160 = 200
    assert_px(
        &fr,
        w,
        195,
        90,
        (255, 0, 0),
        25,
        "slide progress is exactly 50 % at the cut (left of the edge)",
    );
    assert_px(
        &fr,
        w,
        205,
        90,
        (0, 255, 0),
        25,
        "slide progress is exactly 50 % at the cut (right of the edge)",
    );
    // push, half way at the 1.2 s cut: green leaves to the left, blue follows from the right
    let fr = frame_rgb(&out, 36, w, hh);
    assert_px(
        &fr,
        w,
        60,
        90,
        (0, 255, 0),
        25,
        "push: outgoing clip moves out to the left",
    );
    assert_px(
        &fr,
        w,
        250,
        90,
        (0, 0, 255),
        25,
        "push: incoming clip follows from the right",
    );
    assert_px(
        &fr,
        w,
        160,
        90,
        (0, 0, 0),
        25,
        "push: the gap between the pillarboxed clips shows the background",
    );
    assert_px(
        &fr,
        w,
        115,
        90,
        (0, 255, 0),
        25,
        "push: outgoing right edge at 120",
    );
    assert_px(
        &fr,
        w,
        125,
        90,
        (0, 0, 0),
        25,
        "push: outgoing right edge at 120",
    );
    assert_px(
        &fr,
        w,
        195,
        90,
        (0, 0, 0),
        25,
        "push: incoming left edge at 200",
    );
    assert_px(
        &fr,
        w,
        205,
        90,
        (0, 0, 255),
        25,
        "push: incoming left edge at 200",
    );
    // overlay at 1.5 s: 50 % red over blue in the centre region only
    let fr = frame_rgb(&out, 45, w, hh);
    let o = px(&fr, w, 160, 90);
    assert!(
        (90..=165).contains(&o.0) && o.1 < 30 && (90..=165).contains(&o.2),
        "50 % opacity overlay blends red over blue, got {o:?}"
    );
    assert_px(
        &fr,
        w,
        160,
        20,
        (0, 0, 255),
        25,
        "cropped + scaled overlay does not cover the top",
    );
    assert_px(
        &fr,
        w,
        110,
        90,
        (0, 0, 255),
        25,
        "cropped overlay is 60 px wide",
    );
    // dip to black at the 1.8 s cut
    let fr = frame_rgb(&out, 54, w, hh);
    assert_px(
        &fr,
        w,
        160,
        90,
        (0, 0, 0),
        25,
        "dip to black reaches black at the cut",
    );
    // colour: white × 0.5 brightness, desaturated → mid grey
    let fr = frame_rgb(&out, 66, w, hh);
    assert_px(
        &fr,
        w,
        160,
        90,
        (128, 128, 128),
        14,
        "brightness/saturation applied",
    );

    // HEVC and VP9 produce playable files with the right codecs
    for (codec, name, encoder, audio) in [
        (VideoCodec::Hevc, "hevc", "libx265", "aac"),
        (VideoCodec::Vp9, "vp9", "libvpx-vp9", "opus"),
    ] {
        if !has_encoder(encoder) {
            eprintln!("SKIPPED {name}: this FFmpeg has no {encoder}");
            continue;
        }
        let mut s = settings(&f);
        s.video_codec = codec;
        s.range = Some((t(0.3), t(1.5)));
        let job = start(&h, &f, s);
        assert_eq!(job.total_frames, 36, "range export");
        let done = wait_done(&h.manager, &job.id).await;
        assert_eq!(
            done.state,
            RenderState::Completed,
            "{name}: {:?}",
            done.error
        );
        let out = h.manager.output_path(&job.id).unwrap();
        let p = probe(&out);
        assert_eq!(stream(&p, "video")["codec_name"], name);
        assert_eq!(stream(&p, "audio")["codec_name"], audio);
        assert_eq!(stream(&p, "video")["nb_read_packets"], "36");
        assert!(done
            .file_name
            .unwrap()
            .ends_with(if codec == VideoCodec::Vp9 {
                ".webm"
            } else {
                ".mp4"
            }));
        // the range starts at 0.3 s of the timeline: still red; green by 0.97 s
        let fr = frame_rgb(&out, 2, w, hh);
        assert_px(
            &fr,
            w,
            100,
            100,
            (255, 0, 0),
            30,
            "range export starts inside the first clip",
        );
        let fr = frame_rgb(&out, 20, w, hh);
        assert_px(
            &fr,
            w,
            100,
            100,
            (0, 255, 0),
            30,
            "range export keeps timeline order",
        );
    }
}

/// Cuts land on exactly the right source frame: a source whose every frame has a
/// unique grey level is cut, re-ordered and sped up, and each output frame is
/// compared with the source frame it must show.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cuts_are_frame_accurate() {
    if !ffmpeg_available() {
        return;
    }
    let mut f = Fixture::new(160, 120, FrameRate::FPS_30);
    let src = f.path("ramp.mp4");
    run(&[
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x120:r=30:d=2,geq=lum='16+N*3.5':cb=128:cr=128",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "8",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "12",
        &src,
    ]);
    f.register(
        "ramp",
        "ramp.mp4",
        AssetKind::Video,
        true,
        false,
        160,
        120,
        2.0,
        Some(FrameRate::FPS_30),
        None,
    );
    let fps = FrameRate::FPS_30;
    let fr = |n: i64| fps.frame_to_ticks(n);
    let v1 = f.track("V1");
    let add = |f: &mut Fixture, at: i64, a: i64, b: i64| {
        f.cmd(Command::AddAssetClips {
            asset_id: "ramp".into(),
            start: Some(TimelineTime(fr(at))),
            track_id: Some(v1.clone()),
            source_in: Some(SourceTime(fr(a))),
            source_out: Some(SourceTime(fr(b))),
            mode: Default::default(),
        })
    };
    // Reference: the whole source laid out 1:1, rendered through the same pipeline.
    let exports = tempfile::tempdir().unwrap();
    let h = harness_with(exports.path(), "ffmpeg", 2);
    let mut s = settings(&f);
    s.quality = Quality::High;
    add(&mut f, 0, 0, 60);
    let job = start(&h, &f, s.clone());
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
    let reference = h.manager.output_path(&job.id).unwrap();
    let level = |path: &Path, n: i64| px(&frame_rgb(path, n, 160, 120), 160, 80, 60).0;
    let source: Vec<i32> = (0..60).map(|n| level(&reference, n)).collect();
    assert!(
        source[1..].windows(2).all(|w| w[1] - w[0] >= 3),
        "an uncut clip plays its source frames 1:1: {source:?}"
    );

    // Now cut it up.
    let all: Vec<ClipId> = f.project.clips.keys().cloned().collect();
    f.cmd(Command::DeleteClips {
        clip_ids: all,
        ripple: false,
    });
    add(&mut f, 0, 17, 30); // out 0..13   ← src 17..30
    add(&mut f, 13, 40, 50); // out 13..23 ← src 40..50
    let fast = add(&mut f, 23, 10, 30); // out 23..33 ← src 10,12,…,28 at 2×
    f.cmd(Command::SetSpeed {
        clip_ids: fast,
        speed: 2.0,
        ripple: true,
    });
    add(&mut f, 33, 3, 9); // out 33..39   ← src 3..9
    assert_eq!(f.project.duration(), fr(39));
    let job = start(&h, &f, s);
    let done = wait_done(&h.manager, &job.id).await;
    assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
    let out = h.manager.output_path(&job.id).unwrap();

    let expect = |out_frame: i64| -> i64 {
        match out_frame {
            0..=12 => 17 + out_frame,
            13..=22 => 40 + (out_frame - 13),
            23..=32 => 10 + 2 * (out_frame - 23),
            _ => 3 + (out_frame - 33),
        }
    };
    for n in 0..39 {
        let got = level(&out, n);
        let want = source[expect(n) as usize];
        assert!(
            (got - want).abs() <= 1,
            "output frame {n} should show source frame {} (level {want}), got level {got}",
            expect(n)
        );
    }
}

/// Benchmark, not a correctness test: `cargo test -p cutline-server --test render_e2e -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark"]
async fn bench_1080p30_ten_seconds() {
    if !ffmpeg_available() {
        return;
    }
    let mut f = Fixture::new(1920, 1080, FrameRate::FPS_30);
    let p = f.path("hd.mp4");
    run(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1920x1080:r=30:d=12",
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:r=48000:d=12",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        &p,
    ]);
    f.register(
        "hd",
        "hd.mp4",
        AssetKind::Video,
        true,
        true,
        1920,
        1080,
        12.0,
        Some(FrameRate::FPS_30),
        Some(1),
    );
    f.add_image();
    let (v1, v2) = (f.track("V1"), f.track("V2"));
    f.cmd(Command::AddAssetClips {
        asset_id: "hd".into(),
        start: Some(t(0.0)),
        track_id: Some(v1.clone()),
        source_in: Some(st(0.0)),
        source_out: Some(st(5.0)),
        mode: Default::default(),
    });
    f.cmd(Command::AddAssetClips {
        asset_id: "hd".into(),
        start: Some(t(5.0)),
        track_id: Some(v1),
        source_in: Some(st(6.0)),
        source_out: Some(st(11.0)),
        mode: Default::default(),
    });
    let pip = f.cmd(Command::AddAssetClips {
        asset_id: "yellow".into(),
        start: Some(t(2.0)),
        track_id: Some(v2),
        source_in: Some(st(0.0)),
        source_out: Some(st(4.0)),
        mode: Default::default(),
    });
    f.cmd(Command::UpdateClips {
        clip_ids: pip,
        patch: ClipPatch {
            scale: Some(0.3),
            x: Some(0.3),
            y: Some(-0.25),
            ..Default::default()
        },
    });
    f.cmd(Command::AddText {
        text: "Benchmark title".into(),
        start: t(0.0),
        duration: Some(4 * S),
        track_id: None,
    });
    f.cmd(Command::AddCaptions {
        cues: (0..5)
            .map(|i| CueDraft {
                start: t(i as f64 * 2.0),
                duration: 2 * S,
                text: format!("Caption number {i}"),
                speaker: None,
                source: None,
            })
            .collect(),
        track_id: None,
    });
    let exports = tempfile::tempdir().unwrap();
    for (label, quality) in [
        ("draft", Quality::Draft),
        ("standard", Quality::Standard),
        ("high", Quality::High),
    ] {
        let h = harness_with(exports.path(), "ffmpeg", 2);
        let started = std::time::Instant::now();
        let job = start(
            &h,
            &f,
            ExportSettings {
                quality,
                ..ExportSettings::from_project(&f.project)
            },
        );
        let done = wait_done(&h.manager, &job.id).await;
        assert_eq!(done.state, RenderState::Completed, "{:?}", done.error);
        let secs = started.elapsed().as_secs_f64();
        println!(
            "1080p30 10 s, H.264 {label}: {secs:.2} s wall ({:.0} fps, {:.1}× realtime), {} KiB",
            300.0 / secs,
            10.0 / secs,
            done.file_size.unwrap() / 1024
        );
    }
}
