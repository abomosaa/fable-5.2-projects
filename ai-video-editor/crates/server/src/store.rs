//! Project persistence.
//!
//! Each project lives in `<data>/projects/<id>/` as `project.json` (the document,
//! written atomically after every committed change — this *is* the autosave) and
//! `history.json` (undo/redo stacks, flushed shortly after changes and on shutdown).
//! Open projects are kept in memory as [`Session`]s.

use crate::fsutil::{now_ms, read_json, write_json_atomic};
use cutline_core::error::{CommandError, ErrorCode};
use cutline_core::history::{History, Session};
use cutline_core::model::{AssetId, ClipContent, Project, SCHEMA_VERSION};
use cutline_core::time::{FrameRate, Ticks};
use cutline_core::validate;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Clone, Debug, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub revision: u64,
    pub duration: Ticks,
    pub clip_count: usize,
    pub asset_count: usize,
    pub width: u32,
    pub height: u32,
    pub fps: FrameRate,
    /// Asset to use as the project card thumbnail.
    pub poster_asset: Option<AssetId>,
    #[serde(skip)]
    pub asset_ids: BTreeSet<AssetId>,
}

/// A project directory that could not be loaded (shown to the user, never deleted
/// automatically).
#[derive(Clone, Debug, Serialize)]
pub struct BrokenProject {
    pub id: String,
    pub error: String,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Project not found")]
    NotFound,
    #[error("The project file is damaged and could not be opened: {0}")]
    Corrupt(String),
    #[error("Could not save the project: {0}. Check free disk space and permissions of the data directory.")]
    Io(String),
    #[error(transparent)]
    Command(#[from] CommandError),
}

struct Entry {
    session: Session,
    history_dirty: bool,
}

pub struct ProjectStore {
    root: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Mutex<Entry>>>>,
    index: RwLock<BTreeMap<String, ProjectMeta>>,
    broken: RwLock<Vec<BrokenProject>>,
}

fn meta_of(p: &Project) -> ProjectMeta {
    let poster_asset = p
        .clips
        .values()
        .filter(|c| {
            matches!(
                c.content,
                ClipContent::Video { .. } | ClipContent::Image { .. }
            )
        })
        .min_by_key(|c| (c.start, c.id.clone()))
        .and_then(|c| c.asset_id().map(str::to_string))
        .or_else(|| {
            p.assets
                .values()
                .find(|a| a.has_video)
                .map(|a| a.id.clone())
        });
    ProjectMeta {
        id: p.id.clone(),
        name: p.name.clone(),
        created_at_ms: p.created_at_ms,
        updated_at_ms: p.updated_at_ms,
        revision: p.revision,
        duration: p.duration(),
        clip_count: p.clips.len(),
        asset_count: p.assets.len(),
        width: p.settings.width,
        height: p.settings.height,
        fps: p.settings.fps,
        poster_asset,
        asset_ids: p.assets.keys().cloned().collect(),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl ProjectStore {
    pub fn open(root: PathBuf) -> std::io::Result<ProjectStore> {
        std::fs::create_dir_all(&root)?;
        let store = ProjectStore {
            root,
            sessions: Mutex::new(HashMap::new()),
            index: RwLock::new(BTreeMap::new()),
            broken: RwLock::new(Vec::new()),
        };
        for entry in std::fs::read_dir(&store.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            match store.read_project(&id) {
                Ok(p) => {
                    store.index.write().unwrap().insert(id, meta_of(&p));
                }
                Err(e) => {
                    tracing::warn!("project {id} could not be loaded: {e}");
                    store.broken.write().unwrap().push(BrokenProject {
                        id,
                        error: e.to_string(),
                    });
                }
            }
        }
        Ok(store)
    }

    fn dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    fn read_project(&self, id: &str) -> Result<Project, StoreError> {
        let path = self.dir(id).join("project.json");
        if !path.exists() {
            return Err(StoreError::Corrupt("project.json is missing".into()));
        }
        let mut p: Project = read_json(&path).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        if p.schema_version > SCHEMA_VERSION {
            return Err(StoreError::Corrupt(format!(
                "it was saved by a newer version (schema {})",
                p.schema_version
            )));
        }
        if p.id != id {
            p.id = id.to_string();
        }
        validate::validate(&p).map_err(StoreError::Corrupt)?;
        Ok(p)
    }

    fn save_project(&self, p: &Project) -> Result<(), StoreError> {
        write_json_atomic(&self.dir(&p.id).join("project.json"), p)
            .map_err(|e| StoreError::Io(e.to_string()))?;
        self.index.write().unwrap().insert(p.id.clone(), meta_of(p));
        Ok(())
    }

    fn entry(&self, id: &str) -> Result<Arc<Mutex<Entry>>, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::NotFound);
        }
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(e) = sessions.get(id) {
            return Ok(e.clone());
        }
        if !self.index.read().unwrap().contains_key(id) {
            return Err(StoreError::NotFound);
        }
        let project = self.read_project(id)?;
        // A damaged or outdated history must never block opening the project.
        let history = match read_json::<History>(&self.dir(id).join("history.json")) {
            Ok(h) => h,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("history of project {id} is unreadable and was reset: {e}");
                }
                History::default()
            }
        };
        let entry = Arc::new(Mutex::new(Entry {
            session: Session::new(project, history),
            history_dirty: false,
        }));
        sessions.insert(id.to_string(), entry.clone());
        Ok(entry)
    }

    pub fn list(&self) -> Vec<ProjectMeta> {
        let mut v: Vec<ProjectMeta> = self.index.read().unwrap().values().cloned().collect();
        v.sort_by_key(|m| std::cmp::Reverse(m.updated_at_ms));
        v
    }

    pub fn broken(&self) -> Vec<BrokenProject> {
        self.broken.read().unwrap().clone()
    }

    pub fn exists(&self, id: &str) -> bool {
        self.index.read().unwrap().contains_key(id)
    }

    pub fn meta(&self, id: &str) -> Option<ProjectMeta> {
        self.index.read().unwrap().get(id).cloned()
    }

    pub fn create(&self, name: &str) -> Result<ProjectMeta, StoreError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 || name.chars().any(|c| c.is_control()) {
            return Err(
                CommandError::invalid("name", "Project name must be 1–120 characters").into(),
            );
        }
        let id = format!("p{}", uuid::Uuid::new_v4().simple());
        let project = Project::new(id.clone(), name, now_ms());
        std::fs::create_dir_all(self.dir(&id)).map_err(|e| StoreError::Io(e.to_string()))?;
        self.save_project(&project)?;
        Ok(meta_of(&project))
    }

    /// Read-only access to a session.
    pub fn read<R>(&self, id: &str, f: impl FnOnce(&Session) -> R) -> Result<R, StoreError> {
        let entry = self.entry(id)?;
        let guard = entry.lock().unwrap();
        Ok(f(&guard.session))
    }

    /// Run a mutation. On success the document is saved before the result is
    /// returned (autosave); a rejected command changes nothing.
    pub fn mutate<R>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Session) -> Result<R, CommandError>,
    ) -> Result<R, StoreError> {
        let entry = self.entry(id)?;
        let mut guard = entry.lock().unwrap();
        let result = f(&mut guard.session)?;
        guard.history_dirty = true;
        // If the write fails the in-memory session stays ahead of the disk; the error
        // is surfaced to the client (which re-syncs) and the next successful save
        // persists everything.
        self.save_project(&guard.session.project)?;
        Ok(result)
    }

    pub fn duplicate(&self, id: &str) -> Result<ProjectMeta, StoreError> {
        let mut project = self.read(id, |s| s.project.clone())?;
        let existing: BTreeSet<String> = self
            .index
            .read()
            .unwrap()
            .values()
            .map(|m| m.name.clone())
            .collect();
        let base = format!("{} copy", project.name);
        let mut name = base.clone();
        let mut n = 2;
        while existing.contains(&name) {
            name = format!("{base} {n}");
            n += 1;
        }
        let new_id = format!("p{}", uuid::Uuid::new_v4().simple());
        project.id = new_id.clone();
        project.name = name.chars().take(120).collect();
        project.created_at_ms = now_ms();
        project.updated_at_ms = project.created_at_ms;
        std::fs::create_dir_all(self.dir(&new_id)).map_err(|e| StoreError::Io(e.to_string()))?;
        self.save_project(&project)?;
        Ok(meta_of(&project))
    }

    /// Delete a project. Returns the assets no other project references any more
    /// (the caller removes their files and remote resources).
    pub fn delete(&self, id: &str) -> Result<Vec<AssetId>, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::NotFound);
        }
        let was_broken = {
            let mut broken = self.broken.write().unwrap();
            let before = broken.len();
            broken.retain(|b| b.id != id);
            broken.len() != before
        };
        let meta = self.index.write().unwrap().remove(id);
        if meta.is_none() && !was_broken {
            return Err(StoreError::NotFound);
        }
        self.sessions.lock().unwrap().remove(id);
        let dir = self.dir(id);
        if dir.starts_with(&self.root) && dir != self.root {
            std::fs::remove_dir_all(&dir).map_err(|e| StoreError::Io(e.to_string()))?;
        }
        let still_used = self.referenced_assets();
        Ok(meta
            .map(|m| {
                m.asset_ids
                    .into_iter()
                    .filter(|a| !still_used.contains(a))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Every asset referenced by at least one project.
    pub fn referenced_assets(&self) -> BTreeSet<AssetId> {
        self.index
            .read()
            .unwrap()
            .values()
            .flat_map(|m| m.asset_ids.iter().cloned())
            .collect()
    }

    /// Projects whose media bin contains the asset.
    pub fn projects_using(&self, asset_id: &str) -> Vec<String> {
        self.index
            .read()
            .unwrap()
            .values()
            .filter(|m| m.asset_ids.contains(asset_id))
            .map(|m| m.id.clone())
            .collect()
    }

    /// Write out undo histories that changed since the last flush.
    pub fn flush_histories(&self) {
        let entries: Vec<(String, Arc<Mutex<Entry>>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (id, entry) in entries {
            let history = {
                let mut guard = entry.lock().unwrap();
                if !guard.history_dirty {
                    continue;
                }
                guard.history_dirty = false;
                guard.session.history.clone()
            };
            if !self.exists(&id) {
                continue;
            }
            if let Err(e) = write_json_atomic(&self.dir(&id).join("history.json"), &history) {
                tracing::error!("could not save history of project {id}: {e}");
            }
        }
    }
}

impl StoreError {
    pub fn code(&self) -> ErrorCode {
        match self {
            StoreError::Command(c) => c.code,
            StoreError::NotFound => ErrorCode::NotFound,
            _ => ErrorCode::InvariantViolation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cutline_core::commands::Command;
    use cutline_core::model::{AssetInfo, AssetKind, TrackKind};
    use cutline_core::time::TICKS_PER_SECOND;
    use cutline_core::transcript::Env;

    fn asset(id: &str) -> AssetInfo {
        AssetInfo {
            id: id.into(),
            name: format!("{id}.mp4"),
            kind: AssetKind::Video,
            duration: 10 * TICKS_PER_SECOND,
            has_video: true,
            has_audio: true,
            width: 1280,
            height: 720,
            fps: Some(FrameRate::FPS_30),
            sample_rate: Some(48000),
            channels: Some(2),
        }
    }

    fn add_clip(store: &ProjectStore, id: &str) {
        store
            .mutate(id, |s| {
                let rev = s.project.revision;
                s.execute(
                    rev,
                    &Command::AddAssetClips {
                        asset_id: "a1".into(),
                        start: None,
                        track_id: None,
                        source_in: None,
                        source_out: None,
                        mode: Default::default(),
                    },
                    &Env::default(),
                    now_ms(),
                )
            })
            .unwrap();
    }

    #[test]
    fn projects_and_history_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
            let meta = store.create("Launch film").unwrap();
            store
                .mutate(&meta.id, |s| Ok(s.add_asset(asset("a1"), now_ms())))
                .unwrap();
            add_clip(&store, &meta.id);
            store
                .mutate(&meta.id, |s| {
                    let rev = s.project.revision;
                    s.execute(
                        rev,
                        &Command::AddTrack {
                            kind: TrackKind::Video,
                            name: None,
                        },
                        &Env::default(),
                        now_ms(),
                    )
                })
                .unwrap();
            store.flush_histories();
            meta.id
        };
        // "restart"
        let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Launch film");
        assert_eq!(listed[0].clip_count, 2);
        let (rev, tracks, can_undo) = store
            .read(&id, |s| {
                (
                    s.project.revision,
                    s.project.tracks.len(),
                    s.history_state().can_undo,
                )
            })
            .unwrap();
        assert_eq!(rev, 2);
        assert_eq!(tracks, 5);
        assert!(can_undo, "undo history must be restored after restart");
        // undo both edits after the restart
        for _ in 0..2 {
            store
                .mutate(&id, |s| {
                    let rev = s.project.revision;
                    s.undo(rev, now_ms())
                })
                .unwrap();
        }
        let (clips, tracks) = store
            .read(&id, |s| (s.project.clips.len(), s.project.tracks.len()))
            .unwrap();
        assert_eq!((clips, tracks), (0, 4));
    }

    #[test]
    fn stale_revisions_are_rejected_and_nothing_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
        let meta = store.create("P").unwrap();
        let err = store
            .mutate(&meta.id, |s| {
                s.execute(
                    41,
                    &Command::AddTrack {
                        kind: TrackKind::Audio,
                        name: None,
                    },
                    &Env::default(),
                    now_ms(),
                )
            })
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::StaleRevision);
        assert_eq!(store.read(&meta.id, |s| s.project.tracks.len()).unwrap(), 4);
        let on_disk: Project = read_json(&dir.path().join(&meta.id).join("project.json")).unwrap();
        assert_eq!(on_disk.revision, 0);
    }

    #[test]
    fn duplicate_and_delete_track_asset_references() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
        let a = store.create("Original").unwrap();
        store
            .mutate(&a.id, |s| Ok(s.add_asset(asset("a1"), now_ms())))
            .unwrap();
        add_clip(&store, &a.id);
        let b = store.duplicate(&a.id).unwrap();
        assert_eq!(b.name, "Original copy");
        assert_eq!(store.duplicate(&a.id).unwrap().name, "Original copy 2");
        assert_eq!(b.clip_count, 2);
        assert_ne!(a.id, b.id);
        // the copy starts with an empty undo history
        assert!(!store.read(&b.id, |s| s.history_state().can_undo).unwrap());
        // deleting the original keeps the shared asset alive…
        assert!(store.delete(&a.id).unwrap().is_empty());
        assert!(!dir.path().join(&a.id).exists());
        assert!(matches!(
            store.read(&a.id, |_| ()),
            Err(StoreError::NotFound)
        ));
        // …until the last project referencing it is gone
        let copies: Vec<String> = store.list().into_iter().map(|m| m.id).collect();
        let mut orphaned = Vec::new();
        for id in copies {
            orphaned = store.delete(&id).unwrap();
        }
        assert_eq!(orphaned, vec!["a1".to_string()]);
    }

    #[test]
    fn corrupt_projects_are_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("pbroken")).unwrap();
        std::fs::write(dir.path().join("pbroken/project.json"), b"{ truncated").unwrap();
        let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
        assert!(store.list().is_empty());
        assert_eq!(store.broken().len(), 1);
        assert_eq!(store.broken()[0].id, "pbroken");
        // a broken project can still be deleted by the user
        store.delete("pbroken").unwrap();
        assert!(store.broken().is_empty());
        // path traversal ids are rejected
        assert!(matches!(store.delete("../x"), Err(StoreError::NotFound)));
    }

    #[test]
    fn damaged_history_does_not_block_opening() {
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
            store.create("P").unwrap().id
        };
        std::fs::write(dir.path().join(&id).join("history.json"), b"garbage").unwrap();
        let store = ProjectStore::open(dir.path().to_path_buf()).unwrap();
        assert!(!store.read(&id, |s| s.history_state().can_undo).unwrap());
    }
}
