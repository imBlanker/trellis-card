const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/mawf-transport.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/native-provider.json'), 'utf8'));
function load(data = fixture) {
  const calls = [];
  const context = { window: {}, URLSearchParams, location: { search: '?transport=companion', origin: 'http://localhost:1234' }, sessionStorage: { getItem: () => 'token', setItem() {} },
    fetch: async (url, request) => {
      const body = JSON.parse(request.body); calls.push(body);
      assert.equal(request.headers['X-Mawf-Token'], 'token');
      const result = body.method === 'artifact.read' ? { rel: body.params.rel, text: data.bodies[body.params.rel] } : data[body.method];
      return { status: 200, json: async () => result ? { ok: true, result: JSON.parse(JSON.stringify(result)) } : { ok: false, error: { code: 'not_found', message: body.method } } };
    } };
  vm.runInNewContext(source, context);
  return { adapter: context.window.__MAWF_TRANSPORT__, calls };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('real transport maps projects and boot config to the Card UI shape', async () => {
  const { adapter } = load();
  assert.deepEqual(plain(await adapter.invoke('get_config')), { roots: ['/fixture'], configured: true, alwaysOnTop: false, wslSupported: false, wslDistro: null });
  const projects = await adapter.invoke('list_projects');
  assert.equal(projects[0].name, 'fixture'); assert.equal(projects[0].path, '/fixture'); assert.equal(projects[0].taskCount, 1);
  const first = await adapter.invoke('list_tasks', { project: '/fixture' });
  const second = await adapter.invoke('list_tasks', { project: '/fixture' });
  assert.equal(first.version, second.version);
  assert.equal(first.tasks[0].specRefs[0], 'docs/engineering/specs/backend/api.md');
  assert.equal(first.tasks[0].progress, 0.5); assert.equal(first.tasks[0].createdAt, '2026-10-01'); assert.equal(first.tasks[0].kind, 'work');
});
test('detail, archived assets, relations and complete native spec bodies are adapted', async () => {
  const { adapter } = load();
  const detail = await adapter.invoke('get_task', { id: 'task-one' });
  assert.equal(detail.docs[0].content, 'acceptance');
  const archive = await adapter.invoke('list_archived');
  assert.equal(archive.tasks[0].archived, true); assert.equal(archive.tasks[0].dir, 'archive/2026-09/old');
  assert.equal((await adapter.invoke('get_task', { id: 'old' })).docs[0].content, 'old body');
  const rel = await adapter.invoke('list_relations');
  assert.equal(rel.specGroups[0].count, 1); assert.equal(rel.tasks[0].specRefs[0], 'docs/engineering/specs/backend/api.md');
  const specs = await adapter.invoke('list_specs'); assert.equal(specs[0].content, 'contract\n'); assert.equal(specs[0].path, 'backend/api.md');
});
test('runtime stopped records remain stopped, and wrong roots/local mutations fail', async () => {
  const { adapter } = load();
  const snapshot = await adapter.invoke('get_runtime_snapshot');
  assert.equal(snapshot.tasks[0].agent.state, 'none'); assert.equal(snapshot.tasks[0].displayState, 'idle');
  assert.equal(snapshot.tasks[0].taskId, 'task-one'); assert.equal(snapshot.tasks[0].project, '/fixture');
  await assert.rejects(adapter.invoke('list_tasks', { project: '/other' }), /authorized/);
  await assert.rejects(adapter.invoke('archive_task', { task: 'task-one' }), /不支持/);
});
test('legacy summary-only provider remains supported', async () => {
  const data = structuredClone(fixture);
  data['project.list'] = { projects: [{ id: 'fixture', hasTrellis: true }] };
  data['project.specs'] = { specs: [{ name: 'backend', filled: true }] };
  const { adapter } = load(data);
  assert.equal((await adapter.invoke('list_tasks')).tasks.length, 1);
  assert.equal((await adapter.invoke('list_specs'))[0].name, 'backend');
});

test('task session badges retain multiple active sessions and legacy fresh sessions remain working', async () => {
  const data = structuredClone(fixture);
  data['runtime.snapshot'].sessions.push(
    { sessionId: 'one', platform: 'codex', currentTask: 'docs/plans/task-one', lastSeenAt: new Date().toISOString(), status: 'active' },
    { sessionId: 'two', platform: 'claude', currentTask: 'task-one', lastSeenAt: new Date().toISOString(), status: 'active' });
  let { adapter } = load(data);
  const list = await adapter.invoke('list_tasks');
  assert.equal(list.tasks[0].sessions.length, 2);
  assert.equal(list.tasks[0].sessions[0].platform, 'codex');
  data['project.list'] = { projects: [{ id: 'fixture', hasTrellis: true }] };
  data['runtime.snapshot'].sessions = [{ sessionId: 'legacy', platform: 'claude', currentTask: '.trellis/tasks/task-one', lastSeenAt: new Date().toISOString() }];
  ({ adapter } = load(data));
  assert.equal((await adapter.invoke('get_runtime_snapshot')).tasks[0].agent.state, 'working');
});
