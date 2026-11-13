//! HTTP API, media streaming and the embedded web UI.

use crate::app::{App, WebAssets};
use crate::assets::{sanitize_name, AssetRecord, AssetState};
use crate::assistant::{self, AssistantEvent, TurnRequest};
use crate::fsutil::now_ms;
use crate::import;
use crate::store::StoreError;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cutline_core::analysis::SilenceOptions;
use cutline_core::commands::Command;
use cutline_core::error::{CommandError, ErrorCode};
use cutline_core::model::{AssetKind, MAX_DIMENSION, MAX_FPS};
use cutline_core::render::{ExportSettings, RenderError};
use cutline_core::soniox::ProviderError;
use cutline_core::subtitles::{export_srt, export_vtt};
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};
use tower::ServiceExt;
use tower_http::services::ServeFile;

// ------------------------------------------------------------------------------
// errors
// ------------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub field: Option<String>,
    pub extra: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code: code.to_string(),
            message: message.into(),
            field: None,
            extra: None,
        }
    }
    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid_argument", message)
    }
    pub fn not_found(what: &str) -> ApiError {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("{what} not found"),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut err = json!({ "code": self.code, "message": self.message });
        if let Some(f) = self.field {
            err["field"] = json!(f);
        }
        if let Some(Value::Object(extra)) = self.extra {
            for (k, v) in extra {
                err[k] = v;
            }
        }
        (self.status, Json(json!({ "error": err }))).into_response()
    }
}

impl From<CommandError> for ApiError {
    fn from(e: CommandError) -> ApiError {
        let status = match e.code {
            ErrorCode::InvalidArgument => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::NotFound => StatusCode::NOT_FOUND,
            ErrorCode::TrackLocked | ErrorCode::Conflict | ErrorCode::NothingToDo => {
                StatusCode::CONFLICT
            }
            ErrorCode::StaleRevision => StatusCode::CONFLICT,
            ErrorCode::InvariantViolation => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let code: &'static str = e.code.into();
        ApiError {
            status,
            code: code.to_string(),
            message: e.message,
            field: e.field,
            extra: None,
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> ApiError {
        match e {
            StoreError::Command(c) => c.into(),
            StoreError::NotFound => ApiError::not_found("Project"),
            StoreError::Corrupt(_) => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "project_damaged",
                e.to_string(),
            ),
            StoreError::Io(_) => ApiError::new(
                StatusCode::INSUFFICIENT_STORAGE,
                "save_failed",
                e.to_string(),
            ),
        }
    }
}

impl From<ProviderError> for ApiError {
    fn from(e: ProviderError) -> ApiError {
        ApiError {
            status: StatusCode::CONFLICT,
            code: "transcription_error".into(),
            message: e.message.clone(),
            field: None,
            extra: Some(json!({ "retryable": e.retryable, "kind": e.kind })),
        }
    }
}

impl From<RenderError> for ApiError {
    fn from(e: RenderError) -> ApiError {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "export_rejected",
            e.to_string(),
        )
    }
}

type ApiResult<T> = Result<T, ApiError>;
type AppState = State<Arc<App>>;

fn origin(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-client-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(64).collect())
}

/// Run blocking store work off the async executor.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("Internal error: {e}"),
        )
    })
}

// ------------------------------------------------------------------------------
// router
// ------------------------------------------------------------------------------

pub fn router(app: Arc<App>) -> Router {
    let upload_limit = app.cfg.max_upload_bytes;
    Router::new()
        .route("/api/health", get(health))
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{id}",
            get(get_project)
                .patch(rename_project)
                .delete(delete_project),
        )
        .route("/api/projects/{id}/duplicate", post(duplicate_project))
        .route("/api/projects/{id}/commands", post(run_command))
        .route("/api/projects/{id}/undo", post(undo))
        .route("/api/projects/{id}/redo", post(redo))
        .route(
            "/api/projects/{id}/assets",
            get(list_assets)
                .post(upload_assets)
                .layer(DefaultBodyLimit::max(
                    usize::try_from(upload_limit).unwrap_or(usize::MAX),
                )),
        )
        .route("/api/projects/{id}/assets/sample", post(add_sample))
        .route("/api/projects/{id}/transcript", get(transcript_view))
        .route("/api/projects/{id}/silences", get(silences))
        .route("/api/projects/{id}/captions.{ext}", get(captions_file))
        .route(
            "/api/projects/{id}/exports",
            get(list_exports).post(start_export),
        )
        .route("/api/projects/{id}/assistant", post(assistant_turn))
        .route(
            "/api/assets/{asset_id}",
            axum::routing::delete(dismiss_asset),
        )
        .route(
            "/api/assets/{asset_id}/transcription",
            post(transcription_action),
        )
        .route("/api/assets/{asset_id}/transcript", get(asset_transcript))
        .route("/api/assets/{asset_id}/reprocess", post(reprocess_asset))
        .route(
            "/api/exports/{job_id}",
            get(get_export).delete(delete_export),
        )
        .route("/api/exports/{job_id}/cancel", post(cancel_export))
        .route("/api/events", get(events))
        .route("/media/{asset_id}/{file}", get(media))
        .route("/exports/{job_id}/{file}", get(export_file))
        .fallback(static_files)
        .with_state(app)
}

