//! Application state: wires the stores, the media pipeline, transcription, rendering
//! and the assistant together.

use crate::assets::{AssetState, AssetStore};
use crate::assistant::{AssistantConfig, AssistantHost};
use crate::config::Config;
use crate::events::EventBus;
use crate::ffmpeg::{check_tools, path_arg, ToolStatus, Tools};
use crate::fsutil::now_ms;
use crate::render::{RenderConfig, RenderJob, RenderManager};
use crate::soniox::{FixtureSpeech, SonioxHttp, SpeechApi};
use crate::store::{ProjectStore, StoreError};
use crate::transcription::{TranscriptionManager, TranscriptionOptions, TranscriptionStore};
use cutline_core::analysis::{timeline_silences, SilenceCandidate, SilenceOptions};
use cutline_core::commands::Command;
use cutline_core::error::CommandError;
use cutline_core::history::Change;
use cutline_core::mapping::{timeline_transcript, TranscriptView};
use cutline_core::model::{AssetId, AssetKind, Project};
use cutline_core::render::{MediaSource, RenderEnv};
use cutline_core::transcript::Env;
use rust_embed::RustEmbed;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::Semaphore;

/// The web UI, compiled into the binary so a single executable serves everything.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web"]
pub struct WebAssets;

pub struct App {
    pub cfg: Config,
    pub tools: Tools,
    pub events: EventBus,
    pub assets: Arc<AssetStore>,
    pub projects: Arc<ProjectStore>,
    pub transcription: TranscriptionManager,
    pub renders: RenderManager,
    pub tool_status: RwLock<ToolStatus>,
    pub light_jobs: Semaphore,
    pub proxy_jobs: Semaphore,
    /// (regular, bold) font files used for text rendering in exports.
    pub fonts: (PathBuf, PathBuf),
    pub assistant: AssistantConfig,
}

fn extract_font(dir: &std::path::Path, name: &str) -> anyhow::Result<PathBuf> {
    let out = dir.join(name);
    let data = WebAssets::get(&format!("fonts/{name}"))
        .ok_or_else(|| anyhow::anyhow!("embedded font {name} is missing"))?;
    let up_to_date = std::fs::metadata(&out)
        .map(|m| m.len() == data.data.len() as u64)
        .unwrap_or(false);
    if !up_to_date {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&out, &data.data)?;
    }
    Ok(out)
}

impl App {
    pub async fn start(cfg: Config) -> anyhow::Result<Arc<App>> {
        let speech: Arc<dyn SpeechApi> = if cfg.fixture {
            Arc::new(FixtureSpeech::new(Duration::from_millis(
                cfg.fixture_step_ms,
            )))
        } else {
            Arc::new(SonioxHttp::new(
                cfg.soniox_api_key.clone(),
                cfg.soniox_base_url.clone(),
                cfg.soniox_model.clone(),
            ))
        };
        Self::start_with_speech(cfg, speech).await
    }

