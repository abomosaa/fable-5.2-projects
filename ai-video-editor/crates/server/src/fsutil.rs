//! Small filesystem helpers: crash-safe JSON persistence and wall clock.

use serde::{de::DeserializeOwned, Serialize};
use std::io::Write;
use std::path::Path;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write `bytes` to `path` atomically: write a sibling temp file, fsync it, then
/// rename over the target. A crash leaves either the old or the new file, never a
/// torn one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat"),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    write_atomic(path, &bytes)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> std::io::Result<T> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{}: {e}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested/doc.json");
        write_json_atomic(&p, &serde_json::json!({"v": 1})).unwrap();
        write_json_atomic(&p, &serde_json::json!({"v": 2})).unwrap();
        let v: serde_json::Value = read_json(&p).unwrap();
        assert_eq!(v["v"], 2);
        let names: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn corrupt_json_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.json");
        std::fs::write(&p, b"{ not json").unwrap();
        let r: std::io::Result<serde_json::Value> = read_json(&p);
        assert_eq!(r.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    }
}
