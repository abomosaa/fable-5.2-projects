//! Render-plan generation: pure tests (no FFmpeg is executed here; the server crate's
//! `render_e2e` tests run the plans for real).

use cutline_core::commands::{apply, ClipPatch, Command, CueDraft};
use cutline_core::model::*;
use cutline_core::render::*;
use cutline_core::resolve::resolve_layers;
use cutline_core::time::{ticks_to_samples, FrameRate, SourceTime, TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::Env;
use std::collections::BTreeMap;

const S: i64 = TICKS_PER_SECOND;

struct Fx {
    p: Project,
    sources: BTreeMap<AssetId, MediaSource>,
}

fn env() -> RenderEnv {
    RenderEnv {
        font_regular: "/fonts/Inter-Regular.ttf".into(),
        font_bold: "/fonts/Inter-Bold.ttf".into(),
    }
}

impl Fx {
    fn new(w: u32, h: u32, fps: FrameRate) -> Fx {
        let mut p = Project::new("p", "Plan", 0);
        p.settings.width = w;
        p.settings.height = h;
        p.settings.fps = fps;
        let mut fx = Fx {
            p,
            sources: BTreeMap::new(),
        };
        // "movie": 1920×1080 30 fps, 10 min, stereo sound
        fx.asset(
            "movie",
            AssetKind::Video,
            true,
            true,
            1920,
            1080,
            600.0,
            Some(FrameRate::FPS_30),
            Some(2),
        );
        // "voice": mono audio, 10 min
        fx.asset(
            "voice",
            AssetKind::Audio,
            false,
            true,
            0,
            0,
            600.0,
            None,
            Some(1),
        );
        // "photo": 4000×3000 still
        fx.asset(
            "photo",
            AssetKind::Image,
            true,
            false,
            4000,
            3000,
            0.0,
            None,
            None,
        );
        fx
    }

    #[allow(clippy::too_many_arguments)]
    fn asset(
        &mut self,
        id: &str,
        kind: AssetKind,
        v: bool,
        a: bool,
        w: u32,
        h: u32,
        secs: f64,
        fps: Option<FrameRate>,
        channels: Option<u32>,
    ) {
        let duration = (secs * S as f64) as i64;
        self.p.assets.insert(
            id.into(),
            AssetInfo {
                id: id.into(),
                name: format!("{id}.file"),
                kind,
                duration,
                has_video: v,
                has_audio: a,
                width: w,
                height: h,
                fps,
                sample_rate: a.then_some(48_000),
                channels,
            },
        );
        self.sources.insert(
            id.into(),
            MediaSource {
                path: format!("/media/{id}.file"),
                kind,
                has_video: v,
                has_audio: a,
                width: w,
                height: h,
                duration,
                fps,
                channels,
            },
        );
    }

    fn cmd(&mut self, c: Command) -> Vec<ClipId> {
        let a =
            apply(&self.p, &c, &Env::default()).unwrap_or_else(|e| panic!("{c:?} rejected: {e:?}"));
        self.p = a.project;
        a.created
    }

    fn track(&self, name: &str) -> TrackId {
        self.p
            .tracks
            .iter()
            .find(|t| t.name == name)
            .unwrap()
            .id
            .clone()
    }

    /// Place `asset[src_in, src_out)` at `at` on the named track.
    fn add(&mut self, asset: &str, track: &str, at: f64, src_in: f64, src_out: f64) -> Vec<ClipId> {
        let track_id = self.track(track);
        self.cmd(Command::AddAssetClips {
            asset_id: asset.into(),
            start: Some(t(at)),
            track_id: Some(track_id),
            source_in: Some(st(src_in)),
            source_out: Some(st(src_out)),
            mode: Default::default(),
        })
    }

    fn patch(&mut self, ids: &[ClipId], patch: ClipPatch) {
        self.cmd(Command::UpdateClips {
            clip_ids: ids.to_vec(),
            patch,
        });
    }

    fn text(&mut self, text: &str, at: f64, secs: f64) -> ClipId {
        let before: Vec<ClipId> = self.p.clips.keys().cloned().collect();
        let v2 = self.track("V2");
        self.cmd(Command::AddText {
            text: text.into(),
            start: t(at),
            duration: Some((secs * S as f64) as i64),
            track_id: Some(v2),
        });
        self.p
            .clips
            .keys()
            .find(|k| !before.contains(k))
            .unwrap()
            .clone()
    }

    fn settings(&self) -> ExportSettings {
        ExportSettings::from_project(&self.p)
    }

    fn plan_with(&self, s: &ExportSettings) -> RenderPlan {
        build_plan(&self.p, &resolve_layers(&self.p), &self.sources, s, &env()).expect("plan")
    }

    fn plan(&self) -> RenderPlan {
        self.plan_with(&self.settings())
    }
}

fn t(seconds: f64) -> TimelineTime {
    TimelineTime((seconds * S as f64).round() as i64)
}
fn st(seconds: f64) -> SourceTime {
    SourceTime((seconds * S as f64).round() as i64)
}

fn arg_after<'a>(args: &'a [String], flag: &str) -> &'a str {
    let i = args
        .iter()
        .position(|a| a == flag)
        .unwrap_or_else(|| panic!("no {flag} in {args:?}"));
    &args[i + 1]
}

fn video_input<'a>(chunk: &'a ChunkPlan, clip: &str) -> &'a PlanInput {
    chunk
        .inputs
        .iter()
        .find(|i| i.clip_id == clip && i.role != InputRole::Audio)
        .unwrap_or_else(|| panic!("no picture input for {clip}"))
}
fn audio_input<'a>(chunk: &'a ChunkPlan, clip: &str) -> &'a PlanInput {
    chunk
        .inputs
        .iter()
        .find(|i| i.clip_id == clip && i.role == InputRole::Audio)
        .unwrap_or_else(|| panic!("no audio input for {clip}"))
}
/// Filter chain fed by a given input index (`[3:v]…` / `[3:a]…`).
fn chain_of_input(chunk: &ChunkPlan, input: &PlanInput) -> String {
    let v = format!("[{}:v]", input.index);
    let a = format!("[{}:a]", input.index);
    chunk
        .filter_complex
        .split(';')
        .find(|p| p.starts_with(&v) || p.starts_with(&a))
        .unwrap_or_else(|| panic!("input {} unused", input.index))
        .to_string()
}

// ---------------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------------

#[test]
fn chunks_are_frame_aligned_contiguous_and_cover_the_timeline() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 65.0);
    let plan = fx.plan();
    assert_eq!(plan.total_frames, 65 * 30);
    assert_eq!(plan.duration, 65 * S);
    assert_eq!((plan.start, plan.end), (t(0.0), t(65.0)));
    let lens: Vec<i64> = plan.chunks.iter().map(|c| c.frames).collect();
    assert_eq!(lens, vec![600, 600, 600, 150], "≤ 20 s per chunk");
    let mut cursor = 0;
    let mut samples = 0;
    for (i, c) in plan.chunks.iter().enumerate() {
        assert_eq!(c.index, i);
        assert_eq!(c.first_frame, cursor, "chunks are contiguous");
        assert_eq!(
            c.start,
            TimelineTime(FrameRate::FPS_30.frame_to_ticks(cursor))
        );
        assert_eq!(
            c.end,
            TimelineTime(FrameRate::FPS_30.frame_to_ticks(cursor + c.frames))
        );
        assert!(FrameRate::FPS_30.is_aligned(c.start.0) && FrameRate::FPS_30.is_aligned(c.end.0));
        assert_eq!(
            arg_after(&c.args, "-frames:v"),
            c.frames.to_string(),
            "exact frame count per chunk"
        );
        assert_eq!(c.args.last().unwrap(), &format!("chunk_{i:04}.nut"));
        assert_eq!(c.output_name, format!("chunk_{i:04}.nut"));
        assert_eq!(arg_after(&c.args, "-f"), "nut");
        assert!(
            c.filter_complex
                .contains(&format!("trim=end_frame={}", c.frames)),
            "base canvas is exactly as long as the chunk"
        );
        assert!(
            c.filter_complex
                .contains(&format!("atrim=end_sample={}", c.samples)),
            "audio bed is exactly as long as the chunk"
        );
        cursor += c.frames;
        samples += c.samples;
    }
    assert_eq!(cursor, plan.total_frames, "frame counts add up");
    assert_eq!(samples, 65 * 48_000, "sample counts add up");
    assert_eq!(
        plan.concat_list,
        "ffconcat version 1.0\nfile 'chunk_0000.nut'\nduration 20.000000\nfile 'chunk_0001.nut'\nduration 20.000000\nfile 'chunk_0002.nut'\nduration 20.000000\nfile 'chunk_0003.nut'\nduration 5.000000\n"
    );
    assert_eq!(plan.concat_list_name, "chunks.ffconcat");
    assert_eq!(arg_after(&plan.final_args, "-i"), "chunks.ffconcat");
}

