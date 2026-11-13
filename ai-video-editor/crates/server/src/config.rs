//! Runtime configuration (environment + command line).

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    /// Deterministic fixture mode: no external services are contacted, speech data is
    /// synthetic and clearly labelled as such in the UI.
    pub fixture: bool,
    /// Server-side only. Never serialised, logged or sent to the browser.
    pub soniox_api_key: Option<String>,
    pub soniox_base_url: String,
    pub soniox_model: String,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Serve the web UI from this directory instead of the embedded copy (development).
    pub web_dir: Option<PathBuf>,
    pub max_upload_bytes: u64,
    /// Directory of the Pi SDK sidecar (live assistant).
    pub sidecar_dir: PathBuf,
    pub node: PathBuf,
    pub pi_provider: Option<String>,
    pub pi_model: Option<String>,
    /// Artificial per-step latency of fixture adapters so state changes are visible.
    pub fixture_step_ms: u64,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn truthy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

impl Config {
    /// Build the configuration from `.env`, `.env.local`, the process environment and
    /// command line flags (`--fixture`, `--port N`, `--host H`, `--data-dir D`).
    pub fn from_env_and_args<I: IntoIterator<Item = String>>(args: I) -> Result<Config, String> {
        // .env.local overrides .env; real environment variables override both.
        let _ = dotenvy::from_filename(".env.local");
        let _ = dotenvy::from_filename(".env");

        let mut cfg = Config {
            host: env("CUTLINE_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: env("CUTLINE_PORT")
                .or_else(|| env("PORT"))
                .and_then(|p| p.parse().ok())
                .unwrap_or(4310),
            data_dir: PathBuf::from(env("CUTLINE_DATA_DIR").unwrap_or_else(|| "data".into())),
            fixture: env("CUTLINE_FIXTURE").map(|v| truthy(&v)).unwrap_or(false),
            soniox_api_key: env("SONIOX_API_KEY"),
            soniox_base_url: env("SONIOX_BASE_URL")
                .unwrap_or_else(|| "https://api.soniox.com".into()),
            soniox_model: env("SONIOX_MODEL").unwrap_or_else(|| "stt-async-v5".into()),
            ffmpeg: PathBuf::from(env("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into())),
            ffprobe: PathBuf::from(env("FFPROBE_PATH").unwrap_or_else(|| "ffprobe".into())),
            web_dir: env("CUTLINE_WEB_DIR").map(PathBuf::from),
            max_upload_bytes: env("CUTLINE_MAX_UPLOAD_GB")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(64)
                * 1024
                * 1024
                * 1024,
            sidecar_dir: PathBuf::from(
                env("CUTLINE_SIDECAR_DIR").unwrap_or_else(|| "sidecar".into()),
            ),
            node: PathBuf::from(env("NODE_PATH_BIN").unwrap_or_else(|| "node".into())),
            pi_provider: env("PI_PROVIDER"),
            pi_model: env("PI_MODEL"),
            fixture_step_ms: env("CUTLINE_FIXTURE_STEP_MS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(600),
        };
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--fixture" | "--fixtures" => cfg.fixture = true,
                "--live" => cfg.fixture = false,
                "--port" | "-p" => {
                    cfg.port = it
                        .next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("--port needs a number")?;
                }
                "--host" => cfg.host = it.next().ok_or("--host needs a value")?,
                "--data-dir" => {
                    cfg.data_dir = PathBuf::from(it.next().ok_or("--data-dir needs a path")?)
                }
                "--web-dir" => {
                    cfg.web_dir = Some(PathBuf::from(it.next().ok_or("--web-dir needs a path")?))
                }
                "--help" | "-h" => {
                    return Err(HELP.to_string());
                }
                other => return Err(format!("Unknown argument: {other}\n\n{HELP}")),
            }
        }
        Ok(cfg)
    }

    /// A configuration suitable for tests: fixture mode, isolated data dir, no latency.
    pub fn for_tests(data_dir: PathBuf) -> Config {
        Config {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir,
            fixture: true,
            soniox_api_key: None,
            soniox_base_url: "http://127.0.0.1:9".into(),
            soniox_model: "stt-async-v5".into(),
            ffmpeg: PathBuf::from(env("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into())),
            ffprobe: PathBuf::from(env("FFPROBE_PATH").unwrap_or_else(|| "ffprobe".into())),
            web_dir: None,
            max_upload_bytes: 1024 * 1024 * 1024,
            sidecar_dir: PathBuf::from("sidecar"),
            node: PathBuf::from("node"),
            pi_provider: None,
            pi_model: None,
            fixture_step_ms: 0,
        }
    }
}

pub const HELP: &str = "Cutline — video editor server

USAGE:
    cutline [OPTIONS]

OPTIONS:
    --fixture          Deterministic fixture mode (no external services; synthetic,
                       clearly labelled speech data). Same as CUTLINE_FIXTURE=1.
    --live             Force live mode (default).
    --port, -p <N>     Port to listen on (default 4310, env CUTLINE_PORT / PORT).
    --host <ADDR>      Address to bind (default 127.0.0.1, env CUTLINE_HOST).
    --data-dir <DIR>   Where projects, media and exports are stored (default ./data).
    --web-dir <DIR>    Serve the UI from disk instead of the embedded copy.

ENVIRONMENT (.env / .env.local are loaded automatically):
    SONIOX_API_KEY     Soniox key for live transcription (server side only).
    SONIOX_MODEL       Async model (default stt-async-v5).
    FFMPEG_PATH, FFPROBE_PATH   Paths to the FFmpeg tools if not on PATH.
    PI_PROVIDER, PI_MODEL       Model used by the live editing assistant (Pi SDK).";
