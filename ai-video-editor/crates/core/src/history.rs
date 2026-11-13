//! Transactional undo/redo and the editing session.
//!
//! Every committed command is recorded as a pair of [`DocPatch`]es (forward and
//! backward) computed by diffing the document before and after. Undo applies the
//! backward patch, redo the forward patch; both are validated like any other edit
//! and bump the revision, so clients can never act on a stale document.

use crate::commands::{self, Applied, Command};
use crate::error::{CmdResult, CommandError, ErrorCode};
use crate::model::*;
use crate::resolve::{resolve_layers, Layer};
use crate::time::Ticks;
use crate::transcript::Env;
use crate::validate;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A minimal description of how one document differs from another.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DocPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ProjectSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets_upsert: Vec<AssetInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets_remove: Vec<AssetId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clips_upsert: Vec<Clip>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clips_remove: Vec<ClipId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transitions: Option<BTreeMap<TransitionId, Transition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markers: Option<Vec<Marker>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<TranscriptState>,
}

impl DocPatch {
    /// The patch that turns `from` into `to` (ignoring revision, timestamps and the
    /// id counter, which are managed by the session).
    pub fn diff(from: &Project, to: &Project) -> DocPatch {
        let mut d = DocPatch::default();
        if from.name != to.name {
            d.name = Some(to.name.clone());
        }
        if from.settings != to.settings {
            d.settings = Some(to.settings.clone());
        }
        if from.tracks != to.tracks {
            d.tracks = Some(to.tracks.clone());
        }
        for (id, a) in &to.assets {
            if from.assets.get(id) != Some(a) {
                d.assets_upsert.push(a.clone());
            }
        }
        for id in from.assets.keys() {
            if !to.assets.contains_key(id) {
                d.assets_remove.push(id.clone());
            }
        }
        for (id, c) in &to.clips {
            if from.clips.get(id) != Some(c) {
                d.clips_upsert.push(c.clone());
            }
        }
        for id in from.clips.keys() {
            if !to.clips.contains_key(id) {
                d.clips_remove.push(id.clone());
            }
        }
        if from.transitions != to.transitions {
            d.transitions = Some(to.transitions.clone());
        }
        if from.markers != to.markers {
            d.markers = Some(to.markers.clone());
        }
        if from.transcript != to.transcript {
            d.transcript = Some(to.transcript.clone());
        }
        d
    }

    pub fn apply(&self, p: &mut Project) {
        if let Some(n) = &self.name {
            p.name = n.clone();
        }
        if let Some(s) = &self.settings {
            p.settings = s.clone();
        }
        if let Some(t) = &self.tracks {
            p.tracks = t.clone();
        }
        for id in &self.assets_remove {
            p.assets.remove(id);
        }
        for a in &self.assets_upsert {
            p.assets.insert(a.id.clone(), a.clone());
        }
        for id in &self.clips_remove {
            p.clips.remove(id);
        }
        for c in &self.clips_upsert {
            p.clips.insert(c.id.clone(), c.clone());
        }
        if let Some(t) = &self.transitions {
            p.transitions = t.clone();
        }
        if let Some(m) = &self.markers {
            p.markers = m.clone();
        }
        if let Some(t) = &self.transcript {
            p.transcript = t.clone();
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == DocPatch::default()
    }

    /// Rough in-memory weight, used to bound the history.
    pub fn weight(&self) -> usize {
        256 * (self.clips_upsert.len() + self.assets_upsert.len())
            + 24 * (self.clips_remove.len() + self.assets_remove.len())
            + self.transitions.as_ref().map_or(0, |t| 128 * t.len())
            + self.markers.as_ref().map_or(0, |m| 96 * m.len())
            + self.transcript.as_ref().map_or(0, |t| {
                200 * t.removals.len()
                    + 48 * t.corrections.values().map(|m| m.len()).sum::<usize>()
                    + 64
            })
            + self.tracks.as_ref().map_or(0, |t| 96 * t.len())
            + 128
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub label: String,
    pub forward: DocPatch,
    pub backward: DocPatch,
    pub at_ms: i64,
}

/// Undo / redo stacks (persisted next to the project so they survive restarts).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
}

pub const HISTORY_MAX_ENTRIES: usize = 300;
pub const HISTORY_MAX_WEIGHT: usize = 48 * 1024 * 1024;

impl History {
    fn push(&mut self, e: HistoryEntry) {
        self.redo.clear();
        self.undo.push(e);
        let mut weight: usize = self
            .undo
            .iter()
            .map(|e| e.forward.weight() + e.backward.weight())
            .sum();
        while self.undo.len() > HISTORY_MAX_ENTRIES
            || (weight > HISTORY_MAX_WEIGHT && self.undo.len() > 1)
        {
            let old = self.undo.remove(0);
            weight = weight.saturating_sub(old.forward.weight() + old.backward.weight());
        }
    }
}

/// What the client needs to know about the history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct HistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redo_label: Option<String>,
    pub undo_depth: usize,
    pub redo_depth: usize,
}

/// The change produced by a committed command / undo / redo, in the shape sent to
/// clients: the document patch plus the re-resolved layers that changed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub revision: u64,
    pub label: String,
    pub patch: DocPatch,
    /// Layers whose resolved behaviour changed (layers of removed clips are implied
    /// by `patch.clips_remove`).
    pub layers_upsert: Vec<Layer>,
    /// Output duration after the change.
    pub duration: Ticks,
    pub history: HistoryState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub created: Vec<ClipId>,
}

/// A project document together with its undo history and resolved layers.
#[derive(Clone, Debug)]
pub struct Session {
    pub project: Project,
    pub history: History,
    layers: BTreeMap<ClipId, Layer>,
}

