//! Server → browser event bus (delivered over Server-Sent Events).

use serde::Serialize;
use tokio::sync::broadcast;

/// One push message. `project_id: None` means "relevant to every project"
/// (asset and export updates are filtered client-side by id).
#[derive(Clone, Debug, Serialize)]
pub struct Event {
    #[serde(skip)]
    pub project_id: Option<String>,
    /// SSE event name: `asset`, `asset_added`, `change`, `render`, `project`, `assistant`.
    #[serde(skip)]
    pub kind: &'static str,
    #[serde(flatten)]
    pub payload: serde_json::Value,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> EventBus {
        let (tx, _) = broadcast::channel(1024);
        EventBus { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn emit<T: Serialize>(&self, kind: &'static str, project_id: Option<&str>, payload: &T) {
        let payload = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        // No subscribers is fine.
        let _ = self.tx.send(Event {
            project_id: project_id.map(|s| s.to_string()),
            kind,
            payload,
        });
    }
}
