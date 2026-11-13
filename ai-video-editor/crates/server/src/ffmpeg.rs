//! FFmpeg / ffprobe process helpers and media probing.

use cutline_core::model::AssetKind;
use cutline_core::time::{seconds_to_ticks, FrameRate, Ticks};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Why a media file could not be probed or processed. Every variant maps to an
/// actionable, user-facing message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum MediaError {
    #[error("{tool} was not found. Install FFmpeg (https://ffmpeg.org/download.html) or set {env} to its location, then restart the server.")]
    ToolMissing { tool: String, env: String },
    #[error("This file could not be read as media. It may be corrupt, incomplete or not a media file. ({detail})")]
    Unreadable { detail: String },
    #[error("This file has no video, audio or image stream that can be edited.")]
    NoStreams,
    #[error("The media reports a duration of zero, so there is nothing to place on the timeline.")]
    ZeroDuration,
    #[error("The video dimensions ({width}×{height}) are not supported.")]
    BadDimensions { width: i64, height: i64 },
    #[error("ffprobe returned data that could not be understood. ({detail})")]
    BadProbeOutput { detail: String },
    #[error("Processing failed: {detail}")]
    Processing { detail: String },
    #[error("The operation was cancelled.")]
    Cancelled,
    #[error("File error: {detail}")]
    Io { detail: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    pub kind: AssetKind,
    pub duration: Ticks,
    pub has_video: bool,
    pub has_audio: bool,
    /// Display dimensions (rotation metadata applied).
    pub width: u32,
    pub height: u32,
    pub fps: Option<FrameRate>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub format_name: String,
    pub rotation: i32,
    pub bit_rate: Option<u64>,
}

impl Probe {
    /// Can a browser `<video>`/`<audio>` element play the original file directly
    /// (so the preview does not have to wait for the proxy)?
    pub fn browser_playable(&self, ext: &str) -> bool {
        let container_ok = matches!(
            ext,
            "mp4"
                | "m4v"
                | "mov"
                | "webm"
                | "m4a"
                | "mp3"
                | "wav"
                | "ogg"
                | "opus"
                | "flac"
                | "aac"
        );
        let video_ok = match self.video_codec.as_deref() {
            None => true,
            Some("h264") => self
                .pix_fmt
                .as_deref()
                .is_none_or(|p| p == "yuv420p" || p == "yuvj420p"),
            Some("vp8") | Some("vp9") | Some("av1") => ext == "webm" || ext == "mp4",
            _ => false,
        };
        let audio_ok = matches!(
            self.audio_codec.as_deref(),
            None | Some("aac")
                | Some("mp3")
                | Some("opus")
                | Some("vorbis")
                | Some("flac")
                | Some("pcm_s16le")
        );
        let size_ok = self.width <= 1920 && self.height <= 1920;
        // 60 fps 1080p originals stutter on modest machines; prefer the proxy there.
        let fps_ok = self.fps.is_none_or(|f| f.as_f64() <= 61.0);
        container_ok && video_ok && audio_ok && size_ok && fps_ok && self.rotation == 0
    }
}

fn s(v: &serde_json::Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string())
}

fn num(v: &serde_json::Value, k: &str) -> Option<f64> {
    match v.get(k) {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(st)) => st.parse::<f64>().ok(),
        _ => None,
    }
    .filter(|f| f.is_finite())
}

