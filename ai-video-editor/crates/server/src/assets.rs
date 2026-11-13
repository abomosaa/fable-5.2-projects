//! Asset store: imported media files and everything derived from them
//! (probe data, preview proxies, thumbnails, waveforms, transcripts).
//!
//! Layout: `<data>/assets/<asset_id>/{record.json, source.<ext>, proxy.mp4, audio.m4a,
//! speech.flac, thumbs.jpg, poster.jpg, preview.png, waveform.bin, transcript.json, cues.json}`

use crate::events::EventBus;
use crate::ffmpeg::Probe;
use crate::fsutil::{now_ms, read_json, write_json_atomic};
use crate::transcription::TranscriptionStore;
use cutline_core::analysis::Waveform;
use cutline_core::model::{AssetId, AssetInfo};
use cutline_core::soniox::TranscriptionStatus;
use cutline_core::time::Ticks;
use cutline_core::transcript::{SubtitleCue, Transcript};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetState {
    /// Bytes are still arriving from the browser.
    Uploading,
    /// ffprobe is inspecting the file.
    Probing,
    /// Usable on the timeline; previews (proxy, thumbnails, waveform) are being built.
    Processing,
    Ready,
    Failed,
}

/// Thumbnail sprite sheet: `count` tiles of `tile_w × tile_h`, `cols` per row;
/// tile `i` shows source time `i × interval`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThumbSprite {
    pub cols: u32,
    pub rows: u32,
    pub count: u32,
    pub tile_w: u32,
    pub tile_h: u32,
    pub interval: Ticks,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssetRecord {
    pub id: AssetId,
    pub name: String,
    pub ext: String,
    pub size_bytes: u64,
    pub created_at_ms: i64,
    pub state: AssetState,
    /// Actionable message when `state == failed` (or a non-fatal processing warning).
    #[serde(default)]
    pub error: Option<String>,
    /// 0..1 progress of the current stage.
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub info: Option<AssetInfo>,
    #[serde(default)]
    pub probe: Option<Probe>,
    /// The browser can play the original directly while the proxy is being built.
    #[serde(default)]
    pub playable_original: bool,
    #[serde(default)]
    pub proxy: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub speech: bool,
    #[serde(default)]
    pub poster: bool,
    #[serde(default)]
    pub preview_image: bool,
    #[serde(default)]
    pub waveform: bool,
    #[serde(default)]
    pub thumbs: Option<ThumbSprite>,
    #[serde(default)]
    pub transcription: Option<TranscriptionStatus>,
    #[serde(default)]
    pub has_transcript: bool,
    #[serde(default)]
    pub cue_count: Option<u32>,
    /// Generated sample media (fixture mode), not a user file.
    #[serde(default)]
    pub fixture: bool,
    /// Projects that own this asset. The files are deleted when the last owner is
    /// deleted (not when the asset is merely removed from a bin, so undo keeps working).
    #[serde(default)]
    pub projects: Vec<String>,
}

pub struct AssetStore {
    root: PathBuf,
    records: RwLock<HashMap<AssetId, AssetRecord>>,
    transcripts: RwLock<HashMap<AssetId, Arc<Transcript>>>,
    waveforms: RwLock<HashMap<AssetId, Arc<Waveform>>>,
    subtitles: RwLock<HashMap<AssetId, Arc<Vec<SubtitleCue>>>>,
    events: EventBus,
}

