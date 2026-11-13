use cutline_server::{api, app::App, config::Config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .with_target(false)
        .compact()
        .init();

    let cfg = match Config::from_env_and_args(std::env::args().skip(1)) {
        Ok(c) => c,
        Err(msg) => {
            // `--help` and argument errors both end up here
            eprintln!("{msg}");
            std::process::exit(if msg.starts_with("Cutline") { 0 } else { 2 });
        }
    };
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let fixture = cfg.fixture;
    let soniox = cfg.soniox_api_key.is_some();

    let app = match App::start(cfg).await {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Cutline could not start: {e:#}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Could not listen on {addr}: {e}. Is another instance running? Use --port to pick a different port.");
            std::process::exit(1);
        }
    };
    let local = listener.local_addr().map(|a| a.to_string()).unwrap_or(addr);
    tracing::info!("Cutline is running at http://{local}");
    if fixture {
        tracing::info!("mode: FIXTURE — speech data and the assistant are deterministic fixtures; no external services are contacted");
    } else if soniox {
        tracing::info!("mode: live — Soniox transcription enabled");
    } else {
        tracing::warn!("mode: live — SONIOX_API_KEY is not set, transcription will report “not configured”. Add it to .env or start with --fixture.");
    }

    let router = api::router(app.clone());
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down…");
    };
    if let Err(e) = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
    {
        tracing::error!("server error: {e}");
    }
    // Make sure undo histories reach the disk before exiting.
    let a = app.clone();
    let _ = tokio::task::spawn_blocking(move || a.projects.flush_histories()).await;
}
