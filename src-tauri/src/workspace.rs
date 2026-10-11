// MAWF-native workspace adapter. Absence retains legacy Trellis behavior;
// invalid markers are errors and must never enable a legacy fallback.
use std::fs;
use std::path::{Component, Path, PathBuf};

pub struct Layout {
    pub native: bool,
    pub tasks: PathBuf,
    pub archive: PathBuf,
    pub specs: PathBuf,
    pub sessions: PathBuf,
}

pub fn checked(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(part) = part else {
            return Err("invalid workspace path".into());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "workspace storage cannot be a symlink: {}",
                    current.display()
                ))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(current)
}

pub fn layout(root: &Path) -> Result<Layout, String> {
    // Legacy projects may have a valid .mawf directory symlink without a marker.
    // Native storage is checked only after opt-in; dangling opt-outs still fail.
    let marker = root.join(".mawf/workspace.json");
    let native = match fs::read_to_string(&marker) {
        Ok(raw) => {
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("invalid workspace marker: {e}"))?;
            if value["version"] != 1 || value["backend"] != "mawf" || value["trellis"] != false {
                return Err("unsupported workspace marker (expected version=1, backend=mawf, trellis=false)".into());
            }
            checked(root, ".mawf/workspace.json")?;
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            for path in [root.join(".mawf"), marker.clone()] {
                match fs::symlink_metadata(&path) {
                    Ok(meta) if meta.file_type().is_symlink() && !path.exists() => {
                        return Err(format!(
                            "dangling workspace marker path: {}",
                            path.display()
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            false
        }
        Err(e) => return Err(e.to_string()),
    };
    let paths = if native {
        [
            "docs/plans",
            "docs/history/tasks",
            "docs/engineering/specs",
            ".mawf/runtime/sessions",
        ]
    } else {
        [
            ".trellis/tasks",
            ".trellis/tasks/archive",
            ".trellis/spec",
            ".trellis/.runtime/sessions",
        ]
    };
    let resolve = |p: &str| {
        if native {
            checked(root, p)
        } else {
            Ok(root.join(p))
        }
    };
    Ok(Layout {
        native,
        tasks: resolve(paths[0])?,
        archive: resolve(paths[1])?,
        specs: resolve(paths[2])?,
        sessions: resolve(paths[3])?,
    })
}

pub fn is_project(root: &Path) -> bool {
    match layout(root) {
        Ok(layout) => layout.native || layout.tasks.is_dir(),
        Err(error) => {
            eprintln!("[workspace] {}: {error}", root.display());
            false
        }
    }
}

pub fn task_path(root: &Path, dir: &str, archived: bool) -> Result<PathBuf, String> {
    let l = layout(root)?;
    if l.native {
        let relative = if archived {
            format!(
                "docs/history/tasks/{}",
                dir.strip_prefix("archive/").unwrap_or(dir)
            )
        } else {
            format!("docs/plans/{dir}")
        };
        checked(root, &relative)
    } else {
        Ok(l.tasks.join(dir))
    }
}

// Native archive moves only completed tasks, preserving task.json and all assets
// byte-for-byte. Archive membership comes from its location, not a forged status.
pub fn archive(root: &Path, id: &str, month: &str) -> Result<(), String> {
    let l = layout(root)?;
    if !l.native {
        return Err("native archive requires MAWF marker".into());
    }
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err("archive requires a single task directory name".into());
    }
    if month.len() != 7
        || month.as_bytes()[4] != b'-'
        || !month
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || b.is_ascii_digit())
    {
        return Err("archive month must be YYYY-MM".into());
    }
    let src = checked(root, &format!("docs/plans/{id}"))?;
    let meta = checked(root, &format!("docs/plans/{id}/task.json"))?;
    let raw = fs::read_to_string(meta).map_err(|e| e.to_string())?;
    let task: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if !matches!(task["status"].as_str(), Some("completed" | "done")) {
        return Err("only completed tasks can be archived".into());
    }
    checked_files(&src)?;
    let dst = checked(root, &format!("docs/history/tasks/{month}/{id}"))?;
    let lock = checked(root, ".mawf/archive.lock")?;
    let lock_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|e| format!("archive lock unavailable: {e}"))?;
    let result = (|| {
        if dst.exists() {
            return Err("archive destination already exists".into());
        }
        fs::create_dir_all(dst.parent().ok_or("missing archive parent")?)
            .map_err(|e| e.to_string())?;
        fs::rename(&src, &dst).map_err(|e| format!("archive move failed (source retained): {e}"))
    })();
    drop(lock_file);
    let cleanup = fs::remove_file(lock).map_err(|e| format!("archive lock cleanup failed: {e}"));
    result.and(cleanup)
}

pub fn native_agents(root: &Path, now: i64) -> Result<Vec<crate::runtime::AgentRuntime>, String> {
    use crate::runtime::{AgentRuntime, AgentState};
    let l = layout(root)?;
    if !l.native {
        return Ok(Vec::new());
    }
    let entries = match fs::read_dir(&l.sessions) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut agents = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let rel = format!(
            ".mawf/runtime/sessions/{}",
            entry.file_name().to_string_lossy()
        );
        let file = checked(root, &rel)?;
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let updated = value["last_seen_at"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp())
            .unwrap_or(0);
        let status = value["status"].as_str().unwrap_or("unknown");
        let state = if status == "stopped" {
            AgentState::None
        } else if status == "active" && now.saturating_sub(updated) <= 390 {
            AgentState::Working
        } else {
            AgentState::Stale
        };
        let task = value["current_task"]
            .as_str()
            .map(|s| {
                s.replace('\\', "/")
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .to_owned()
            })
            .filter(|s| !s.is_empty());
        agents.push(AgentRuntime {
            session_id: entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            agent_kind: value["platform"].as_str().unwrap_or("unknown").to_owned(),
            project: crate::platform::strip_device_prefix(&root.to_string_lossy()),
            task_id: task,
            event_name: if status == "stopped" {
                "SessionEnd"
            } else {
                "Heartbeat"
            }
            .into(),
            state,
            waiting_reason: None,
            tool_name: None,
            tool_input: None,
            activity: None,
            started_at: updated,
            updated_at: updated,
        });
    }
    Ok(agents)
}

