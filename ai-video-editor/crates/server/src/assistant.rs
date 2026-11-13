//! The editing assistant.
//!
//! Two interchangeable drivers produce tool calls; both go through the same
//! [`execute_tool`] path, which validates arguments with `cutline_core::tools` and
//! applies edits as ordinary commands (revisioned, autosaved, undoable):
//!
//! * **Live mode** — the real Pi SDK. The server spawns `sidecar/pi-agent.mjs`
//!   (Node) and talks JSON Lines over stdio. The sidecar owns the model loop; every
//!   tool call comes back here to be validated and executed. Provider credentials
//!   are read by the sidecar from the server's environment and never reach the
//!   browser.
//! * **Fixture mode** — a deterministic rule-based planner (no AI model, no
//!   network), clearly labelled as such in every reply.

use cutline_core::analysis::{SilenceCandidate, SilenceOptions};
use cutline_core::commands::Command;
use cutline_core::error::{CommandError, ErrorCode};
use cutline_core::history::Change;
use cutline_core::mapping::TranscriptView;
use cutline_core::model::{ClipContent, Project, RemovalReason, TrackKind};
use cutline_core::tools::{self, ToolAction, ToolQuery};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_HISTORY_MESSAGES: usize = 24;
const FIXTURE_PREFIX: &str = "Fixture assistant (rule-based, not an AI model):";

// ---------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------

/// What the assistant needs from the application. Implemented by the server's `App`
/// (and by in-memory hosts in tests).
pub trait AssistantHost: Send + Sync + 'static {
    fn project(&self, project_id: &str) -> Result<Project, String>;
    fn transcript_view(&self, project_id: &str) -> Result<TranscriptView, String>;
    fn silences(
        &self,
        project_id: &str,
        opts: SilenceOptions,
    ) -> Result<Vec<SilenceCandidate>, String>;
    /// Execute against the *current* revision. The host takes care of revision
    /// checks, persistence and broadcasting the change to open editors.
    fn execute(&self, project_id: &str, command: Command) -> Result<Change, CommandError>;
}

#[derive(Clone, Debug)]
pub struct AssistantConfig {
    /// Use the rule-based fixture planner instead of the Pi SDK.
    pub fixture: bool,
    pub node: PathBuf,
    pub sidecar_dir: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub max_tool_calls: u32,
    pub turn_timeout: Duration,
}

/// Events of one assistant turn, streamed to the browser.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantEvent {
    Started {
        /// `"fixture"` or `"live"`.
        mode: String,
        provider: Option<String>,
        model: Option<String>,
        fixture: bool,
    },
    TextDelta {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        id: String,
        ok: bool,
        /// Short human sentence: what happened, or why it was rejected.
        summary: String,
        /// New project revision when the call changed the project.
        revision: Option<u64>,
    },
    Done {
        text: String,
        tool_calls: u32,
        /// Tool calls that changed the project (each one is an undo step).
        edits: u32,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TurnRequest {
    pub message: String,
    #[serde(default)]
    pub history: Vec<HistoryMessage>,
    /// Editor context (optional): lets "split here" / "speed up the selection" work.
    #[serde(default)]
    pub playhead_seconds: Option<f64>,
    #[serde(default)]
    pub selected_clip_ids: Vec<String>,
}

/// Result of one tool call.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub ok: bool,
    /// JSON text handed back to the model.
    pub content: String,
    /// Short human summary for the UI.
    pub summary: String,
    /// Set when the project changed.
    pub revision: Option<u64>,
}

/// Environment given to the sidecar process.
#[derive(Clone, Debug, Default)]
pub enum SidecarEnv {
    /// Inherit the server's environment (production: provider keys come from `.env`).
    #[default]
    Inherit,
    /// Start from an empty environment (plus `PATH`) and set only these variables.
    /// Used by tests so no real credentials can leak into a test run.
    Only(Vec<(String, String)>),
}

// ---------------------------------------------------------------------------------
// Shared tool execution
// ---------------------------------------------------------------------------------

fn error_content(code: &str, message: &str, field: Option<&str>) -> String {
    let mut e = json!({ "code": code, "message": message });
    if let Some(f) = field {
        e["field"] = json!(f);
    }
    json!({ "ok": false, "error": e }).to_string()
}

fn fail(code: &str, message: String, field: Option<&str>) -> ToolOutcome {
    ToolOutcome {
        ok: false,
        content: error_content(code, &message, field),
        summary: message,
        revision: None,
    }
}

fn noop(message: &str) -> ToolOutcome {
    ToolOutcome {
        ok: true,
        content: json!({ "ok": true, "changed": false, "result": message }).to_string(),
        summary: message.to_string(),
        revision: None,
    }
}

fn run_command(host: &dyn AssistantHost, project_id: &str, command: Command) -> ToolOutcome {
    match host.execute(project_id, command) {
        Ok(change) => {
            let mut summary = change.label.clone();
            if let Some(n) = change.notices.first() {
                summary = format!("{summary}. {n}");
            }
            let content = json!({
                "ok": true,
                "changed": true,
                "result": change.label,
                "revision": change.revision,
                "timeline_duration_seconds": tools::secs(change.duration),
                "created_clip_ids": change.created,
                "notices": change.notices,
            });
            ToolOutcome {
                ok: true,
                content: content.to_string(),
                summary,
                revision: Some(change.revision),
            }
        }
        Err(e) if e.code == ErrorCode::NothingToDo => {
            noop("Nothing changed: the timeline already looks like that.")
        }
        Err(e) => {
            let code = serde_json::to_value(e.code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "error".into());
            fail(&code, e.message.clone(), e.field.as_deref())
        }
    }
}

fn untranscribed_hint(view: &TranscriptView) -> String {
    if view.segments.is_empty() {
        " There is no transcribed speech on the timeline yet (enable transcript editing and wait for transcription to finish).".to_string()
    } else if !view.untranscribed_assets.is_empty() {
        format!(
            " {} media item(s) on the timeline have no transcript yet.",
            view.untranscribed_assets.len()
        )
    } else {
        String::new()
    }
}

