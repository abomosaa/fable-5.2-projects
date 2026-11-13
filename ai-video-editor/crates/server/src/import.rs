//! Media import pipeline: probe → register in the project → build previews.
//!
//! An asset becomes usable on the timeline as soon as probing succeeds; the preview
//! proxy, thumbnails and waveform arrive afterwards and are announced over SSE.

use crate::app::App;
use crate::assets::{AssetRecord, AssetState, ThumbSprite};
use crate::ffmpeg::{self, path_arg, MediaError, Probe};
use crate::fsutil::now_ms;
use cutline_core::analysis::Waveform;
use cutline_core::model::{AssetInfo, AssetKind};
use cutline_core::subtitles::parse_subtitles;
use cutline_core::time::{ms_to_ticks, ticks_to_seconds_string, Ticks, TICKS_PER_SECOND};
use std::sync::Arc;

pub const WAVEFORM_PEAKS_PER_SECOND: u32 = 100;
const WAVEFORM_SAMPLE_RATE: u32 = 8000;
const PROXY_MAX_W: u32 = 1280;
const PROXY_MAX_H: u32 = 720;

fn fail(app: &App, id: &str, message: String) {
    tracing::warn!("asset {id} failed: {message}");
    app.assets.update(id, |r| {
        r.state = AssetState::Failed;
        r.error = Some(message);
        r.stage = "Failed".into();
        r.progress = 0.0;
    });
}

/// Run the whole pipeline for a freshly uploaded (or resumed) asset.
pub async fn process_asset(app: Arc<App>, project_id: Option<String>, asset_id: String) {
    let Some(rec) = app.assets.update(&asset_id, |r| {
        r.state = AssetState::Probing;
        r.stage = "Analysing".into();
        r.error = None;
    }) else {
        return;
    };
    let source = app.assets.source_path(&rec);

    // ---- subtitles: parsed, not probed --------------------------------------
    if matches!(rec.ext.as_str(), "srt" | "vtt") {
        let text = match tokio::fs::read(&source).await {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(e) => {
                return fail(
                    &app,
                    &asset_id,
                    format!("The subtitle file could not be read: {e}"),
                )
            }
        };
        match parse_subtitles(&text) {
            Ok(cues) => {
                let duration = cues
                    .iter()
                    .map(|c| ms_to_ticks(c.end_ms))
                    .max()
                    .unwrap_or(0);
                let n = cues.len() as u32;
                if let Err(e) = app.assets.save_subtitle_cues(&asset_id, cues) {
                    return fail(
                        &app,
                        &asset_id,
                        format!("The subtitle file could not be stored: {e}"),
                    );
                }
                let info = AssetInfo {
                    id: asset_id.clone(),
                    name: rec.name.clone(),
                    kind: AssetKind::Subtitle,
                    duration,
                    has_video: false,
                    has_audio: false,
                    width: 0,
                    height: 0,
                    fps: None,
                    sample_rate: None,
                    channels: None,
                };
                register(&app, project_id.as_deref(), &info);
                app.assets.update(&asset_id, |r| {
                    r.info = Some(info);
                    r.cue_count = Some(n);
                    r.state = AssetState::Ready;
                    r.stage = "Ready".into();
                    r.progress = 1.0;
                });
            }
            Err(e) => fail(
                &app,
                &asset_id,
                format!("This subtitle file could not be parsed: {e}"),
            ),
        }
        return;
    }

    // ---- probe ---------------------------------------------------------------
    let probe = match ffmpeg::probe(&app.tools, &source).await {
        Ok(p) => p,
        Err(e) => return fail(&app, &asset_id, e.to_string()),
    };
    let info = AssetInfo {
        id: asset_id.clone(),
        name: rec.name.clone(),
        kind: probe.kind,
        duration: probe.duration,
        has_video: probe.has_video,
        has_audio: probe.has_audio,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        sample_rate: probe.sample_rate,
        channels: probe.channels,
    };
    register(&app, project_id.as_deref(), &info);
    let playable = probe.kind != AssetKind::Image && probe.browser_playable(&rec.ext);
    app.assets.update(&asset_id, |r| {
        r.info = Some(info.clone());
        r.probe = Some(probe.clone());
        r.playable_original = playable;
        r.state = AssetState::Processing;
        r.stage = "Preparing preview".into();
        r.progress = 0.0;
    });

    // ---- derived files -------------------------------------------------------
    let mut warnings: Vec<String> = Vec::new();
    {
        // light work (stills, thumbnails, audio) runs with modest parallelism
        let _permit = app.light_jobs.acquire().await;
        if probe.has_video {
            if let Err(e) = make_poster(&app, &rec, &probe).await {
                warnings.push(format!("thumbnail: {e}"));
            }
        }
        if probe.kind == AssetKind::Image {
            if let Err(e) = make_image_preview(&app, &rec).await {
                warnings.push(format!("preview: {e}"));
            }
        }
        if probe.has_audio {
            if let Err(e) = make_audio(&app, &rec, &probe).await {
                warnings.push(format!("audio: {e}"));
            }
        }
        if probe.kind == AssetKind::Video {
            if let Err(e) = make_thumbs(&app, &rec, &probe).await {
                warnings.push(format!("filmstrip: {e}"));
            }
        }
    }
    // Speech audio is ready: start transcription if the project asked for it.
    if let Some(pid) = &project_id {
        app.ensure_transcriptions(pid);
    }
    if probe.kind == AssetKind::Video {
        let _permit = app.proxy_jobs.acquire().await;
        if let Err(e) = make_proxy(&app, &rec, &probe).await {
            warnings.push(format!("preview video: {e}"));
        }
    }
    let Some(now) = app.assets.get(&asset_id) else {
        return;
    };
    let previewable = match probe.kind {
        AssetKind::Video => now.proxy || now.playable_original,
        AssetKind::Audio => now.audio || now.playable_original,
        AssetKind::Image => now.preview_image,
        AssetKind::Subtitle => true,
    };
    app.assets.update(&asset_id, |r| {
        if previewable {
            r.state = AssetState::Ready;
            r.stage = "Ready".into();
            r.progress = 1.0;
            r.error = if warnings.is_empty() { None } else { Some(format!("Some previews could not be generated ({}). Editing and export still work.", warnings.join("; "))) };
        } else {
            r.state = AssetState::Failed;
            r.stage = "Failed".into();
            r.error = Some(format!("A preview could not be created for this media ({}). The file may use an unsupported codec.", warnings.join("; ")));
        }
    });
}

