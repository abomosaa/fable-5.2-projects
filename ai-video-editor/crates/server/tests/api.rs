//! End-to-end API tests: a real server on a random port, real FFmpeg, generated
//! media, and the deterministic fixture speech adapter. No network, no secrets.

use cutline_server::soniox::{FixtureSpeech, SpeechApi};
use cutline_server::{api, app::App, config::Config};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

const T: i64 = 705_600_000;

fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct Server {
    base: String,
    app: Arc<App>,
    speech: Arc<FixtureSpeech>,
    http: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start(data_dir: PathBuf) -> Server {
        let speech = Arc::new(FixtureSpeech::new(Duration::from_millis(5)));
        let dynamic: Arc<dyn SpeechApi> = speech.clone();
        let app = App::start_with_speech(Config::for_tests(data_dir), dynamic)
            .await
            .expect("app starts");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = api::router(app.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server {
            base,
            app,
            speech,
            http: reqwest::Client::new(),
            task,
        }
    }

    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
        let app = self.app.clone();
        tokio::task::spawn_blocking(move || app.projects.flush_histories())
            .await
            .unwrap();
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let r = self
            .http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        (status, r.json().await.unwrap_or(Value::Null))
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .http
            .request(method, format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        (status, r.json().await.unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.send(reqwest::Method::POST, path, body).await
    }

    async fn create_project(&self, name: &str) -> String {
        let (s, v) = self.post("/api/projects", json!({ "name": name })).await;
        assert_eq!(s, 200, "{v}");
        v["project"]["id"].as_str().unwrap().to_string()
    }

    async fn revision(&self, pid: &str) -> u64 {
        self.get(&format!("/api/projects/{pid}")).await.1["project"]["revision"]
            .as_u64()
            .unwrap()
    }

    /// Run a command against the current revision; panics on rejection.
    async fn cmd(&self, pid: &str, command: Value) -> Value {
        let rev = self.revision(pid).await;
        let (s, v) = self
            .post(
                &format!("/api/projects/{pid}/commands"),
                json!({ "base_revision": rev, "command": command }),
            )
            .await;
        assert_eq!(s, 200, "command rejected: {v}");
        v["change"].clone()
    }

    async fn upload(&self, pid: &str, path: &Path) -> Value {
        let bytes = tokio::fs::read(path).await.unwrap();
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(path.file_name().unwrap().to_string_lossy().to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        let r = self
            .http
            .post(format!("{}/api/projects/{pid}/assets", self.base))
            .multipart(form)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200);
        r.json::<Value>().await.unwrap()["assets"][0].clone()
    }

    async fn asset(&self, pid: &str, asset_id: &str) -> Value {
        let (_, v) = self.get(&format!("/api/projects/{pid}/assets")).await;
        v["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == asset_id)
            .cloned()
            .unwrap_or(Value::Null)
    }

    async fn wait_asset(
        &self,
        pid: &str,
        asset_id: &str,
        pred: impl Fn(&Value) -> bool,
        what: &str,
    ) -> Value {
        for _ in 0..600 {
            let a = self.asset(pid, asset_id).await;
            if pred(&a) {
                return a;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "timed out waiting for {what}: {}",
            self.asset(pid, asset_id).await
        );
    }
}

fn make_media(dir: &Path, name: &str, seconds: u32) -> PathBuf {
    let out = dir.join(name);
    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("testsrc2=size=320x180:rate=30:duration={seconds}"))
        .args(["-f", "lavfi", "-i"])
        .arg(format!("sine=frequency=440:duration={seconds}"))
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    out
}

fn probe_duration(path: &Path) -> f64 {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn health_reports_mode_and_never_exposes_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_tests(dir.path().join("live"));
    cfg.fixture = false;
    cfg.soniox_api_key = Some("sk-super-secret-value".into());
    let app = App::start(cfg).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, api::router(app)).await.unwrap() });
    let body = reqwest::get(format!("{base}/api/health"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        !body.contains("sk-super-secret-value"),
        "the API key must never reach the browser"
    );
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["mode"], "live");
    assert_eq!(v["fixture"], false);
    assert_eq!(v["speech"]["configured"], true);
    assert_eq!(v["speech"]["model"], "stt-async-v5");
    assert_eq!(v["limits"]["max_dimension"], 4096);
    task.abort();

    let s = Server::start(dir.path().join("fixture")).await;
    let (_, v) = s.get("/api/health").await;
    assert_eq!(v["mode"], "fixture");
    assert_eq!(v["speech"]["provider"], "fixture");
    assert_eq!(v["assistant"]["fixture"], true);
    // the UI shell is served from the embedded copy
    let html = reqwest::get(format!("{}/", s.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("<div id=\"app\">"));
    // unknown API routes are JSON errors, not the app shell
    let (status, err) = s.get("/api/nope").await;
    assert_eq!(status, 404);
    assert_eq!(err["error"]["code"], "not_found");
    s.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_commands_and_history_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = Server::start(dir.path().to_path_buf()).await;

    // create / rename / duplicate / validation
    let pid = s.create_project("First cut").await;
    let (status, err) = s.post("/api/projects", json!({ "name": "   " })).await;
    assert_eq!(status, 422, "{err}");
    assert_eq!(err["error"]["field"], "name");
    let (status, v) = s
        .send(
            reqwest::Method::PATCH,
            &format!("/api/projects/{pid}"),
            json!({ "name": "Renamed cut" }),
        )
        .await;
    assert_eq!(status, 200, "{v}");
    let (_, dup) = s
        .post(&format!("/api/projects/{pid}/duplicate"), json!({}))
        .await;
    assert_eq!(dup["project"]["name"], "Renamed cut copy");
    let dup_id = dup["project"]["id"].as_str().unwrap().to_string();

    // valid commands
    let change = s
        .cmd(
            &pid,
            json!({ "type": "add_text", "text": "Title", "start": 0, "duration": 3 * T }),
        )
        .await;
    assert_eq!(change["revision"], 1);
    assert_eq!(change["history"]["can_undo"], true);
    let clip_id = change["created"][0].as_str().unwrap().to_string();
    s.cmd(&pid, json!({ "type": "split_clips", "at": T })).await;

    // stale revision → 409, nothing applied
    let (status, err) = s
        .post(
            &format!("/api/projects/{pid}/commands"),
            json!({ "base_revision": 1, "command": { "type": "add_marker", "time": 0 } }),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(err["error"]["code"], "stale_revision");
    assert_eq!(err["error"]["current_revision"], 2);
    // unknown command type / unknown field / wrong type → 422, nothing applied
    for bad in [
        json!({ "type": "explode_timeline" }),
        json!({ "type": "split_clips", "at": T, "surprise": true }),
        json!({ "type": "split_clips", "at": "soon" }),
        json!({ "type": "update_clips", "clip_ids": [clip_id], "patch": { "opacity": 7.5 } }),
        json!({ "type": "add_text", "text": "x", "start": -5 }),
    ] {
        let (status, err) = s
            .post(
                &format!("/api/projects/{pid}/commands"),
                json!({ "base_revision": 2, "command": bad }),
            )
            .await;
        assert_eq!(status, 422, "{bad} → {err}");
        assert_eq!(err["error"]["code"], "invalid_argument", "{err}");
    }
    let (status, err) = s.post(&format!("/api/projects/{pid}/commands"), json!({ "base_revision": 2, "command": { "type": "delete_clips", "clip_ids": ["nope"] } })).await;
    assert_eq!(status, 404, "{err}");
    assert_eq!(
        s.revision(&pid).await,
        2,
        "rejected commands must not change the project"
    );

    // undo / redo over HTTP
    let (status, v) = s
        .post(
            &format!("/api/projects/{pid}/undo"),
            json!({ "base_revision": 2 }),
        )
        .await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["change"]["revision"], 3);
    assert_eq!(v["change"]["history"]["can_redo"], true);
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    assert_eq!(p["project"]["clips"].as_object().unwrap().len(), 1);

    // restart: documents, names and undo/redo history are all restored
    s.stop().await;
    let s = Server::start(dir.path().to_path_buf()).await;
    let (_, list) = s.get("/api/projects").await;
    let names: Vec<&str> = list["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"Renamed cut") && names.contains(&"Renamed cut copy"),
        "{names:?}"
    );
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    assert_eq!(p["project"]["revision"], 3);
    assert_eq!(p["history"]["can_undo"], true);
    assert_eq!(p["history"]["can_redo"], true);
    let (status, v) = s
        .post(
            &format!("/api/projects/{pid}/redo"),
            json!({ "base_revision": 3 }),
        )
        .await;
    assert_eq!(status, 200, "{v}");
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    assert_eq!(
        p["project"]["clips"].as_object().unwrap().len(),
        2,
        "redo after restart re-applies the split"
    );

    // delete
    let (status, _) = s
        .send(
            reqwest::Method::DELETE,
            &format!("/api/projects/{dup_id}"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(s.get(&format!("/api/projects/{dup_id}")).await.0, 404);
    assert!(!dir.path().join("projects").join(&dup_id).exists());
    s.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn import_transcribe_edit_and_export_round_trip() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media_dir = tempfile::tempdir().unwrap();
    let s = Server::start(dir.path().to_path_buf()).await;
    let pid = s.create_project("Round trip").await;

    // ---- a file that is not media fails with an actionable message -----------
    let garbage = media_dir.path().join("broken.mp4");
    std::fs::write(&garbage, b"this is definitely not an mp4 file").unwrap();
    let bad = s.upload(&pid, &garbage).await;
    let bad_id = bad["id"].as_str().unwrap().to_string();
    let failed = s
        .wait_asset(&pid, &bad_id, |a| a["state"] == "failed", "probe failure")
        .await;
    assert!(
        failed["error"]
            .as_str()
            .unwrap()
            .contains("could not be read as media"),
        "{failed}"
    );
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    assert!(
        p["project"]["assets"].as_object().unwrap().is_empty(),
        "unreadable files never enter the project"
    );
    let (status, _) = s
        .send(
            reqwest::Method::DELETE,
            &format!("/api/assets/{bad_id}?project={pid}"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(!dir.path().join("assets").join(&bad_id).exists());

    // ---- real media: probe, proxy, thumbnails, waveform ------------------------
    let clip = make_media(media_dir.path(), "talk.mp4", 6);
    let up = s.upload(&pid, &clip).await;
    let aid = up["id"].as_str().unwrap().to_string();
    let ready = s
        .wait_asset(&pid, &aid, |a| a["state"] == "ready", "asset processing")
        .await;
    assert_eq!(ready["info"]["kind"], "video");
    assert_eq!(ready["info"]["width"], 320);
    assert!(
        ready["proxy"] == true
            && ready["audio"] == true
            && ready["waveform"] == true
            && ready["poster"] == true,
        "{ready}"
    );
    assert!(ready["thumbs"]["count"].as_u64().unwrap() >= 10);
    let dur = ready["info"]["duration"].as_i64().unwrap();
    assert!((dur - 6 * T).abs() < T / 5, "probed duration {dur}");
    // derived media is served with HTTP range support (needed for seeking)
    let r = s
        .http
        .get(format!("{}/media/{aid}/proxy.mp4", s.base))
        .header("range", "bytes=0-99")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 206);
    assert_eq!(r.bytes().await.unwrap().len(), 100);
    let wf = s
        .http
        .get(format!("{}/media/{aid}/waveform.bin", s.base))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&wf[0..4], b"CWF1");
    assert!(wf.len() > 12 + 2 * 500, "≈100 peaks per second for 6 s");
    assert_eq!(
        s.http
            .get(format!("{}/media/{aid}/record.json", s.base))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        404
    );

    // ---- timeline: add linked A/V, split, trim ---------------------------------
    let change = s
        .cmd(&pid, json!({ "type": "add_asset_clips", "asset_id": aid }))
        .await;
    assert_eq!(
        change["created"].as_array().unwrap().len(),
        2,
        "video with sound becomes a linked pair"
    );
    s.cmd(&pid, json!({ "type": "split_clips", "at": 3 * T }))
        .await;
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    let clips = p["project"]["clips"].as_object().unwrap();
    assert_eq!(clips.len(), 4);
    let last_pair: Vec<String> = clips
        .values()
        .filter(|c| c["start"] == 3 * T)
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    s.cmd(
        &pid,
        json!({ "type": "trim_clips", "clip_ids": last_pair, "edge": "end", "delta": -T }),
    )
    .await;
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    let timeline = p["duration"].as_i64().unwrap();
    assert!(
        (timeline - 5 * T).abs() <= T / 10,
        "trimmed timeline is ≈5 s, got {timeline}"
    );

    // ---- transcript editing with the fixture speech adapter --------------------
    s.cmd(
        &pid,
        json!({ "type": "set_transcript_editing", "enabled": true }),
    )
    .await;
    let done = s
        .wait_asset(
            &pid,
            &aid,
            |a| {
                a["transcription"]["state"] == "completed"
                    && a["transcription"]["cleanup"] == "done"
            },
            "transcription",
        )
        .await;
    assert_eq!(done["transcription"]["fixture"], true);
    assert!(done["transcription"]["word_count"].as_u64().unwrap() > 5);
    assert!(
        s.speech.live_files().is_empty() && s.speech.live_transcriptions().is_empty(),
        "remote objects are deleted once the transcript is stored"
    );
    let (_, tv) = s.get(&format!("/api/projects/{pid}/transcript")).await;
    let segments = tv["view"]["segments"].as_array().unwrap();
    assert_eq!(segments.len(), 2, "one segment per audible clip");
    let seg = &segments[0];
    let word = &seg["words"][1];
    let w_len = word["end"].as_i64().unwrap() - word["start"].as_i64().unwrap();
    // transcript-linked ripple edit: remove one word by its source range
    let change = s
        .cmd(
            &pid,
            json!({ "type": "ripple_delete_source", "reason": "manual", "cuts": [{ "clip_id": seg["clip_id"], "source_start": word["source_start"], "source_end": word["source_end"], "text": word["text"] }] }),
        )
        .await;
    let after = change["duration"].as_i64().unwrap();
    let frame = T / 30;
    assert!(
        ((timeline - after) - w_len).abs() <= frame,
        "timeline shrinks by the word length: {} vs {}",
        timeline - after,
        w_len
    );
    let (_, p) = s.get(&format!("/api/projects/{pid}")).await;
    let removals = p["project"]["transcript"]["removals"].as_array().unwrap();
    assert_eq!(removals.len(), 1);
    assert_eq!(removals[0]["asset_id"], aid.as_str());
    assert_eq!(removals[0]["source_start"], word["source_start"]);
    assert_eq!(removals[0]["text"], word["text"]);
    let (_, tv) = s.get(&format!("/api/projects/{pid}/transcript")).await;
    assert!(
        tv["view"]["segments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|sg| sg["removed_before"]["text"] == word["text"]),
        "the removed word stays traceable in the transcript view"
    );

    // corrections never alter the stored provider tokens
    let (_, raw_before) = s.get(&format!("/api/assets/{aid}/transcript")).await;
    s.cmd(
        &pid,
        json!({ "type": "correct_word", "asset_id": aid, "word_index": 0, "text": "These" }),
    )
    .await;
    let (_, raw_after) = s.get(&format!("/api/assets/{aid}/transcript")).await;
    assert_eq!(raw_before, raw_after);
    assert_eq!(raw_after["fixture"], true);
    let (_, tv) = s.get(&format!("/api/projects/{pid}/transcript")).await;
    let first = &tv["view"]["segments"][0]["words"][0];
    assert_eq!(first["text"], "These");
    assert_eq!(first["original"], raw_after["words"][0]["text"]);

    // captions + subtitle download
    let change = s
        .cmd(&pid, json!({ "type": "generate_captions", "options": {} }))
        .await;
    assert!(!change["created"].as_array().unwrap().is_empty());
    let srt = s
        .http
        .get(format!("{}/api/projects/{pid}/captions.srt", s.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(srt.contains("-->") && srt.contains("These"), "{srt}");
    let (_, sil) = s
        .get(&format!("/api/projects/{pid}/silences?min_duration_ms=200"))
        .await;
    assert!(sil["silences"].is_array());

    // ---- export: a real composited render --------------------------------------
    let (status, bad) = s
        .post(
            &format!("/api/projects/{pid}/exports"),
            json!({ "width": 5000 }),
        )
        .await;
    assert_eq!(status, 422, "{bad}");
    let (status, v) = s
        .post(
            &format!("/api/projects/{pid}/exports"),
            json!({ "width": 320, "height": 180, "quality": "draft" }),
        )
        .await;
    assert_eq!(status, 200, "{v}");
    let job_id = v["export"]["id"].as_str().unwrap().to_string();
    let mut job = Value::Null;
    for _ in 0..600 {
        job = s.get(&format!("/api/exports/{job_id}")).await.1["export"].clone();
        if matches!(
            job["state"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(job["state"], "completed", "{job}");
    assert_eq!(job["progress"], 1.0);
    let r = s
        .http
        .get(format!("{}/exports/{job_id}/out.mp4", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let bytes = r.bytes().await.unwrap();
    assert!(
        bytes.len() > 10_000,
        "export is a real file ({} bytes)",
        bytes.len()
    );
    let out = media_dir.path().join("export.mp4");
    std::fs::write(&out, &bytes).unwrap();
    let expected = after as f64 / T as f64;
    let got = probe_duration(&out);
    assert!(
        (got - expected).abs() < 0.15,
        "export duration {got} ≈ timeline {expected}"
    );
    assert_ne!(
        bytes.len() as u64,
        std::fs::metadata(&clip).unwrap().len(),
        "the export is not the source file"
    );

    // ---- deleting the project removes its media, exports and remote data -------
    let asset_dir = dir.path().join("assets").join(&aid);
    assert!(asset_dir.exists());
    let (status, _) = s
        .send(
            reqwest::Method::DELETE,
            &format!("/api/projects/{pid}"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(!asset_dir.exists(), "media of a deleted project is removed");
    assert_eq!(s.get(&format!("/api/exports/{job_id}")).await.0, 404);
    assert!(s.speech.live_files().is_empty() && s.speech.live_transcriptions().is_empty());
    s.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_project_mid_transcription_cleans_up_remote_objects() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media_dir = tempfile::tempdir().unwrap();
    // slow fixture: the job is still processing when the project is deleted
    let speech = Arc::new(FixtureSpeech::new(Duration::from_millis(400)));
    let dynamic: Arc<dyn SpeechApi> = speech.clone();
    let app = App::start_with_speech(Config::for_tests(dir.path().to_path_buf()), dynamic)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = api::router(app.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let s = Server {
        base,
        app,
        speech,
        http: reqwest::Client::new(),
        task,
    };

    let pid = s.create_project("Short lived").await;
    let clip = make_media(media_dir.path(), "a.mp4", 3);
    let aid = s.upload(&pid, &clip).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    s.wait_asset(&pid, &aid, |a| a["speech"] == true, "speech audio")
        .await;
    s.cmd(
        &pid,
        json!({ "type": "set_transcript_editing", "enabled": true }),
    )
    .await;
    s.wait_asset(
        &pid,
        &aid,
        |a| {
            matches!(
                a["transcription"]["state"].as_str(),
                Some("uploading" | "processing")
            )
        },
        "job to start",
    )
    .await;
    // wait until the remote objects actually exist
    for _ in 0..100 {
        if !s.speech.live_files().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !s.speech.live_files().is_empty(),
        "the upload should be in flight"
    );
    let (status, _) = s
        .send(
            reqwest::Method::DELETE,
            &format!("/api/projects/{pid}"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        s.speech.live_files().is_empty(),
        "remote file deleted: {:?}",
        s.speech.live_files()
    );
    assert!(
        s.speech.live_transcriptions().is_empty(),
        "remote transcription deleted: {:?}",
        s.speech.live_transcriptions()
    );
    assert!(!dir.path().join("assets").join(&aid).exists());
    s.stop().await;
}