/// Interpret `ffprobe -print_format json -show_format -show_streams` output.
/// Pure, so probing failures are unit-testable without media files.
pub fn parse_probe(json: &str) -> Result<Probe, MediaError> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| MediaError::BadProbeOutput {
            detail: e.to_string(),
        })?;
    let empty = Vec::new();
    let streams = v
        .get("streams")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty);
    let format = v.get("format").cloned().unwrap_or(serde_json::Value::Null);
    let format_name = s(&format, "format_name").unwrap_or_default();

    let is_cover = |st: &serde_json::Value| {
        st.get("disposition")
            .and_then(|d| d.get("attached_pic"))
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
            == 1
    };
    let video = streams
        .iter()
        .find(|st| s(st, "codec_type").as_deref() == Some("video") && !is_cover(st));
    let audio = streams
        .iter()
        .find(|st| s(st, "codec_type").as_deref() == Some("audio"));
    if video.is_none() && audio.is_none() {
        return Err(MediaError::NoStreams);
    }

    let mut duration_s = num(&format, "duration").unwrap_or(0.0);
    for st in video.iter().chain(audio.iter()) {
        if duration_s <= 0.0 {
            duration_s = num(st, "duration").unwrap_or(0.0);
        }
    }

    let (mut width, mut height, mut fps, mut rotation, mut video_codec, mut pix_fmt) =
        (0u32, 0u32, None, 0i32, None, None);
    let mut is_image = false;
    if let Some(vs) = video {
        let (w, h) = (
            num(vs, "width").unwrap_or(0.0) as i64,
            num(vs, "height").unwrap_or(0.0) as i64,
        );
        if w < 2 || h < 2 || w > 16384 || h > 16384 {
            return Err(MediaError::BadDimensions {
                width: w,
                height: h,
            });
        }
        // rotation: side data (modern) or the legacy `rotate` tag
        let mut rot = vs
            .get("side_data_list")
            .and_then(|l| l.as_array())
            .and_then(|l| l.iter().find_map(|sd| num(sd, "rotation")))
            .or_else(|| vs.get("tags").and_then(|t| num(t, "rotate")))
            .unwrap_or(0.0)
            .round() as i32;
        rot = rot.rem_euclid(360);
        rotation = rot;
        if rot == 90 || rot == 270 {
            width = h as u32;
            height = w as u32;
        } else {
            width = w as u32;
            height = h as u32;
        }
        video_codec = s(vs, "codec_name");
        pix_fmt = s(vs, "pix_fmt");
        fps = s(vs, "avg_frame_rate")
            .and_then(|r| FrameRate::parse(&r))
            .or_else(|| s(vs, "r_frame_rate").and_then(|r| FrameRate::parse(&r)));
        let still_format = format_name
            .split(',')
            .any(|f| f == "image2" || f.ends_with("_pipe"));
        let frames = num(vs, "nb_frames").unwrap_or(0.0);
        is_image = audio.is_none() && (still_format || (frames == 1.0 && duration_s < 0.5));
        // animated formats (gif/apng/webp sequences) with real duration are videos
        if is_image && duration_s > 0.5 && frames > 1.0 {
            is_image = false;
        }
    }
    let (kind, has_video) = if is_image {
        (AssetKind::Image, true)
    } else if video.is_some() {
        (AssetKind::Video, true)
    } else {
        (AssetKind::Audio, false)
    };
    if kind != AssetKind::Image && duration_s <= 0.0 {
        return Err(MediaError::ZeroDuration);
    }
    Ok(Probe {
        kind,
        duration: if kind == AssetKind::Image {
            0
        } else {
            seconds_to_ticks(duration_s)
        },
        has_video,
        has_audio: audio.is_some() && kind != AssetKind::Image,
        width,
        height,
        fps: if kind == AssetKind::Video { fps } else { None },
        sample_rate: audio.and_then(|a| num(a, "sample_rate")).map(|x| x as u32),
        channels: audio.and_then(|a| num(a, "channels")).map(|x| x as u32),
        video_codec,
        audio_codec: audio.and_then(|a| s(a, "codec_name")),
        pix_fmt,
        format_name,
        rotation,
        bit_rate: num(&format, "bit_rate").map(|b| b as u64),
    })
}

fn spawn_error(tool: &Path, env: &str, e: std::io::Error) -> MediaError {
    if e.kind() == std::io::ErrorKind::NotFound {
        MediaError::ToolMissing {
            tool: tool.display().to_string(),
            env: env.to_string(),
        }
    } else {
        MediaError::Io {
            detail: format!("could not start {}: {e}", tool.display()),
        }
    }
}

/// Last few meaningful lines of an FFmpeg stderr dump.
pub fn stderr_tail(stderr: &str, lines: usize) -> String {
    let v: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

pub async fn probe(tools: &Tools, path: &Path) -> Result<Probe, MediaError> {
    let out = Command::new(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| spawn_error(&tools.ffprobe, "FFPROBE_PATH", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let detail = stderr_tail(&err, 2);
        return Err(MediaError::Unreadable {
            detail: if detail.is_empty() {
                "ffprobe rejected the file".into()
            } else {
                strip_path(&detail, path)
            },
        });
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Do not leak server paths into user-facing messages.
fn strip_path(msg: &str, path: &Path) -> String {
    msg.replace(&path.display().to_string(), "file")
}

/// Run FFmpeg to completion. `on_progress` receives the output position in
/// microseconds (parsed from `-progress pipe:1`).
pub async fn run_ffmpeg<F: FnMut(i64) + Send>(
    tools: &Tools,
    args: &[String],
    mut on_progress: F,
) -> Result<(), MediaError> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
    ])
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error(&tools.ffmpeg, "FFMPEG_PATH", e))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(v) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        {
            if let Ok(us) = v.trim().parse::<i64>() {
                on_progress(us);
            }
        }
    }
    let status = child.wait().await.map_err(|e| MediaError::Io {
        detail: e.to_string(),
    })?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(MediaError::Processing {
            detail: stderr_tail(&err, 4),
        });
    }
    Ok(())
}