#[test]
fn chunk_durations_are_whole_microseconds_at_every_frame_rate() {
    for fps in [
        FrameRate::FPS_23_976,
        FrameRate::FPS_24,
        FrameRate::FPS_25,
        FrameRate::FPS_29_97,
        FrameRate::FPS_30,
        FrameRate::FPS_50,
        FrameRate::FPS_59_94,
        FrameRate::FPS_60,
    ] {
        let mut fx = Fx::new(640, 360, fps);
        fx.add("movie", "V1", 0.0, 0.0, 47.3);
        let plan = fx.plan();
        assert!(plan.chunks.len() >= 3, "{fps:?}");
        let mut frames = 0;
        let mut samples = 0;
        for (i, c) in plan.chunks.iter().enumerate() {
            assert!(
                c.frames as f64 / fps.as_f64() <= CHUNK_MAX_SECONDS as f64 + 0.1,
                "{fps:?}: chunk too long"
            );
            if i + 1 < plan.chunks.len() {
                // duration in µs must be an integer so concat offsets never drift
                let micros_num = c.frames as i128 * fps.den as i128 * 1_000_000;
                assert_eq!(
                    micros_num % fps.num as i128,
                    0,
                    "{fps:?}: chunk of {} frames is not a whole number of µs",
                    c.frames
                );
            }
            assert!(fps.is_aligned(c.start.0) && fps.is_aligned(c.end.0));
            frames += c.frames;
            samples += c.samples;
        }
        assert_eq!(frames, plan.total_frames);
        assert_eq!(plan.duration, fps.frame_to_ticks(plan.total_frames));
        assert_eq!(
            samples,
            ticks_to_samples(plan.duration, 48_000),
            "{fps:?}: audio length matches the picture exactly"
        );
        // the plan follows the frame grid of the timeline
        assert_eq!(plan.total_frames, fps.ticks_to_frame_round(fx.p.duration()));
    }
}

#[test]
fn busy_stretches_are_split_into_smaller_chunks() {
    let mut fx = Fx::new(640, 360, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 30.0);
    // 100 captions of 0.3 s each = a caption-dense 30 s
    let cues: Vec<CueDraft> = (0..100)
        .map(|i| CueDraft {
            start: t(i as f64 * 0.3),
            duration: S * 3 / 10,
            text: format!("caption {i}"),
            speaker: None,
            source: None,
        })
        .collect();
    fx.cmd(Command::AddCaptions {
        cues,
        track_id: None,
    });
    let plan = fx.plan();
    assert!(
        plan.chunks.len() > 2,
        "more chunks than duration alone would need: {}",
        plan.chunks.len()
    );
    let fps = FrameRate::FPS_30;
    for c in &plan.chunks {
        let portions = c.inputs.len() + c.filter_complex.matches("drawtext=").count();
        assert!(
            portions <= CHUNK_MAX_PORTIONS,
            "chunk {} has {portions} portions",
            c.index
        );
        assert!(c.frames >= CHUNK_MIN_SECONDS * 30 || c.index + 1 == plan.chunks.len());
        assert!(fps.is_aligned(c.start.0));
    }
    assert_eq!(plan.chunks.iter().map(|c| c.frames).sum::<i64>(), 900);
    // every caption is burnt in exactly once across all chunks (none dropped or duplicated
    // unless it straddles a boundary)
    let drawn: usize = plan
        .chunks
        .iter()
        .map(|c| c.filter_complex.matches("drawtext=").count())
        .sum();
    assert!(
        (100..=100 + plan.chunks.len()).contains(&drawn),
        "{drawn} caption draws"
    );
    assert_eq!(plan.text_files.len(), 100);

    // without captions the same timeline needs only two chunks
    let mut s = fx.settings();
    s.burn_captions = false;
    assert_eq!(fx.plan_with(&s).chunks.len(), 2);
}

#[test]
fn plans_are_deterministic() {
    let build = || {
        let mut fx = Fx::new(1920, 1080, FrameRate::FPS_29_97);
        let a = fx.add("movie", "V1", 0.0, 3.0, 28.0);
        fx.add("movie", "V1", 25.0, 100.0, 130.0);
        fx.cmd(Command::AddTransitions {
            left_clip_ids: vec![a[0].clone()],
            kind: TransitionKind::CrossDissolve,
            duration: S,
        });
        fx.add("photo", "V2", 2.0, 0.0, 4.0);
        fx.text("Title\nline two", 1.0, 3.0);
        fx.plan()
    };
    let (a, b) = (build(), build());
    assert_eq!(a, b);
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
    let back: RenderPlan = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    assert_eq!(back, a, "plans survive serialisation");
}

// ---------------------------------------------------------------------------------
// what is (not) rendered
// ---------------------------------------------------------------------------------

