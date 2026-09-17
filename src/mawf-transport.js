// MAWF transport seam (P5.2, task 09-17-mawf-four-tool-integration).
//
// Lets the EXISTING Card UI run against either:
//   1. Tauri (local desktop, upstream behavior), or
//   2. the MAWF companion HTTP service (remote workspace via bridge
//      providers) — enabled by loading app with ?transport=companion&base=URL
//      (&token=... handled by sessionStorage per companion contract).
//
// MAWF-original code; no upstream logic is replaced — window.MawfTransport is
// consulted only when present, so plain Tauri runs are byte-identical.
//
// Remote mode capability map (honest, stabilization §23 discipline):
//   mapped   : read-only channels backed by bridge providers
//   refused  : local-desktop-only channels (folder pickers, window shape,
//              hook config mutation, archive write) — rejected with a clear
//              reason instead of silently misbehaving
//   deferred : real-time listen() (runtime events) — returns a no-op
//              unsubscribe; the UI's 5s poll keeps data fresh meanwhile.
(function () {
  'use strict';
  if (window.__MAWF_TRANSPORT__) return; // idempotent

  const q = new URLSearchParams(location.search);
  if (q.get('transport') !== 'companion') return;

  const base = (q.get('base') || location.origin).replace(/\/$/, '');
  let token = sessionStorage.getItem('mawf_companion_token') || q.get('token') || '';
  if (q.get('token')) sessionStorage.setItem('mawf_companion_token', token);

  // invoke channel -> bridge protocol method (read-only surface)
  const MAP = {
    list_projects: 'project.list',
    list_tasks: 'project.tasks',
    list_archived: 'project.tasks', // archived subset unsupported yet — caller tolerates empty
    list_relations: 'project.relations',
    list_specs: 'project.specs',
    get_task: 'task.get',
    get_runtime_snapshot: 'runtime.snapshot',
  };
  const LOCAL_ONLY = new Set([
    'pick_folder', 'add_root', 'remove_root', 'complete_setup',
    'configure_hook', 'get_hook_statuses', 'archive_task',
    'set_wsl_distro', 'get_wsl_info',
    'set_window_mode', 'set_window_size', 'set_capsule_expanded',
    'set_always_on_top', 'snap_window_top', 'fit_window_height', 'hide_window',
  ]);

  let rpcSeq = 0;
  async function rpc(method, params) {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mawf-Token': token },
      body: JSON.stringify({ id: `t${++rpcSeq}`, method, params: params ?? {} }),
    });
    if (res.status === 401) throw new Error('companion 认证失败：token 无效或过期，请从 mawf companion serve 输出重新进入');
    const msg = await res.json();
    if (!msg.ok) throw new Error(msg.error ? `${msg.error.code}: ${msg.error.message}` : 'companion rpc failed');
    return msg.result;
  }

  window.__MAWF_TRANSPORT__ = {
    mode: 'companion',
    base,
    invoke(cmd, args) {
      if (LOCAL_ONLY.has(cmd)) {
        return Promise.reject(new Error(`远端模式不支持本地操作 ${cmd}（该能力属于桌面端/本机配置）`));
      }
      const method = MAP[cmd];
      if (!method) {
        return Promise.reject(new Error(`远端模式尚未映射通道 ${cmd}`));
      }
      // channel-specific param/result adaptation lives in the providers;
      // the invoke args are forwarded as params unchanged.
      return rpc(method, args ?? {});
    },
    listen(_event, _cb) {
      // runtime events over the companion arrive in a later milestone;
      // the Card's polling loop keeps remote data fresh meanwhile.
      return () => {};
    },
  };
  window.__MAWF_MANAGED__ = true; // disables the upstream update check in app.js
})();