// ------------------------------------------------------------------------------
// health / projects
// ------------------------------------------------------------------------------

async fn health(State(app): AppState) -> Json<Value> {
    let tools = app.tool_status.read().unwrap().clone();
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "mode": if app.cfg.fixture { "fixture" } else { "live" },
        "fixture": app.cfg.fixture,
        "speech": {
            "provider": if app.cfg.fixture { "fixture" } else { "soniox" },
            "model": app.cfg.soniox_model,
            // only whether a key exists is ever exposed, never the key
            "configured": app.cfg.fixture || app.cfg.soniox_api_key.is_some(),
        },
        "ffmpeg": tools,
        "assistant": assistant::assistant_status(&app.assistant),
        "limits": { "max_dimension": MAX_DIMENSION, "max_fps": MAX_FPS, "max_upload_bytes": app.cfg.max_upload_bytes },
    }))
}

async fn list_projects(State(app): AppState) -> Json<Value> {
    Json(json!({ "projects": app.projects.list(), "broken": app.projects.broken() }))
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn create_project(
    State(app): AppState,
    Json(body): Json<NameBody>,
) -> ApiResult<Json<Value>> {
    let meta = blocking(move || app.projects.create(&body.name)).await??;
    Ok(Json(json!({ "project": meta })))
}

fn project_payload(app: &App, id: &str) -> Result<Value, StoreError> {
    let (project, layers, history) = app
        .projects
        .read(id, |s| (s.project.clone(), s.layers(), s.history_state()))?;
    let assets = bin_assets(app, id, &project);
    Ok(json!({
        "project": project,
        "layers": layers,
        "history": history,
        "duration": project.duration(),
        "assets": assets,
        "exports": app.renders.list(id),
    }))
}

/// Asset records shown in a project's media bin: everything in the document plus
/// uploads that have not been registered yet (still probing, or failed).
fn bin_assets(app: &App, id: &str, project: &cutline_core::Project) -> Vec<AssetRecord> {
    app.assets
        .owned_by(id)
        .into_iter()
        .filter(|r| project.assets.contains_key(&r.id) || r.info.is_none())
        .collect()
}

async fn get_project(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let a = app.clone();
    let payload = blocking(move || project_payload(&a, &id)).await??;
    Ok(Json(payload))
}

async fn rename_project(
    State(app): AppState,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> ApiResult<Json<Value>> {
    let a = app.clone();
    let pid = id.clone();
    blocking(move || a.projects.mutate(&pid, |s| s.rename(&body.name, now_ms()))).await??;
    let meta = app.projects.meta(&id);
    app.events
        .emit("project", Some(&id), &json!({ "renamed": meta }));
    Ok(Json(json!({ "project": meta })))
}

async fn duplicate_project(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let meta = blocking(move || app.duplicate_project(&id)).await??;
    Ok(Json(json!({ "project": meta })))
}

async fn delete_project(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    app.delete_project(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------------------------------
// commands / undo / redo
// ------------------------------------------------------------------------------

#[derive(Deserialize)]
struct CommandBody {
    base_revision: u64,
    command: Value,
}

fn stale_extra(app: &App, id: &str, mut err: ApiError) -> ApiError {
    if err.code == "stale_revision" {
        if let Ok(rev) = app.projects.read(id, |s| s.project.revision) {
            err.extra = Some(json!({ "current_revision": rev }));
        }
    }
    err
}

async fn run_command(
    State(app): AppState,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CommandBody>,
) -> ApiResult<Json<Value>> {
    // Parse strictly: unknown command types, unknown fields and wrong types are rejected.
    let command: Command = serde_json::from_value(body.command).map_err(|e| ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "invalid_argument".into(),
        message: format!("Invalid command: {e}"),
        field: None,
        extra: None,
    })?;
    let origin = origin(&headers);
    let a = app.clone();
    let pid = id.clone();
    let change =
        blocking(move || a.execute(&pid, Some(body.base_revision), &command, origin.as_deref()))
            .await?
            .map_err(|e| stale_extra(&app, &id, e.into()))?;
    Ok(Json(json!({ "change": change })))
}

#[derive(Deserialize)]
struct RevisionBody {
    base_revision: u64,
}

async fn undo(
    State(app): AppState,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionBody>,
) -> ApiResult<Json<Value>> {
    step(app, id, headers, body.base_revision, true).await
}

async fn redo(
    State(app): AppState,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionBody>,
) -> ApiResult<Json<Value>> {
    step(app, id, headers, body.base_revision, false).await
}

async fn step(
    app: Arc<App>,
    id: String,
    headers: HeaderMap,
    base_revision: u64,
    is_undo: bool,
) -> ApiResult<Json<Value>> {
    let origin = origin(&headers);
    let a = app.clone();
    let pid = id.clone();
    let change = blocking(move || a.undo_redo(&pid, base_revision, is_undo, origin.as_deref()))
        .await?
        .map_err(|e| stale_extra(&app, &id, e.into()))?;
    Ok(Json(json!({ "change": change })))
}

// ------------------------------------------------------------------------------
// assets
// ------------------------------------------------------------------------------

async fn list_assets(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let project = app.projects.read(&id, |s| s.project.clone())?;
    Ok(Json(json!({ "assets": bin_assets(&app, &id, &project) })))
}

async fn upload_assets(
    State(app): AppState,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    if !app.projects.exists(&id) {
        return Err(ApiError::not_found("Project"));
    }
    let mut created: Vec<AssetRecord> = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                return Err(ApiError::bad_request(format!(
                    "The upload was interrupted or malformed: {e}"
                )))
            }
        };
        let Some(file_name) = field.file_name().map(|s| s.to_string()) else {
            continue;
        };
        let (name, ext) = sanitize_name(&file_name);
        let rec = app
            .assets
            .create(&name, &ext, false, Some(&id))
            .map_err(|e| {
                ApiError::new(
                    StatusCode::INSUFFICIENT_STORAGE,
                    "save_failed",
                    format!("Could not store the upload: {e}"),
                )
            })?;
        let path = app.assets.source_path(&rec);
        match save_field(field, &path, app.cfg.max_upload_bytes).await {
            Ok(size) if size > 0 => {
                app.assets.update(&rec.id, |r| r.size_bytes = size);
                let (a, pid, aid) = (app.clone(), id.clone(), rec.id.clone());
                tokio::spawn(async move { import::process_asset(a, Some(pid), aid).await });
                if let Some(r) = app.assets.get(&rec.id) {
                    created.push(r);
                }
            }
            Ok(_) => {
                app.assets.remove(&rec.id);
                return Err(ApiError::bad_request(format!("“{name}” is empty.")));
            }
            Err(e) => {
                app.assets.remove(&rec.id);
                return Err(e);
            }
        }
    }
    if created.is_empty() {
        return Err(ApiError::bad_request("No file was received."));
    }
    Ok(Json(json!({ "assets": created })))
}