fn register(app: &App, project_id: Option<&str>, info: &AssetInfo) {
    let Some(pid) = project_id else { return };
    let res = app
        .projects
        .mutate(pid, |s| Ok(s.add_asset(info.clone(), now_ms())));
    match res {
        Ok(patch) => app.events.emit(
            "asset_added",
            Some(pid),
            &serde_json::json!({ "patch": patch }),
        ),
        Err(e) => tracing::warn!("could not add asset {} to project {pid}: {e}", info.id),
    }
}

async fn make_poster(app: &App, rec: &AssetRecord, probe: &Probe) -> Result<(), MediaError> {
    let src = app.assets.source_path(rec);
    let out = app.assets.file(&rec.id, "poster.jpg");
    let mut args: Vec<String> = Vec::new();
    if probe.kind == AssetKind::Video {
        // a frame a little way in avoids black leaders
        let t = (probe.duration / 10).min(TICKS_PER_SECOND);
        args.extend(["-ss".into(), ticks_to_seconds_string(t)]);
    }
    args.extend([
        "-i".into(),
        path_arg(&src),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=w='min(480,iw)':h=-2".into(),
        "-q:v".into(),
        "4".into(),
        path_arg(&out),
    ]);
    ffmpeg::run_ffmpeg(&app.tools, &args, |_| {}).await?;
    app.assets.update(&rec.id, |r| r.poster = true);
    Ok(())
}

async fn make_image_preview(app: &App, rec: &AssetRecord) -> Result<(), MediaError> {
    let src = app.assets.source_path(rec);
    let out = app.assets.file(&rec.id, "preview.png");
    let args: Vec<String> = vec![
        "-i".into(),
        path_arg(&src),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease".into(),
        path_arg(&out),
    ];
    ffmpeg::run_ffmpeg(&app.tools, &args, |_| {}).await?;
    app.assets.update(&rec.id, |r| r.preview_image = true);
    Ok(())
}