    /// Start with an explicit speech adapter (tests inject a deterministic one and
    /// inspect which remote objects are still alive).
    pub async fn start_with_speech(
        cfg: Config,
        speech: Arc<dyn SpeechApi>,
    ) -> anyhow::Result<Arc<App>> {
        std::fs::create_dir_all(&cfg.data_dir)?;
        let data_dir = std::fs::canonicalize(&cfg.data_dir)?;
        let tools = Tools {
            ffmpeg: cfg.ffmpeg.clone(),
            ffprobe: cfg.ffprobe.clone(),
        };
        let events = EventBus::new();
        let assets = AssetStore::open(data_dir.join("assets"), events.clone())?;
        let projects = Arc::new(ProjectStore::open(data_dir.join("projects"))?);
        let fonts_dir = data_dir.join("fonts");
        let fonts = (
            extract_font(&fonts_dir, "Inter-Regular.ttf")?,
            extract_font(&fonts_dir, "Inter-Bold.ttf")?,
        );

        let store: Arc<dyn TranscriptionStore> = assets.clone();
        let transcription = TranscriptionManager::new(
            speech,
            store,
            TranscriptionOptions {
                poll_interval: Duration::from_millis(if cfg.fixture {
                    cfg.fixture_step_ms.max(1)
                } else {
                    1500
                }),
                max_wait: Duration::from_secs(4 * 3600),
                max_attempts: 4,
                retry_backoff: Duration::from_millis(if cfg.fixture { 1 } else { 1500 }),
            },
        );

        let render_events = events.clone();
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let renders = RenderManager::new(
            RenderConfig {
                ffmpeg: cfg.ffmpeg.clone(),
                ffprobe: cfg.ffprobe.clone(),
                exports_dir: data_dir.join("exports"),
                env: RenderEnv {
                    font_regular: path_arg(&fonts.0),
                    font_bold: path_arg(&fonts.1),
                },
                max_parallel_chunks: (cores / 8).clamp(1, 4),
            },
            Arc::new(move |job: &RenderJob| render_events.emit("render", None, job)),
        );

        let tool_status = check_tools(&tools).await;
        if let Some(m) = &tool_status.message {
            tracing::warn!("{m}");
        }
        let assistant = AssistantConfig {
            fixture: cfg.fixture,
            node: cfg.node.clone(),
            sidecar_dir: cfg.sidecar_dir.clone(),
            provider: cfg.pi_provider.clone(),
            model: cfg.pi_model.clone(),
            max_tool_calls: 24,
            turn_timeout: Duration::from_secs(180),
        };
        let app = Arc::new(App {
            cfg,
            tools,
            events,
            assets,
            projects,
            transcription,
            renders,
            tool_status: RwLock::new(tool_status),
            light_jobs: Semaphore::new((cores / 4).clamp(1, 4)),
            proxy_jobs: Semaphore::new((cores / 8).clamp(1, 2)),
            fonts,
            assistant,
        });
        app.recover().await;

        // Undo histories are flushed shortly after edits (documents themselves are
        // saved synchronously with every change).
        let flusher = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                let a = flusher.clone();
                let _ = tokio::task::spawn_blocking(move || a.projects.flush_histories()).await;
            }
        });
        Ok(app)
    }

    /// Bring half-finished work back into a consistent state after a restart.
    async fn recover(self: &Arc<Self>) {
        for rec in self.assets.all() {
            let owners: Vec<String> = rec
                .projects
                .iter()
                .filter(|p| self.projects.exists(p))
                .cloned()
                .collect();
            if owners.is_empty() {
                // abandoned upload or last owner deleted while we were down
                self.transcription.purge(&rec.id).await;
                self.assets.remove(&rec.id);
                continue;
            }
            match rec.state {
                AssetState::Uploading => {
                    self.assets.update(&rec.id, |r| {
                        r.state = AssetState::Failed;
                        r.error = Some("The upload was interrupted by a server restart. Remove this item and import the file again.".into());
                    });
                }
                AssetState::Probing | AssetState::Processing => {
                    let app = self.clone();
                    let (pid, id) = (owners.first().cloned(), rec.id.clone());
                    tokio::spawn(async move { crate::import::process_asset(app, pid, id).await });
                }
                _ => {}
            }
        }
        // Resuming may retry remote clean-ups (slow when offline): never block startup on it.
        let mgr = self.transcription.clone();
        tokio::spawn(async move { mgr.resume_pending().await });
    }

    /// The read-only inputs commands may consult for this project.
    pub fn env_for(&self, project: &Project) -> Env {
        let mut env = Env::default();
        for (id, a) in &project.assets {
            if a.kind == AssetKind::Subtitle {
                if let Some(c) = self.assets.subtitle_cues(id) {
                    env.subtitles.insert(id.clone(), c);
                }
            } else if a.has_audio {
                if let Some(t) = self.assets.transcript(id) {
                    env.transcripts.insert(id.clone(), t);
                }
            }
        }
        env
    }

    /// Execute a command against a project, persist it and broadcast the change.
    /// `origin` identifies the browser tab that issued it (it ignores its own echo).
    pub fn execute(
        &self,
        project_id: &str,
        base_revision: Option<u64>,
        command: &Command,
        origin: Option<&str>,
    ) -> Result<Change, StoreError> {
        let needs_env = matches!(
            command,
            Command::GenerateCaptions { .. }
                | Command::CorrectWord { .. }
                | Command::AddAssetClips { .. }
                | Command::Batch { .. }
        );
        let env = if needs_env {
            self.projects
                .read(project_id, |s| self.env_for(&s.project))?
        } else {
            Env::default()
        };
        let change = self.projects.mutate(project_id, |s| {
            let rev = base_revision.unwrap_or(s.project.revision);
            s.execute(rev, command, &env, now_ms())
        })?;
        self.after_change(project_id, &change, origin);
        Ok(change)
    }

    pub fn undo_redo(
        &self,
        project_id: &str,
        base_revision: u64,
        undo: bool,
        origin: Option<&str>,
    ) -> Result<Change, StoreError> {
        let change = self.projects.mutate(project_id, |s| {
            if undo {
                s.undo(base_revision, now_ms())
            } else {
                s.redo(base_revision, now_ms())
            }
        })?;
        self.after_change(project_id, &change, origin);
        Ok(change)
    }

    fn after_change(&self, project_id: &str, change: &Change, origin: Option<&str>) {
        self.events.emit(
            "change",
            Some(project_id),
            &serde_json::json!({ "origin": origin, "change": change }),
        );
        self.ensure_transcriptions(project_id);
    }

    /// When transcript editing is enabled, make sure every audio-bearing asset of
    /// the project has a transcription job (idempotent).
    pub fn ensure_transcriptions(&self, project_id: &str) {
        let Ok((enabled, ids)) = self.projects.read(project_id, |s| {
            (
                s.project.transcript.enabled,
                s.project
                    .assets
                    .values()
                    .filter(|a| a.has_audio)
                    .map(|a| a.id.clone())
                    .collect::<Vec<_>>(),
            )
        }) else {
            return;
        };
        if !enabled {
            return;
        }
        for id in ids {
            let Some(rec) = self.assets.get(&id) else {
                continue;
            };
            // never started, and the speech audio is ready
            if rec.transcription.is_none() && rec.speech {
                if let Err(e) = self.transcription.start(&id, false) {
                    tracing::debug!("transcription of {id} not started: {}", e.message);
                }
            }
        }
    }

    pub fn transcript_view(&self, project_id: &str) -> Result<TranscriptView, StoreError> {
        self.projects.read(project_id, |s| {
            let env = self.env_for(&s.project);
            timeline_transcript(&s.project, &env.transcripts)
        })
    }

    pub fn silences(
        &self,
        project_id: &str,
        opts: SilenceOptions,
    ) -> Result<Vec<SilenceCandidate>, StoreError> {
        self.projects.read(project_id, |s| {
            let env = self.env_for(&s.project);
            let mut waveforms = BTreeMap::new();
            for (id, a) in &s.project.assets {
                if a.has_audio {
                    if let Some(w) = self.assets.waveform(id) {
                        waveforms.insert(id.clone(), w);
                    }
                }
            }
            timeline_silences(&s.project, &waveforms, &env.transcripts, opts)
        })
    }

    /// Original media files for rendering.
    pub fn media_sources(&self, project: &Project) -> BTreeMap<AssetId, MediaSource> {
        let mut out = BTreeMap::new();
        for (id, a) in &project.assets {
            let Some(rec) = self.assets.get(id) else {
                continue;
            };
            if a.kind == AssetKind::Subtitle {
                continue;
            }
            out.insert(
                id.clone(),
                MediaSource {
                    path: path_arg(&self.assets.source_path(&rec)),
                    kind: a.kind,
                    has_video: a.has_video,
                    has_audio: a.has_audio,
                    width: a.width,
                    height: a.height,
                    duration: a.duration,
                    fps: a.fps,
                    channels: a.channels,
                },
            );
        }
        out
    }

    /// Delete a project together with everything only it owns: exports, media
    /// files and any remote Soniox resources.
    pub async fn delete_project(&self, project_id: &str) -> Result<(), StoreError> {
        self.projects.delete(project_id)?;
        self.renders.delete_project(project_id).await;
        for rec in self.assets.owned_by(project_id) {
            let remaining: Vec<String> = rec
                .projects
                .iter()
                .filter(|p| p.as_str() != project_id && self.projects.exists(p))
                .cloned()
                .collect();
            if remaining.is_empty() {
                self.transcription.purge(&rec.id).await;
                self.assets.remove(&rec.id);
            } else {
                self.assets.update(&rec.id, |r| r.projects = remaining);
            }
        }
        self.events.emit(
            "project",
            None,
            &serde_json::json!({ "deleted": project_id }),
        );
        Ok(())
    }

    /// Duplicate a project; the copy shares (and co-owns) the media files.
    pub fn duplicate_project(
        &self,
        project_id: &str,
    ) -> Result<crate::store::ProjectMeta, StoreError> {
        let meta = self.projects.duplicate(project_id)?;
        for rec in self.assets.owned_by(project_id) {
            if meta.asset_ids.contains(&rec.id) {
                self.assets.update(&rec.id, |r| {
                    if !r.projects.contains(&meta.id) {
                        r.projects.push(meta.id.clone());
                    }
                });
            }
        }
        Ok(meta)
    }
}

impl AssistantHost for App {
    fn project(&self, project_id: &str) -> Result<Project, String> {
        self.projects
            .read(project_id, |s| s.project.clone())
            .map_err(|e| e.to_string())
    }

    fn transcript_view(&self, project_id: &str) -> Result<TranscriptView, String> {
        App::transcript_view(self, project_id).map_err(|e| e.to_string())
    }

    fn silences(
        &self,
        project_id: &str,
        opts: SilenceOptions,
    ) -> Result<Vec<SilenceCandidate>, String> {
        App::silences(self, project_id, opts).map_err(|e| e.to_string())
    }

    fn execute(&self, project_id: &str, command: Command) -> Result<Change, CommandError> {
        App::execute(self, project_id, None, &command, Some("assistant")).map_err(|e| match e {
            StoreError::Command(c) => c,
            other => CommandError::conflict(other.to_string()),
        })
    }
}