async fn save_field(
    mut field: axum::extract::multipart::Field<'_>,
    path: &std::path::Path,
    limit: u64,
) -> ApiResult<u64> {
    let io = |e: std::io::Error| {
        ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "save_failed",
            format!("Could not store the upload: {e}. Check free disk space."),
        )
    };
    let mut file = tokio::fs::File::create(path).await.map_err(io)?;
    let mut size: u64 = 0;
    loop {
        match field.chunk().await {
            Ok(Some(chunk)) => {
                size += chunk.len() as u64;
                if size > limit {
                    return Err(ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "too_large",
                        format!(
                            "The file is larger than the upload limit of {} GB.",
                            limit / (1024 * 1024 * 1024)
                        ),
                    ));
                }
                file.write_all(&chunk).await.map_err(io)?;
            }
            Ok(None) => break,
            Err(e) => {
                return Err(ApiError::bad_request(format!(
                    "The upload was interrupted: {e}"
                )))
            }
        }
    }
    file.flush().await.map_err(io)?;
    Ok(size)
}

/// Generate a clearly labelled sample clip (handy in fixture mode and for first runs).
async fn add_sample(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !app.projects.exists(&id) {
        return Err(ApiError::not_found("Project"));
    }
    let n = app
        .assets
        .owned_by(&id)
        .iter()
        .filter(|r| r.fixture)
        .count()
        + 1;
    let rec = app
        .assets
        .create(
            &format!("Sample clip {n} (generated).mp4"),
            "mp4",
            true,
            Some(&id),
        )
        .map_err(|e| {
            ApiError::new(
                StatusCode::INSUFFICIENT_STORAGE,
                "save_failed",
                e.to_string(),
            )
        })?;
    let path = app.assets.source_path(&rec);
    if let Err(e) = import::generate_sample(&app, &path, 20).await {
        app.assets.remove(&rec.id);
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "sample_failed",
            e.to_string(),
        ));
    }
    let size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    app.assets.update(&rec.id, |r| r.size_bytes = size);
    let (a, pid, aid) = (app.clone(), id.clone(), rec.id.clone());
    tokio::spawn(async move { import::process_asset(a, Some(pid), aid).await });
    Ok(Json(json!({ "assets": [app.assets.get(&rec.id)] })))
}

