//! Cutline core: the deterministic editing engine.
//!
//! This crate is pure (no I/O, no clocks, no randomness). Given the same inputs it
//! always produces the same outputs, which is what makes edits reproducible,
//! undoable and testable:
//!
//! * [`time`]       – tick-based time model with distinct timeline / clip / source types
//! * [`model`]      – the project document
//! * [`commands`]   – validated, atomic mutations of the document
//! * [`history`]    – revisioned sessions with patch-based undo / redo
//! * [`resolve`]    – fades and transitions resolved into concrete layers
//! * [`transcript`], [`soniox`], [`mapping`], [`analysis`], [`captions`], [`subtitles`]
//!   – speech data, provider normalisation and transcript ⇄ timeline mapping
//! * [`render`]     – FFmpeg render-plan generation
//! * [`tools`]      – typed tool surface for the editing assistant

pub mod analysis;
pub mod captions;
pub mod commands;
pub mod error;
pub mod history;
pub mod mapping;
pub mod model;
pub mod render;
pub mod resolve;
pub mod soniox;
pub mod subtitles;
pub mod time;
pub mod tools;
pub mod transcript;
pub mod validate;

pub use commands::{apply, Command};
pub use error::{CommandError, ErrorCode};
pub use history::{Change, DocPatch, History, Session};
pub use model::Project;
pub use time::{ClipTime, FrameRate, SourceTime, Speed, Ticks, TimelineTime, TICKS_PER_SECOND};
