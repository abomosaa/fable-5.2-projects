//! Export job runner: executes a [`RenderPlan`] with real FFmpeg processes.
//!
//! * every chunk of the plan is rendered by its own `ffmpeg` child (bounded
//!   parallelism), progress is parsed from `-progress pipe:1`
//! * the chunks are joined and the audio encoded in a final step
//! * the finished file is probed and verified before the job is reported complete
//! * cancellation kills all children, failures are mapped to actionable messages
//! * job state is persisted as `job.json` so finished exports survive restarts

use cutline_core::model::{AssetId, Project};
use cutline_core::render::{
    build_plan, ExportSettings, MediaSource, RenderEnv, RenderError, RenderPlan,
};
use cutline_core::resolve::Layer;
use cutline_core::time::Ticks;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderState {
    Queued,
    Rendering,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
}

impl RenderState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RenderState::Completed | RenderState::Failed | RenderState::Cancelled
        )
    }
}

/// Why an export failed, phrased for the person who has to fix it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderFailure {
    /// Stable machine readable code (`ffmpeg_not_found`, `encoder_unavailable`, …).
    pub code: String,
    /// What went wrong, user facing.
    pub message: String,
    /// What to do about it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Last lines of FFmpeg's error output, for bug reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_tail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderJob {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub state: RenderState,
    /// 0..=1
    pub progress: f64,
    /// Human readable description of the current step.
    pub stage: String,
    pub settings: ExportSettings,
    /// Output duration in ticks.
    pub duration: Ticks,
    pub total_frames: i64,
    pub frames_done: i64,
    /// Rendering speed in output frames per second.
    #[serde(default)]
    pub fps_speed: Option<f64>,
    #[serde(default)]
    pub eta_seconds: Option<f64>,
    #[serde(default)]
    pub error: Option<RenderFailure>,
    /// Suggested download name, e.g. `My project.mp4`.
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub file_size: Option<u64>,
    /// Duration probed from the finished file.
    #[serde(default)]
    pub output_duration_ms: Option<i64>,
    pub created_at_ms: i64,
    #[serde(default)]
    pub finished_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct RenderConfig {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub exports_dir: PathBuf,
    pub env: RenderEnv,
    /// How many chunks are encoded at the same time (each encoder is itself
    /// multi-threaded).
    pub max_parallel_chunks: usize,
}

pub type RenderListener = Arc<dyn Fn(&RenderJob) + Send + Sync>;