#[test]
fn inactive_layers_are_excluded() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let main = fx.add("movie", "V1", 0.0, 0.0, 4.0); // video + linked audio on A1
    let hidden = fx.add("photo", "V2", 0.0, 0.0, 4.0);
    let disabled = fx.add("movie", "V1", 4.0, 10.0, 12.0);
    let music = fx.add("voice", "A2", 0.0, 0.0, 6.0);
    let plan = fx.plan();
    let ids = |p: &RenderPlan| -> Vec<(String, InputRole)> {
        p.chunks[0]
            .inputs
            .iter()
            .map(|i| (i.clip_id.clone(), i.role))
            .collect()
    };
    assert_eq!(
        ids(&plan).len(),
        6,
        "2 video + 1 image + 3 audio inputs: {:?}",
        ids(&plan)
    );

    // hide V2, disable the second movie clip (picture only), mute A2
    let v2 = fx.track("V2");
    let a2 = fx.track("A2");
    fx.cmd(Command::UpdateTrack {
        track_id: v2,
        name: None,
        muted: None,
        solo: None,
        locked: None,
        hidden: Some(true),
        gain_db: None,
    });
    fx.patch(
        &disabled[..1],
        ClipPatch {
            enabled: Some(false),
            ..Default::default()
        },
    );
    fx.cmd(Command::UpdateTrack {
        track_id: a2.clone(),
        name: None,
        muted: Some(true),
        solo: None,
        locked: None,
        hidden: None,
        gain_db: None,
    });
    let plan = fx.plan();
    let got = ids(&plan);
    assert!(
        got.contains(&(main[0].clone(), InputRole::Video))
            && got.contains(&(main[1].clone(), InputRole::Audio))
    );
    assert!(
        got.contains(&(disabled[1].clone(), InputRole::Audio)),
        "its (still enabled) audio clip plays on"
    );
    assert!(
        !got.iter().any(|(id, _)| id == &hidden[0]),
        "hidden track is not rendered"
    );
    assert!(
        !got.iter()
            .any(|(id, role)| id == &disabled[0] && *role == InputRole::Video),
        "disabled clip is not rendered"
    );
    assert!(
        !got.iter().any(|(id, _)| id == &music[0]),
        "muted track is not mixed"
    );
    assert_eq!(got.len(), 3);
    assert_eq!(
        plan.total_frames, 180,
        "the timeline length is unchanged by hiding things"
    );

    // solo A2: only it is audible, even though it was muted a moment ago
    fx.cmd(Command::UpdateTrack {
        track_id: a2,
        name: None,
        muted: Some(false),
        solo: Some(true),
        locked: None,
        hidden: None,
        gain_db: None,
    });
    let plan = fx.plan();
    let audio: Vec<String> = plan.chunks[0]
        .inputs
        .iter()
        .filter(|i| i.role == InputRole::Audio)
        .map(|i| i.clip_id.clone())
        .collect();
    assert_eq!(audio, vec![music[0].clone()]);

    // fully transparent picture and silent audio cost nothing
    fx.patch(
        &main[..1],
        ClipPatch {
            opacity: Some(0.0),
            ..Default::default()
        },
    );
    fx.patch(
        &music,
        ClipPatch {
            gain_db: Some(-60.0),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    assert!(plan.chunks[0].inputs.is_empty(), "{:?}", ids(&plan));
    assert!(plan.chunks[0]
        .filter_complex
        .contains("anullsrc=r=48000:cl=stereo"));
    assert!(!plan.chunks[0].filter_complex.contains("amix"));
}

#[test]
fn captions_follow_burn_captions_and_text_never_enters_the_graph() {
    let mut fx = Fx::new(1920, 1080, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 6.0);
    let nasty = "it's 100%: [a]; b, c='d' \\ %{pts}\n$(rm -rf) \"x\"";
    fx.cmd(Command::AddCaptions {
        cues: vec![CueDraft {
            start: t(1.0),
            duration: 2 * S,
            text: nasty.into(),
            speaker: None,
            source: None,
        }],
        track_id: None,
    });
    let title = fx.text("Ünïcödé — title; [v0]overlay=0:0,", 0.0, 2.0);
    let plan = fx.plan();
    let g = &plan.chunks[0].filter_complex;
    for needle in ["100%", "rm -rf", "%{pts}", "it's", "Ünï", "title;"] {
        assert!(
            !g.contains(needle),
            "text leaked into the filter graph: {needle}"
        );
        assert!(!plan.chunks[0].args.iter().any(|a| a.contains(needle)));
    }
    assert_eq!(g.matches("drawtext=").count(), 2);
    assert_eq!(
        g.matches("expansion=none").count(),
        2,
        "text is drawn verbatim, never expanded"
    );
    let files: BTreeMap<&str, &str> = plan
        .text_files
        .iter()
        .map(|f| (f.name.as_str(), f.content.as_str()))
        .collect();
    assert_eq!(files.len(), 2);
    assert_eq!(
        files[format!("text_{title}.txt").as_str()],
        "Ünïcödé — title; [v0]overlay=0:0,"
    );
    assert!(
        files.values().any(|c| *c == nasty),
        "caption text is passed through a file byte for byte"
    );
    for f in &plan.text_files {
        assert!(
            f.name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.'),
            "safe file name {}",
            f.name
        );
        assert!(g.contains(&format!("textfile={}", f.name)));
    }
    assert_eq!(
        plan.font_files,
        vec![
            FontFile {
                name: "font-regular.ttf".into(),
                source: "/fonts/Inter-Regular.ttf".into()
            },
            FontFile {
                name: "font-bold.ttf".into(),
                source: "/fonts/Inter-Bold.ttf".into()
            }
        ]
    );
    // the graph is still well formed: every ';'-separated part ends in an output label
    for part in g.split(';') {
        assert!(part.ends_with(']'), "malformed graph part: {part}");
    }

    // caption geometry and style come from the project caption style
    let cap = g
        .split(';')
        .find(|p| p.contains("boxcolor=0x000000@0.702"))
        .expect("caption uses the caption style box");
    // 1080 × 0.048 = 51.84 → 52 px; two lines; centre y = 540 + 0.38·1080 = 950.4
    assert!(cap.contains("fontsize=52:"), "{cap}");
    assert!(cap.contains("fontfile=font-bold.ttf"));
    assert!(cap.contains("x='960-text_w/2'"));
    assert!(
        cap.contains(&format!(
            "y={}",
            (950.4f64 - 2.0 * 1.21 * 52.0 / 2.0).round()
        )),
        "{cap}"
    );
    assert!(
        cap.contains("boxborderw=16"),
        "padding = round(0.3 × 52): {cap}"
    );
    assert!(
        cap.contains("text_align=C")
            && cap.contains("y_align=font")
            && cap.contains("line_spacing=0")
    );
    assert!(
        cap.contains("enable='between((t*30/1),29.5,89.5)'"),
        "caption visible for frames 30..90: {cap}"
    );
    assert!(!cap.contains("shadowx") && !cap.contains("borderw=0"));

    // burn_captions = false: the caption disappears, the title stays
    let mut s = fx.settings();
    s.burn_captions = false;
    let plan = fx.plan_with(&s);
    assert_eq!(
        plan.chunks[0].filter_complex.matches("drawtext=").count(),
        1
    );
    assert_eq!(plan.text_files.len(), 1);
    assert_eq!(plan.text_files[0].name, format!("text_{title}.txt"));

    // no text at all → no fonts needed
    fx.cmd(Command::DeleteClips {
        clip_ids: vec![title],
        ripple: false,
    });
    let plan = fx.plan_with(&s);
    assert!(plan.text_files.is_empty() && plan.font_files.is_empty());
    assert!(!plan.chunks[0].filter_complex.contains("drawtext"));
}

// ---------------------------------------------------------------------------------
// time mapping
// ---------------------------------------------------------------------------------

#[test]
fn trims_speed_and_offsets_reach_the_input_seeks() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    // source 90 s..150 s at 2× → 30 s on the timeline, starting at 10 s
    let c = fx.add("movie", "V1", 10.0, 90.0, 150.0);
    fx.cmd(Command::SetSpeed {
        clip_ids: c.clone(),
        speed: 2.0,
        ripple: true,
    });
    assert_eq!(fx.p.duration(), 40 * S);
    let plan = fx.plan();
    assert_eq!(plan.chunks.len(), 2);

    // chunk 0 = [0, 20): the clip occupies frames 300..600
    let c0 = &plan.chunks[0];
    let vin = video_input(c0, &c[0]);
    assert_eq!(vin.seek, Some(90 * S));
    assert_eq!(&vin.args[..2], ["-ss", "90.000000"]);
    assert_eq!(
        vin.limit,
        Some(20 * S + S / 4),
        "10 s of output at 2× = 20 s of source (+ margin)"
    );
    assert_eq!(
        vin.args[2..],
        ["-t", "20.250000", "-i", "/media/movie.file"]
    );
    let chain = chain_of_input(c0, vin);
    assert!(
        chain.contains("setpts=(PTS-STARTPTS)*1/2,fps=30"),
        "{chain}"
    );
    assert!(
        chain.ends_with("setpts=PTS-STARTPTS+300[v0]"),
        "placed at chunk frame 300: {chain}"
    );
    assert!(c0
        .filter_complex
        .contains("enable='between((t*30/1),299.5,599.5)'"));
    let ain = audio_input(c0, &c[1]);
    assert_eq!(ain.seek, Some(90 * S));
    let achain = chain_of_input(c0, ain);
    assert!(achain.contains("atempo=2"), "{achain}");
    assert!(
        achain.contains("atrim=end_sample=480000"),
        "10 s of output audio: {achain}"
    );
    assert!(
        achain.contains("adelay=delays=480000S:all=1"),
        "starts 10 s into the chunk: {achain}"
    );
    assert!(!achain.contains("pan="), "stereo source is not re-panned");

    // chunk 1 = [20, 40): continues 10 s into the clip → source 90 + 2·10 = 110 s
    let c1 = &plan.chunks[1];
    let vin = video_input(c1, &c[0]);
    assert_eq!(vin.seek, Some(110 * S));
    assert_eq!(vin.limit, Some(40 * S + S / 4));
    assert!(chain_of_input(c1, vin).ends_with("setpts=PTS-STARTPTS+0[v0]"));
    let ain = audio_input(c1, &c[1]);
    assert_eq!(ain.seek, Some(110 * S));
    assert!(
        !chain_of_input(c1, ain).contains("adelay"),
        "no delay when the portion starts with the chunk"
    );

    // slow motion uses chained atempo filters (each within 0.5..2)
    fx.cmd(Command::SetSpeed {
        clip_ids: c.clone(),
        speed: 0.2,
        ripple: true,
    });
    let plan = fx.plan();
    let ain = audio_input(&plan.chunks[0], &c[1]);
    let achain = chain_of_input(&plan.chunks[0], ain);
    assert!(
        achain.contains("atempo=0.5,atempo=0.5,atempo=0.8"),
        "{achain}"
    );
    assert!(
        chain_of_input(&plan.chunks[0], video_input(&plan.chunks[0], &c[0]))
            .contains("setpts=(PTS-STARTPTS)*5/1")
    );
    fx.cmd(Command::SetSpeed {
        clip_ids: c.clone(),
        speed: 8.0,
        ripple: true,
    });
    let plan = fx.plan();
    assert!(
        chain_of_input(&plan.chunks[0], audio_input(&plan.chunks[0], &c[1]))
            .contains("atempo=2,atempo=2,atempo=2")
    );
}