#[derive(Deserialize)]
struct ProjectQuery {
    project: Option<String>,
}

/// Dismiss an upload that never made it into the project (failed / unreadable file).
async fn dismiss_asset(
    State(app): AppState,
    Path(asset_id): Path<String>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<Json<Value>> {
    let rec = app
        .assets
        .get(&asset_id)
        .ok_or_else(|| ApiError::not_found("Media"))?;
    let in_a_bin = !app.projects.projects_using(&asset_id).is_empty();
    if in_a_bin {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            "This media is part of a project. Remove it from the media bin instead.",
        ));
    }
    let remaining: Vec<String> = rec
        .projects
        .iter()
        .filter(|p| Some(p.as_str()) != q.project.as_deref())
        .cloned()
        .collect();
    if remaining.is_empty() || rec.info.is_none() {
        app.transcription.purge(&asset_id).await;
        app.assets.remove(&asset_id);
    } else {
        app.assets.update(&asset_id, |r| r.projects = remaining);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn reprocess_asset(
    State(app): AppState,
    Path(asset_id): Path<String>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<Json<Value>> {
    let rec = app
        .assets
        .get(&asset_id)
        .ok_or_else(|| ApiError::not_found("Media"))?;
    if !matches!(rec.state, AssetState::Failed | AssetState::Ready) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            "This media is already being processed.",
        ));
    }
    let pid = q.project.or_else(|| rec.projects.first().cloned());
    let (a, aid) = (app.clone(), asset_id.clone());
    tokio::spawn(async move { import::process_asset(a, pid, aid).await });
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TranscriptionBody {
    action: String,
}

async fn transcription_action(
    State(app): AppState,
    Path(asset_id): Path<String>,
    Json(body): Json<TranscriptionBody>,
) -> ApiResult<Json<Value>> {
    if app.assets.get(&asset_id).is_none() {
        return Err(ApiError::not_found("Media"));
    }
    let status = match body.action.as_str() {
        "start" => Some(app.transcription.start(&asset_id, false)?),
        "retry" => Some(app.transcription.start(&asset_id, true)?),
        "cancel" => app.transcription.cancel(&asset_id).await,
        other => {
            return Err(ApiError::bad_request(format!(
                "Unknown action “{other}”. Use start, retry or cancel."
            )))
        }
    };
    Ok(Json(json!({ "transcription": status })))
}

async fn asset_transcript(
    State(app): AppState,
    Path(asset_id): Path<String>,
) -> ApiResult<Response> {
    let a = app.clone();
    let t = blocking(move || a.assets.transcript(&asset_id))
        .await?
        .ok_or_else(|| ApiError::not_found("Transcript"))?;
    Ok(Json(&*t).into_response())
}

async fn transcript_view(State(app): AppState, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let view = blocking(move || app.transcript_view(&id)).await??;
    Ok(Json(json!({ "view": view })))
}

async fn silences(
    State(app): AppState,
    Path(id): Path<String>,
    Query(opts): Query<SilenceOptions>,
) -> ApiResult<Json<Value>> {
    let opts = opts.sanitized();
    let found = blocking(move || app.silences(&id, opts)).await??;
    Ok(Json(json!({ "options": opts, "silences": found })))
}