struct Entry {
    job: RenderJob,
    cancel: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

struct Inner {
    cfg: RenderConfig,
    listener: RenderListener,
    jobs: Mutex<BTreeMap<String, Entry>>,
}

/// Owns all export jobs. Cheap to clone.
#[derive(Clone)]
pub struct RenderManager {
    inner: Arc<Inner>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const JOB_FILE: &str = "job.json";

fn download_name(project_name: &str, ext: &str) -> String {
    let cleaned: String = project_name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let base: String = cleaned.chars().take(80).collect();
    let base = base.trim().trim_matches('.').to_string();
    format!(
        "{}.{ext}",
        if base.is_empty() {
            "export".to_string()
        } else {
            base
        }
    )
}

fn tail(text: &str, max_lines: usize, max_chars: usize) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let start = lines.len().saturating_sub(max_lines);
    let mut s = lines[start..].join("\n");
    if s.chars().count() > max_chars {
        let skip = s.chars().count() - max_chars;
        s = s.chars().skip(skip).collect();
    }
    Some(s)
}

fn failure(
    code: &str,
    message: impl Into<String>,
    hint: Option<&str>,
    log: Option<String>,
) -> RenderFailure {
    RenderFailure {
        code: code.to_string(),
        message: message.into(),
        hint: hint.map(str::to_string),
        log_tail: log,
    }
}

/// The FFmpeg binary could not be started at all.
fn spawn_failure(program: &Path, err: &std::io::Error) -> RenderFailure {
    if err.kind() == std::io::ErrorKind::NotFound {
        failure(
            "ffmpeg_not_found",
            format!("FFmpeg could not be started: “{}” was not found.", program.display()),
            Some("Install FFmpeg 6.1 or newer (Linux: your package manager, macOS: `brew install ffmpeg`, Windows: `winget install ffmpeg`) or point FFMPEG_PATH / FFPROBE_PATH at the binaries, then export again."),
            None,
        )
    } else if err.kind() == std::io::ErrorKind::PermissionDenied {
        failure(
            "ffmpeg_not_executable",
            format!("FFmpeg at “{}” is not executable.", program.display()),
            Some("Check the file permissions of the FFmpeg binary or set FFMPEG_PATH to a working one."),
            None,
        )
    } else {
        failure(
            "ffmpeg_spawn_failed",
            format!("FFmpeg could not be started: {err}"),
            Some("Check that FFmpeg is installed correctly and try again."),
            None,
        )
    }
}

/// Map FFmpeg's error output to something a user can act on.
pub fn classify_ffmpeg_error(stderr: &str, settings: &ExportSettings) -> RenderFailure {
    use cutline_core::render::VideoCodec;
    let lower = stderr.to_lowercase();
    let log = tail(stderr, 12, 2000);
    let codec = match settings.video_codec {
        VideoCodec::H264 => "H.264 (libx264)",
        VideoCodec::Hevc => "HEVC (libx265)",
        VideoCodec::Vp9 => "VP9 (libvpx-vp9)",
    };
    if lower.contains("unknown encoder")
        || lower.contains("encoder not found")
        || lower.contains("error selecting an encoder")
    {
        return failure(
            "encoder_unavailable",
            format!("This FFmpeg build cannot encode {codec} (or the matching audio codec)."),
            Some("Choose a different codec in the export dialog (H.264 is the most widely available) or install a full FFmpeg build."),
            log,
        );
    }
    if lower.contains("no space left on device") {
        return failure(
            "disk_full",
            "The disk ran out of space while exporting.",
            Some("Free up disk space (or lower the resolution / quality) and export again."),
            log,
        );
    }
    if lower.contains("no such file or directory") {
        return failure(
            "source_missing",
            "A media file used on the timeline could not be opened.",
            Some("The original file may have been moved or deleted. Re-import the media or remove its clips, then export again."),
            log,
        );
    }
    if lower.contains("permission denied") {
        return failure(
            "permission_denied",
            "FFmpeg was not allowed to read a media file or write the export.",
            Some("Check the permissions of the data directory and export again."),
            log,
        );
    }
    if lower.contains("invalid data found when processing input")
        || lower.contains("moov atom not found")
        || lower.contains("could not find codec parameters")
    {
        return failure(
            "source_unreadable",
            "A media file used on the timeline is damaged or in a format FFmpeg cannot decode.",
            Some("Re-import the file (or convert it to MP4 first), then export again."),
            log,
        );
    }
    if lower.contains("no such filter")
        || lower.contains("option not found")
        || (lower.contains("option '") && lower.contains("not found"))
        || lower.contains("unrecognized option")
    {
        return failure(
            "ffmpeg_too_old",
            "The installed FFmpeg is missing a feature the exporter needs.",
            Some("Update FFmpeg to version 6.1 or newer (built with libfreetype for text) and export again."),
            log,
        );
    }
    if lower.contains("cannot allocate memory") || lower.contains("out of memory") {
        return failure(
            "out_of_memory",
            "FFmpeg ran out of memory while exporting.",
            Some("Close other applications or export at a lower resolution."),
            log,
        );
    }
    failure(
        "ffmpeg_failed",
        "FFmpeg stopped with an error while rendering.",
        Some("Try again. If it keeps failing, export with a different codec or resolution and include the log below in a bug report."),
        log,
    )
}

enum RunError {
    Cancelled,
    Failed(RenderFailure),
}

impl RenderManager {
    /// Create the manager and load persisted jobs. Jobs that were still running when
    /// the server stopped are marked failed ("interrupted").
    pub fn new(cfg: RenderConfig, listener: RenderListener) -> Self {
        let mut jobs = BTreeMap::new();
        let _ = std::fs::create_dir_all(&cfg.exports_dir);
        if let Ok(rd) = std::fs::read_dir(&cfg.exports_dir) {
            for e in rd.flatten() {
                let dir = e.path();
                let Ok(text) = std::fs::read_to_string(dir.join(JOB_FILE)) else {
                    continue;
                };
                let Ok(mut job) = serde_json::from_str::<RenderJob>(&text) else {
                    continue;
                };
                if !job.state.is_terminal() {
                    job.state = RenderState::Failed;
                    job.stage = "Interrupted".into();
                    job.fps_speed = None;
                    job.eta_seconds = None;
                    job.finished_at_ms = Some(now_ms());
                    job.error = Some(failure(
                        "interrupted",
                        "The export was interrupted because the server restarted.",
                        Some("Start the export again."),
                        None,
                    ));
                    clean_intermediates(&dir, None);
                    let _ = write_job(&dir, &job);
                } else if job.state == RenderState::Completed {
                    let ok = job_output(&dir, &job).is_some_and(|p| p.is_file());
                    if !ok {
                        job.state = RenderState::Failed;
                        job.error = Some(failure(
                            "output_missing",
                            "The exported file is no longer on disk.",
                            Some("Export the project again."),
                            None,
                        ));
                        let _ = write_job(&dir, &job);
                    }
                }
                jobs.insert(
                    job.id.clone(),
                    Entry {
                        job,
                        cancel: None,
                        task: None,
                    },
                );
            }
        }
        RenderManager {
            inner: Arc::new(Inner {
                cfg,
                listener,
                jobs: Mutex::new(jobs),
            }),
        }
    }