#[test]
fn video_seeks_snap_to_the_source_frame_that_contains_the_instant() {
    // a 25 fps source on a 30 fps timeline: cuts fall between source frames
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    fx.asset(
        "pal",
        AssetKind::Video,
        true,
        false,
        1280,
        720,
        60.0,
        Some(FrameRate::FPS_25),
        None,
    );
    let c = fx.add("pal", "V1", 0.0, 1.0 + 1.0 / 30.0, 5.0); // 1.0333 s lies inside source frame 25 (1.00–1.04 s)
    let plan = fx.plan();
    let vin = video_input(&plan.chunks[0], &c[0]);
    assert_eq!(
        vin.seek,
        Some(S),
        "seek to the start of the frame the preview would show"
    );
    assert_eq!(vin.args[1], "1.000000");
    // seeks are rounded *down* to the microsecond so the frame at the cut is never skipped
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 2.0 / 30.0, 5.0);
    let plan = fx.plan();
    assert_eq!(video_input(&plan.chunks[0], &c[0]).args[1], "0.066666");
}

#[test]
fn cross_dissolve_uses_handles_and_resolved_ramps() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let a = fx.add("movie", "V1", 0.0, 10.0, 14.0); // 0–4 s
    let b = fx.add("movie", "V1", 4.0, 0.0, 3.0); // 4–7 s, starts at the very beginning of its media
    fx.cmd(Command::AddTransitions {
        left_clip_ids: vec![a[0].clone()],
        kind: TransitionKind::CrossDissolve,
        duration: S,
    });
    fx.cmd(Command::AddTransitions {
        left_clip_ids: vec![a[1].clone()],
        kind: TransitionKind::CrossDissolve,
        duration: S,
    });
    let plan = fx.plan();
    let c0 = &plan.chunks[0];

    // outgoing picture: plays 0.5 s past its out point (handle), stays opaque
    let out_v = video_input(c0, &a[0]);
    assert_eq!(out_v.seek, Some(10 * S));
    assert_eq!(out_v.limit, Some(4 * S + S / 2 + S / 4));
    let chain = chain_of_input(c0, out_v);
    assert!(
        !chain.contains("fade="),
        "the outgoing picture does not fade in a dissolve: {chain}"
    );
    assert!(chain.contains("format=yuv420p") && !chain.contains("yuva"));
    assert!(
        c0.filter_complex
            .contains("enable='between((t*30/1),-0.5,134.5)'"),
        "visible until 4.5 s"
    );

    // incoming picture: starts 0.5 s early; no media before 0 → first frame is held, alpha ramps over 1 s
    let in_v = video_input(c0, &b[0]);
    assert_eq!(in_v.seek, Some(0));
    assert_eq!(
        in_v.limit,
        Some(3 * S + S / 4),
        "only the real media is read"
    );
    let chain = chain_of_input(c0, in_v);
    assert!(
        chain.contains("tpad=start_mode=clone:start_duration=0.500000"),
        "{chain}"
    );
    assert!(chain.contains("format=yuva420p"));
    assert!(
        chain.contains(
            "setpts=PTS-STARTPTS+0,fade=t=in:st=0.000000:d=1.000000:alpha=1,setpts=PTS+105"
        ),
        "ramp 3.5–4.5 s, layer starts at frame 105: {chain}"
    );
    assert!(c0
        .filter_complex
        .contains("enable='between((t*30/1),104.5,209.5)'"));
    // paint order: incoming over outgoing
    let pos_out = c0
        .filter_complex
        .find(&format!("[{}:v]", out_v.index))
        .unwrap();
    let pos_in = c0
        .filter_complex
        .find(&format!("[{}:v]", in_v.index))
        .unwrap();
    assert!(pos_out < pos_in);

    // sound: a real crossfade, linear, with silence where the incoming handle has no media
    let out_a = chain_of_input(c0, audio_input(c0, &a[1]));
    assert!(
        out_a.contains("afade=t=out:st=3.500000:d=1.000000:curve=tri"),
        "{out_a}"
    );
    assert!(
        out_a.contains("atrim=end_sample=216000"),
        "4.5 s incl. handle"
    );
    let in_a_input = audio_input(c0, &b[1]);
    assert_eq!(in_a_input.seek, Some(0));
    let in_a = chain_of_input(c0, in_a_input);
    assert!(
        in_a.contains("afade=t=in:st=0.000000:d=1.000000:curve=tri"),
        "{in_a}"
    );
    assert!(
        in_a.contains("asetpts=(N+24000)/SR/TB"),
        "audio starts half-way into its ramp (after 0.5 s of silence): {in_a}"
    );
    assert!(
        in_a.contains("adelay=delays=192000S:all=1"),
        "first real sample lands at 4.0 s: {in_a}"
    );
    assert!(c0
        .filter_complex
        .contains("amix=inputs=3:normalize=0:duration=first"));
}