impl Session {
    pub fn new(project: Project, history: History) -> Session {
        let layers = resolve_layers(&project)
            .into_iter()
            .map(|l| (l.clip_id.clone(), l))
            .collect();
        Session {
            project,
            history,
            layers,
        }
    }

    /// Resolved layers in paint order.
    pub fn layers(&self) -> Vec<Layer> {
        let mut v: Vec<Layer> = self.layers.values().cloned().collect();
        v.sort_by(crate::resolve::paint_order);
        v
    }

    pub fn history_state(&self) -> HistoryState {
        HistoryState {
            can_undo: !self.history.undo.is_empty(),
            can_redo: !self.history.redo.is_empty(),
            undo_label: self.history.undo.last().map(|e| e.label.clone()),
            redo_label: self.history.redo.last().map(|e| e.label.clone()),
            undo_depth: self.history.undo.len(),
            redo_depth: self.history.redo.len(),
        }
    }

    fn check_revision(&self, base_revision: u64) -> CmdResult<()> {
        if base_revision != self.project.revision {
            return Err(CommandError::new(
                ErrorCode::StaleRevision,
                format!(
                    "The project changed since revision {base_revision} (now at {}). The edit was not applied; the latest version has been loaded.",
                    self.project.revision
                ),
            ));
        }
        Ok(())
    }

    fn commit(
        &mut self,
        new: Project,
        label: String,
        notices: Vec<String>,
        created: Vec<ClipId>,
        patch: DocPatch,
    ) -> Change {
        let new_layers: BTreeMap<ClipId, Layer> = resolve_layers(&new)
            .into_iter()
            .map(|l| (l.clip_id.clone(), l))
            .collect();
        let layers_upsert: Vec<Layer> = new_layers
            .iter()
            .filter(|(id, l)| self.layers.get(*id) != Some(*l))
            .map(|(_, l)| l.clone())
            .collect();
        self.layers = new_layers;
        self.project = new;
        Change {
            revision: self.project.revision,
            label,
            patch,
            layers_upsert,
            duration: self.project.duration(),
            history: self.history_state(),
            notices,
            created,
        }
    }

    /// Validate and apply a command atomically. `base_revision` must equal the
    /// current revision, otherwise the command is rejected as stale.
    pub fn execute(
        &mut self,
        base_revision: u64,
        cmd: &Command,
        env: &Env,
        now_ms: i64,
    ) -> CmdResult<Change> {
        self.check_revision(base_revision)?;
        let Applied {
            mut project,
            label,
            notices,
            created,
        } = commands::apply(&self.project, cmd, env)?;
        project.updated_at_ms = now_ms;
        let forward = DocPatch::diff(&self.project, &project);
        if forward.is_empty() {
            return Err(CommandError::new(ErrorCode::NothingToDo, "Nothing changed"));
        }
        let backward = DocPatch::diff(&project, &self.project);
        self.history.push(HistoryEntry {
            label: label.clone(),
            forward: forward.clone(),
            backward,
            at_ms: now_ms,
        });
        Ok(self.commit(project, label, notices, created, forward))
    }

    fn step(&mut self, base_revision: u64, undo: bool, now_ms: i64) -> CmdResult<Change> {
        self.check_revision(base_revision)?;
        let entry = if undo {
            self.history.undo.last()
        } else {
            self.history.redo.last()
        }
        .cloned()
        .ok_or_else(|| {
            CommandError::new(
                ErrorCode::NothingToDo,
                if undo {
                    "Nothing to undo"
                } else {
                    "Nothing to redo"
                },
            )
        })?;
        let patch = if undo {
            entry.backward.clone()
        } else {
            entry.forward.clone()
        };
        let mut project = self.project.clone();
        patch.apply(&mut project);
        project.revision = self.project.revision + 1;
        project.updated_at_ms = now_ms;
        validate::validate(&project).map_err(CommandError::invariant)?;
        if undo {
            self.history.undo.pop();
            self.history.redo.push(entry.clone());
        } else {
            self.history.redo.pop();
            self.history.undo.push(entry.clone());
        }
        // The effective patch relative to the current document (it can differ from the
        // recorded one for system-managed state such as newly imported assets).
        let effective = DocPatch::diff(&self.project, &project);
        let label = format!(
            "{} {}",
            if undo { "Undo" } else { "Redo" },
            lower_first(&entry.label)
        );
        Ok(self.commit(project, label, Vec::new(), Vec::new(), effective))
    }

    pub fn undo(&mut self, base_revision: u64, now_ms: i64) -> CmdResult<Change> {
        self.step(base_revision, true, now_ms)
    }

    pub fn redo(&mut self, base_revision: u64, now_ms: i64) -> CmdResult<Change> {
        self.step(base_revision, false, now_ms)
    }

    /// System mutation: add a probed asset to the bin. Not undoable and does not
    /// bump the revision (it commutes with every edit).
    pub fn add_asset(&mut self, info: AssetInfo, now_ms: i64) -> DocPatch {
        let patch = DocPatch {
            assets_upsert: vec![info.clone()],
            ..Default::default()
        };
        commands::add_asset(&mut self.project, info);
        self.project.updated_at_ms = now_ms;
        patch
    }

    /// System mutation: rename the project (not part of the undo history).
    pub fn rename(&mut self, name: &str, now_ms: i64) -> CmdResult<()> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 || name.chars().any(|c| c.is_control()) {
            return Err(CommandError::invalid(
                "name",
                "Project name must be 1–120 characters",
            ));
        }
        self.project.name = name.to_string();
        self.project.updated_at_ms = now_ms;
        Ok(())
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
