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

  let workspace;
  async function context() {
    if (!workspace) {
      const [identity, listing] = await Promise.all([rpc('workspace.describe'), rpc('project.list')]);
      const project = listing.projects[0];
      if (!project) throw new Error('workspace has no project');
      workspace = { root: identity.root, name: project.id, native: project.backend === 'mawf' };
    }
    return workspace;
  }
  const taskBase = ctx => ctx.native ? 'docs/plans' : '.trellis/tasks';
  const archiveBase = ctx => ctx.native ? 'docs/history/tasks' : '.trellis/tasks/archive';
  const specBase = ctx => ctx.native ? 'docs/engineering/specs' : '.trellis/spec';
  const seconds = value => Number.isFinite(Date.parse(value)) ? Math.floor(Date.parse(value) / 1000) : 0;
  function taskModel(raw, id, dir, archived, flags = {}) {
    const status = raw.status || 'planning';
    const subtasks = Array.isArray(raw.subtasks) ? raw.subtasks : [];
    const done = ['completed', 'done'].includes(status);
    const progress = done ? 1 : subtasks.length ? subtasks.filter(t => ['completed', 'done'].includes(t.status)).length / subtasks.length : ({ planning: 0.1, in_progress: 0.5, review: 0.85 }[status] || 0.1);
    const lane = done ? 3 : status === 'review' ? 2 : status === 'planning' ? 0 : 1;
    return {
      ...raw, id: raw.id || id, dir, title: raw.title || raw.name || id,
      description: raw.description || '', status, priority: raw.priority || 'P2',
      devType: raw.dev_type || null, createdAt: raw.createdAt || raw.created_at || null, completedAt: raw.completedAt || raw.completed_at || null,
      children: raw.children || [], subtasks, mtime: seconds(raw.updatedAt || raw.completedAt || raw.completed_at || raw.createdAt || raw.created_at),
      progress, partial: progress, lane, stage: ['seed', 'sprout', 'bud', 'bloom'][lane], kind: done ? 'done' : status === 'review' ? 'wrap' : status === 'planning' ? 'plan' : status === 'blocked' ? 'halt' : 'work', archived,
      sessions: [], excerpt: '', specRefs: [], fileRefs: [], prdRefs: [],
      artifacts: { prd: !!flags.hasPrd, design: !!flags.hasDesign, implement: !!flags.hasImplement, researchCount: 0, implEntries: 0, checkEntries: 0, reportCount: 0 },
      phase: { id: status, label: status, warn: false }, workflow: raw.workflow || null,
    };
  }
  async function tasks(ctx) {
    const [listing, edges, snapshot] = await Promise.all([rpc('project.tasks'), rpc('project.relations'), rpc('runtime.snapshot')]);
    const rows = await Promise.all(listing.tasks.map(async summary => {
      const detail = await rpc('task.get', { id: summary.id });
      const row = taskModel(detail.task || summary, summary.id, summary.id, false, detail);
      row.fileRefs = (edges.groups.find(g => g.task === summary.id) || {}).files || [];
      row.specRefs = row.fileRefs.filter(f => f.startsWith(specBase(ctx) + '/'));
      row.sessions = snapshot.sessions.filter(session => session.status !== 'stopped' && session.currentTask && [row.id, row.dir].includes(session.currentTask.replace(/\\/g, '/').split('/').pop())).map(session => ({ platform: session.platform, lastSeenAt: session.lastSeenAt }));
      return row;
    }));
    // Provider epoch advances on every read, so content is the stable UI version.
    return { version: JSON.stringify(rows), tasks: rows, errors: [] };
  }
  async function archived(ctx) {
    const listing = await rpc('artifact.list');
    const prefix = archiveBase(ctx) + '/';
    const rows = await Promise.all(listing.artifacts.filter(a => a.rel.startsWith(prefix) && a.rel.endsWith('/task.json')).map(async item => {
      const raw = JSON.parse((await rpc('artifact.read', { rel: item.rel })).text);
      const rel = item.rel.slice(prefix.length, -'/task.json'.length);
      const id = rel.split('/').pop();
      return taskModel(raw, id, 'archive/' + rel, true);
    }));
    return { version: JSON.stringify(rows), tasks: rows, errors: [] };
  }
  async function detail(ctx, id) {
    const active = (await tasks(ctx)).tasks;
    let task = active.find(t => t.id === id || t.dir === id);
    if (!task) task = (await archived(ctx)).tasks.find(t => t.id === id || t.dir === id);
    if (!task) throw new Error('task not found');
    const dir = task.archived ? archiveBase(ctx) + '/' + task.dir.slice('archive/'.length) : taskBase(ctx) + '/' + task.dir;
    const listing = await rpc('artifact.list');
    const docs = await Promise.all(listing.artifacts.filter(a => a.rel.startsWith(dir + '/') && a.rel.endsWith('.md')).map(async a => {
      const name = a.rel.slice(dir.length + 1);
      const body = await rpc('artifact.read', { rel: a.rel });
      return { name, label: name, content: body.text };
    }));
    return { ...task, docs };
  }
  async function relations(ctx) {
    const [list, edges] = await Promise.all([tasks(ctx), rpc('project.relations')]);
    const groups = new Map();
    const rows = list.tasks.map(task => {
      const files = (edges.groups.find(g => g.task === task.dir) || {}).files || [];
      const refs = files.filter(f => f.startsWith(specBase(ctx) + '/'));
      for (const ref of refs) { if (!groups.has(ref)) groups.set(ref, []); groups.get(ref).push(task.id); }
      return { ...task, fileRefs: files, specRefs: refs };
    });
    return { tasks: rows, specGroups: [...groups].map(([path, taskIds]) => ({ path, taskIds, count: taskIds.length })), prdGroups: [] };
  }
  async function runtime(ctx) {
    const [snapshot, list] = await Promise.all([rpc('runtime.snapshot'), tasks(ctx)]);
    const now = Math.floor(Date.now() / 1000);
    const agents = snapshot.sessions.map(s => {
      const updatedAt = seconds(s.lastSeenAt);
      const state = s.status === 'stopped' ? 'none' : (s.status === 'active' || (!ctx.native && !s.status)) && now - updatedAt <= 390 ? 'working' : 'stale';
      return { sessionId: s.sessionId, agentKind: s.platform || 'unknown', project: ctx.root, taskId: s.currentTask ? s.currentTask.replace(/\\/g, '/').split('/').pop() : null,
        eventName: s.status === 'stopped' ? 'SessionEnd' : 'Heartbeat', state, waitingReason: null, toolName: null, toolInput: null,
        activity: null, startedAt: updatedAt, updatedAt };
    });
    return { tasks: list.tasks.map(t => {
      const agent = agents.filter(a => a.taskId === t.id || a.taskId === t.dir).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      const displayState = ['completed', 'done'].includes(t.status) ? 'completed' : ['blocked', 'failed'].includes(t.status) ? t.status : agent && agent.state === 'working' ? 'working' : agent && agent.state === 'stale' ? 'stale' : t.status === 'planning' ? 'planning' : 'idle';
      return { project: ctx.root, taskId: t.id, taskStatus: t.status, phase: t.phase.id, displayState, attention: 'normal', confidence: 'low', action: null, agent, activity: null, focusScore: 0, lastChangedAt: agent ? agent.updatedAt : t.mtime };
    }), projectActivities: agents.filter(a => !a.taskId), errors: snapshot.warnings || [], focusKey: null, generatedAt: now };
  }

  window.__MAWF_TRANSPORT__ = {
    mode: 'companion', base,
    async invoke(cmd, args = {}) {
      if (LOCAL_ONLY.has(cmd)) throw new Error(`远端模式不支持本地操作 ${cmd}（该能力属于桌面端/本机配置）`);
      const ctx = await context();
      if (args.project && args.project !== ctx.root) throw new Error('workspace does not match the authorized companion root');
      switch (cmd) {
        case 'get_config': return { roots: [ctx.root], configured: true, alwaysOnTop: false, wslSupported: false, wslDistro: null };
        case 'list_projects': {
          const list = await tasks(ctx);
          return [{ name: ctx.name, path: ctx.root, taskCount: list.tasks.length, lastActivity: null }];
        }
        case 'list_tasks': return tasks(ctx);
        case 'list_archived': return archived(ctx);
        case 'get_task': return detail(ctx, args.id);
        case 'list_relations': return relations(ctx);
        case 'list_specs': {
          const list = await rpc('project.specs');
          if (Array.isArray(list.files)) {
            return Promise.all(list.files.map(async file => {
              const body = await rpc('artifact.read', { rel: file.rel });
              const relative = file.rel.slice(specBase(ctx).length + 1);
              const lineCount = body.text.split('\n').filter(l => l.trim()).length;
              return { path: relative, name: relative.split('/').pop().replace(/\.md$/, ''), category: relative.split('/')[0], filled: lineCount >= 40, lineCount, referencedBy: 0, content: body.text, paths: [] };
            }));
          }
          return list.specs.map(s => ({ path: s.name, name: s.name, category: s.name, filled: s.filled, lineCount: 0, referencedBy: 0, content: '', paths: [] }));
        }
        case 'get_runtime_snapshot': return runtime(ctx);
        default: throw new Error(`远端模式尚未映射通道 ${cmd}`);
      }
    },
    listen(_event, _cb) {
      // runtime events over the companion arrive in a later milestone;
      // the Card's polling loop keeps remote data fresh meanwhile.
      return () => {};
    },
  };
  window.__MAWF_MANAGED__ = true; // disables the upstream update check in app.js
})();