    fn job_dir(&self, job_id: &str) -> PathBuf {
        self.inner.cfg.exports_dir.join(job_id)
    }

    /// Plan (synchronously, so bad settings, an empty timeline or unknown media are
    /// rejected immediately) and start rendering in the background.
    pub fn start(
        &self,
        project: &Project,
        layers: &[Layer],
        sources: BTreeMap<AssetId, MediaSource>,
        settings: ExportSettings,
    ) -> Result<RenderJob, RenderError> {
        let plan = build_plan(project, layers, &sources, &settings, &self.inner.cfg.env)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let job = RenderJob {
            id: id.clone(),
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            state: RenderState::Queued,
            progress: 0.0,
            stage: "Queued".into(),
            settings: settings.clone(),
            duration: plan.duration,
            total_frames: plan.total_frames,
            frames_done: 0,
            fps_speed: None,
            eta_seconds: None,
            error: None,
            file_name: Some(download_name(&project.name, settings.extension())),
            file_size: None,
            output_duration_ms: None,
            created_at_ms: now_ms(),
            finished_at_ms: None,
        };
        let dir = self.job_dir(&id);
        let _ = std::fs::create_dir_all(&dir);
        let _ = write_job(&dir, &job);
        let (tx, rx) = watch::channel(false);
        // names of the assets by path, for "file missing" messages
        let names: BTreeMap<String, String> = sources
            .iter()
            .map(|(asset_id, s)| {
                (
                    s.path.clone(),
                    project
                        .assets
                        .get(asset_id)
                        .map(|a| a.name.clone())
                        .unwrap_or_else(|| asset_id.clone()),
                )
            })
            .collect();
        {
            let mut jobs = self.inner.jobs.lock().unwrap();
            jobs.insert(
                id.clone(),
                Entry {
                    job: job.clone(),
                    cancel: Some(tx),
                    task: None,
                },
            );
        }
        (self.inner.listener)(&job);
        let this = self.clone();
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            this.run(task_id, plan, names, rx).await;
        });
        if let Some(e) = self.inner.jobs.lock().unwrap().get_mut(&id) {
            e.task = Some(task);
        }
        Ok(job)
    }

    /// Apply a mutation to a job, persist and broadcast it.
    fn update(&self, id: &str, persist: bool, f: impl FnOnce(&mut RenderJob)) -> Option<RenderJob> {
        let job = {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let e = jobs.get_mut(id)?;
            f(&mut e.job);
            e.job.clone()
        };
        if persist {
            let _ = write_job(&self.job_dir(id), &job);
        }
        (self.inner.listener)(&job);
        Some(job)
    }

    async fn run(
        &self,
        id: String,
        plan: RenderPlan,
        names: BTreeMap<String, String>,
        mut cancel: watch::Receiver<bool>,
    ) {
        let dir = self.job_dir(&id);
        let result = self.execute(&id, &dir, &plan, &names, &mut cancel).await;
        match result {
            Ok((size, duration_ms)) => {
                clean_intermediates(&dir, Some(&plan.output_name));
                self.update(&id, true, |j| {
                    j.state = RenderState::Completed;
                    j.progress = 1.0;
                    j.frames_done = j.total_frames;
                    j.stage = "Completed".into();
                    j.eta_seconds = Some(0.0);
                    j.file_size = Some(size);
                    j.output_duration_ms = Some(duration_ms);
                    j.finished_at_ms = Some(now_ms());
                });
            }
            Err(RunError::Cancelled) => {
                clean_intermediates(&dir, None);
                self.update(&id, true, |j| {
                    j.state = RenderState::Cancelled;
                    j.stage = "Cancelled".into();
                    j.fps_speed = None;
                    j.eta_seconds = None;
                    j.finished_at_ms = Some(now_ms());
                });
            }
            Err(RunError::Failed(f)) => {
                clean_intermediates(&dir, None);
                tracing::warn!(job = %id, code = %f.code, "export failed: {}", f.message);
                self.update(&id, true, |j| {
                    j.state = RenderState::Failed;
                    j.stage = "Failed".into();
                    j.fps_speed = None;
                    j.eta_seconds = None;
                    j.error = Some(f);
                    j.finished_at_ms = Some(now_ms());
                });
            }
        }
        if let Some(e) = self.inner.jobs.lock().unwrap().get_mut(&id) {
            e.cancel = None;
        }
    }

    async fn execute(
        &self,
        id: &str,
        dir: &Path,
        plan: &RenderPlan,
        names: &BTreeMap<String, String>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<(u64, i64), RunError> {
        let cfg = &self.inner.cfg;
        let settings = self
            .get(id)
            .map(|j| j.settings)
            .ok_or(RunError::Cancelled)?;
        if *cancel.borrow() {
            return Err(RunError::Cancelled);
        }
        // 1. the sources must still be on disk
        for chunk in &plan.chunks {
            for input in &chunk.inputs {
                if !Path::new(&input.path).is_file() {
                    let name = names
                        .get(&input.path)
                        .cloned()
                        .unwrap_or_else(|| input.path.clone());
                    return Err(RunError::Failed(failure(
                        "source_missing",
                        format!("The media file for “{name}” is missing on disk."),
                        Some("Re-import the media or remove its clips from the timeline, then export again."),
                        None,
                    )));
                }
            }
        }
        // 2. job files
        let io_fail = |what: &str, e: std::io::Error| {
            RunError::Failed(failure(
                if e.kind() == std::io::ErrorKind::StorageFull { "disk_full" } else { "io_error" },
                format!("Could not {what}: {e}"),
                Some("Check free disk space and the permissions of the data directory, then export again."),
                None,
            ))
        };
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| io_fail("create the export folder", e))?;
        for t in &plan.text_files {
            tokio::fs::write(dir.join(&t.name), t.content.as_bytes())
                .await
                .map_err(|e| io_fail("write export files", e))?;
        }
        for f in &plan.font_files {
            tokio::fs::copy(&f.source, dir.join(&f.name)).await.map_err(|e| {
                RunError::Failed(failure(
                    "font_missing",
                    format!("The font file “{}” needed for text could not be read: {e}", f.source),
                    Some("Reinstall the application files (the fonts ship in web/fonts) and export again."),
                    None,
                ))
            })?;
        }
        tokio::fs::write(
            dir.join(&plan.concat_list_name),
            plan.concat_list.as_bytes(),
        )
        .await
        .map_err(|e| io_fail("write export files", e))?;

        // 3. render the chunks
        let n_chunks = plan.chunks.len();
        self.update(id, true, |j| {
            j.state = RenderState::Rendering;
            j.stage = if n_chunks > 1 {
                format!("Rendering ({n_chunks} segments)")
            } else {
                "Rendering".into()
            };
        });
        let counters: Arc<Vec<AtomicI64>> =
            Arc::new((0..n_chunks).map(|_| AtomicI64::new(0)).collect());
        let started = Instant::now();
        let total = plan.total_frames.max(1);

        // progress reporter (≈5 updates per second)
        let reporter = {
            let this = self.clone();
            let id = id.to_string();
            let counters = counters.clone();
            tokio::spawn(async move {
                let mut last = -1i64;
                let mut tick = tokio::time::interval(Duration::from_millis(200));
                loop {
                    tick.tick().await;
                    let done: i64 = counters
                        .iter()
                        .map(|c| c.load(Ordering::Relaxed))
                        .sum::<i64>()
                        .min(total);
                    if done == last {
                        continue;
                    }
                    last = done;
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let speed = done as f64 / elapsed;
                    this.update(&id, false, |j| {
                        if j.state != RenderState::Rendering {
                            return;
                        }
                        j.frames_done = j.frames_done.max(done);
                        j.progress = j.progress.max(0.97 * done as f64 / total as f64);
                        if done > 0 {
                            j.fps_speed = Some((speed * 10.0).round() / 10.0);
                            j.eta_seconds =
                                Some(((total - done) as f64 / speed.max(0.001) * 1.03).round());
                        }
                    });
                }
            })
        };

        let parallel = cfg.max_parallel_chunks.max(1);
        let (abort_tx, abort_rx) = watch::channel(false);
        let limiter = Arc::new(Semaphore::new(parallel));
        let mut set: JoinSet<Result<(), RunError>> = JoinSet::new();
        for chunk in &plan.chunks {
            let counters = counters.clone();
            let mut cancel = cancel.clone();
            let mut abort = abort_rx.clone();
            let settings = settings.clone();
            let limiter = limiter.clone();
            let ffmpeg = cfg.ffmpeg.clone();
            let dir = dir.to_path_buf();
            let (index, frames, args) = (chunk.index, chunk.frames, chunk.args.clone());
            set.spawn(async move {
                let _permit = limiter
                    .acquire_owned()
                    .await
                    .map_err(|_| RunError::Cancelled)?;
                if *cancel.borrow() || *abort.borrow() {
                    return Err(RunError::Cancelled);
                }
                let counter = &counters[index];
                let r = run_ffmpeg(
                    &ffmpeg,
                    &args,
                    &dir,
                    &mut cancel,
                    Some(&mut abort),
                    |frame| {
                        counter.store(frame.min(frames), Ordering::Relaxed);
                    },
                )
                .await;
                match r {
                    Ok(()) => {
                        counter.store(frames, Ordering::Relaxed);
                        Ok(())
                    }
                    Err(FfmpegError::Cancelled) => Err(RunError::Cancelled),
                    Err(FfmpegError::Spawn(e)) => Err(RunError::Failed(spawn_failure(&ffmpeg, &e))),
                    Err(FfmpegError::Exit(stderr)) => {
                        Err(RunError::Failed(classify_ffmpeg_error(&stderr, &settings)))
                    }
                }
            });
        }

        let mut outcome: Result<(), RunError> = Ok(());
        while let Some(joined) = set.join_next().await {
            let r = joined.unwrap_or_else(|e| {
                Err(RunError::Failed(failure(
                    "internal_error",
                    format!("An export worker stopped unexpectedly: {e}"),
                    Some("Try exporting again."),
                    None,
                )))
            });
            if let Err(e) = r {
                // stop the siblings; keep the first real failure
                let _ = abort_tx.send(true);
                match (&outcome, &e) {
                    (Ok(()), _) => outcome = Err(e),
                    (Err(RunError::Cancelled), RunError::Failed(_)) if !*cancel.borrow() => {
                        outcome = Err(e)
                    }
                    _ => {}
                }
            }
        }
        reporter.abort();
        let _ = reporter.await;
        if *cancel.borrow() {
            return Err(RunError::Cancelled);
        }
        outcome?;

        // 4. join chunks, encode audio, mux
        self.update(id, true, |j| {
            j.state = RenderState::Finalizing;
            j.stage = "Finalizing (joining segments and encoding audio)".into();
            j.frames_done = j.total_frames;
            j.progress = j.progress.max(0.97);
            j.eta_seconds = None;
        });
        let duration_us = (plan.duration as i128 * 1_000_000
            / cutline_core::time::TICKS_PER_SECOND as i128)
            .max(1) as f64;
        let this = self.clone();
        let fin_id = id.to_string();
        let mut last_report = Instant::now();
        let r = run_ffmpeg_with(
            &cfg.ffmpeg,
            &plan.final_args,
            dir,
            cancel,
            None,
            |key, value| {
                if key == "out_time_us" || key == "out_time_ms" {
                    if let Ok(us) = value.parse::<f64>() {
                        if last_report.elapsed() >= Duration::from_millis(200) {
                            last_report = Instant::now();
                            let frac = (us / duration_us).clamp(0.0, 1.0);
                            this.update(&fin_id, false, |j| {
                                j.progress = j.progress.max(0.97 + 0.025 * frac)
                            });
                        }
                    }
                }
            },
        )
        .await;
        match r {
            Ok(()) => {}
            Err(FfmpegError::Cancelled) => return Err(RunError::Cancelled),
            Err(FfmpegError::Spawn(e)) => {
                return Err(RunError::Failed(spawn_failure(&cfg.ffmpeg, &e)))
            }
            Err(FfmpegError::Exit(stderr)) => {
                return Err(RunError::Failed(classify_ffmpeg_error(&stderr, &settings)))
            }
        }

        // 5. verify the result is a real, playable file
        let out = dir.join(&plan.output_name);
        let size = tokio::fs::metadata(&out)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if size == 0 {
            return Err(RunError::Failed(failure(
                "output_invalid",
                "FFmpeg finished but produced an empty file.",
                Some("Try exporting again, or with a different codec."),
                None,
            )));
        }
        let probe = probe_output(&cfg.ffprobe, &out)
            .await
            .map_err(RunError::Failed)?;
        if !probe.has_video || probe.duration_ms <= 0 {
            return Err(RunError::Failed(failure(
                "output_invalid",
                "The exported file failed verification (no playable video stream).",
                Some("Try exporting again, or with a different codec."),
                None,
            )));
        }
        if *cancel.borrow() {
            return Err(RunError::Cancelled);
        }
        Ok((size, probe.duration_ms))
    }

    /// Cancel a running export. Returns the job (in its final state) if it exists.
    pub async fn cancel(&self, job_id: &str) -> Option<RenderJob> {
        let task = {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let e = jobs.get_mut(job_id)?;
            if e.job.state.is_terminal() {
                return Some(e.job.clone());
            }
            if let Some(tx) = &e.cancel {
                let _ = tx.send(true);
            }
            e.task.take()
        };
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(15), t).await;
        }
        self.get(job_id)
    }

    pub fn get(&self, job_id: &str) -> Option<RenderJob> {
        self.inner
            .jobs
            .lock()
            .unwrap()
            .get(job_id)
            .map(|e| e.job.clone())
    }

    /// Jobs of a project, newest first.
    pub fn list(&self, project_id: &str) -> Vec<RenderJob> {
        let mut v: Vec<RenderJob> = self
            .inner
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.job.project_id == project_id)
            .map(|e| e.job.clone())
            .collect();
        v.sort_by(|a, b| (b.created_at_ms, &b.id).cmp(&(a.created_at_ms, &a.id)));
        v
    }

    /// Cancel (if running) and remove a job together with its files.
    pub async fn delete(&self, job_id: &str) -> bool {
        if self.get(job_id).is_none() {
            return false;
        }
        self.cancel(job_id).await;
        self.inner.jobs.lock().unwrap().remove(job_id);
        let _ = tokio::fs::remove_dir_all(self.job_dir(job_id)).await;
        true
    }

    pub async fn delete_project(&self, project_id: &str) {
        let ids: Vec<String> = self
            .inner
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.job.project_id == project_id)
            .map(|e| e.job.id.clone())
            .collect();
        for id in ids {
            self.delete(&id).await;
        }
    }

    /// Path of the finished file (completed jobs only).
    pub fn output_path(&self, job_id: &str) -> Option<PathBuf> {
        let job = self.get(job_id)?;
        if job.state != RenderState::Completed {
            return None;
        }
        job_output(&self.job_dir(job_id), &job).filter(|p| p.is_file())
    }
}