/// Validate and run one tool call. Used by both the fixture planner and the live
/// model, so every assistant edit takes exactly the same path.
pub fn execute_tool(
    host: &dyn AssistantHost,
    project_id: &str,
    name: &str,
    arguments: &Value,
) -> ToolOutcome {
    let project = match host.project(project_id) {
        Ok(p) => p,
        Err(e) => {
            return fail(
                "not_found",
                format!("The project could not be read: {e}"),
                None,
            )
        }
    };
    let action = match tools::parse_tool_call(name, arguments, &project) {
        Ok(a) => a,
        Err(e) => {
            let code = serde_json::to_value(e.code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "invalid_arguments".into());
            return fail(&code, e.message.clone(), e.field.as_deref());
        }
    };
    match action {
        ToolAction::Command(command) => run_command(host, project_id, command),
        ToolAction::Query(ToolQuery::GetTimeline) => {
            let summary = format!(
                "Read the timeline ({} clips on {} tracks)",
                project.clips.len(),
                project.tracks.len()
            );
            ToolOutcome {
                ok: true,
                content: tools::describe_timeline(&project).to_string(),
                summary,
                revision: None,
            }
        }
        ToolAction::Query(ToolQuery::GetProjectInfo) => ToolOutcome {
            ok: true,
            content: tools::describe_project(&project).to_string(),
            summary: "Read the project info".into(),
            revision: None,
        },
        ToolAction::Query(ToolQuery::GetTranscript { start, end }) => {
            match host.transcript_view(project_id) {
                Ok(view) => {
                    let range = match (start, end) {
                        (None, None) => None,
                        (s, e) => Some((
                            s.unwrap_or(cutline_core::TimelineTime(0)),
                            e.unwrap_or(cutline_core::TimelineTime(i64::MAX)),
                        )),
                    };
                    let d = tools::describe_transcript(&view, &project, range);
                    let summary = format!(
                        "Read the transcript ({} words)",
                        d["word_count"].as_u64().unwrap_or(0)
                    );
                    ToolOutcome {
                        ok: true,
                        content: d.to_string(),
                        summary,
                        revision: None,
                    }
                }
                Err(e) => fail(
                    "conflict",
                    format!("The transcript could not be read: {e}"),
                    None,
                ),
            }
        }
        ToolAction::RemoveFillers => match host.transcript_view(project_id) {
            Ok(view) => {
                let cuts = tools::filler_cuts(&view);
                if cuts.is_empty() {
                    return noop(&format!(
                        "No filler words found on the timeline.{}",
                        untranscribed_hint(&view)
                    ));
                }
                run_command(
                    host,
                    project_id,
                    Command::RippleDeleteSource {
                        cuts,
                        reason: RemovalReason::Filler,
                    },
                )
            }
            Err(e) => fail(
                "conflict",
                format!("The transcript could not be read: {e}"),
                None,
            ),
        },
        ToolAction::RemoveSilences(opts) => match host.silences(project_id, opts) {
            Ok(candidates) => {
                let cuts = tools::silence_cuts(&candidates);
                if cuts.is_empty() {
                    return noop(
                        "No pauses matching those settings were found in the audible audio.",
                    );
                }
                run_command(
                    host,
                    project_id,
                    Command::RippleDeleteSource {
                        cuts,
                        reason: RemovalReason::Silence,
                    },
                )
            }
            Err(e) => fail(
                "conflict",
                format!("Silences could not be analysed: {e}"),
                None,
            ),
        },
        ToolAction::RemoveSpokenRange { start, end } => match host.transcript_view(project_id) {
            Ok(view) => {
                let cuts = tools::spoken_range_cuts(&view, start, end);
                if cuts.is_empty() {
                    return noop(&format!(
                        "No spoken words lie in that time range.{}",
                        untranscribed_hint(&view)
                    ));
                }
                run_command(
                    host,
                    project_id,
                    Command::RippleDeleteSource {
                        cuts,
                        reason: RemovalReason::Assistant,
                    },
                )
            }
            Err(e) => fail(
                "conflict",
                format!("The transcript could not be read: {e}"),
                None,
            ),
        },
    }
}

// ---------------------------------------------------------------------------------
// Status (for /api/health)
// ---------------------------------------------------------------------------------

fn node_available(node: &std::path::Path) -> bool {
    if node.components().count() > 1 {
        return node.exists();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(node);
        candidate.is_file() || candidate.with_extension("exe").is_file()
    })
}

/// Describe which assistant is active and whether live mode can run.
pub fn assistant_status(cfg: &AssistantConfig) -> Value {
    let node = node_available(&cfg.node);
    let script = cfg.sidecar_dir.join("pi-agent.mjs").exists();
    let installed = cfg.sidecar_dir.join("node_modules").exists();
    let live_ready = node && script && installed;
    let hint = if cfg.fixture {
        Some("Fixture mode: the assistant is a rule-based planner, not an AI model. Start the server without --fixture to use the Pi SDK.".to_string())
    } else if !node {
        Some("The live assistant needs Node.js 20+. Install it (or set NODE_PATH_BIN to the node binary) and restart the server.".to_string())
    } else if !script || !installed {
        Some(format!("The live assistant's Pi SDK sidecar is not installed. Run `npm ci` in `{}` and try again.", cfg.sidecar_dir.display()))
    } else {
        None
    };
    json!({
        "mode": if cfg.fixture { "fixture" } else { "live" },
        "fixture": cfg.fixture,
        "available": cfg.fixture || live_ready,
        "sdk": "pi (@mariozechner/pi-agent-core)",
        "node_found": node,
        "sidecar_installed": script && installed,
        "provider": cfg.provider,
        "model": cfg.model,
        "hint": hint,
        "examples": FIXTURE_EXAMPLES,
    })
}

/// Requests the fixture planner understands (also good prompts for the live model).
pub const FIXTURE_EXAMPLES: &[&str] = &[
    "Remove filler words",
    "Remove silences longer than 1s",
    "Generate captions",
    "Split at 5s",
    "Cut from 0:10 to 0:15",
    "Add title \"Hello world\" at 2s for 4 seconds",
    "Speed up 2x",
    "Mute A2",
];

// ---------------------------------------------------------------------------------
// Turn entry point
// ---------------------------------------------------------------------------------

