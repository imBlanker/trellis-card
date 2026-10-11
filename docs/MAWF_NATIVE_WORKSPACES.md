# Native MAWF workspace compatibility

The Card retains its existing Trellis project adapter and upstream identity. A
project selects native MAWF storage with `.mawf/workspace.json`:

```json
{"version":1,"backend":"mawf","trellis":false}
```

Missing marker preserves legacy behavior. Invalid or unsupported markers are
errors, even if `.trellis` still exists. Native storage does not use symlink aliases.

| Asset | Path |
| --- | --- |
| Active task directories | docs/plans/<id>/ |
| Archived task directories | docs/history/tasks/<YYYY-MM>/<id>/ |
| Engineering specifications | docs/engineering/specs/ (recursive Markdown) |
| Native host sessions | .mawf/runtime/sessions/*.json |

Project discovery, task details, relation references, specification views,
watchers and runtime snapshots use the selected backend. Native sessions come
from `mawf session start/heartbeat/stop`; no Trellis hook is needed. Active records
older than 390 seconds become stale. Stopped records do not claim working state.
No tool activity or waiting reason is invented from a heartbeat.

Local archive supports completed/done native tasks. It preserves task.json,
IDs, statuses and documents byte-for-byte, and atomically moves the entire task
folder to its month directory. It refuses an existing destination, symlinks,
noncompleted tasks and path traversal. A workspace archive lock serializes Card
archive attempts. On crash, inspect the source/destination and verify no archive
operation remains running before removing a leftover `.mawf/archive.lock`.
Historical documents and their embedded links are preserved as historical records.

## Companion mode

The transport maps MAWF protocol results to the Card UI models: project arrays,
stable task versions, task details, archived artifact documents, relation groups,
and native runtime state. Native `project.specs.files` entries are read using
`artifact.read` for full specification content. Older providers without that
optional field display the available specification summaries.

The companion is read-only. Folder pickers, local hook/configuration mutation,
window management and remote archive remain explicitly unavailable. Polling
refreshes runtime data; the transport does not claim a websocket subscription.
The companion's authorized root is used for every displayed project and mismatched
project arguments are rejected. Its existing authenticated RPC envelope is unchanged.

## Verification

```sh
npm run test:js
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

Tests evaluate the actual browser transport in Node VM using fixtures matching
MAWF provider shapes. Rust tests cover both the unchanged legacy adapter and
native discovery, task IDs, archive metadata, references, marker validation,
symlinks, sessions, runtime fusion and watcher paths. Native desktop GUI and
Windows packaging still require their respective environment; unit tests do not
substitute for a desktop acceptance run.