fn job_output(dir: &Path, job: &RenderJob) -> Option<PathBuf> {
    Some(dir.join(format!("output.{}", job.settings.extension())))
}

fn write_job(dir: &Path, job: &RenderJob) -> std::io::Result<()> {
    let tmp = dir.join(format!("{JOB_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(job).unwrap_or_default())?;
    std::fs::rename(tmp, dir.join(JOB_FILE))
}

/// Remove everything from a job directory except `job.json` and (optionally) the output.
fn clean_intermediates(dir: &Path, keep: Option<&str>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == JOB_FILE || Some(name.as_str()) == keep {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
        } else {
            let _ = std::fs::remove_file(p);
        }
    }
}

enum FfmpegError {
    Cancelled,
    Spawn(std::io::Error),
    /// Non-zero exit; carries stderr.
    Exit(String),
}

async fn run_ffmpeg(
    program: &Path,
    args: &[String],
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
    abort: Option<&mut watch::Receiver<bool>>,
    mut on_frame: impl FnMut(i64),
) -> Result<(), FfmpegError> {
    run_ffmpeg_with(program, args, dir, cancel, abort, |key, value| {
        if key == "frame" {
            if let Ok(n) = value.parse::<i64>() {
                on_frame(n);
            }
        }
    })
    .await
}

/// Run one FFmpeg process to completion, feeding `-progress` key/value pairs to
/// `on_progress`. The child is killed (and reaped) on cancellation.
async fn run_ffmpeg_with(
    program: &Path,
    args: &[String],
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
    mut abort: Option<&mut watch::Receiver<bool>>,
    mut on_progress: impl FnMut(&str, &str),
) -> Result<(), FfmpegError> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(FfmpegError::Spawn)?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > 64 * 1024 {
                        let cut = buf.len() - 32 * 1024;
                        buf.drain(..cut);
                    }
                }
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut cancelled = *cancel.borrow() || abort.as_ref().is_some_and(|a| *a.borrow());
    let mut cancel_open = true;
    let mut abort_open = abort.is_some();
    while !cancelled {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some((k, v)) = l.split_once('=') {
                        on_progress(k.trim(), v.trim());
                    }
                }
                _ => break,
            },
            r = cancel.changed(), if cancel_open => {
                if r.is_err() { cancel_open = false; } else if *cancel.borrow() { cancelled = true; }
            }
            r = async { abort.as_mut().unwrap().changed().await }, if abort_open => {
                if r.is_err() { abort_open = false; } else if abort.as_ref().is_some_and(|a| *a.borrow()) { cancelled = true; }
            }
        }
    }
    if cancelled {
        let _ = child.kill().await; // kill() also waits, so no zombie is left behind
        let _ = child.wait().await;
        stderr_task.abort();
        return Err(FfmpegError::Cancelled);
    }
    // stdout closed: the process is exiting; still honour a late cancel
    let status = loop {
        tokio::select! {
            s = child.wait() => break s,
            r = cancel.changed(), if cancel_open => {
                if r.is_err() { cancel_open = false; } else if *cancel.borrow() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    stderr_task.abort();
                    return Err(FfmpegError::Cancelled);
                }
            }
        }
    };
    let stderr_text = stderr_task.await.unwrap_or_default();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err(FfmpegError::Exit(stderr_text)),
        Err(e) => Err(FfmpegError::Exit(format!(
            "{stderr_text}\nwait failed: {e}"
        ))),
    }
}

