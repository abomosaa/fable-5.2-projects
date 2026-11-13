use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// A field failed validation (bad range, wrong type, empty selection …).
    InvalidArgument,
    /// A referenced clip / track / asset / transition does not exist.
    NotFound,
    /// The target track is locked.
    TrackLocked,
    /// The edit is well formed but cannot be applied to the current timeline.
    Conflict,
    /// The command would have produced an inconsistent document (a bug guard:
    /// the document is left untouched).
    InvariantViolation,
    /// The client edited against an outdated revision.
    StaleRevision,
    /// Nothing to undo / redo.
    NothingToDo,
}

/// A rejected command. Rejection is always atomic: the project is unchanged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    /// The offending argument, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            field: None,
        }
    }
    pub fn invalid(field: &str, message: impl Into<String>) -> Self {
        CommandError {
            code: ErrorCode::InvalidArgument,
            message: message.into(),
            field: Some(field.to_string()),
        }
    }
    pub fn not_found(what: &str, id: &str) -> Self {
        CommandError {
            code: ErrorCode::NotFound,
            message: format!("{what} “{id}” does not exist"),
            field: None,
        }
    }
    pub fn locked(track_name: &str) -> Self {
        CommandError {
            code: ErrorCode::TrackLocked,
            message: format!("Track {track_name} is locked. Unlock it to edit its clips."),
            field: None,
        }
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        CommandError::new(ErrorCode::Conflict, message)
    }
    pub fn invariant(message: impl Into<String>) -> Self {
        CommandError::new(ErrorCode::InvariantViolation, message)
    }
}

pub type CmdResult<T> = Result<T, CommandError>;