impl AssetStore {
    pub fn open(root: PathBuf, events: EventBus) -> std::io::Result<Arc<AssetStore>> {
        std::fs::create_dir_all(&root)?;
        let mut records = HashMap::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            match read_json::<AssetRecord>(&entry.path().join("record.json")) {
                Ok(rec) => {
                    records.insert(rec.id.clone(), rec);
                }
                Err(e) => {
                    tracing::warn!("skipping unreadable asset {}: {e}", entry.path().display())
                }
            }
        }
        Ok(Arc::new(AssetStore {
            root,
            records: RwLock::new(records),
            transcripts: RwLock::new(HashMap::new()),
            waveforms: RwLock::new(HashMap::new()),
            subtitles: RwLock::new(HashMap::new()),
            events,
        }))
    }

    pub fn dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    pub fn file(&self, id: &str, name: &str) -> PathBuf {
        self.root.join(id).join(name)
    }

    pub fn source_path(&self, rec: &AssetRecord) -> PathBuf {
        self.file(&rec.id, &format!("source.{}", rec.ext))
    }

    pub fn get(&self, id: &str) -> Option<AssetRecord> {
        self.records.read().unwrap().get(id).cloned()
    }

    pub fn list<'a, I: IntoIterator<Item = &'a String>>(&self, ids: I) -> Vec<AssetRecord> {
        let recs = self.records.read().unwrap();
        ids.into_iter()
            .filter_map(|id| recs.get(id).cloned())
            .collect()
    }

    pub fn all(&self) -> Vec<AssetRecord> {
        self.records.read().unwrap().values().cloned().collect()
    }

    /// Records owned by a project, oldest first.
    pub fn owned_by(&self, project_id: &str) -> Vec<AssetRecord> {
        let mut v: Vec<AssetRecord> = self
            .records
            .read()
            .unwrap()
            .values()
            .filter(|r| r.projects.iter().any(|p| p == project_id))
            .cloned()
            .collect();
        v.sort_by_key(|r| (r.created_at_ms, r.id.clone()));
        v
    }

    /// Register a new asset (state `uploading`) and create its directory.
    pub fn create(
        &self,
        name: &str,
        ext: &str,
        fixture: bool,
        project_id: Option<&str>,
    ) -> std::io::Result<AssetRecord> {
        let id = format!("a{}", uuid::Uuid::new_v4().simple());
        std::fs::create_dir_all(self.dir(&id))?;
        let rec = AssetRecord {
            id: id.clone(),
            name: name.to_string(),
            ext: ext.to_string(),
            size_bytes: 0,
            created_at_ms: now_ms(),
            state: AssetState::Uploading,
            error: None,
            progress: 0.0,
            stage: "Uploading".into(),
            info: None,
            probe: None,
            playable_original: false,
            proxy: false,
            audio: false,
            speech: false,
            poster: false,
            preview_image: false,
            waveform: false,
            thumbs: None,
            transcription: None,
            has_transcript: false,
            cue_count: None,
            fixture,
            projects: project_id.map(|p| vec![p.to_string()]).unwrap_or_default(),
        };
        self.records.write().unwrap().insert(id, rec.clone());
        self.persist(&rec);
        Ok(rec)
    }

    fn persist(&self, rec: &AssetRecord) {
        if let Err(e) = write_json_atomic(&self.file(&rec.id, "record.json"), rec) {
            tracing::error!("could not persist asset record {}: {e}", rec.id);
        }
    }

    /// Mutate a record, persist it and notify listeners.
    pub fn update<F: FnOnce(&mut AssetRecord)>(&self, id: &str, f: F) -> Option<AssetRecord> {
        let rec = {
            let mut recs = self.records.write().unwrap();
            let rec = recs.get_mut(id)?;
            f(rec);
            rec.clone()
        };
        self.persist(&rec);
        self.events.emit("asset", None, &rec);
        Some(rec)
    }

    /// Progress-only update: notifies listeners but skips the disk write.
    pub fn update_progress(&self, id: &str, stage: &str, progress: f64) {
        let rec = {
            let mut recs = self.records.write().unwrap();
            let Some(rec) = recs.get_mut(id) else { return };
            rec.stage = stage.to_string();
            rec.progress = progress.clamp(0.0, 1.0);
            rec.clone()
        };
        self.events.emit("asset", None, &rec);
    }

    pub fn remove(&self, id: &str) {
        self.records.write().unwrap().remove(id);
        self.transcripts.write().unwrap().remove(id);
        self.waveforms.write().unwrap().remove(id);
        self.subtitles.write().unwrap().remove(id);
        let dir = self.dir(id);
        if dir.starts_with(&self.root) && dir != self.root {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    pub fn transcript(&self, id: &str) -> Option<Arc<Transcript>> {
        if let Some(t) = self.transcripts.read().unwrap().get(id) {
            return Some(t.clone());
        }
        if !self.get(id)?.has_transcript {
            return None;
        }
        let t: Transcript = read_json(&self.file(id, "transcript.json")).ok()?;
        let t = Arc::new(t);
        self.transcripts
            .write()
            .unwrap()
            .insert(id.to_string(), t.clone());
        Some(t)
    }

    pub fn waveform(&self, id: &str) -> Option<Arc<Waveform>> {
        if let Some(w) = self.waveforms.read().unwrap().get(id) {
            return Some(w.clone());
        }
        if !self.get(id)?.waveform {
            return None;
        }
        let bytes = std::fs::read(self.file(id, "waveform.bin")).ok()?;
        let w = Arc::new(Waveform::from_bytes(&bytes)?);
        self.waveforms
            .write()
            .unwrap()
            .insert(id.to_string(), w.clone());
        Some(w)
    }

    pub fn subtitle_cues(&self, id: &str) -> Option<Arc<Vec<SubtitleCue>>> {
        if let Some(c) = self.subtitles.read().unwrap().get(id) {
            return Some(c.clone());
        }
        let cues: Vec<SubtitleCue> = read_json(&self.file(id, "cues.json")).ok()?;
        let cues = Arc::new(cues);
        self.subtitles
            .write()
            .unwrap()
            .insert(id.to_string(), cues.clone());
        Some(cues)
    }

    pub fn save_subtitle_cues(&self, id: &str, cues: Vec<SubtitleCue>) -> std::io::Result<()> {
        write_json_atomic(&self.file(id, "cues.json"), &cues)?;
        self.subtitles
            .write()
            .unwrap()
            .insert(id.to_string(), Arc::new(cues));
        Ok(())
    }

    /// Which derived file a media URL may serve (whitelist; prevents path traversal).
    pub fn servable(&self, id: &str, name: &str) -> Option<PathBuf> {
        let rec = self.get(id)?;
        let file = match name {
            "proxy.mp4" | "audio.m4a" | "thumbs.jpg" | "poster.jpg" | "preview.png"
            | "waveform.bin" => self.file(id, name),
            "original" => self.source_path(&rec),
            _ => return None,
        };
        file.exists().then_some(file)
    }
}

impl TranscriptionStore for AssetStore {
    fn audio_for_upload(&self, asset_id: &str) -> Result<(PathBuf, i64), String> {
        let rec = self
            .get(asset_id)
            .ok_or_else(|| "The media no longer exists.".to_string())?;
        let info = rec.info.as_ref().ok_or_else(|| {
            "The media is still being analysed. Try again in a moment.".to_string()
        })?;
        if !info.has_audio {
            return Err("This media has no audio track to transcribe.".into());
        }
        let path = self.file(asset_id, "speech.flac");
        if !rec.speech || !path.exists() {
            return Err(
                "The audio is still being prepared for transcription. Try again in a moment."
                    .into(),
            );
        }
        Ok((path, cutline_core::time::SourceTime(info.duration).as_ms()))
    }

    fn load_status(&self, asset_id: &str) -> Option<TranscriptionStatus> {
        self.get(asset_id).and_then(|r| r.transcription)
    }

    fn save_status(&self, asset_id: &str, status: &TranscriptionStatus) {
        self.update(asset_id, |r| r.transcription = Some(status.clone()));
    }

    fn save_transcript(&self, asset_id: &str, transcript: &Transcript) -> Result<(), String> {
        write_json_atomic(&self.file(asset_id, "transcript.json"), transcript)
            .map_err(|e| format!("Could not store the transcript: {e}"))?;
        self.transcripts
            .write()
            .unwrap()
            .insert(asset_id.to_string(), Arc::new(transcript.clone()));
        self.update(asset_id, |r| r.has_transcript = true);
        Ok(())
    }

    fn all_statuses(&self) -> Vec<(String, TranscriptionStatus)> {
        self.records
            .read()
            .unwrap()
            .values()
            .filter_map(|r| r.transcription.clone().map(|s| (r.id.clone(), s)))
            .collect()
    }
}

/// Keep a client-supplied file name presentable and harmless.
pub fn sanitize_name(raw: &str) -> (String, String) {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    let name = if name.trim().is_empty() {
        "untitled".to_string()
    } else {
        name.trim().to_string()
    };
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".to_string());
    (name, ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitised() {
        assert_eq!(
            sanitize_name("../../etc/passwd"),
            ("passwd".into(), "bin".into())
        );
        assert_eq!(
            sanitize_name("C:\\clips\\My Clip.MP4"),
            ("My Clip.MP4".into(), "mp4".into())
        );
        assert_eq!(sanitize_name("weird.ext!!").1, "bin");
        assert_eq!(sanitize_name("").0, "untitled");
    }

    #[test]
    fn only_whitelisted_files_are_servable() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::open(dir.path().to_path_buf(), EventBus::new()).unwrap();
        let rec = store.create("clip.mp4", "mp4", false, Some("p1")).unwrap();
        std::fs::write(store.source_path(&rec), b"x").unwrap();
        std::fs::write(store.file(&rec.id, "poster.jpg"), b"x").unwrap();
        assert!(store.servable(&rec.id, "original").is_some());
        assert!(store.servable(&rec.id, "poster.jpg").is_some());
        assert!(store.servable(&rec.id, "record.json").is_none());
        assert!(store.servable(&rec.id, "../x").is_none());
        assert!(store.servable("nope", "original").is_none());
        // records survive a restart
        let store2 = AssetStore::open(dir.path().to_path_buf(), EventBus::new()).unwrap();
        assert_eq!(store2.get(&rec.id).unwrap().name, "clip.mp4");
        store2.remove(&rec.id);
        assert!(!dir.path().join(&rec.id).exists());
    }
}