/// Run one assistant turn, streaming [`AssistantEvent`]s. Always ends with exactly
/// one `Done` or `Error` event (unless the receiver went away).
pub async fn run_turn(
    host: Arc<dyn AssistantHost>,
    cfg: &AssistantConfig,
    project_id: &str,
    req: TurnRequest,
    events: Sender<AssistantEvent>,
    cancel: CancellationToken,
) {
    run_turn_with_env(
        host,
        cfg,
        project_id,
        req,
        events,
        cancel,
        SidecarEnv::Inherit,
    )
    .await
}

/// [`run_turn`] with explicit control over the sidecar's environment.
pub async fn run_turn_with_env(
    host: Arc<dyn AssistantHost>,
    cfg: &AssistantConfig,
    project_id: &str,
    req: TurnRequest,
    events: Sender<AssistantEvent>,
    cancel: CancellationToken,
    env: SidecarEnv,
) {
    let message = req.message.trim().to_string();
    if message.is_empty() {
        let _ = events
            .send(AssistantEvent::Error {
                code: "invalid_request".into(),
                message: "Type what you would like the assistant to do.".into(),
            })
            .await;
        return;
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        let _ = events
            .send(AssistantEvent::Error { code: "invalid_request".into(), message: format!("That message is too long (max {MAX_MESSAGE_CHARS} characters). Please shorten it.") })
            .await;
        return;
    }
    if let Some(p) = req.playhead_seconds {
        if !p.is_finite() || p < 0.0 {
            let _ = events
                .send(AssistantEvent::Error {
                    code: "invalid_request".into(),
                    message: "playhead_seconds must be a non-negative number.".into(),
                })
                .await;
            return;
        }
    }
    let req = TurnRequest { message, ..req };
    if cfg.fixture {
        run_fixture(host, project_id, req, events, cancel).await;
    } else {
        run_live(host, cfg, project_id, req, events, cancel, env).await;
    }
}

// ---------------------------------------------------------------------------------
// Live mode: Pi SDK sidecar bridge
// ---------------------------------------------------------------------------------

const SYSTEM_PROMPT: &str = "You are the editing assistant inside Cutline, a multitrack video editor. You edit the user's timeline only by calling the provided tools; every successful edit is saved immediately and is a normal undo step.

Rules:
- Before the first edit of a turn, call get_timeline (and get_transcript when the request is about spoken words) so you work with real clip ids, track ids and times. Never invent ids.
- All times are timeline seconds. Clips linked as video+audio pairs are edited together unless include_linked is false.
- Prefer the transcript tools (remove_filler_words, remove_silences, remove_spoken_range) for speech edits; they ripple-delete precisely and keep audio and picture in sync.
- If a tool returns an error, read the message, fix the arguments and try again; do not repeat the same failing call.
- Do only what was asked. When the request is ambiguous or destructive beyond what was asked, ask a short question instead of guessing.
- Be brief: after editing, reply with one or two sentences describing what changed. Mention that the user can undo.";

fn redact(text: &str, env: &SidecarEnv) -> String {
    let mut secrets: Vec<String> = Vec::new();
    let sensitive = |k: &str| {
        let k = k.to_ascii_uppercase();
        k.ends_with("_KEY")
            || k.ends_with("_TOKEN")
            || k.ends_with("_SECRET")
            || k.contains("API_KEY")
    };
    for (k, v) in std::env::vars() {
        if sensitive(&k) && v.len() >= 8 {
            secrets.push(v);
        }
    }
    if let SidecarEnv::Only(vars) = env {
        for (k, v) in vars {
            if sensitive(k) && v.len() >= 8 {
                secrets.push(v.clone());
            }
        }
    }
    let mut out = text.to_string();
    for s in secrets {
        out = out.replace(&s, "[redacted]");
    }
    // anything that still looks like a provider key
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(pos) = rest.find("sk-") {
        let (before, after) = rest.split_at(pos);
        cleaned.push_str(before);
        let key_len = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .count();
        if key_len >= 12 {
            cleaned.push_str("[redacted]");
        } else {
            cleaned.push_str(&after[..key_len]);
        }
        rest = &after[key_len..];
    }
    cleaned.push_str(rest);
    cleaned
}

fn tail(text: &str, max_chars: usize) -> String {
    let t = text.trim();
    let n = t.chars().count();
    if n <= max_chars {
        t.to_string()
    } else {
        format!("…{}", t.chars().skip(n - max_chars).collect::<String>())
    }
}

fn live_error_message(code: &str, message: &str) -> String {
    match code {
        "not_configured" => format!("{message} Add it to `.env` on the server (it is never sent to the browser) and restart, or start the server with --fixture to use the rule-based fixture assistant."),
        "model_not_found" => format!("{message} Check PI_PROVIDER and PI_MODEL in `.env`."),
        "aborted" => "The assistant turn was cancelled.".to_string(),
        _ => format!("The AI provider could not complete the request: {message}"),
    }
}

fn context_note(req: &TurnRequest) -> String {
    let mut parts = Vec::new();
    if let Some(p) = req.playhead_seconds {
        parts.push(format!("playhead at {:.3} s", p));
    }
    if !req.selected_clip_ids.is_empty() {
        let ids: Vec<&str> = req
            .selected_clip_ids
            .iter()
            .take(50)
            .map(|s| s.as_str())
            .collect();
        parts.push(format!("selected clips: {}", ids.join(", ")));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("\n\n[Editor context: {}]", parts.join("; "))
    }
}