pub fn checked_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!(
                "workspace asset cannot be a symlink: {}",
                entry.path().display()
            ));
        }
        if kind.is_dir() {
            files.extend(checked_files(&entry.path())?);
        } else if kind.is_file() {
            files.push(entry.path());
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "card-native-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join(".mawf")).unwrap();
            fs::write(
                root.join(".mawf/workspace.json"),
                r#"{"version":1,"backend":"mawf","trellis":false}"#,
            )
            .unwrap();
            Self(root)
        }
        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn marker_native_legacy_and_invalid_are_distinct() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join(".trellis/tasks")).unwrap();
        assert!(layout(&f.0).unwrap().native);
        assert!(is_project(&f.0));
        f.write(".mawf/workspace.json", "{}");
        assert!(layout(&f.0).is_err());
        assert!(!is_project(&f.0));
        assert!(!crate::scan::scan_tasks(&f.0).1.is_empty());
        fs::remove_file(f.0.join(".mawf/workspace.json")).unwrap();
        assert!(!layout(&f.0).unwrap().native);
        assert!(is_project(&f.0));
    }

    #[test]
    fn native_discovery_scan_relations_archived_and_documents() {
        let f = Fixture::new();
        f.write(
            "docs/plans/live/task.json",
            r#"{"id":"stable-id","title":"Native","status":"planning"}"#,
        );
        f.write(
            "docs/plans/live/implement.jsonl",
            "{\"file\":\"docs/engineering/specs/backend/api.md\"}\n",
        );
        f.write(
            "docs/history/tasks/2026-09/old/task.json",
            r#"{"id":"old","status":"completed"}"#,
        );
        f.write(
            "docs/history/tasks/2026-09/old/prd.md",
            "historical document",
        );
        f.write("docs/engineering/specs/backend/api.md", "contract");
        f.write(".trellis/tasks/ignored/task.json", r#"{"id":"ignored"}"#);
        assert!(crate::scan::discover_projects(&f.0, 1).contains(&f.0));
        let (tasks, errors) = crate::scan::scan_tasks(&f.0);
        assert!(errors.is_empty());
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "stable-id");
        assert_eq!(
            tasks[0].spec_refs,
            ["docs/engineering/specs/backend/api.md"]
        );
        let (archive, errors) = crate::scan::scan_archived(&f.0);
        assert!(errors.is_empty());
        assert_eq!(archive[0].dir, "archive/2026-09/old");
        assert_eq!(
            fs::read_to_string(
                task_path(&f.0, &archive[0].dir, true)
                    .unwrap()
                    .join("prd.md")
            )
            .unwrap(),
            "historical document"
        );
        assert_eq!(crate::scan::scan_tasks_with_archived(&f.0).0.len(), 2);
        assert_eq!(
            checked_files(&layout(&f.0).unwrap().specs).unwrap().len(),
            1
        );
    }

    #[test]
    fn native_archive_preserves_metadata_refuses_collision_and_incomplete_tasks() {
        let f = Fixture::new();
        let original = r#"{"id":"stable-id","status":"completed","custom":{"keep":true}}"#;
        f.write("docs/plans/a/task.json", original);
        f.write("docs/plans/a/prd.md", "exact bytes");
        archive(&f.0, "a", "2026-10").unwrap();
        assert!(!f.0.join("docs/plans/a").exists());
        assert_eq!(
            fs::read_to_string(f.0.join("docs/history/tasks/2026-10/a/task.json")).unwrap(),
            original
        );
        f.write("docs/plans/a/task.json", original);
        assert!(archive(&f.0, "a", "2026-10")
            .unwrap_err()
            .contains("already exists"));
        assert!(f.0.join("docs/plans/a/task.json").exists());
        f.write("docs/plans/b/task.json", r#"{"status":"in_progress"}"#);
        assert!(archive(&f.0, "b", "2026-10").is_err());
        assert!(archive(&f.0, "../b", "2026-10").is_err());
        assert!(!f.0.join(".mawf/archive.lock").exists());
    }

    #[test]
    fn native_session_records_reach_runtime_without_legacy_hooks() {
        let f = Fixture::new();
        f.write(".mawf/runtime/sessions/real-id.json", r#"{"platform":"codex","current_task":"docs/plans/a","last_seen_at":"2026-10-12T00:00:00Z","status":"active"}"#);
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-12T00:00:01Z")
            .unwrap()
            .timestamp();
        let agents = native_agents(&f.0, now).unwrap();
        assert_eq!(agents[0].state, crate::runtime::AgentState::Working);
        assert_eq!(agents[0].task_id.as_deref(), Some("a"));
        assert_eq!(
            native_agents(&f.0, now + 400).unwrap()[0].state,
            crate::runtime::AgentState::Stale
        );
        f.write(".mawf/runtime/sessions/real-id.json", r#"{"platform":"codex","current_task":"a","last_seen_at":"2026-10-12T00:00:00Z","status":"stopped"}"#);
        assert_eq!(
            native_agents(&f.0, now).unwrap()[0].state,
            crate::runtime::AgentState::None
        );
        assert!(crate::watch::is_relevant_task_event(
            &f.0.join(".mawf/runtime/sessions/real-id.json")
        ));
        assert!(crate::watch::is_relevant_task_event(
            &f.0.join("docs/plans/a/task.json")
        ));
        assert!(crate::watch::is_relevant_task_event(
            &f.0.join("docs/history/tasks/2026-10/a/task.json")
        ));
    }

    #[test]
    #[cfg(unix)]
    fn native_scan_rejects_external_session_leaf_symlink() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        f.write(
            "docs/plans/a/task.json",
            r#"{"id":"a","status":"in_progress"}"#,
        );
        outside.write("external.json", r#"{"platform":"outside","current_task":"a","last_seen_at":"2026-10-12T00:00:00Z","status":"active"}"#);
        fs::create_dir_all(f.0.join(".mawf/runtime/sessions")).unwrap();
        symlink(
            outside.0.join("external.json"),
            f.0.join(".mawf/runtime/sessions/escape.json"),
        )
        .unwrap();
        let (tasks, errors) = crate::scan::scan_tasks(&f.0);
        assert!(errors.is_empty());
        assert!(tasks[0].sessions.is_empty());
        assert!(native_agents(&f.0, 0).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn legacy_valid_mawf_directory_symlink_without_marker_is_preserved() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::remove_dir_all(f.0.join(".mawf")).unwrap();
        fs::create_dir_all(f.0.join(".trellis/tasks")).unwrap();
        symlink(&outside.0, f.0.join(".mawf")).unwrap();
        assert!(!layout(&f.0).unwrap().native);
        assert!(is_project(&f.0));
        outside.write(
            "workspace.json",
            r#"{"version":1,"backend":"mawf","trellis":false}"#,
        );
        assert!(
            layout(&f.0).is_err(),
            "native marker must reject the same symlink"
        );
        fs::remove_file(outside.0.join("workspace.json")).unwrap();
        symlink(outside.0.join("missing"), outside.0.join("workspace.json")).unwrap();
        assert!(
            layout(&f.0).is_err(),
            "dangling marker leaf must not fall back to legacy"
        );
    }

    #[test]
    #[cfg(unix)]
    fn native_rejects_symlink_paths_and_dangling_optout() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir_all(f.0.join("docs")).unwrap();
        symlink(&outside.0, f.0.join("docs/plans")).unwrap();
        assert!(layout(&f.0).is_err());
        fs::remove_file(f.0.join("docs/plans")).unwrap();
        fs::remove_dir_all(f.0.join(".mawf")).unwrap();
        symlink(f.0.join("missing"), f.0.join(".mawf")).unwrap();
        assert!(layout(&f.0).is_err());
    }
}