async fn captions_file(
    State(app): AppState,
    Path((id, ext)): Path<(String, String)>,
) -> ApiResult<Response> {
    let (name, body, mime) = app.projects.read(&id, |s| match ext.as_str() {
        "srt" => Ok((
            s.project.name.clone(),
            export_srt(&s.project),
            "application/x-subrip; charset=utf-8",
        )),
        "vtt" => Ok((
            s.project.name.clone(),
            export_vtt(&s.project),
            "text/vtt; charset=utf-8",
        )),
        _ => Err(ApiError::not_found("Caption format")),
    })??;
    let file = format!("{}.{}", safe_filename(&name), ext);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(mime)),
            (header::CONTENT_DISPOSITION, disposition(&file, true)),
        ],
        body,
    )
        .into_response())
}

// ------------------------------------------------------------------------------
// exports
// ------------------------------------------------------------------------------

async fn list_exports(State(app): AppState, Path(id): Path<String>) -> Json<Value> {
    Json(json!({ "exports": app.renders.list(&id) }))
}

async fn start_export(
    State(app): AppState,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (project, layers) = app
        .projects
        .read(&id, |s| (s.project.clone(), s.layers()))?;
    // Unspecified settings default to the project's own format.
    let mut settings =
        serde_json::to_value(ExportSettings::from_project(&project)).unwrap_or(Value::Null);
    if let (Value::Object(base), Value::Object(over)) = (&mut settings, body) {
        for (k, v) in over {
            base.insert(k, v);
        }
    }
    let settings: ExportSettings = serde_json::from_value(settings).map_err(|e| ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "invalid_argument".into(),
        message: format!("Invalid export settings: {e}"),
        field: None,
        extra: None,
    })?;
    if !app.tool_status.read().unwrap().ok {
        // re-check: the user may have installed FFmpeg since startup
        let status = crate::ffmpeg::check_tools(&app.tools).await;
        let ok = status.ok;
        let message = status.message.clone();
        *app.tool_status.write().unwrap() = status;
        if !ok {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ffmpeg_missing",
                message.unwrap_or_else(|| "FFmpeg is not available.".into()),
            ));
        }
    }
    let sources = app.media_sources(&project);
    let job = app.renders.start(&project, &layers, sources, settings)?;
    Ok(Json(json!({ "export": job })))
}

async fn get_export(State(app): AppState, Path(job_id): Path<String>) -> ApiResult<Json<Value>> {
    let job = app
        .renders
        .get(&job_id)
        .ok_or_else(|| ApiError::not_found("Export"))?;
    Ok(Json(json!({ "export": job })))
}

async fn cancel_export(State(app): AppState, Path(job_id): Path<String>) -> ApiResult<Json<Value>> {
    let job = app
        .renders
        .cancel(&job_id)
        .await
        .ok_or_else(|| ApiError::not_found("Export"))?;
    Ok(Json(json!({ "export": job })))
}

async fn delete_export(State(app): AppState, Path(job_id): Path<String>) -> ApiResult<Json<Value>> {
    if !app.renders.delete(&job_id).await {
        return Err(ApiError::not_found("Export"));
    }
    app.events
        .emit("render", None, &json!({ "id": job_id, "deleted": true }));
    Ok(Json(json!({ "ok": true })))
}

fn safe_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        "export".into()
    } else {
        s.chars().take(100).collect()
    }
}

fn disposition(file: &str, attachment: bool) -> HeaderValue {
    let ascii: String = file
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = file
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    HeaderValue::from_str(&format!(
        "{}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}",
        if attachment { "attachment" } else { "inline" }
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

#[derive(Deserialize)]
struct DownloadQuery {
    download: Option<String>,
}

async fn export_file(
    State(app): AppState,
    Path((job_id, _file)): Path<(String, String)>,
    Query(q): Query<DownloadQuery>,
    req: Request,
) -> ApiResult<Response> {
    let job = app
        .renders
        .get(&job_id)
        .ok_or_else(|| ApiError::not_found("Export"))?;
    let path = app.renders.output_path(&job_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "not_ready",
            "This export has not finished.",
        )
    })?;
    let mut res = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.map(Body::new).into_response())
        .unwrap_or_else(|e| match e {});
    if q.download.is_some() {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
        let file = format!("{}.{}", safe_filename(&job.project_name), ext);
        res.headers_mut()
            .insert(header::CONTENT_DISPOSITION, disposition(&file, true));
    }
    Ok(res)
}