/// One decode pass producing the preview audio (AAC), the speech upload (FLAC,
/// 16 kHz mono) and the waveform peaks (computed from 8 kHz PCM on stdout).
async fn make_audio(app: &App, rec: &AssetRecord, probe: &Probe) -> Result<(), MediaError> {
    let src = app.assets.source_path(rec);
    let audio = app.assets.file(&rec.id, "audio.m4a");
    let speech = app.assets.file(&rec.id, "speech.flac");
    let args: Vec<String> = [
        "-i",
        &path_arg(&src),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        &path_arg(&audio),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "flac",
        &path_arg(&speech),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        &WAVEFORM_SAMPLE_RATE.to_string(),
        "-f",
        "s16le",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let window = (WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND) as usize;
    let mut peaks: Vec<u16> = Vec::with_capacity(
        (probe.duration / TICKS_PER_SECOND) as usize * WAVEFORM_PEAKS_PER_SECOND as usize + 16,
    );
    let mut carry: Option<u8> = None;
    let (mut in_window, mut peak) = (0usize, 0u16);
    ffmpeg::run_ffmpeg_stdout(&app.tools, &args, |bytes| {
        let mut i = 0;
        if let Some(lo) = carry.take() {
            if !bytes.is_empty() {
                let v = i16::from_le_bytes([lo, bytes[0]]).unsigned_abs().min(32767);
                peak = peak.max(v);
                in_window += 1;
                i = 1;
            } else {
                carry = Some(lo);
            }
        }
        while i + 1 < bytes.len() {
            let v = i16::from_le_bytes([bytes[i], bytes[i + 1]])
                .unsigned_abs()
                .min(32767);
            peak = peak.max(v);
            in_window += 1;
            if in_window == window {
                peaks.push(peak * 2);
                peak = 0;
                in_window = 0;
            }
            i += 2;
        }
        if i < bytes.len() {
            carry = Some(bytes[i]);
        }
        if in_window == window {
            peaks.push(peak * 2);
            peak = 0;
            in_window = 0;
        }
    })
    .await?;
    if in_window > 0 {
        peaks.push(peak * 2);
    }
    let wf = Waveform {
        peaks_per_second: WAVEFORM_PEAKS_PER_SECOND,
        peaks,
    };
    tokio::fs::write(app.assets.file(&rec.id, "waveform.bin"), wf.to_bytes())
        .await
        .map_err(|e| MediaError::Io {
            detail: e.to_string(),
        })?;
    app.assets.update(&rec.id, |r| {
        r.audio = true;
        r.speech = true;
        r.waveform = true;
    });
    Ok(())
}

/// Sprite layout for a filmstrip of a video of the given size and duration.
pub fn plan_thumbs(width: u32, height: u32, duration: Ticks) -> ThumbSprite {
    const TILE_H: u32 = 72;
    const COLS: u32 = 16;
    const MAX_TILES: i64 = 240;
    let aspect = if height > 0 {
        width as f64 / height as f64
    } else {
        16.0 / 9.0
    };
    let tile_w = (((TILE_H as f64 * aspect) / 2.0).round() as u32 * 2).clamp(32, 256);
    let interval = (duration / MAX_TILES).max(TICKS_PER_SECOND / 2);
    let count = ((duration + interval - 1) / interval).clamp(1, MAX_TILES) as u32;
    let cols = COLS.min(count);
    let rows = count.div_ceil(cols);
    ThumbSprite {
        cols,
        rows,
        count,
        tile_w,
        tile_h: TILE_H,
        interval,
    }
}

async fn make_thumbs(app: &App, rec: &AssetRecord, probe: &Probe) -> Result<(), MediaError> {
    let src = app.assets.source_path(rec);
    let out = app.assets.file(&rec.id, "thumbs.jpg");
    let sprite = plan_thumbs(probe.width, probe.height, probe.duration);
    let mut args: Vec<String> = Vec::new();
    // Long files: decode keyframes only — far faster and plenty for a filmstrip.
    if probe.duration > 180 * TICKS_PER_SECOND {
        args.extend(["-skip_frame".into(), "nokey".into()]);
    }
    args.extend([
        "-i".into(),
        path_arg(&src),
        "-an".into(),
        "-vf".into(),
        format!(
            "fps=fps=1/{}:round=near,scale={}:{},tile={}x{}",
            ticks_to_seconds_string(sprite.interval),
            sprite.tile_w,
            sprite.tile_h,
            sprite.cols,
            sprite.rows
        ),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        "5".into(),
        path_arg(&out),
    ]);
    let total_us = (probe.duration as f64 / TICKS_PER_SECOND as f64 * 1e6).max(1.0);
    let assets = app.assets.clone();
    let id = rec.id.clone();
    let mut last = 0.0;
    ffmpeg::run_ffmpeg(&app.tools, &args, move |us| {
        let p = (us as f64 / total_us).clamp(0.0, 1.0);
        if p - last >= 0.1 {
            last = p;
            assets.update_progress(&id, "Building filmstrip", p);
        }
    })
    .await?;
    app.assets.update(&rec.id, |r| r.thumbs = Some(sprite));
    Ok(())
}

async fn make_proxy(app: &App, rec: &AssetRecord, probe: &Probe) -> Result<(), MediaError> {
    let src = app.assets.source_path(rec);
    let out = app.assets.file(&rec.id, "proxy.mp4");
    let tmp = app.assets.file(&rec.id, "proxy.partial.mp4");
    let mut args: Vec<String> = vec!["-i".into(), path_arg(&src), "-map".into(), "0:v:0".into()];
    if probe.has_audio {
        args.extend([
            "-map".into(),
            "0:a:0".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-ac".into(),
            "2".into(),
        ]);
    }
    // Convert to BT.709 and tag the proxy accordingly, so browsers show the same
    // colours the exporter produces (it also normalises everything to BT.709).
    let mut vf = format!("scale=w='min({PROXY_MAX_W},iw)':h='min({PROXY_MAX_H},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv");
    // constant frame rate keeps preview seeking frame accurate; cap at 60 fps
    if let Some(fps) = probe.fps {
        let (n, d) = if fps.as_f64() > 60.0 {
            (60, 1)
        } else {
            (fps.num, fps.den)
        };
        vf.push_str(&format!(",fps={n}/{d}"));
    }
    args.extend([
        "-vf".into(),
        vf,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "24".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-colorspace".into(),
        "bt709".into(),
        "-color_primaries".into(),
        "bt709".into(),
        "-color_trc".into(),
        "bt709".into(),
        "-color_range".into(),
        "tv".into(),
        // short GOPs make scrubbing and cut-to-cut seeks fast
        "-g".into(),
        "15".into(),
        "-keyint_min".into(),
        "15".into(),
        "-sc_threshold".into(),
        "0".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        path_arg(&tmp),
    ]);
    let total_us = (probe.duration as f64 / TICKS_PER_SECOND as f64 * 1e6).max(1.0);
    let assets = app.assets.clone();
    let id = rec.id.clone();
    let mut last = -1.0;
    let res = ffmpeg::run_ffmpeg(&app.tools, &args, move |us| {
        let p = (us as f64 / total_us).clamp(0.0, 1.0);
        if p - last >= 0.02 {
            last = p;
            assets.update_progress(&id, "Preparing preview", p);
        }
    })
    .await;
    if let Err(e) = res {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    tokio::fs::rename(&tmp, &out)
        .await
        .map_err(|e| MediaError::Io {
            detail: e.to_string(),
        })?;
    app.assets.update(&rec.id, |r| r.proxy = true);
    Ok(())
}

/// Generate clearly labelled sample media with FFmpeg's test sources (fixture
/// mode / first-run convenience). Returns the path of the written file.
pub async fn generate_sample(
    app: &App,
    out: &std::path::Path,
    seconds: u32,
) -> Result<(), MediaError> {
    let font = path_arg(&app.fonts.1)
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'");
    // Tone bursts with pauses: gives the waveform, silence detection and transcript
    // panels something realistic to work with.
    let audio = format!("aevalsrc=exprs='0.35*sin(2*PI*(180+40*sin(2*PI*0.7*t))*t)*(0.55+0.45*sin(2*PI*3.1*t))*gt(sin(2*PI*0.2*t+0.6)\\,-0.45)':s=48000:d={seconds}");
    let video = format!(
        "testsrc2=size=1280x720:rate=30:duration={seconds},drawtext=fontfile='{font}':text='SAMPLE MEDIA  %{{pts\\:hms}}':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=64"
    );
    let args: Vec<String> = [
        "-f",
        "lavfi",
        "-i",
        &video,
        "-f",
        "lavfi",
        "-i",
        &audio,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        &path_arg(out),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    ffmpeg::run_ffmpeg(&app.tools, &args, |_| {}).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_plan_is_bounded_and_covers_the_media() {
        let s = plan_thumbs(1920, 1080, 10 * TICKS_PER_SECOND);
        assert_eq!((s.tile_w, s.tile_h), (128, 72));
        assert_eq!(s.interval, TICKS_PER_SECOND / 2);
        assert_eq!(s.count, 20);
        assert_eq!((s.cols, s.rows), (16, 2));
        let long = plan_thumbs(3840, 2160, 3 * 3600 * TICKS_PER_SECOND);
        assert_eq!(long.count, 240);
        assert!(long.interval as i128 * long.count as i128 >= 3 * 3600 * TICKS_PER_SECOND as i128);
        assert_eq!(long.rows, 15);
        let portrait = plan_thumbs(1080, 1920, TICKS_PER_SECOND / 4);
        assert_eq!(portrait.count, 1);
        assert_eq!((portrait.cols, portrait.rows), (1, 1));
        assert_eq!(portrait.tile_w, 40);
    }
}