struct OutputProbe {
    has_video: bool,
    duration_ms: i64,
}

async fn probe_output(ffprobe: &Path, file: &Path) -> Result<OutputProbe, RenderFailure> {
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json"])
        .arg(file)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                failure(
                    "ffprobe_not_found",
                    format!("ffprobe could not be started: “{}” was not found.", ffprobe.display()),
                    Some("Install FFmpeg (it includes ffprobe) or set FFPROBE_PATH, then export again."),
                    None,
                )
            } else {
                failure("ffprobe_failed", format!("ffprobe could not be started: {e}"), None, None)
            }
        })?;
    if !out.status.success() {
        return Err(failure(
            "output_invalid",
            "The exported file could not be verified.",
            Some("Try exporting again, or with a different codec."),
            tail(&String::from_utf8_lossy(&out.stderr), 8, 1200),
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let has_video = v["streams"]
        .as_array()
        .is_some_and(|s| s.iter().any(|x| x["codec_type"] == "video"));
    let parse = |x: &serde_json::Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    let mut duration = parse(&v["format"]["duration"]).unwrap_or(0.0);
    if duration <= 0.0 {
        duration = v["streams"]
            .as_array()
            .map(|s| {
                s.iter()
                    .filter_map(|x| parse(&x["duration"]))
                    .fold(0.0, f64::max)
            })
            .unwrap_or(0.0);
    }
    Ok(OutputProbe {
        has_video,
        duration_ms: (duration * 1000.0).round() as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names_are_safe() {
        assert_eq!(
            download_name("My / Film: part 1?", "mp4"),
            "My Film part 1.mp4"
        );
        assert_eq!(download_name("  ", "webm"), "export.webm");
        assert_eq!(download_name("..", "mp4"), "export.mp4");
    }

    #[test]
    fn errors_are_classified() {
        let s = ExportSettings {
            width: 1280,
            height: 720,
            fps: cutline_core::FrameRate::FPS_30,
            video_codec: cutline_core::render::VideoCodec::Hevc,
            quality: cutline_core::render::Quality::Standard,
            audio_bitrate_kbps: 192,
            burn_captions: true,
            range: None,
        };
        assert_eq!(
            classify_ffmpeg_error("Unknown encoder 'libx265'", &s).code,
            "encoder_unavailable"
        );
        assert!(classify_ffmpeg_error("Unknown encoder 'libx265'", &s)
            .message
            .contains("HEVC"));
        assert_eq!(
            classify_ffmpeg_error("/x/y.mp4: No such file or directory", &s).code,
            "source_missing"
        );
        assert_eq!(
            classify_ffmpeg_error("av_interleaved_write_frame(): No space left on device", &s).code,
            "disk_full"
        );
        assert_eq!(
            classify_ffmpeg_error("[AVFilterGraph] No such filter: 'drawtext'", &s).code,
            "ffmpeg_too_old"
        );
        assert_eq!(
            classify_ffmpeg_error("a.mp4: Invalid data found when processing input", &s).code,
            "source_unreadable"
        );
        let generic = classify_ffmpeg_error("line1\nsomething odd happened", &s);
        assert_eq!(generic.code, "ffmpeg_failed");
        assert!(generic.log_tail.unwrap().contains("something odd"));
        assert!(generic.hint.is_some());
    }
}