/// Run FFmpeg and capture raw stdout (used for PCM extraction).
pub async fn run_ffmpeg_stdout<F: FnMut(&[u8]) + Send>(
    tools: &Tools,
    args: &[String],
    mut on_data: F,
) -> Result<(), MediaError> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error(&tools.ffmpeg, "FFMPEG_PATH", e))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = stdout.read(&mut buf).await.map_err(|e| MediaError::Io {
            detail: e.to_string(),
        })?;
        if n == 0 {
            break;
        }
        on_data(&buf[..n]);
    }
    let status = child.wait().await.map_err(|e| MediaError::Io {
        detail: e.to_string(),
    })?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(MediaError::Processing {
            detail: stderr_tail(&err, 4),
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ToolStatus {
    pub ok: bool,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    pub message: Option<String>,
    pub encoders: Vec<String>,
}

async fn version_of(bin: &Path) -> Option<String> {
    let out = Command::new(bin)
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(2))
        .map(|v| v.to_string())
}

/// Check that the FFmpeg tools exist and which encoders are available.
pub async fn check_tools(tools: &Tools) -> ToolStatus {
    let ffmpeg_version = version_of(&tools.ffmpeg).await;
    let ffprobe_version = version_of(&tools.ffprobe).await;
    let mut encoders = Vec::new();
    if ffmpeg_version.is_some() {
        if let Ok(out) = Command::new(&tools.ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .stdin(Stdio::null())
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for name in ["libx264", "libx265", "libvpx-vp9", "aac", "libopus"] {
                if text
                    .lines()
                    .any(|l| l.split_whitespace().nth(1) == Some(name))
                {
                    encoders.push(name.to_string());
                }
            }
        }
    }
    let ok = ffmpeg_version.is_some() && ffprobe_version.is_some();
    let message = if ok {
        if encoders.iter().any(|e| e == "libx264") {
            None
        } else {
            Some("FFmpeg was found but has no H.264 encoder (libx264). MP4 export will not work; install a full FFmpeg build.".to_string())
        }
    } else {
        Some(
            MediaError::ToolMissing {
                tool: if ffmpeg_version.is_none() {
                    "ffmpeg".into()
                } else {
                    "ffprobe".into()
                },
                env: if ffmpeg_version.is_none() {
                    "FFMPEG_PATH".into()
                } else {
                    "FFPROBE_PATH".into()
                },
            }
            .to_string(),
        )
    };
    ToolStatus {
        ok,
        ffmpeg_version,
        ffprobe_version,
        message,
        encoders,
    }
}

pub fn path_arg(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cutline_core::time::TICKS_PER_SECOND;

    const VIDEO: &str = r#"{"streams":[{"index":0,"codec_name":"h264","codec_type":"video","width":1920,"height":1080,"pix_fmt":"yuv420p","r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001","duration":"10.010000","nb_frames":"300","disposition":{"attached_pic":0}},{"index":1,"codec_name":"aac","codec_type":"audio","sample_rate":"48000","channels":2,"duration":"10.0"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"10.010000","bit_rate":"2500000"}}"#;

    #[test]
    fn parses_video_with_audio() {
        let p = parse_probe(VIDEO).unwrap();
        assert_eq!(p.kind, AssetKind::Video);
        assert!(p.has_video && p.has_audio);
        assert_eq!((p.width, p.height), (1920, 1080));
        assert_eq!(p.fps, Some(FrameRate::FPS_29_97));
        assert_eq!(p.duration, seconds_to_ticks(10.01));
        assert_eq!(p.sample_rate, Some(48000));
        assert!(p.browser_playable("mp4"));
        assert!(!p.browser_playable("mkv"));
    }

    #[test]
    fn rotation_swaps_dimensions() {
        let j = r#"{"streams":[{"codec_name":"hevc","codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30/1","side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]}],"format":{"format_name":"mov,mp4","duration":"2.0"}}"#;
        let p = parse_probe(j).unwrap();
        assert_eq!((p.width, p.height), (1080, 1920));
        assert_eq!(p.rotation, 270);
        assert!(!p.browser_playable("mp4"));
        let legacy = r#"{"streams":[{"codec_name":"h264","codec_type":"video","width":1280,"height":720,"avg_frame_rate":"25/1","tags":{"rotate":"90"}}],"format":{"format_name":"mov,mp4","duration":"2.0"}}"#;
        assert_eq!(parse_probe(legacy).unwrap().width, 720);
    }

    #[test]
    fn stills_and_cover_art() {
        let img = r#"{"streams":[{"codec_name":"png","codec_type":"video","width":800,"height":600,"avg_frame_rate":"25/1","nb_frames":"1"}],"format":{"format_name":"png_pipe"}}"#;
        let p = parse_probe(img).unwrap();
        assert_eq!(p.kind, AssetKind::Image);
        assert_eq!(p.duration, 0);
        assert!(!p.has_audio);
        // an mp3 with embedded cover art is audio, not video
        let mp3 = r#"{"streams":[{"codec_name":"mp3","codec_type":"audio","sample_rate":"44100","channels":2},{"codec_name":"mjpeg","codec_type":"video","width":500,"height":500,"disposition":{"attached_pic":1}}],"format":{"format_name":"mp3","duration":"180.5"}}"#;
        let p = parse_probe(mp3).unwrap();
        assert_eq!(p.kind, AssetKind::Audio);
        assert!(!p.has_video);
        assert_eq!(p.duration, 180 * TICKS_PER_SECOND + TICKS_PER_SECOND / 2);
    }

    #[test]
    fn probe_failures_are_classified() {
        assert_eq!(
            parse_probe(r#"{"streams":[],"format":{}}"#),
            Err(MediaError::NoStreams)
        );
        assert_eq!(parse_probe("{}"), Err(MediaError::NoStreams));
        assert!(matches!(
            parse_probe("not json"),
            Err(MediaError::BadProbeOutput { .. })
        ));
        let zero = r#"{"streams":[{"codec_name":"h264","codec_type":"video","width":640,"height":360,"avg_frame_rate":"30/1"}],"format":{"format_name":"mov,mp4","duration":"0.000000"}}"#;
        assert_eq!(parse_probe(zero), Err(MediaError::ZeroDuration));
        let tiny = r#"{"streams":[{"codec_name":"h264","codec_type":"video","width":0,"height":0}],"format":{"format_name":"mov,mp4","duration":"1.0"}}"#;
        assert!(matches!(
            parse_probe(tiny),
            Err(MediaError::BadDimensions { .. })
        ));
        let only_data = r#"{"streams":[{"codec_type":"data"}],"format":{"format_name":"mov,mp4","duration":"1.0"}}"#;
        assert_eq!(parse_probe(only_data), Err(MediaError::NoStreams));
    }

    #[test]
    fn stream_duration_fallback_and_string_numbers() {
        let j = r#"{"streams":[{"codec_name":"pcm_s16le","codec_type":"audio","sample_rate":"44100","channels":"1","duration":"3.5"}],"format":{"format_name":"wav"}}"#;
        let p = parse_probe(j).unwrap();
        assert_eq!(p.kind, AssetKind::Audio);
        assert_eq!(p.duration, seconds_to_ticks(3.5));
        assert_eq!(p.channels, Some(1));
    }

    #[tokio::test]
    async fn missing_tool_is_actionable() {
        let tools = Tools {
            ffmpeg: "definitely-not-ffmpeg-xyz".into(),
            ffprobe: "definitely-not-ffprobe-xyz".into(),
        };
        let err = probe(&tools, Path::new("/tmp/nothing.mp4"))
            .await
            .unwrap_err();
        assert!(matches!(err, MediaError::ToolMissing { .. }));
        assert!(err.to_string().contains("FFPROBE_PATH"));
        let status = check_tools(&tools).await;
        assert!(!status.ok);
        assert!(status.message.unwrap().contains("Install FFmpeg"));
    }
}