#[test]
fn a_fade_that_crosses_a_chunk_boundary_continues_mid_ramp() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 0.0, 30.0);
    // 20 s fade out: starts at 10 s, crosses the chunk boundary at 20 s
    fx.patch(
        &c,
        ClipPatch {
            fade_out: Some(20 * S),
            ..Default::default()
        },
    );
    let title = fx.text("fading title", 15.0, 10.0);
    fx.patch(
        std::slice::from_ref(&title),
        ClipPatch {
            fade_in: Some(8 * S),
            opacity: Some(0.5),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    assert_eq!(plan.chunks.len(), 2);
    let (c0, c1) = (&plan.chunks[0], &plan.chunks[1]);

    // picture: both chunks evaluate the same ramp in the layer's own time base
    let ch0 = chain_of_input(c0, video_input(c0, &c[0]));
    let ch1 = chain_of_input(c1, video_input(c1, &c[0]));
    assert!(
        ch0.contains(
            "setpts=PTS-STARTPTS+0,fade=t=out:st=10.000000:d=20.000000:alpha=1,setpts=PTS+0"
        ),
        "{ch0}"
    );
    assert!(
        ch1.contains(
            "setpts=PTS-STARTPTS+600,fade=t=out:st=10.000000:d=20.000000:alpha=1,setpts=PTS-600"
        ),
        "second chunk resumes 600 frames into the layer: {ch1}"
    );
    assert_eq!(video_input(c1, &c[0]).seek, Some(20 * S));

    // sound: same idea in samples
    let a0 = chain_of_input(c0, audio_input(c0, &c[1]));
    let a1 = chain_of_input(c1, audio_input(c1, &c[1]));
    assert!(
        a0.contains("asetpts=(N+0)/SR/TB,afade=t=out:st=10.000000:d=20.000000:curve=tri"),
        "{a0}"
    );
    assert!(
        a1.contains("asetpts=(N+960000)/SR/TB,afade=t=out:st=10.000000:d=20.000000:curve=tri"),
        "{a1}"
    );

    // text: alpha expression in chunk time; in chunk 1 the ramp began 150 frames before the chunk
    let d0 = c0
        .filter_complex
        .split(';')
        .find(|p| p.contains("drawtext="))
        .unwrap();
    let d1 = c1
        .filter_complex
        .split(';')
        .find(|p| p.contains("drawtext="))
        .unwrap();
    assert!(
        d0.contains("alpha='0.5*clip(((t*30/1)-(450))/240,0,1)'"),
        "{d0}"
    );
    assert!(
        d1.contains("alpha='0.5*clip(((t*30/1)-(-150))/240,0,1)'"),
        "{d1}"
    );
    assert!(d0.contains("enable='between((t*30/1),449.5,599.5)'"));
    assert!(d1.contains("enable='between((t*30/1),-0.5,149.5)'"));

    // a ramp that is already over (or has not begun) inside a chunk is not rendered there
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 0.0, 50.0);
    fx.patch(
        &c,
        ClipPatch {
            fade_in: Some(2 * S),
            fade_out: Some(3 * S),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let chains: Vec<String> = plan
        .chunks
        .iter()
        .map(|ch| chain_of_input(ch, video_input(ch, &c[0])))
        .collect();
    assert!(chains[0].contains("fade=t=in") && !chains[0].contains("fade=t=out"));
    assert!(
        !chains[1].contains("fade="),
        "middle chunk is a plain opaque clip: {}",
        chains[1]
    );
    assert!(chains[1].contains("format=yuv420p"));
    assert!(
        !chains[2].contains("fade=t=in")
            && chains[2].contains("fade=t=out:st=47.000000:d=3.000000")
    );
}

#[test]
fn slide_push_and_dip_transitions() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let a = fx.add("photo", "V1", 0.0, 0.0, 2.0);
    let b = fx.add("photo", "V1", 2.0, 0.0, 2.0);
    let c = fx.add("photo", "V1", 4.0, 0.0, 2.0);
    let d = fx.add("photo", "V1", 6.0, 0.0, 2.0);
    fx.cmd(Command::AddTransitions {
        left_clip_ids: a.clone(),
        kind: TransitionKind::Slide,
        duration: S,
    });
    fx.cmd(Command::AddTransitions {
        left_clip_ids: b.clone(),
        kind: TransitionKind::Push,
        duration: S,
    });
    fx.cmd(Command::AddTransitions {
        left_clip_ids: c.clone(),
        kind: TransitionKind::DipToBlack,
        duration: S,
    });
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let overlay_of = |clip: &ClipId| -> String {
        let idx = video_input(ch, clip).index;
        let label = chain_of_input(ch, video_input(ch, clip))
            .rsplit('[')
            .next()
            .unwrap()
            .trim_end_matches(']')
            .to_string();
        let _ = idx;
        ch.filter_complex
            .split(';')
            .find(|p| p.contains(&format!("][{label}]overlay=")))
            .unwrap()
            .to_string()
    };
    // 4000×3000 still in 1280×720: fitted 960×720, centred
    let oa = overlay_of(&a[0]);
    assert!(
        oa.contains("overlay=x=160:y=0:eval=init:enable='between((t*30/1),-0.5,74.5)'"),
        "slide: outgoing stays put until 2.5 s: {oa}"
    );
    let ob = overlay_of(&b[0]);
    assert!(ob.contains("x='640-w/2+1280*(1*(1-clip(((t*30/1)-(45))/30,0,1))+-1*clip(((t*30/1)-(105))/30,0,1))'"), "slides in from the right, later pushed out left: {ob}");
    assert!(ob.contains("y='360-h/2':eval=frame"));
    let oc = overlay_of(&c[0]);
    assert!(
        oc.contains("x='640-w/2+1280*(1*(1-clip(((t*30/1)-(105))/30,0,1)))'"),
        "push: incoming follows: {oc}"
    );
    // dip to black: outgoing fades 5.5–6 s, incoming fades 6–6.5 s, no handles
    let cc = chain_of_input(ch, video_input(ch, &c[0]));
    assert!(
        cc.contains("fade=t=out:st=2.000000:d=0.500000:alpha=1"),
        "layer starts at 3.5 s, ramp at 5.5 s: {cc}"
    );
    assert!(
        cc.contains("loop=loop=-1:size=1:start=0,fps=30,trim=end_frame=75"),
        "a still becomes a frame sequence when it fades: {cc}"
    );
    assert!(oc.contains("enable='between((t*30/1),104.5,179.5)'"));
    let dc = chain_of_input(ch, video_input(ch, &d[0]));
    assert!(
        dc.contains("fade=t=in:st=0.000000:d=0.500000:alpha=1"),
        "{dc}"
    );
    assert!(overlay_of(&d[0]).contains("enable='between((t*30/1),179.5,239.5)'"));
    // stills are read once (no -loop / -t) and held
    let still = video_input(ch, &a[0]);
    assert_eq!(still.role, InputRole::Image);
    assert_eq!(still.args, ["-i", "/media/photo.file"]);
    let ac = chain_of_input(ch, still);
    assert!(
        ac.starts_with(&format!("[{}:v]trim=end_frame=1,", still.index)) && !ac.contains("loop="),
        "{ac}"
    );
    assert!(
        ac.contains("format=yuva420p"),
        "stills keep their own transparency"
    );
}

// ---------------------------------------------------------------------------------
// transforms, colour, text
// ---------------------------------------------------------------------------------

#[test]
fn neutral_clips_take_the_fast_path_and_transforms_add_only_what_is_needed() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 0.0, 2.0);
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let chain = chain_of_input(ch, video_input(ch, &c[0]));
    assert_eq!(
        chain,
        format!("[{}:v]setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=bicubic:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p,setpts=PTS-STARTPTS+0[v0]", video_input(ch, &c[0]).index),
        "an untouched full-frame clip is scale → overlay only"
    );
    assert!(ch
        .filter_complex
        .contains("[base][v0]overlay=x=0:y=0:eval=init:enable='between((t*30/1),-0.5,59.5)'[c0]"));
    for absent in [
        "rotate=",
        "lutrgb",
        "colorchannelmixer",
        "crop=",
        "rgba",
        "yuva420p",
        "lut=a",
        "hflip",
        "vflip",
        "fade=",
        "tpad",
        "volume=",
        "afade",
    ] {
        assert!(
            !ch.filter_complex.contains(absent),
            "unexpected {absent} in a neutral plan"
        );
    }
    assert!(ch
        .filter_complex
        .starts_with("color=c=0x000000:s=1280x720:r=30,"));
    assert_eq!(arg_after(&ch.args, "-map"), "[c0]");

    // scale + position: 0.5× at (+0.25, −0.25) → 640×360 centred on (960, 180)
    fx.patch(
        &c[..1],
        ClipPatch {
            scale: Some(0.5),
            x: Some(0.25),
            y: Some(-0.25),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    assert!(chain_of_input(ch, video_input(ch, &c[0])).contains("scale=640:360:"));
    assert!(ch.filter_complex.contains("overlay=x=640:y=0:eval=init"));

    // crop + flips: crop fractions in source space, fit of the cropped picture
    fx.patch(
        &c[..1],
        ClipPatch {
            scale: Some(1.0),
            x: Some(0.0),
            y: Some(0.0),
            crop_left: Some(0.25),
            crop_right: Some(0.25),
            flip_h: Some(true),
            flip_v: Some(true),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let chain = chain_of_input(ch, video_input(ch, &c[0]));
    // 1920×1080 cropped to 960×1080 → fitted height 720 → 640×720, centred at x=320
    assert!(
        chain.contains("crop=w=iw*0.5:h=ih*1:x=iw*0.25:y=ih*0,hflip,vflip,scale=640:720:"),
        "{chain}"
    );
    assert!(ch.filter_complex.contains("overlay=x=320:y=0:eval=init"));

    // rotation + opacity need alpha; rotation is clockwise radians about the centre
    fx.patch(
        &c[..1],
        ClipPatch {
            crop_left: Some(0.0),
            crop_right: Some(0.0),
            flip_h: Some(false),
            flip_v: Some(false),
            rotation: Some(90.0),
            opacity: Some(0.4),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let chain = chain_of_input(ch, video_input(ch, &c[0]));
    assert!(chain.contains("format=yuva420p,rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=black@0,lut=a='val*0.4'"), "{chain}");
    assert!(ch
        .filter_complex
        .contains("overlay=x='640-w/2':y='360-h/2':eval=frame"));
    // 360° is no rotation at all
    fx.patch(
        &c[..1],
        ClipPatch {
            rotation: Some(360.0),
            opacity: Some(1.0),
            ..Default::default()
        },
    );
    assert!(!fx.plan().chunks[0].filter_complex.contains("rotate="));
    fx.patch(
        &c[..1],
        ClipPatch {
            rotation: Some(-90.0),
            ..Default::default()
        },
    );
    assert!(
        fx.plan().chunks[0]
            .filter_complex
            .contains("rotate=4.712389:"),
        "−90° ≡ 270° clockwise"
    );
}

#[test]
fn zooming_in_only_scales_the_visible_part() {
    let mut fx = Fx::new(3840, 2160, FrameRate::FPS_60);
    let c = fx.add("movie", "V1", 0.0, 0.0, 1.0);
    fx.patch(
        &c[..1],
        ClipPatch {
            scale: Some(4.0),
            x: Some(0.5),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let chain = chain_of_input(ch, video_input(ch, &c[0]));
    // displayed 15360×8640 centred on (3840, 1080), i.e. spanning x −3840..11520:
    // the visible x ∈ [0, 3840) is source 0.25–0.5, y the middle quarter
    assert!(
        chain.contains("crop=w=iw*0.25:h=ih*0.25:x=iw*0.25:y=ih*0.375,scale=3840:2160:"),
        "{chain}"
    );
    assert!(ch.filter_complex.contains("overlay=x=0:y=0:eval=init"));
    assert!(
        !chain.contains("15360"),
        "never scales to the full zoomed size"
    );
}

#[test]
fn colour_controls_follow_the_documented_math() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 0.0, 2.0);
    // only saturation → only the matrix
    fx.patch(
        &c[..1],
        ClipPatch {
            saturation: Some(0.0),
            ..Default::default()
        },
    );
    let chain = {
        let plan = fx.plan();
        chain_of_input(&plan.chunks[0], video_input(&plan.chunks[0], &c[0]))
    };
    assert!(chain.contains("format=rgba,colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126:gg=0.7152:gb=0.0722:br=0.2126:bg=0.7152:bb=0.0722,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"), "{chain}");
    assert!(!chain.contains("lutrgb"));
    // temperature, brightness, contrast in that order, clamped after each step
    fx.patch(
        &c[..1],
        ClipPatch {
            saturation: Some(1.0),
            temperature: Some(0.4),
            brightness: Some(1.2),
            contrast: Some(1.5),
            ..Default::default()
        },
    );
    let chain = {
        let plan = fx.plan();
        chain_of_input(&plan.chunks[0], video_input(&plan.chunks[0], &c[0]))
    };
    assert!(
        chain.contains("lutrgb=r='clip((clip(clip(val*1.1,0,255)*1.2,0,255)-127.5)*1.5+127.5,0,255)':g='clip((clip(val*1.2,0,255)-127.5)*1.5+127.5,0,255)':b='clip((clip(clip(val*0.9,0,255)*1.2,0,255)-127.5)*1.5+127.5,0,255)'"),
        "{chain}"
    );
    assert!(!chain.contains("colorchannelmixer"));

    // the saturation matrix itself
    let m = color_matrix(1.0);
    assert_eq!(m, [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    let m = color_matrix(2.0);
    for row in m {
        assert!(
            (row.iter().sum::<f64>() - 1.0).abs() < 1e-12,
            "greys are preserved at any saturation"
        );
    }
    assert!((m[0][0] - (2.0 - 0.2126)).abs() < 1e-12 && (m[0][1] + 0.7152).abs() < 1e-12);
}

#[test]
fn layout_and_text_metrics_are_the_shared_contract() {
    // contain-fit of 4:3 into 16:9, scaled and offset
    let tr = Transform {
        x: 0.1,
        y: -0.2,
        scale: 0.5,
        ..Default::default()
    };
    let r = layout_rect(1920, 1080, 4000, 3000, &tr);
    assert_eq!((r.dw, r.dh), (720, 540));
    assert_eq!((r.cx, r.cy), (960.0 + 192.0, 540.0 - 216.0));
    // crop changes the fitted aspect
    let tr = Transform {
        crop: Crop {
            left: 0.25,
            right: 0.25,
            top: 0.0,
            bottom: 0.5,
        },
        ..Default::default()
    };
    let r = layout_rect(1920, 1080, 1920, 1080, &tr);
    assert_eq!(
        (r.dw, r.dh),
        (1920, 1080),
        "960×540 crop fills the frame again"
    );
    // unknown source size falls back to the canvas
    assert_eq!(layout_rect(1280, 720, 0, 0, &Transform::default()).dw, 1280);
    // layout is resolution independent
    let tr = Transform {
        x: 0.3,
        y: 0.1,
        scale: 0.4,
        ..Default::default()
    };
    let (a, b) = (
        layout_rect(1920, 1080, 1280, 720, &tr),
        layout_rect(3840, 2160, 1280, 720, &tr),
    );
    assert_eq!((a.dw * 2, a.dh * 2), (b.dw, b.dh));
    assert_eq!((a.cx * 2.0, a.cy * 2.0), (b.cx, b.cy));

    let style = TextStyle {
        font_size: 0.1,
        outline_width: 0.05,
        ..Default::default()
    };
    let m = text_metrics(1080, &style, 1.0, "two\nlines", 540.0);
    assert_eq!(m.font_px, 108);
    assert_eq!(m.lines, 2);
    assert_eq!(
        m.block_top,
        (540.0f64 - 2.0 * 1.21 * 108.0 / 2.0).round() as i64
    );
    assert_eq!(m.box_padding, 32);
    assert_eq!(m.outline_px, 5);
    assert_eq!(m.shadow_px, 6);
    assert_eq!(
        text_metrics(1080, &style, 2.0, "x", 0.0).font_px,
        216,
        "transform scale multiplies the font size"
    );
    assert_eq!(
        text_metrics(
            90,
            &TextStyle {
                font_size: 0.01,
                ..Default::default()
            },
            1.0,
            "x",
            0.0
        )
        .shadow_px,
        1
    );
}

#[test]
fn text_clips_render_with_their_style_transform_and_rotation() {
    let mut fx = Fx::new(1920, 1080, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 4.0);
    let title = fx.text("Hello\nWorld", 1.0, 2.0);
    fx.patch(
        std::slice::from_ref(&title),
        ClipPatch {
            font_size: Some(0.1),
            text_color: Some("#FFCC00".into()),
            bold: Some(false),
            align: Some(TextAlign::Right),
            background: Some(Some("#10203080".into())),
            outline_color: Some("#112233".into()),
            outline_width: Some(0.05),
            shadow: Some(true),
            x: Some(0.25),
            y: Some(-0.25),
            scale: Some(2.0),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let g = &plan.chunks[0].filter_complex;
    let d = g.split(';').find(|p| p.contains("drawtext=")).unwrap();
    // 0.1 × 1080 × 2 = 216 px; centre (1440, 270); two lines → top = round(270 − 1.21·216)
    let expect = format!(
        "[c0]drawtext=fontfile=font-regular.ttf:textfile=text_{title}.txt:expansion=none:fontsize=216:fontcolor=0xffcc00:line_spacing=0:y_align=font:text_align=R:x='1440-text_w/2':y=9:box=1:boxcolor=0x102030@0.502:boxborderw=65:borderw=11:bordercolor=0x112233:shadowx=13:shadowy=13:shadowcolor=0x000000@0.6:enable='between((t*30/1),29.5,89.5)'[c1]"
    );
    assert_eq!(d, expect);
    assert!(
        !g.contains("color=c=black@0.0"),
        "upright text is drawn straight onto the composite"
    );

    // rotated text goes through a transparent layer that is rotated and overlaid at the same centre
    fx.patch(
        std::slice::from_ref(&title),
        ClipPatch {
            rotation: Some(30.0),
            opacity: Some(0.8),
            flip_h: Some(true),
            fade_out: Some(S),
            ..Default::default()
        },
    );
    let plan = fx.plan();
    let g = &plan.chunks[0].filter_complex;
    let layer = g
        .split(';')
        .find(|p| {
            p.starts_with(
                "color=c=black@0.0:s=1920x1080:r=30,format=rgba,trim=end_frame=60,drawtext=",
            )
        })
        .expect("transparent text layer");
    assert!(
        layer.contains("x='960-text_w/2':y=279"),
        "drawn centred on the layer: {layer}"
    );
    assert!(layer.contains(",hflip,rotate=0.523599:c=black@0,colorchannelmixer=aa=0.8,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,"), "{layer}");
    assert!(
        layer.contains("fade=t=out:st=1.000000:d=1.000000:alpha=1"),
        "{layer}"
    );
    assert!(
        !layer.contains("alpha='"),
        "opacity and fades are applied to the layer, not the glyphs"
    );
    assert!(
        g.contains("overlay=x='480':y='-270':eval=frame:enable='between((t*30/1),29.5,89.5)'"),
        "layer centre moved to (1440, 270)"
    );
}

// ---------------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------------

#[test]
fn audio_gain_placement_and_mono_handling() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    fx.add("photo", "V1", 0.0, 0.0, 10.0);
    let v = fx.add("voice", "A1", 2.0, 30.0, 34.0);
    fx.patch(
        &v,
        ClipPatch {
            gain_db: Some(-6.0),
            fade_in: Some(S),
            ..Default::default()
        },
    );
    let a1 = fx.track("A1");
    fx.cmd(Command::UpdateTrack {
        track_id: a1,
        name: None,
        muted: None,
        solo: None,
        locked: None,
        hidden: None,
        gain_db: Some(-6.0),
    });
    let plan = fx.plan();
    let ch = &plan.chunks[0];
    let input = audio_input(ch, &v[0]);
    assert_eq!(
        input.args,
        [
            "-ss",
            "30.000000",
            "-t",
            "4.250000",
            "-i",
            "/media/voice.file"
        ]
    );
    let chain = chain_of_input(ch, input);
    let want = format!(
        "[{}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,atrim=end_sample=192000,asetpts=(N+0)/SR/TB,afade=t=in:st=0.000000:d=1.000000:curve=tri,asetpts=N/SR/TB,adelay=delays=96000S:all=1,volume=0.251189[a0]",
        input.index
    );
    assert_eq!(
        chain, want,
        "mono is spread at unity; −6 dB clip × −6 dB track = 0.251"
    );
    assert!(ch.filter_complex.contains("anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=480000[bed]"));
    assert!(ch.filter_complex.ends_with("[bed][a0]amix=inputs=2:normalize=0:duration=first:dropout_transition=0,atrim=end_sample=480000[aout]"));
    assert_eq!(
        &ch.args[ch.args.len() - 9..],
        [
            "-c:a",
            "pcm_s24le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "nut",
            "chunk_0000.nut"
        ]
    );

    // project sample rate is honoured
    fx.p.settings.sample_rate = 44_100;
    let plan = fx.plan();
    assert!(
        plan.chunks[0].filter_complex.contains("aresample=44100")
            && plan.chunks[0].filter_complex.contains("anullsrc=r=44100")
    );
    assert_eq!(arg_after(&plan.chunks[0].args, "-ar"), "44100");
    assert_eq!(plan.chunks[0].samples, 441_000);
}

// ---------------------------------------------------------------------------------
// settings, codecs, ranges, errors
// ---------------------------------------------------------------------------------

#[test]
fn export_settings_are_validated() {
    let fx = Fx::new(1920, 1080, FrameRate::FPS_30);
    let base = fx.settings();
    assert_eq!(
        base,
        ExportSettings {
            width: 1920,
            height: 1080,
            fps: FrameRate::FPS_30,
            video_codec: VideoCodec::H264,
            quality: Quality::Standard,
            audio_bitrate_kbps: 192,
            burn_captions: true,
            range: None
        }
    );
    assert!(base.validate().is_ok());
    let field = |s: ExportSettings| match s.validate() {
        Err(RenderError::InvalidSettings { field, message }) => {
            assert!(!message.is_empty());
            field
        }
        other => panic!("expected InvalidSettings, got {other:?}"),
    };
    assert_eq!(
        field(ExportSettings {
            width: 1921,
            ..base.clone()
        }),
        "width"
    );
    assert_eq!(
        field(ExportSettings {
            height: 1081,
            ..base.clone()
        }),
        "height"
    );
    assert_eq!(
        field(ExportSettings {
            width: 4098,
            ..base.clone()
        }),
        "width"
    );
    assert_eq!(
        field(ExportSettings {
            height: 8,
            ..base.clone()
        }),
        "height"
    );
    assert_eq!(
        field(ExportSettings {
            fps: FrameRate { num: 120, den: 1 },
            ..base.clone()
        }),
        "fps"
    );
    assert_eq!(
        field(ExportSettings {
            fps: FrameRate { num: 61, den: 1 },
            ..base.clone()
        }),
        "fps"
    );
    assert_eq!(
        field(ExportSettings {
            fps: FrameRate { num: 0, den: 1 },
            ..base.clone()
        }),
        "fps"
    );
    assert_eq!(
        field(ExportSettings {
            audio_bitrate_kbps: 8,
            ..base.clone()
        }),
        "audio_bitrate_kbps"
    );
    assert_eq!(
        field(ExportSettings {
            range: Some((t(3.0), t(3.0))),
            ..base.clone()
        }),
        "range"
    );
    assert_eq!(
        field(ExportSettings {
            range: Some((t(-1.0), t(3.0))),
            ..base.clone()
        }),
        "range"
    );
    // up to 4K (UHD and DCI) at 60 fps is fine
    for (w, h) in [(3840, 2160), (4096, 2160), (2160, 3840), (16, 16)] {
        assert!(
            ExportSettings {
                width: w,
                height: h,
                fps: FrameRate::FPS_60,
                ..base.clone()
            }
            .validate()
            .is_ok(),
            "{w}×{h}@60"
        );
    }
    assert!(ExportSettings {
        fps: FrameRate::FPS_59_94,
        ..base.clone()
    }
    .validate()
    .is_ok());
    // settings round-trip through JSON with sensible defaults
    let s: ExportSettings =
        serde_json::from_str(r#"{"width":1280,"height":720,"fps":{"num":25,"den":1}}"#).unwrap();
    assert_eq!(
        (
            s.video_codec,
            s.quality,
            s.audio_bitrate_kbps,
            s.burn_captions,
            s.range
        ),
        (VideoCodec::H264, Quality::Standard, 192, true, None)
    );
    assert_eq!(serde_json::to_value(VideoCodec::Vp9).unwrap(), "vp9");
    assert_eq!(serde_json::to_value(Quality::Draft).unwrap(), "draft");

    // invalid settings are rejected by the planner too
    let mut fx = Fx::new(1920, 1080, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 1.0);
    let err = build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &fx.sources,
        &ExportSettings {
            width: 333,
            ..fx.settings()
        },
        &env(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "invalid_settings");
}

#[test]
fn codec_quality_and_container_arguments() {
    let mut fx = Fx::new(3840, 2160, FrameRate::FPS_60);
    fx.add("movie", "V1", 0.0, 0.0, 2.0);
    let with = |codec, quality| {
        fx.plan_with(&ExportSettings {
            video_codec: codec,
            quality,
            audio_bitrate_kbps: 256,
            ..fx.settings()
        })
    };

    let p = with(VideoCodec::H264, Quality::Standard);
    let a = &p.chunks[0].args;
    assert_eq!(
        (
            arg_after(a, "-c:v"),
            arg_after(a, "-preset"),
            arg_after(a, "-crf"),
            arg_after(a, "-pix_fmt"),
            arg_after(a, "-g")
        ),
        ("libx264", "fast", "20", "yuv420p", "120")
    );
    assert_eq!(
        (arg_after(a, "-colorspace"), arg_after(a, "-color_range")),
        ("bt709", "tv")
    );
    assert_eq!(
        arg_after(a, "-c:a"),
        "pcm_s24le",
        "chunks carry lossless audio; it is encoded once at the end"
    );
    assert_eq!(
        &a[..8],
        [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-nostats",
            "-progress",
            "pipe:1"
        ]
    );
    assert_eq!(p.output_name, "output.mp4");
    assert_eq!(
        p.final_args,
        [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-nostats",
            "-progress",
            "pipe:1",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "chunks.ffconcat",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            "output.mp4"
        ]
    );
    assert!(p.chunks[0].filter_complex.contains("s=3840x2160:r=60"));
    assert_eq!(p.total_frames, 120);

    assert_eq!(
        arg_after(
            &with(VideoCodec::H264, Quality::Draft).chunks[0].args,
            "-crf"
        ),
        "27"
    );
    assert_eq!(
        arg_after(
            &with(VideoCodec::H264, Quality::High).chunks[0].args,
            "-preset"
        ),
        "slow"
    );

    let p = with(VideoCodec::Hevc, Quality::High);
    assert_eq!(arg_after(&p.chunks[0].args, "-c:v"), "libx265");
    assert!(arg_after(&p.chunks[0].args, "-x265-params").contains("open-gop=0"));
    assert!(
        !p.chunks[0].args.contains(&"hvc1".to_string()),
        "the hvc1 tag belongs to the final MP4, not the intermediate"
    );
    assert_eq!(arg_after(&p.final_args, "-tag:v"), "hvc1");
    assert_eq!(p.final_args.last().unwrap(), "output.mp4");

    let p = with(VideoCodec::Vp9, Quality::Standard);
    let a = &p.chunks[0].args;
    assert_eq!(
        (
            arg_after(a, "-c:v"),
            arg_after(a, "-b:v"),
            arg_after(a, "-row-mt")
        ),
        ("libvpx-vp9", "0", "1")
    );
    assert_eq!(arg_after(&p.final_args, "-c:a"), "libopus");
    assert!(!p.final_args.contains(&"-movflags".to_string()));
    assert_eq!(p.output_name, "output.webm");
    let s = ExportSettings {
        video_codec: VideoCodec::Vp9,
        ..fx.settings()
    };
    assert_eq!((s.extension(), s.mime_type()), ("webm", "video/webm"));
    assert_eq!(
        (fx.settings().extension(), fx.settings().mime_type()),
        ("mp4", "video/mp4")
    );
}

#[test]
fn export_resolution_and_frame_rate_are_independent_of_the_project() {
    let mut fx = Fx::new(1920, 1080, FrameRate::FPS_30);
    let c = fx.add("movie", "V1", 0.0, 0.0, 3.0);
    fx.patch(
        &c[..1],
        ClipPatch {
            scale: Some(0.5),
            x: Some(0.25),
            ..Default::default()
        },
    );
    fx.text("Title", 0.0, 3.0);
    let hd = fx.plan();
    let uhd = fx.plan_with(&ExportSettings {
        width: 3840,
        height: 2160,
        fps: FrameRate::FPS_60,
        ..fx.settings()
    });
    assert_eq!(hd.total_frames, 90);
    assert_eq!(uhd.total_frames, 180, "same duration, twice the frames");
    assert_eq!(uhd.duration, hd.duration);
    assert!(
        hd.chunks[0].filter_complex.contains("scale=960:540:")
            && hd.chunks[0].filter_complex.contains("overlay=x=960:y=270")
    );
    assert!(
        uhd.chunks[0].filter_complex.contains("scale=1920:1080:")
            && uhd.chunks[0]
                .filter_complex
                .contains("overlay=x=1920:y=540"),
        "layout scales with the output"
    );
    assert!(
        hd.chunks[0].filter_complex.contains("fontsize=97:")
            && uhd.chunks[0].filter_complex.contains("fontsize=194:")
    );
    assert!(
        uhd.chunks[0].filter_complex.contains("fps=60")
            && uhd.chunks[0]
                .filter_complex
                .contains("enable='between((t*60/1),-0.5,179.5)'")
    );
    assert_eq!(uhd.chunks[0].samples, 144_000);
}

#[test]
fn range_exports_only_the_requested_part() {
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let a = fx.add("movie", "V1", 0.0, 50.0, 60.0);
    let b = fx.add("movie", "V1", 10.0, 200.0, 230.0);
    let plan = fx.plan_with(&ExportSettings {
        range: Some((t(8.0), t(12.0))),
        ..fx.settings()
    });
    assert_eq!(plan.total_frames, 120);
    assert_eq!(
        (plan.start, plan.end, plan.duration),
        (t(8.0), t(12.0), 4 * S)
    );
    assert_eq!(plan.chunks.len(), 1);
    let ch = &plan.chunks[0];
    assert_eq!((ch.first_frame, ch.frames), (0, 120));
    assert_eq!(
        video_input(ch, &a[0]).seek,
        Some(58 * S),
        "starts 8 s into the first clip"
    );
    assert_eq!(video_input(ch, &b[0]).seek, Some(200 * S));
    assert!(
        ch.filter_complex
            .contains("enable='between((t*30/1),-0.5,59.5)'")
            && ch
                .filter_complex
                .contains("enable='between((t*30/1),59.5,119.5)'")
    );
    // clips entirely outside the range are not even opened
    let plan = fx.plan_with(&ExportSettings {
        range: Some((t(12.0), t(14.0))),
        ..fx.settings()
    });
    assert!(plan.chunks[0]
        .inputs
        .iter()
        .all(|i| i.clip_id != a[0] && i.clip_id != a[1]));
    assert_eq!(video_input(&plan.chunks[0], &b[0]).seek, Some(202 * S));
    // a range past the end is clamped; one entirely outside is rejected
    let plan = fx.plan_with(&ExportSettings {
        range: Some((t(38.0), t(100.0))),
        ..fx.settings()
    });
    assert_eq!(plan.total_frames, 60);
    let err = build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &fx.sources,
        &ExportSettings {
            range: Some((t(50.0), t(60.0))),
            ..fx.settings()
        },
        &env(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "invalid_settings");
}

#[test]
fn planning_failures_are_reported_before_any_rendering() {
    let fx = Fx::new(1280, 720, FrameRate::FPS_30);
    let err = build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &fx.sources,
        &fx.settings(),
        &env(),
    )
    .unwrap_err();
    assert_eq!(err, RenderError::EmptyTimeline);
    assert_eq!(err.code(), "empty_timeline");
    assert!(err.to_string().contains("Add at least one clip"));

    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    fx.add("movie", "V1", 0.0, 0.0, 2.0);
    let mut sources = fx.sources.clone();
    sources.remove("movie");
    let err = build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &sources,
        &fx.settings(),
        &env(),
    )
    .unwrap_err();
    assert_eq!(
        err,
        RenderError::MissingSource {
            asset_id: "movie".into(),
            name: "movie.file".into()
        }
    );
    assert!(err.to_string().contains("movie.file") && err.to_string().contains("Re-import"));
    assert_eq!(
        serde_json::to_value(&err).unwrap()["code"],
        "missing_source"
    );

    // an asset whose file turned out to have no video stream
    let mut sources = fx.sources.clone();
    sources.get_mut("movie").unwrap().has_video = false;
    let err = build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &sources,
        &fx.settings(),
        &env(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "unusable_source");
    assert!(err.to_string().contains("no video stream"));

    // a missing source only matters if something active uses it
    let mut sources = fx.sources.clone();
    sources.remove("voice");
    sources.remove("photo");
    assert!(build_plan(
        &fx.p,
        &resolve_layers(&fx.p),
        &sources,
        &fx.settings(),
        &env()
    )
    .is_ok());
}

#[test]
fn transition_handles_that_run_out_of_media_hold_a_frame() {
    // The outgoing clip ends exactly at the end of its media, and a chunk boundary
    // falls inside its transition handle: the second chunk has nothing but the handle.
    let mut fx = Fx::new(1280, 720, FrameRate::FPS_30);
    fx.asset(
        "short",
        AssetKind::Video,
        true,
        true,
        1280,
        720,
        19.5,
        Some(FrameRate::FPS_30),
        Some(2),
    );
    let a = fx.add("short", "V1", 0.0, 0.0, 19.5);
    let b = fx.add("movie", "V1", 19.5, 5.0, 30.0);
    fx.cmd(Command::AddTransitions {
        left_clip_ids: vec![a[0].clone()],
        kind: TransitionKind::CrossDissolve,
        duration: 2 * S,
    });
    let plan = fx.plan();
    assert!(plan.chunks.len() >= 2);
    let c1 = &plan.chunks[1];
    assert_eq!(c1.start, t(20.0));
    // picture: last frame of the media, held (the layer runs until 20.5 s)
    let held = video_input(c1, &a[0]);
    assert_eq!(
        held.seek,
        Some(19 * S + S / 4),
        "seeks close to the end to grab the last frame"
    );
    assert_eq!(held.limit, None);
    let chain = chain_of_input(c1, held);
    assert!(
        chain.contains("reverse,trim=end_frame=1,setpts=PTS-STARTPTS"),
        "{chain}"
    );
    assert!(c1
        .filter_complex
        .contains("enable='between((t*30/1),-0.5,14.5)'"));
    // sound: nothing left to play → no input at all, just the other clip
    assert!(c1
        .inputs
        .iter()
        .all(|i| !(i.clip_id == a[1] && i.role == InputRole::Audio)));
    assert!(c1
        .inputs
        .iter()
        .any(|i| i.clip_id == b[1] && i.role == InputRole::Audio));
    // the incoming clip has real handle media (source 4–5 s) and uses it
    let c0 = &plan.chunks[0];
    assert_eq!(video_input(c0, &b[0]).seek, Some(4 * S));
    assert!(!chain_of_input(c0, video_input(c0, &b[0])).contains("tpad"));
}