async fn stop_child(
    child: &mut tokio::process::Child,
    stdin: &mut Option<tokio::process::ChildStdin>,
) {
    if let Some(mut s) = stdin.take() {
        let _ = s.write_all(b"{\"type\":\"abort\"}\n").await;
        let _ = s.flush().await;
        // keep stdin open briefly so the sidecar can abort the model request cleanly
        if tokio::time::timeout(Duration::from_millis(1500), child.wait())
            .await
            .is_ok()
        {
            return;
        }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

async fn run_live(
    host: Arc<dyn AssistantHost>,
    cfg: &AssistantConfig,
    project_id: &str,
    req: TurnRequest,
    events: Sender<AssistantEvent>,
    cancel: CancellationToken,
    env: SidecarEnv,
) {
    let script = cfg.sidecar_dir.join("pi-agent.mjs");
    if !script.exists() || !cfg.sidecar_dir.join("node_modules").exists() {
        let _ = events
            .send(AssistantEvent::Error {
                code: "sidecar_missing".into(),
                message: format!(
                    "The live assistant's Pi SDK sidecar is not installed. Run `npm ci` in `{}` and try again (or start the server with --fixture).",
                    cfg.sidecar_dir.display()
                ),
            })
            .await;
        return;
    }
    let mut cmd = tokio::process::Command::new(&cfg.node);
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let SidecarEnv::Only(vars) = &env {
        cmd.env_clear();
        if let Some(path) = std::env::var_os("PATH") {
            cmd.env("PATH", path);
        }
        cmd.envs(vars.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let (code, message) = if e.kind() == std::io::ErrorKind::NotFound {
                ("node_missing", format!("Node.js was not found (looked for `{}`). The live assistant needs Node.js 20+; install it or set NODE_PATH_BIN to the node binary, then restart the server.", cfg.node.display()))
            } else {
                (
                    "sidecar_failed",
                    format!("The assistant process could not be started: {e}"),
                )
            };
            let _ = events
                .send(AssistantEvent::Error {
                    code: code.into(),
                    message,
                })
                .await;
            return;
        }
    };
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Drain stderr continuously (so the child can never block on it) but keep only
    // the tail for diagnostics.
    let stderr_task = tokio::spawn(async move {
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            kept.extend_from_slice(&chunk[..n]);
            if kept.len() > 64 * 1024 {
                let cut = kept.len() - 32 * 1024;
                kept.drain(..cut);
            }
        }
        String::from_utf8_lossy(&kept).to_string()
    });

    let history: Vec<Value> = req
        .history
        .iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.text.trim().is_empty())
        .rev()
        .take(MAX_HISTORY_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|m| json!({ "role": m.role, "text": m.text.chars().take(MAX_MESSAGE_CHARS).collect::<String>() }))
        .collect();
    let tool_defs: Vec<Value> = tools::tool_specs()
        .into_iter()
        .map(
            |t| json!({ "name": t.name, "description": t.description, "parameters": t.parameters }),
        )
        .collect();
    let start = json!({
        "type": "start",
        "system_prompt": SYSTEM_PROMPT,
        "tools": tool_defs,
        "history": history,
        "prompt": format!("{}{}", req.message, context_note(&req)),
        "provider": cfg.provider,
        "model": cfg.model,
        "max_tool_calls": cfg.max_tool_calls.max(1),
    });
    let write_line = |stdin: &mut Option<tokio::process::ChildStdin>, v: Value| {
        let line = format!("{v}\n");
        let mut taken = stdin.take();
        async move {
            let ok = match taken.as_mut() {
                Some(s) => s.write_all(line.as_bytes()).await.is_ok() && s.flush().await.is_ok(),
                None => false,
            };
            (taken, ok)
        }
    };
    let (s, ok) = write_line(&mut stdin, start).await;
    stdin = s;
    // a failed write means the process died immediately; the read loop reports why
    let _ = ok;

    let deadline = tokio::time::Instant::now() + cfg.turn_timeout;
    let mut lines = BufReader::new(stdout).lines();
    let (mut tool_calls, mut edits) = (0u32, 0u32);
    let mut streamed = String::new();

    loop {
        let line = tokio::select! {
            _ = cancel.cancelled() => {
                stop_child(&mut child, &mut stdin).await;
                let _ = events.send(AssistantEvent::Error { code: "aborted".into(), message: live_error_message("aborted", "") }).await;
                return;
            }
            _ = tokio::time::sleep_until(deadline) => {
                stop_child(&mut child, &mut stdin).await;
                let _ = events.send(AssistantEvent::Error {
                    code: "timeout".into(),
                    message: format!("The assistant did not finish within {} seconds and was stopped. Edits it already made are kept (use Undo to revert them).", cfg.turn_timeout.as_secs()),
                }).await;
                return;
            }
            line = lines.next_line() => line,
        };
        let line = match line {
            Ok(Some(l)) => l,
            _ => {
                // stdout closed without done/error: the process crashed
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                let _ = child.start_kill();
                let err = tokio::time::timeout(Duration::from_secs(2), stderr_task)
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                    .unwrap_or_default();
                let detail = tail(&redact(&err, &env), 400);
                let message = if detail.is_empty() {
                    "The assistant process stopped unexpectedly. Check that the sidecar is installed (`npm ci` in `sidecar/`) and try again.".to_string()
                } else {
                    format!("The assistant process stopped unexpectedly: {detail}")
                };
                let _ = events
                    .send(AssistantEvent::Error {
                        code: "sidecar_failed".into(),
                        message,
                    })
                    .await;
                return;
            }
        };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            tracing::debug!("assistant sidecar wrote a non-JSON line; ignored");
            continue;
        };
        let event = match msg["type"].as_str().unwrap_or("") {
            "ready" => Some(AssistantEvent::Started {
                mode: "live".into(),
                provider: msg["provider"].as_str().map(str::to_string),
                model: msg["model"].as_str().map(str::to_string),
                fixture: false,
            }),
            "text_delta" => {
                let text = msg["text"].as_str().unwrap_or("").to_string();
                streamed.push_str(&text);
                Some(AssistantEvent::TextDelta { text })
            }
            "tool_call" => {
                let id = msg["id"].as_str().unwrap_or("").to_string();
                let name = msg["name"].as_str().unwrap_or("").to_string();
                let arguments = msg.get("arguments").cloned().unwrap_or(Value::Null);
                if events
                    .send(AssistantEvent::ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    })
                    .await
                    .is_err()
                {
                    stop_child(&mut child, &mut stdin).await;
                    return;
                }
                let (h, pid) = (host.clone(), project_id.to_string());
                let outcome = tokio::task::spawn_blocking(move || {
                    execute_tool(h.as_ref(), &pid, &name, &arguments)
                })
                .await
                .unwrap_or_else(|_| {
                    fail("internal", "The tool crashed while running.".into(), None)
                });
                tool_calls += 1;
                if outcome.revision.is_some() {
                    edits += 1;
                }
                let (s, ok) = write_line(&mut stdin, json!({ "type": "tool_result", "id": id, "ok": outcome.ok, "content": outcome.content })).await;
                stdin = s;
                let _ = ok;
                Some(AssistantEvent::ToolResult {
                    id,
                    ok: outcome.ok,
                    summary: outcome.summary,
                    revision: outcome.revision,
                })
            }
            "done" => {
                let text = msg["text"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or(streamed.clone());
                let _ = events
                    .send(AssistantEvent::Done {
                        text,
                        tool_calls,
                        edits,
                    })
                    .await;
                drop(stdin.take());
                let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                return;
            }
            "error" => {
                let code = msg["code"].as_str().unwrap_or("provider_error").to_string();
                let message = redact(
                    &live_error_message(&code, msg["message"].as_str().unwrap_or("unknown error")),
                    &env,
                );
                let _ = events.send(AssistantEvent::Error { code, message }).await;
                drop(stdin.take());
                let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                return;
            }
            _ => None,
        };
        if let Some(ev) = event {
            if events.send(ev).await.is_err() {
                // the browser went away: stop spending tokens
                stop_child(&mut child, &mut stdin).await;
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------------
// Fixture mode: deterministic rule-based planner
// ---------------------------------------------------------------------------------

/// One step of a fixture plan.
#[derive(Clone, Debug, PartialEq)]
pub enum FixtureStep {
    Tool {
        name: &'static str,
        arguments: Value,
    },
    Say(String),
}

fn tokenize(message: &str) -> Vec<String> {
    message
        .to_lowercase()
        .split_whitespace()
        .map(|t| {
            t.trim_matches(|c: char| {
                matches!(
                    c,
                    ',' | ';' | '!' | '?' | '(' | ')' | '"' | '\'' | '“' | '”'
                )
            })
            .trim_end_matches('.')
            .to_string()
        })
        .filter(|t| !t.is_empty())
        .collect()
}

fn unit_seconds(unit: &str) -> Option<f64> {
    match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => Some(1.0),
        "ms" | "millisecond" | "milliseconds" => Some(0.001),
        "m" | "min" | "mins" | "minute" | "minutes" => Some(60.0),
        "h" | "hr" | "hrs" | "hour" | "hours" => Some(3600.0),
        _ => None,
    }
}

/// Parse a self-contained time expression: `5s`, `5.5sec`, `90ms`, `1m30s`, `1:23`,
/// `00:01:23.5`. Bare numbers are *not* accepted here (see [`time_at`]).
pub fn parse_time_expr(token: &str) -> Option<f64> {
    let t = token.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains(':') {
        let parts: Vec<&str> = t.split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let mut total = 0.0;
        for (i, p) in parts.iter().enumerate() {
            let last = i == parts.len() - 1;
            if p.is_empty() || (!last && !p.chars().all(|c| c.is_ascii_digit())) {
                return None;
            }
            let v: f64 = p.parse().ok()?;
            if !v.is_finite() || v < 0.0 || (i > 0 && v >= 60.0) {
                return None;
            }
            total = total * 60.0 + v;
        }
        return Some(total);
    }
    // sequences of <number><unit>
    let mut total = 0.0;
    let mut rest = t;
    let mut any = false;
    while !rest.is_empty() {
        let num_len = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .count();
        if num_len == 0 {
            return None;
        }
        let value: f64 = rest[..num_len].parse().ok()?;
        rest = &rest[num_len..];
        let unit_len = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
        if unit_len == 0 {
            return None;
        }
        total += value * unit_seconds(&rest[..unit_len])?;
        rest = &rest[unit_len..];
        any = true;
    }
    (any && total.is_finite()).then_some(total)
}

fn bare_number(token: &str) -> Option<f64> {
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    token.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// A time starting at token `i`: a time expression, or a number followed by a unit
/// word, or (when `allow_bare`) a plain number of seconds. Returns (seconds, tokens used).
fn time_at(tokens: &[String], i: usize, allow_bare: bool) -> Option<(f64, usize)> {
    let tok = tokens.get(i)?;
    if let Some(v) = parse_time_expr(tok) {
        return Some((v, 1));
    }
    let n = bare_number(tok)?;
    if let Some(mult) = tokens.get(i + 1).and_then(|u| unit_seconds(u)) {
        return Some((n * mult, 2));
    }
    allow_bare.then_some((n, 1))
}

/// Every time mentioned in the message, with the index of its first token. Bare
/// numbers only count directly after a preposition such as "at" or "from".
fn all_times(tokens: &[String]) -> Vec<(usize, f64)> {
    const PREPOSITIONS: &[&str] = &[
        "at", "from", "to", "between", "and", "until", "till", "for", "than", "-", "–", "after",
        "before",
    ];
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let after_prep = i > 0 && PREPOSITIONS.contains(&tokens[i - 1].as_str());
        // "3-5s" / "10s-15s" style ranges
        if let Some((a, b)) = tokens[i].split_once(['-', '–']) {
            let right = parse_time_expr(b);
            let left = parse_time_expr(a).or_else(|| right.and(bare_number(a)));
            if let (Some(l), Some(r)) = (left, right) {
                out.push((i, l));
                out.push((i, r));
                i += 1;
                continue;
            }
        }
        match time_at(tokens, i, after_prep) {
            Some((v, used)) => {
                out.push((i, v));
                i += used;
            }
            None => i += 1,
        }
    }
    out
}

fn has(tokens: &[String], stems: &[&str]) -> bool {
    tokens
        .iter()
        .any(|t| stems.iter().any(|s| t.starts_with(s)))
}

fn has_exact(tokens: &[String], words: &[&str]) -> bool {
    tokens.iter().any(|t| words.contains(&t.as_str()))
}

/// First quoted string of the original message (straight or curly double quotes,
/// or single quotes that are not apostrophes).
fn quoted(message: &str) -> Option<String> {
    for (open, close) in [('"', '"'), ('“', '”'), ('«', '»')] {
        if let Some(start) = message.find(open) {
            let after = &message[start + open.len_utf8()..];
            if let Some(end) = after.find(close) {
                let inner = after[..end].trim();
                if !inner.is_empty() {
                    return Some(inner.to_string());
                }
            }
        }
    }
    // 'single quotes' at word boundaries
    let chars: Vec<(usize, char)> = message.char_indices().collect();
    for (n, &(i, c)) in chars.iter().enumerate() {
        if c == '\'' && (n == 0 || chars[n - 1].1.is_whitespace()) {
            let after = &message[i + 1..];
            let mut search = 0;
            while let Some(rel) = after[search..].find('\'') {
                let end = search + rel;
                let next = after[end + 1..].chars().next();
                if next.is_none_or(|ch| !ch.is_alphanumeric()) {
                    let inner = after[..end].trim();
                    if !inner.is_empty() {
                        return Some(inner.to_string());
                    }
                    break;
                }
                search = end + 1;
            }
        }
    }
    None
}

fn fmt_secs(s: f64) -> String {
    let total_ms = (s * 1000.0).round() as i64;
    let (m, sec, ms) = (total_ms / 60_000, (total_ms / 1000) % 60, total_ms % 1000);
    format!("{m}:{sec:02}.{:02}", ms / 10)
}

const HELP: &str = "I understand a small set of requests: \"remove filler words\", \"remove silences longer than 1s\", \"generate captions\", \"split at 5s\", \"cut from 0:10 to 0:15\", \"add title \\\"Hello\\\" at 2s\", \"speed up 2x\" / \"slow motion\", and \"mute A2\". Start the server without --fixture to use the real AI assistant (Pi SDK).";

/// Turn a request into tool calls with simple, deterministic pattern rules.
pub fn fixture_plan(req: &TurnRequest, project: &Project) -> Vec<FixtureStep> {
    let tokens = tokenize(&req.message);
    let times = all_times(&tokens);
    let mut steps: Vec<FixtureStep> = Vec::new();
    let removal = has(
        &tokens,
        &[
            "remov", "delet", "cut", "strip", "drop", "trim", "clean", "rid", "tighten",
        ],
    );
    let wants_fillers = has(&tokens, &["filler"])
        || (removal && has_exact(&tokens, &["um", "ums", "uh", "uhs", "umm", "uhm"]));
    let wants_silences = has(&tokens, &["silenc", "pause", "gap"])
        || tokens.windows(2).any(|w| w[0] == "dead" && w[1] == "air");
    let wants_text = has_exact(
        &tokens,
        &[
            "text",
            "title",
            "titles",
            "heading",
            "headline",
            "lower-third",
        ],
    ) && has(
        &tokens,
        &["add", "insert", "put", "creat", "make", "show", "overlay"],
    );
    let wants_captions = has(&tokens, &["caption", "subtitle"]) && !wants_text;

    if has_exact(&tokens, &["undo", "redo", "revert"]) {
        steps.push(FixtureStep::Say("I can't undo for you. Use Undo (Ctrl+Z) in the toolbar: every assistant edit is a normal undo step.".into()));
        return steps;
    }

    // ---- split ---------------------------------------------------------------
    let wants_split = has(&tokens, &["split", "razor", "slice"])
        || (has_exact(&tokens, &["cut"])
            && has_exact(&tokens, &["at"])
            && times.len() == 1
            && !has_exact(&tokens, &["from", "between"]));
    if wants_split {
        let at = times.first().map(|t| t.1).or_else(|| {
            if has(&tokens, &["playhead", "here", "current", "cursor"]) || times.is_empty() {
                req.playhead_seconds
            } else {
                None
            }
        });
        match at {
            Some(t) => steps.push(FixtureStep::Tool {
                name: "split_clips",
                arguments: json!({ "time_seconds": t }),
            }),
            None => steps.push(FixtureStep::Say(
                "Tell me where to split, for example \"split at 5s\" or \"split at 1:23\".".into(),
            )),
        }
    }

    // ---- delete a time range ---------------------------------------------------
    let wants_range = removal
        && !wants_split
        && !wants_fillers
        && !wants_silences
        && times.len() >= 2
        && !wants_text;
    if wants_range {
        let (a, b) = (times[0].1, times[1].1);
        let (start, end) = if a <= b { (a, b) } else { (b, a) };
        if has(
            &tokens,
            &[
                "word",
                "spoken",
                "speech",
                "sentence",
                "said",
                "say",
                "transcript",
            ],
        ) {
            steps.push(FixtureStep::Tool {
                name: "remove_spoken_range",
                arguments: json!({ "start_seconds": start, "end_seconds": end }),
            });
        } else {
            steps.push(FixtureStep::Tool {
                name: "delete_time_range",
                arguments: json!({ "start_seconds": start, "end_seconds": end }),
            });
        }
    }

    // ---- transcript clean-up ---------------------------------------------------
    if wants_fillers {
        steps.push(FixtureStep::Tool {
            name: "remove_filler_words",
            arguments: json!({}),
        });
    }
    if wants_silences && (removal || has(&tokens, &["shorten", "close"])) {
        let mut args = serde_json::Map::new();
        if let Some(pos) = tokens
            .iter()
            .position(|t| t == "than" || t == "over" || t == "above" || t == "least")
        {
            if let Some((_, secs)) = times.iter().find(|(i, _)| *i > pos) {
                args.insert(
                    "min_duration_ms".into(),
                    json!((secs * 1000.0).round() as i64),
                );
            }
        }
        steps.push(FixtureStep::Tool {
            name: "remove_silences",
            arguments: Value::Object(args),
        });
    } else if wants_silences {
        steps.push(FixtureStep::Say(
            "To cut pauses, say \"remove silences\" (optionally \"longer than 1s\").".into(),
        ));
    }

    // ---- speed -----------------------------------------------------------------
    let mut speed: Option<f64> = None;
    for t in &tokens {
        let factor = t
            .strip_suffix('x')
            .or_else(|| t.strip_suffix('×'))
            .or_else(|| t.strip_prefix('x'))
            .and_then(bare_number);
        let percent = t.strip_suffix('%').and_then(bare_number).map(|p| p / 100.0);
        if let Some(v) = factor.or(percent) {
            speed = Some(v);
        }
    }
    let speed_words = has(
        &tokens,
        &["speed", "faster", "slower", "slow", "fast", "playback"],
    );
    if speed.is_none() {
        if tokens
            .windows(2)
            .any(|w| w[0] == "slow" && w[1].starts_with("mo"))
            || has(&tokens, &["slow-mo", "slowmo", "half-speed"])
            || (has_exact(&tokens, &["half"]) && speed_words)
        {
            speed = Some(0.5);
        } else if has_exact(&tokens, &["double", "twice"]) && speed_words {
            speed = Some(2.0);
        } else if has_exact(&tokens, &["normal", "original", "regular"]) && speed_words {
            speed = Some(1.0);
        }
    }
    if let Some(v) = speed.filter(|_| {
        speed_words
            || tokens
                .iter()
                .any(|t| t.ends_with('x') || t.ends_with('×') || t.ends_with('%'))
    }) {
        let mentioned: Vec<String> = tokens
            .iter()
            .filter(|t| project.clips.contains_key(t.as_str()))
            .cloned()
            .collect();
        let targets: Vec<String> = if !req.selected_clip_ids.is_empty() {
            req.selected_clip_ids.clone()
        } else if !mentioned.is_empty() {
            mentioned
        } else {
            project
                .clips
                .values()
                .filter(|c| {
                    c.content.is_timed_media()
                        && project.track(&c.track_id).is_some_and(|t| !t.locked)
                })
                .map(|c| c.id.clone())
                .collect()
        };
        if targets.is_empty() {
            steps.push(FixtureStep::Say(
                "There are no video or audio clips on the timeline to change the speed of.".into(),
            ));
        } else {
            steps.push(FixtureStep::Tool {
                name: "set_clip_speed",
                arguments: json!({ "clip_ids": targets, "speed": v }),
            });
        }
    } else if speed_words && !wants_split && !wants_range {
        steps.push(FixtureStep::Say(
            "Tell me the speed, for example \"speed up 2x\", \"50% speed\" or \"slow motion\"."
                .into(),
        ));
    }

    // ---- text overlay ----------------------------------------------------------
    if wants_text {
        match quoted(&req.message) {
            Some(text) => {
                let at_pos = tokens.iter().position(|t| t == "at" || t == "from");
                let for_pos = tokens.iter().position(|t| t == "for");
                let start = at_pos
                    .and_then(|p| times.iter().find(|(i, _)| *i == p + 1))
                    .map(|t| t.1)
                    .or(req.playhead_seconds)
                    .unwrap_or(0.0);
                let duration = for_pos
                    .and_then(|p| times.iter().find(|(i, _)| *i == p + 1))
                    .map(|t| t.1);
                let mut args = json!({ "text": text, "start_seconds": start });
                if let Some(d) = duration {
                    args["duration_seconds"] = json!(d);
                }
                steps.push(FixtureStep::Tool {
                    name: "add_text",
                    arguments: args,
                });
            }
            None => steps.push(FixtureStep::Say(
                "Put the text in quotes, for example: add title \"Hello world\" at 2s.".into(),
            )),
        }
    }

    // ---- track switches --------------------------------------------------------
    let switch: Option<(&str, bool)> = [
        ("unmute", "muted", false),
        ("mute", "muted", true),
        ("unsolo", "solo", false),
        ("solo", "solo", true),
        ("unlock", "locked", false),
        ("lock", "locked", true),
        ("unhide", "hidden", false),
        ("hide", "hidden", true),
    ]
    .iter()
    .find(|(word, _, _)| {
        tokens.iter().any(|t| {
            t == word || t.strip_suffix('s') == Some(word) || t.strip_suffix('d') == Some(word)
        })
    })
    .map(|(_, field, value)| (*field, *value));
    if let Some((field, value)) = switch {
        let mut targets: Vec<&cutline_core::model::Track> = project
            .tracks
            .iter()
            .filter(|t| {
                tokens
                    .iter()
                    .any(|tok| tok.eq_ignore_ascii_case(&t.name) || tok == &t.id)
            })
            .collect();
        if targets.is_empty() && has_exact(&tokens, &["all", "everything", "every"]) {
            let audio_switch = field == "muted" || field == "solo";
            targets = project
                .tracks
                .iter()
                .filter(|t| !audio_switch || t.kind == TrackKind::Audio)
                .collect();
        }
        if targets.is_empty() {
            let names: Vec<&str> = project.tracks.iter().map(|t| t.name.as_str()).collect();
            steps.push(FixtureStep::Say(format!(
                "Which track? Name one of: {}. For example \"mute {}\".",
                names.join(", "),
                names.last().copied().unwrap_or("A1")
            )));
        }
        for t in targets {
            steps.push(FixtureStep::Tool {
                name: "set_track",
                arguments: json!({ "track_id": t.id, field: value }),
            });
        }
    }

    // ---- captions (last, so they reflect the cuts above) -------------------------
    if wants_captions {
        if removal && !has(&tokens, &["add", "generat", "creat", "make", "burn"]) {
            steps.push(FixtureStep::Say("I can generate captions but not delete them. Select the caption clips on the timeline and press Delete.".into()));
        } else {
            let mut args = serde_json::Map::new();
            if has(&tokens, &["speaker", "name"]) {
                args.insert("speaker_labels".into(), json!(true));
            }
            steps.push(FixtureStep::Tool {
                name: "generate_captions",
                arguments: Value::Object(args),
            });
        }
    }

    // ---- describe --------------------------------------------------------------
    if steps.is_empty()
        && (has(&tokens, &["describ", "summar", "overview"])
            || (has_exact(&tokens, &["what", "what's", "whats", "show", "list"])
                && has(&tokens, &["timeline", "clip", "track", "project"])))
    {
        steps.push(FixtureStep::Tool {
            name: "get_timeline",
            arguments: json!({}),
        });
    }
    if steps.is_empty() {
        steps.push(FixtureStep::Say(HELP.to_string()));
    }
    steps
}

fn describe_for_user(project: &Project) -> String {
    let (mut video, mut audio, mut text, mut captions) = (0, 0, 0, 0);
    for c in project.clips.values() {
        match c.content {
            ClipContent::Video { .. } | ClipContent::Image { .. } => video += 1,
            ClipContent::Audio { .. } => audio += 1,
            ClipContent::Text { .. } => text += 1,
            ClipContent::Caption { .. } => captions += 1,
        }
    }
    format!(
        "The timeline runs for {} with {} picture clip(s), {} audio clip(s), {} text overlay(s) and {} caption(s) on {} tracks.",
        fmt_secs(tools::secs(project.duration())),
        video,
        audio,
        text,
        captions,
        project.tracks.len()
    )
}

async fn run_fixture(
    host: Arc<dyn AssistantHost>,
    project_id: &str,
    req: TurnRequest,
    events: Sender<AssistantEvent>,
    cancel: CancellationToken,
) {
    if events
        .send(AssistantEvent::Started {
            mode: "fixture".into(),
            provider: None,
            model: None,
            fixture: true,
        })
        .await
        .is_err()
    {
        return;
    }
    let project = match host.project(project_id) {
        Ok(p) => p,
        Err(e) => {
            let _ = events
                .send(AssistantEvent::Error {
                    code: "not_found".into(),
                    message: format!("The project could not be read: {e}"),
                })
                .await;
            return;
        }
    };
    let steps = fixture_plan(&req, &project);
    let mut sentences: Vec<String> = Vec::new();
    let (mut tool_calls, mut edits) = (0u32, 0u32);
    for step in steps {
        if cancel.is_cancelled() {
            let _ = events
                .send(AssistantEvent::Error {
                    code: "aborted".into(),
                    message: "The assistant turn was cancelled.".into(),
                })
                .await;
            return;
        }
        match step {
            FixtureStep::Say(s) => sentences.push(s),
            FixtureStep::Tool { name, arguments } => {
                tool_calls += 1;
                let id = format!("fixture-{tool_calls}");
                if events
                    .send(AssistantEvent::ToolCall {
                        id: id.clone(),
                        name: name.to_string(),
                        arguments: arguments.clone(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                let (h, pid) = (host.clone(), project_id.to_string());
                let outcome = tokio::task::spawn_blocking(move || {
                    execute_tool(h.as_ref(), &pid, name, &arguments)
                })
                .await
                .unwrap_or_else(|_| {
                    fail("internal", "The tool crashed while running.".into(), None)
                });
                if outcome.revision.is_some() {
                    edits += 1;
                }
                sentences.push(if name == "get_timeline" && outcome.ok {
                    host.project(project_id)
                        .map(|p| describe_for_user(&p))
                        .unwrap_or_else(|_| outcome.summary.clone())
                } else if outcome.ok {
                    format!("{}.", outcome.summary.trim_end_matches('.'))
                } else {
                    format!("I could not do that: {}", outcome.summary)
                });
                if events
                    .send(AssistantEvent::ToolResult {
                        id,
                        ok: outcome.ok,
                        summary: outcome.summary,
                        revision: outcome.revision,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }
    if edits > 0 {
        sentences.push(if edits == 1 {
            "You can undo this with Ctrl+Z.".into()
        } else {
            format!("These are {edits} separate undo steps.")
        });
    }
    let mut text = String::new();
    for (i, part) in std::iter::once(FIXTURE_PREFIX.to_string())
        .chain(sentences)
        .enumerate()
    {
        let delta = if i == 0 { part } else { format!(" {part}") };
        text.push_str(&delta);
        if events
            .send(AssistantEvent::TextDelta { text: delta })
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = events
        .send(AssistantEvent::Done {
            text,
            tool_calls,
            edits,
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_expressions() {
        assert_eq!(parse_time_expr("5s"), Some(5.0));
        assert_eq!(parse_time_expr("5.5sec"), Some(5.5));
        assert_eq!(parse_time_expr("90ms"), Some(0.09));
        assert_eq!(parse_time_expr("2min"), Some(120.0));
        assert_eq!(parse_time_expr("1m30s"), Some(90.0));
        assert_eq!(parse_time_expr("1:23"), Some(83.0));
        assert_eq!(parse_time_expr("00:01:23"), Some(83.0));
        assert_eq!(parse_time_expr("1:02:03.5"), Some(3723.5));
        for bad in [
            "", "5", "abc", "1:75", "1:2:3:4", "5x", "s", ":30", "1:", "2x5s",
        ] {
            assert_eq!(parse_time_expr(bad), None, "{bad}");
        }
    }

    #[test]
    fn times_in_sentences() {
        let t = |s: &str| {
            all_times(&tokenize(s))
                .into_iter()
                .map(|x| x.1)
                .collect::<Vec<_>>()
        };
        assert_eq!(t("split at 5"), vec![5.0]);
        assert_eq!(t("split at 5.5 seconds."), vec![5.5]);
        assert_eq!(t("cut from 0:10 to 0:15"), vec![10.0, 15.0]);
        assert_eq!(t("delete between 3 and 4.5"), vec![3.0, 4.5]);
        assert_eq!(t("remove 10s-15s"), vec![10.0, 15.0]);
        assert_eq!(t("remove 3-5s please"), vec![3.0, 5.0]);
        assert_eq!(
            t("make 2 copies"),
            Vec::<f64>::new(),
            "bare numbers need a preposition"
        );
        assert_eq!(
            t("add title \"Q3 results\" at 2s for 4 seconds"),
            vec![2.0, 4.0]
        );
    }

    #[test]
    fn quoted_text() {
        assert_eq!(
            quoted("add title \"Hello world\" at 2s").as_deref(),
            Some("Hello world")
        );
        assert_eq!(
            quoted("add title “Smart quotes” now").as_deref(),
            Some("Smart quotes")
        );
        assert_eq!(
            quoted("add text 'It's here' at 1s").as_deref(),
            Some("It's here")
        );
        assert_eq!(quoted("don't add anything"), None);
        assert_eq!(quoted("add title \"\""), None);
    }

    #[test]
    fn secrets_are_redacted() {
        let env = SidecarEnv::Only(vec![(
            "ANTHROPIC_API_KEY".into(),
            "super-secret-value-123".into(),
        )]);
        let out = redact(
            "401 for key super-secret-value-123 and sk-ant-abcdefghijklmnop, ask-me later",
            &env,
        );
        assert!(!out.contains("super-secret-value-123"));
        assert!(!out.contains("sk-ant-abcdefghijklmnop"));
        assert!(out.contains("ask-me later"), "{out}");
        assert_eq!(out.matches("[redacted]").count(), 2);
    }
}