// ------------------------------------------------------------------------------
// media streaming (HTTP range requests via tower-http)
// ------------------------------------------------------------------------------

async fn media(
    State(app): AppState,
    Path((asset_id, file)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let path = app
        .assets
        .servable(&asset_id, &file)
        .ok_or_else(|| ApiError::not_found("Media file"))?;
    let mut res = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.map(Body::new).into_response())
        .unwrap_or_else(|e| match e {});
    if res.status().is_success() {
        // derived files never change for a given asset id
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=31536000, immutable"),
        );
    }
    Ok(res)
}

// ------------------------------------------------------------------------------
// server-sent events
// ------------------------------------------------------------------------------

async fn events(
    State(app): AppState,
    Query(q): Query<ProjectQuery>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let project = q.project;
    let stream = BroadcastStream::new(app.events.subscribe()).filter_map(move |msg| {
        let project = project.clone();
        async move {
            match msg {
                Ok(ev) => {
                    if ev.project_id.is_some() && ev.project_id != project {
                        return None;
                    }
                    Some(Ok(SseEvent::default()
                        .event(ev.kind)
                        .data(ev.payload.to_string())))
                }
                // The client fell behind and missed events: tell it to re-sync.
                Err(_) => Some(Ok(SseEvent::default().event("resync").data("{}"))),
            }
        }
    });
    let hello = futures::stream::once(async { Ok(SseEvent::default().event("hello").data("{}")) });
    Sse::new(hello.chain(stream))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

// ------------------------------------------------------------------------------
// assistant (streamed over SSE from a POST)
// ------------------------------------------------------------------------------

async fn assistant_turn(
    State(app): AppState,
    Path(id): Path<String>,
    Json(req): Json<TurnRequest>,
) -> ApiResult<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>> {
    if !app.projects.exists(&id) {
        return Err(ApiError::not_found("Project"));
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<AssistantEvent>(64);
    let cancel = tokio_util::sync::CancellationToken::new();
    let guard = cancel.clone().drop_guard();
    let host: Arc<dyn assistant::AssistantHost> = app.clone();
    let cfg = app.assistant.clone();
    tokio::spawn(async move {
        assistant::run_turn(host, &cfg, &id, req, tx, cancel).await;
    });
    // Dropping the response stream (client went away) cancels the turn.
    let stream = ReceiverStream::new(rx).map(move |ev| {
        let _keep = &guard;
        Ok(SseEvent::default()
            .event("assistant")
            .data(serde_json::to_string(&ev).unwrap_or_else(|_| "{}".into())))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

// ------------------------------------------------------------------------------
// static web UI
// ------------------------------------------------------------------------------

async fn static_files(State(app): AppState, req: Request) -> Response {
    let raw = req.uri().path().trim_start_matches('/');
    if raw.starts_with("api/") || raw.starts_with("media/") || raw.starts_with("exports/") {
        return ApiError::not_found("Endpoint").into_response();
    }
    if raw
        .split('/')
        .any(|seg| seg == ".." || seg.starts_with('.'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if raw.is_empty() { "index.html" } else { raw };
    let load = |p: &str| -> Option<(Vec<u8>, String)> {
        if let Some(dir) = &app.cfg.web_dir {
            let bytes = std::fs::read(dir.join(p)).ok()?;
            let tag = format!(
                "\"{}-{}\"",
                bytes.len(),
                std::fs::metadata(dir.join(p))
                    .ok()?
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_millis()
            );
            Some((bytes, tag))
        } else {
            let f = WebAssets::get(p)?;
            let tag = format!(
                "\"{}\"",
                f.metadata
                    .sha256_hash()
                    .iter()
                    .take(12)
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            Some((f.data.into_owned(), tag))
        }
    };
    // unknown extension-less paths fall back to the app shell
    let (bytes, tag, served) = match load(path) {
        Some((b, t)) => (b, t, path),
        None if !path.contains('.') => match load("index.html") {
            Some((b, t)) => (b, t, "index.html"),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(tag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let mime = mime_guess::from_path(served).first_or_octet_stream();
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(v) = HeaderValue::from_str(&tag) {
        h.insert(header::ETAG, v);
    }
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    res
}

#[allow(dead_code)]
fn _kind_marker(_: AssetKind) {}
