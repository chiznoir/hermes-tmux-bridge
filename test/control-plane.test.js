import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionById, inferSessionKind, listSessions } from '../src/control-plane/registry.js';
import { decideBackend, normalizeCommandMode } from '../src/control-plane/policy.js';
import { appendAudit, auditEventToRouterEvent, readAuditLog } from '../src/control-plane/audit-log.js';
import { openEventIndex, upsertEvents } from '../src/control-plane/event-index.js';
import { routeSessionEvents } from '../src/control-plane/event-router.js';
import { buildSessionIndex } from '../src/codex.js';

async function withEnv(env, fn) {
  const previous = new Map();
  for (const key of Object.keys(env)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('session kind policy infers team, tmux, and codex-thread sessions', () => {
  assert.equal(inferSessionKind({ cwd: '/home/user/work/codex-bridge/.codex/team/worker-1', project: 'worker-1' }), 'codex-team');
  assert.equal(inferSessionKind({ tmuxId: 'tmux-1', project: 'codex-bridge' }), 'codex-tmux');
  assert.equal(inferSessionKind({ project: 'plain-codex' }), 'codex-thread');
});

test('backend policy normalizes mode and respects forced visible/team routing', () => {
  assert.equal(normalizeCommandMode('codex'), 'codex');
  assert.equal(normalizeCommandMode('tmux'), 'tmux');
  assert.equal(normalizeCommandMode('invalid'), 'auto');

  assert.deepEqual(decideBackend({ kind: 'codex-thread' }, { mode: 'codex' }), { backend: null, reason: 'mode-codex-unsupported', unsupported: true });
  assert.deepEqual(decideBackend({ kind: 'codex-team' }, { mode: 'auto' }), { backend: 'tmux', reason: 'auto-tmux-default' });
  assert.deepEqual(decideBackend({ kind: 'codex-tmux' }, { mode: 'auto' }), { backend: 'tmux', reason: 'auto-tmux-default' });
  assert.deepEqual(decideBackend({ kind: 'codex-thread' }, { mode: 'auto', visible: true }), { backend: 'tmux', reason: 'visible-control-requested' });
});

test('audit log appends and filters router events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-audit-'));
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  const accepted = await appendAudit('command.accepted', {
    sessionId: 'bridge-1',
    bridgeSessionId: 'bridge-1',
    codexThreadId: 'thread-1',
    commandText: 'hello',
    backend: 'codex',
  }, { projectRoot: root, timestamp: '2026-04-30T05:00:00.000Z' });
  await appendAudit('command.completed', {
    sessionId: 'bridge-1',
    bridgeSessionId: 'bridge-1',
    codexThreadId: 'thread-1',
    commandText: 'hello',
    backend: 'codex',
  }, { projectRoot: root, timestamp: '2026-04-30T05:01:00.000Z' });

  const filtered = await readAuditLog({ sessionId: 'bridge-1', since: '2026-04-30T05:00:30.000Z' }, { projectRoot: root });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].eventType, 'command.completed');

  const routerEvent = auditEventToRouterEvent(accepted);
  assert.equal(routerEvent.type, 'command.accepted');
  assert.equal(routerEvent.source, 'audit-log');
  assert.equal(routerEvent.backend, 'codex');
  assert.equal(routerEvent.text, 'hello');
});

test('session index reconciles Codex start logs without creating unknown-project shadow sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-reconcile-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '04');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  const lifecycleSessionId = 'codex-1777898039258-41oaw1';
  const codexSessionId = '019df2fb-2cc0-78b3-827c-718684103227';
  await writeFile(join(sessionsDir, `rollout-2026-05-04T12-34-00-${codexSessionId}.jsonl`), [
    { timestamp: '2026-05-04T12:34:00.000Z', type: 'session_meta', payload: { id: codexSessionId, timestamp: '2026-05-04T12:33:59.385Z', cwd: root } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-04.jsonl'), [
    { event: 'session_start', session_id: lifecycleSessionId, pid: 108253, timestamp: '2026-05-04T12:33:59.385Z' },
    { event: 'session_start_reconciled', session_id: lifecycleSessionId, native_session_id: codexSessionId, pid: 108618, timestamp: '2026-05-04T12:34:26.093Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({ projectRoot: root, codexHome, discoverTmuxProjectRoots: false });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].codexSessionId, codexSessionId);
  assert.equal(sessions[0].lifecycleSessionId, lifecycleSessionId);
  assert.equal(sessions[0].cwd, root);
  assert.equal(sessions[0].project, root.split('/').pop());
  assert.equal(sessions.some((session) => session.codexSessionId === lifecycleSessionId || session.project === 'unknown'), false);
});

test('session index marks ended sessions as ended and clears stale endedAt after later restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-ended-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), [
    {
      session_id: 'codex-ended-session',
      native_session_id: 'codex-ended',
      started_at: '2026-05-04T10:00:00.000Z',
      ended_at: '2026-05-04T10:05:00.000Z',
      cwd: root,
      pid: 123,
    },
    {
      session_id: 'codex-restarted-old',
      native_session_id: 'codex-reused',
      started_at: '2026-05-04T10:00:00.000Z',
      ended_at: '2026-05-04T10:05:00.000Z',
      cwd: root,
      pid: 456,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-04.jsonl'), [
    {
      event: 'session_start',
      session_id: 'codex-restarted-new',
      timestamp: '2026-05-04T10:06:00.000Z',
      pid: 789,
    },
    {
      event: 'session_start_reconciled',
      session_id: 'codex-restarted-new',
      native_session_id: 'codex-reused',
      timestamp: '2026-05-04T10:06:10.000Z',
      pid: 790,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({ projectRoot: root, codexHome, discoverTmuxProjectRoots: false });
  const ended = sessions.find((session) => session.codexSessionId === 'codex-ended');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.endedAt, '2026-05-04T10:05:00.000Z');

  const restarted = sessions.find((session) => session.codexSessionId === 'codex-reused');
  assert.equal(restarted.lifecycleSessionId, 'codex-restarted-new');
  assert.equal(restarted.startedAt, '2026-05-04T10:06:00.000Z');
  assert.equal(restarted.endedAt, null);
  assert.equal(restarted.status, 'unknown');
});

test('session index uses explicit Codex session_end logs as the canonical SessionEnd source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-explicit-end-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
    {
      event: 'session_start',
      session_id: 'codex-explicit-end',
      timestamp: '2026-05-14T01:00:00.000Z',
      cwd: root,
      pid: 101,
    },
    {
      event: 'session_start_reconciled',
      session_id: 'codex-explicit-end',
      native_session_id: 'codex-explicit-end',
      timestamp: '2026-05-14T01:00:05.000Z',
      cwd: root,
      pid: 102,
    },
    {
      event: 'session_end',
      session_id: 'codex-explicit-end',
      native_session_id: 'codex-explicit-end',
      timestamp: '2026-05-14T01:07:30.000Z',
      reason: 'session_exit',
      pid: 102,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({ projectRoot: root, codexHome, discoverTmuxProjectRoots: false });
  const ended = sessions.find((session) => session.codexSessionId === 'codex-explicit-end');
  assert.equal(ended?.lifecycleSessionId, 'codex-explicit-end');
  assert.equal(ended?.status, 'ended');
  assert.equal(ended?.endedAt, '2026-05-14T01:07:30.000Z');
  assert.equal(ended?.endedAtSource, 'codex-log-session-end');

  const events = await routeSessionEvents(ended, { projectRoot: root });
  const end = events.find((event) => event.type === 'SessionEnd' && event.source === 'notification');
  assert.equal(end?.eventId, 'codex-explicit-end:end');
  assert.equal(end?.timestamp, '2026-05-14T01:07:30.000Z');
  assert.equal(end?.reason, 'session_exit');
});

test('session index does not attach live tmux identity to ended historical sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-ended-live-tmux-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-ended-old',
    native_session_id: 'codex-ended-old',
    started_at: '2026-05-04T18:02:38.660Z',
    ended_at: '2026-05-04T18:29:20.735Z',
    cwd: root,
    pid: 4098021,
  }) + '\n');

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
case "$1" in
  list-panes)
    printf 'current-live-tmux\\t%%99\\t4242\\t0\\t%s\\n' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'current-live-tmux\\t1777919363\\t1\\n'
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({ projectRoot: root, codexHome, discoverTmuxProjectRoots: false });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'ended');
    assert.equal(sessions[0].tmuxId, null);
    assert.equal(sessions[0].tmuxPaneId, null);
  });
});

test('session index does not attach a much newer tmux pane to stale unended sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-stale-live-tmux-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-stale-unended',
    native_session_id: 'codex-stale-unended',
    started_at: '2026-05-05T11:35:19.284Z',
    cwd: root,
    pid: 879459,
  }) + '\n');

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
case "$1" in
  list-panes)
    printf 'codex-chiz-crab-093119\\t%%81\\t4242\\t0\\t%s\\n' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'codex-chiz-crab-093119\\t1778059879\\t1\\n'
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: root,
      codexHome,
      discoverTmuxProjectRoots: false,
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].tmuxId, null);
    assert.equal(sessions[0].tmuxPaneId, null);
    assert.equal(sessions[0].status, 'unknown');
  });
});

test('session index prefers exact tmux pane pid over timestamp proximity for rapid Codex starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-rapid-tmux-pid-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), [
    {
      session_id: 'codex-rapid-a',
      native_session_id: 'codex-rapid-a',
      started_at: '2026-05-09T02:53:40.768Z',
      cwd: root,
      pid: 1831744,
    },
    {
      session_id: 'codex-rapid-b',
      native_session_id: 'codex-rapid-b',
      started_at: '2026-05-09T02:53:41.872Z',
      cwd: root,
      pid: 1832002,
    },
    {
      session_id: 'codex-rapid-c',
      native_session_id: 'codex-rapid-c',
      started_at: '2026-05-09T02:53:42.976Z',
      cwd: root,
      pid: 1832313,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
case "$1" in
  list-panes)
    printf 'codex-rapid-025340\\t%%238\\t1831744\\t0\\t%s\\n' "$ROOT_PATH"
    printf 'codex-rapid-025340\\t%%239\\t1831829\\t0\\t%s\\n' "$ROOT_PATH"
    printf 'codex-rapid-025341\\t%%240\\t1832002\\t0\\t%s\\n' "$ROOT_PATH"
    printf 'codex-rapid-025341\\t%%241\\t1832071\\t0\\t%s\\n' "$ROOT_PATH"
    printf 'codex-rapid-025342\\t%%242\\t1832313\\t0\\t%s\\n' "$ROOT_PATH"
    printf 'codex-rapid-025342\\t%%243\\t1832393\\t0\\t%s\\n' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'codex-rapid-025340\\t1778295220\\t0\\n'
    printf 'codex-rapid-025341\\t1778295221\\t0\\n'
    printf 'codex-rapid-025342\\t1778295222\\t0\\n'
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: root,
      codexHome,
      discoverTmuxProjectRoots: false,
    });
    const byCodex = new Map(sessions.map((session) => [session.lifecycleSessionId, session]));
    assert.equal(byCodex.get('codex-rapid-a')?.tmuxId, 'codex-rapid-025340');
    assert.equal(byCodex.get('codex-rapid-a')?.tmuxPaneId, '%238');
    assert.equal(byCodex.get('codex-rapid-b')?.tmuxId, 'codex-rapid-025341');
    assert.equal(byCodex.get('codex-rapid-b')?.tmuxPaneId, '%240');
    assert.equal(byCodex.get('codex-rapid-c')?.tmuxId, 'codex-rapid-025342');
    assert.equal(byCodex.get('codex-rapid-c')?.tmuxPaneId, '%242');
  });
});

test.skip('session index remembers discovered Codex roots long enough to catch SessionEnd after tmux closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-discovered-root-'));
  const bridgeRoot = join(root, 'bridge');
  const projectRoot = join(root, 'chiz-crab');
  const codexHome = join(root, 'codex-home');
  const tmuxFlag = join(root, 'tmux-on');
  const registryPath = join(bridgeRoot, '.codex', 'state', 'discovered-roots.json');
  await mkdir(join(bridgeRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(projectRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(tmuxFlag, 'on');
  await writeFile(join(projectRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-chiz-live',
    native_session_id: 'codex-chiz-live',
    started_at: '2026-05-05T11:42:23.006Z',
    cwd: projectRoot,
    pid: 988308,
  }) + '\n');

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
PROJECT_ROOT=${JSON.stringify(projectRoot)}
TMUX_FLAG=${JSON.stringify(tmuxFlag)}
case "$1" in
  list-panes)
    if [ -f "$TMUX_FLAG" ]; then
      printf 'codex-chiz-crab\\t%%42\\t988308\\t0\\t%s\\n' "$PROJECT_ROOT"
    fi
    ;;
  list-sessions)
    if [ -f "$TMUX_FLAG" ]; then
      printf 'codex-chiz-crab\\t1777981342\\t1\\n'
    fi
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const activeSessions = await buildSessionIndex({
      projectRoot: bridgeRoot,
      codexHome,
      discoverTmuxProjectRoots: true,
      discoveredProjectRootsPath: registryPath,
      now: '2026-05-05T11:43:00.000Z',
    });
    const active = activeSessions.find((session) => session.codexSessionId === 'codex-chiz-live');
    assert.equal(active?.project, 'chiz-crab');
    assert.equal(active?.status, 'active');

    await writeFile(join(projectRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
      session_id: 'codex-chiz-live',
      native_session_id: 'codex-chiz-live',
      started_at: '2026-05-05T11:42:23.006Z',
      ended_at: '2026-05-05T11:43:29.956Z',
      cwd: projectRoot,
      pid: 988308,
    }) + '\n');
    await rm(tmuxFlag);

    const endedSessions = await buildSessionIndex({
      projectRoot: bridgeRoot,
      codexHome,
      discoverTmuxProjectRoots: true,
      discoveredProjectRootsPath: registryPath,
      now: '2026-05-05T11:44:00.000Z',
    });
    const ended = endedSessions.find((session) => session.codexSessionId === 'codex-chiz-live');
    assert.equal(ended?.project, 'chiz-crab');
    assert.equal(ended?.status, 'ended');
    assert.equal(ended?.endedAt, '2026-05-05T11:43:29.956Z');

    const events = await routeSessionEvents(ended, { projectRoot: ended.lifecycleRoot });
    assert.equal(events.find((event) => event.type === 'SessionEnd' && event.source === 'notification')?.eventId, 'codex-chiz-live:end');
  });
});

test.skip('session index keeps pending SessionStart roots until SessionEnd is indexed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-pending-terminal-root-'));
  const bridgeRoot = join(root, 'bridge');
  const projectRoot = join(root, 'chiz-monitor');
  const runRoot = join(root, 'codex-runs', 'run-20260521030326-2d58');
  const codexHome = join(root, 'codex-home');
  const eventIndexPath = join(bridgeRoot, '.codex', 'state', 'bridge-event-index.sqlite');
  await mkdir(join(bridgeRoot, '.codex', 'state'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-21T03:03:26.667Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-21.jsonl'), [
    { event: 'session_start', session_id: 'codex-delayed-end', pid: 2562506, timestamp: '2026-05-21T03:03:26.902Z' },
    { event: 'session_start_reconciled', session_id: 'codex-delayed-end', native_session_id: 'codex-delayed-end', pid: 2562656, timestamp: '2026-05-21T03:04:08.440Z' },
    { event: 'session_end', session_id: 'codex-delayed-end', native_session_id: 'codex-delayed-end', timestamp: '2026-05-21T03:21:04.098Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-delayed-end',
    native_session_id: 'codex-delayed-end',
    started_at: '2026-05-21T03:03:26.902Z',
    ended_at: '2026-05-21T03:21:04.098Z',
    cwd: projectRoot,
    pid: 2562656,
  }) + '\n');

  const index = await openEventIndex(bridgeRoot, { eventIndexPath });
  upsertEvents(index.db, [{
    session: {
      codexSessionId: 'codex-delayed-end',
      bridgeSessionId: 'codex-delayed-end',
      lifecycleSessionId: 'codex-delayed-end',
      lifecycleRoot: runRoot,
      project: 'chiz-monitor',
      hasBridgeLifecycle: true,
      startedAt: '2026-05-21T03:03:26.902Z',
    },
    event: {
      eventId: 'codex-delayed-end:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-21T03:03:26.902Z',
      text: '새 세션을 시작했어.',
    },
  }]);
  index.db.close();

  const withoutPendingRoot = await buildSessionIndex({
    projectRoot: bridgeRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
    terminalPendingRootDiscoveryEnabled: false,
    eventIndexPath,
  });
  assert.equal(withoutPendingRoot.some((session) => session.lifecycleSessionId === 'codex-delayed-end'), false);

  const withPendingRoot = await buildSessionIndex({
    projectRoot: bridgeRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
    eventIndexPath,
    now: '2026-05-21T03:21:05.000Z',
  });
  const ended = withPendingRoot.find((session) => session.lifecycleSessionId === 'codex-delayed-end');
  assert.equal(ended?.status, 'ended');
  assert.equal(ended?.endedAt, '2026-05-21T03:21:04.098Z');
  assert.equal(ended?.lifecycleRoot, runRoot);

  const events = await routeSessionEvents(ended, { projectRoot: ended.lifecycleRoot });
  assert.equal(events.find((event) => event.type === 'SessionEnd' && event.source === 'notification')?.eventId, 'codex-delayed-end:end');
});

test('session index ignores skipped tmux hook records when mapping live panes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-skipped-hook-'));
  const chizRoot = join(root, 'chiz-wiki');
  const newsRoot = join(root, 'news-insight');
  const codexHome = join(root, 'codex-home');
  await mkdir(join(chizRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(newsRoot, { recursive: true });

  await writeFile(join(chizRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-chiz-thread',
    native_session_id: 'codex-chiz-thread',
    started_at: '2026-05-06T01:10:23.067Z',
    cwd: chizRoot,
    pid: 1001,
  }) + '\n');
  await writeFile(join(chizRoot, '.codex', 'logs', 'tmux-hook-2026-05-06.jsonl'), JSON.stringify({
    timestamp: '2026-05-06T01:10:44.154Z',
    type: 'tmux_hook',
    event: 'injection_skipped',
    reason: 'mode_not_allowed',
    thread_id: 'codex-chiz-thread',
    target: { type: 'pane', value: '%42' },
    dry_run: false,
    sent: false,
  }) + '\n');

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
NEWS_ROOT=${JSON.stringify(newsRoot)}
case "$1" in
  list-panes)
    printf 'codex-news-insight-034017\\t%%42\\t4242\\t0\\t%s\\n' "$NEWS_ROOT"
    ;;
  list-sessions)
    printf 'codex-news-insight-034017\\t1778038817\\t1\\n'
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: chizRoot,
      codexHome,
      discoverTmuxProjectRoots: false,
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].project, 'chiz-wiki');
    assert.equal(sessions[0].cwd, chizRoot);
    assert.equal(sessions[0].tmuxId, null);
    assert.equal(sessions[0].tmuxPaneId, null);
    assert.equal(sessions[0].status, 'unknown');
  });
});

test.skip('session index discovers Codex 0.16 sandboxed isolated state roots by source cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sandboxed-source-'));
  const projectRoot = join(root, 'codex-bridge');
  const runsDir = join(root, 'codex-runs');
  const runRoot = join(runsDir, 'run-20260506044818-0b73');
  const codexHome = join(root, 'codex-home');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T04:48:18.489Z',
    cwd: runRoot,
    source_cwd: projectRoot,
    argv: ['--dangerously-bypass-approvals-and-sandbox'],
  }, null, 2));
  await writeFile(join(runsDir, 'registry.jsonl'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T04:48:18.489Z',
    cwd: runRoot,
    source_cwd: projectRoot,
    argv: ['--dangerously-bypass-approvals-and-sandbox'],
  }) + '\n');
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-06.jsonl'), [
    { event: 'session_start', session_id: 'codex-sandboxed', pid: 2185244, timestamp: '2026-05-06T04:48:18.585Z' },
    { event: 'session_start_reconciled', session_id: 'codex-sandboxed', native_session_id: 'codex-sandboxed', pid: 2185388, timestamp: '2026-05-06T04:51:30.176Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-sandboxed',
    native_session_id: 'codex-sandboxed',
    started_at: '2026-05-06T04:48:18.585Z',
    cwd: projectRoot,
    pid: 2185388,
  }, null, 2));

  const sessions = await buildSessionIndex({
    projectRoot,
    codexHome,
    codexRunsDir: runsDir,
    discoverTmuxProjectRoots: false,
    now: '2026-05-06T05:00:00.000Z',
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].codexSessionId, 'codex-sandboxed');
  assert.equal(sessions[0].lifecycleSessionId, 'codex-sandboxed');
  assert.equal(sessions[0].cwd, projectRoot);
  assert.equal(sessions[0].project, 'codex-bridge');
  assert.equal(sessions[0].lifecycleRoot, runRoot);

  const events = await routeSessionEvents(sessions[0], { projectRoot: sessions[0].lifecycleRoot });
  assert.equal(events.some((event) => event.eventId === 'codex-log:codex-sandboxed:1'), true);
});

test.skip('session index does not promote native-only starts inside an isolated Codex run to lifecycle sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-shadow-'));
  const projectRoot = join(root, 'chiz-crab');
  const runRoot = join(root, 'codex-runs', 'run-20260506093119-4528');
  const codexHome = join(root, 'codex-home');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T09:31:19.520Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-06.jsonl'), [
    { event: 'session_start', session_id: 'launcher-owned-primary', pid: 513878, timestamp: '2026-05-06T09:31:19.615Z' },
    { event: 'session_start_reconciled', session_id: 'launcher-owned-primary', native_session_id: '019df490-af5e-7343-b890-f68c1d05d45d', pid: 514032, timestamp: '2026-05-06T09:32:49.281Z' },
    { event: 'session_start', session_id: '019dfce5-f473-7a10-958a-6fb085820ca0', native_session_id: '019dfce5-f473-7a10-958a-6fb085820ca0', pid: 1350069, timestamp: '2026-05-06T10:47:09.421Z' },
    { event: 'session_start', session_id: '019dfce7-8fff-7ea2-bc01-227b04023ee1', native_session_id: '019dfce7-8fff-7ea2-bc01-227b04023ee1', pid: 1374708, timestamp: '2026-05-06T10:48:52.821Z' },
    { event: 'session_start', session_id: '019dfce8-aec1-7b42-b63a-bcdd31627b95', native_session_id: '019dfce8-aec1-7b42-b63a-bcdd31627b95', pid: 1392083, timestamp: '2026-05-06T10:50:05.751Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: '019dfce8-aec1-7b42-b63a-bcdd31627b95',
    native_session_id: '019dfce8-aec1-7b42-b63a-bcdd31627b95',
    started_at: '2026-05-06T10:50:05.751Z',
    cwd: projectRoot,
    pid: 1392083,
    pid_cmdline: 'codex exec --json --ephemeral -',
  }, null, 2));

  const sessions = await buildSessionIndex({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const main = sessions.find((session) => session.lifecycleSessionId === 'launcher-owned-primary');
  assert.equal(main?.hasBridgeLifecycle, true);
  assert.equal(main?.project, 'chiz-crab');
  assert.equal(sessions.filter((session) => session.hasBridgeLifecycle === true).length, 1);
  assert.equal(
    sessions.find((session) => session.codexSessionId === '019dfce8-aec1-7b42-b63a-bcdd31627b95')?.hasBridgeLifecycle,
    false,
  );

  const events = (await Promise.all(sessions.map((session) => (
    routeSessionEvents(session, { projectRoot: session.lifecycleRoot || runRoot })
  )))).flat();
  assert.deepEqual(
    events.filter((event) => event.type === 'SessionStart' && event.source === 'notification').map((event) => event.eventId),
    ['launcher-owned-primary:start'],
  );
});

test.skip('session index keeps current native Codex session attached to its owned Codex lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-current-native-owned-'));
  const projectRoot = join(root, 'chiz-wiki');
  const runRoot = join(root, 'codex-runs', 'run-20260506100716-84e0');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T10:07:16.603Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-06.jsonl'), [
    { event: 'session_start', session_id: 'codex-owned-visible', pid: 878706, timestamp: '2026-05-06T10:07:16.684Z' },
    { event: 'session_start_reconciled', session_id: 'codex-owned-visible', native_session_id: 'codex-initial', pid: 878832, timestamp: '2026-05-06T10:19:07.893Z' },
    { event: 'session_start', session_id: 'codex-current', native_session_id: 'codex-current', pid: 878832, timestamp: '2026-05-06T10:40:43.193Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-current',
    native_session_id: 'codex-current',
    started_at: '2026-05-06T10:40:43.193Z',
    cwd: projectRoot,
    pid: 878832,
    pid_cmdline: `${process.execPath} codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file="${runRoot}/.codex/state/sessions/codex-owned-visible/AGENTS.md"`,
  }, null, 2));
  await writeFile(join(sessionsDir, 'rollout-2026-05-06T10-40-43-codex-current.jsonl'), [
    { timestamp: '2026-05-06T10:40:43.193Z', type: 'session_meta', payload: { id: 'codex-current', timestamp: '2026-05-06T10:40:43.193Z', cwd: projectRoot } },
    { timestamp: '2026-05-06T10:59:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '현재 세션 확인' }] } },
    { timestamp: '2026-05-06T11:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '완료했습니다.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const current = sessions.find((session) => session.codexSessionId === 'codex-current');
  assert.equal(current?.lifecycleSessionId, 'codex-owned-visible');
  assert.equal(current?.hasBridgeLifecycle, true);
  assert.equal(current?.lifecycleOwner, 'codex');
  assert.equal(current?.startedAt, '2026-05-06T10:07:16.684Z');

  const events = await routeSessionEvents(current, { projectRoot: current.lifecycleRoot });
  assert.equal(events.some((event) => event.type === 'FinalAnswer' && event.eventId === 'codex-current:message-3'), true);
  assert.equal(
    events.filter((event) => event.type === 'SessionStart' && event.source === 'notification').map((event) => event.eventId)[0],
    'codex-owned-visible:start',
  );

  const registrySessions = await listSessions({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const mapped = registrySessions.find((session) => session.lifecycleSessionId === 'codex-owned-visible');
  assert.equal(mapped?.bridgeSessionId, 'codex-current');
  assert.equal(mapped?.codexThreadId, 'codex-current');

  const byOldCodexId = await getSessionById('codex-owned-visible', {
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  assert.equal(byOldCodexId?.bridgeSessionId, 'codex-current');
  assert.equal(byOldCodexId?.codexSessionId, 'codex-current');
});

test.skip('session index does not emit SessionEnd for replaced native helper sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-replaced-native-helper-'));
  const projectRoot = join(root, 'memory-project');
  const runRoot = join(root, 'codex-runs', 'run-20260514094807-572f');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '14');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex',
    created_at: '2026-05-14T09:48:07.500Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-parent',
    native_session_id: 'codex-helper',
    started_at: '2026-05-14T09:49:13.550Z',
    ended_at: '2026-05-15T00:33:15.903Z',
    cwd: projectRoot,
    pid: 3371771,
    active_session_id: 'codex-helper',
  }) + '\n');
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
    { event: 'session_start', session_id: 'codex-parent', pid: 3357929, timestamp: '2026-05-14T09:48:07.596Z' },
    { event: 'session_start_reconciled', session_id: 'codex-parent', native_session_id: 'codex-parent', pid: 3358037, timestamp: '2026-05-14T09:48:58.885Z' },
    {
      event: 'native_session_replaced',
      session_id: 'codex-parent',
      previous_native_session_id: 'codex-parent',
      replaced_by_native_session_id: 'codex-helper',
      pid: 3371771,
      timestamp: '2026-05-14T09:49:13.533Z',
    },
    { event: 'session_start', session_id: 'codex-helper', native_session_id: 'codex-helper', pid: 3371771, timestamp: '2026-05-14T09:49:13.550Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-15.jsonl'), JSON.stringify({
    event: 'session_end',
    session_id: 'codex-parent',
    native_session_id: 'codex-helper',
    active_session_id: 'codex-helper',
    timestamp: '2026-05-15T00:33:15.903Z',
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T18-48-08-codex-parent.jsonl'), [
    {
      timestamp: '2026-05-14T09:48:58.885Z',
      type: 'session_meta',
      payload: {
        id: 'codex-parent',
        timestamp: '2026-05-14T09:48:58.885Z',
        cwd: projectRoot,
        base_instructions: { text: '**Session:** codex-parent | 2026-05-14T09:48:07.596Z' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T18-49-07-codex-helper.jsonl'), [
    {
      timestamp: '2026-05-14T09:49:07.466Z',
      type: 'session_meta',
      payload: {
        id: 'codex-helper',
        timestamp: '2026-05-14T09:49:07.187Z',
        cwd: projectRoot,
        originator: 'codex_exec',
        base_instructions: { text: '# Codex Explore Lightweight Instructions\n\nread-only only' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const helper = sessions.find((session) => session.lifecycleSessionId === 'codex-helper');
  assert.equal(helper?.hasBridgeLifecycle, undefined);

  const events = (await Promise.all(sessions.map((session) => (
    routeSessionEvents(session, { projectRoot: session.lifecycleRoot || runRoot })
  )))).flat();
  const endIds = events
    .filter((event) => event.type === 'SessionEnd' && event.source === 'notification')
    .map((event) => event.eventId);
  assert.equal(endIds.includes('codex-helper:end'), false);
  assert.equal(endIds.includes('codex-parent:end'), true);
});

test.skip('session index routes resumed slash-command logs while keeping the owned Codex lifecycle canonical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-resume-active-log-'));
  const projectRoot = join(root, 'codex-bridge');
  const runRoot = join(root, 'codex-runs', 'run-20260510190111-7aac');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '10');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-10T09:01:11.120Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-10.jsonl'), [
    { event: 'session_start', session_id: 'codex-visible', pid: 1490821, timestamp: '2026-05-10T09:01:11.322Z' },
    { event: 'session_start_reconciled', session_id: 'codex-visible', native_session_id: 'codex-initial', pid: 1490968, timestamp: '2026-05-10T09:02:11.069Z' },
    { event: 'session_start', session_id: 'codex-resumed', native_session_id: 'codex-resumed', pid: 1490968, timestamp: '2026-05-10T10:17:04.503Z' },
    { event: 'session_start', session_id: 'codex-stale-new', native_session_id: 'codex-stale-new', pid: 1490968, timestamp: '2026-05-10T10:52:55.472Z' },
    { event: 'session_start', session_id: 'codex-after-new', native_session_id: 'codex-after-new', pid: 1490968, timestamp: '2026-05-10T11:39:13.474Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-stale-new',
    native_session_id: 'codex-stale-new',
    started_at: '2026-05-10T10:52:55.472Z',
    cwd: projectRoot,
    pid: 1490968,
    pid_cmdline: `${process.execPath} codex -c model_instructions_file="${runRoot}/.codex/state/sessions/codex-visible/AGENTS.md"`,
  }, null, 2));

  await writeFile(join(sessionsDir, 'rollout-2026-05-10T19-44-56-codex-stale-new.jsonl'), [
    { timestamp: '2026-05-10T10:52:55.472Z', type: 'session_meta', payload: { id: 'codex-stale-new', timestamp: '2026-05-10T10:52:55.472Z', cwd: projectRoot } },
    { timestamp: '2026-05-10T10:53:01.993Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stale prompt' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-10T19-16-25-codex-resumed.jsonl'), [
    { timestamp: '2026-05-10T10:17:04.265Z', type: 'session_meta', payload: { id: 'codex-resumed', timestamp: '2026-05-10T10:16:25.772Z', cwd: projectRoot } },
    { timestamp: '2026-05-10T11:37:34.517Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '/resume 뒤 입력' }] } },
    { timestamp: '2026-05-10T11:38:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'resume 답변' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-10T20-39-13-codex-after-new.jsonl'), [
    { timestamp: '2026-05-10T11:39:13.474Z', type: 'session_meta', payload: { id: 'codex-after-new', timestamp: '2026-05-10T11:39:13.474Z', cwd: projectRoot } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const active = sessions.find((session) => session.lifecycleSessionId === 'codex-visible');
  assert.equal(active?.codexSessionId, 'codex-after-new');
  assert.equal(active?.sessionLogMatchSource, 'active-codex-log');
  assert.deepEqual(
    active.associatedCodexLogs.map((log) => log.codexSessionId),
    ['codex-after-new', 'codex-resumed', 'codex-stale-new'],
  );

  const events = await routeSessionEvents(active, { projectRoot: active.lifecycleRoot });
  assert.equal(events.some((event) => event.eventId === 'codex-resumed:message-2' && event.type === 'CommandSubmitted'), true);
  assert.equal(events.some((event) => event.eventId === 'codex-resumed:message-3' && event.type === 'FinalAnswer'), true);
  assert.equal(events.some((event) => event.type === 'SessionStart' && event.source === 'notification'), false);
});

test.skip('session index keeps runtime-owned user Codex log when helper current state overwrites session.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-helper-overwrite-runtime-log-'));
  const projectRoot = join(root, 'gunsan_new');
  const runRoot = join(root, 'codex-runs', 'run-20260514095508-7add');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '15');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-14T09:55:08.458Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
    { event: 'session_start', session_id: 'codex-visible', pid: 528192, timestamp: '2026-05-14T09:55:08.458Z' },
    { event: 'session_start_reconciled', session_id: 'codex-visible', native_session_id: 'codex-old', pid: 528192, timestamp: '2026-05-14T09:55:20.000Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-15.jsonl'), [
    { event: 'session_start', session_id: 'codex-linked', native_session_id: 'codex-linked', pid: 528192, timestamp: '2026-05-15T05:15:24.388Z' },
    { event: 'session_start', session_id: 'codex-helper', native_session_id: 'codex-helper', pid: 2083727, timestamp: '2026-05-15T07:20:00.000Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-helper',
    native_session_id: 'codex-helper',
    started_at: '2026-05-15T07:20:00.000Z',
    cwd: projectRoot,
    pid: 2083727,
    pid_cmdline: 'codex exec --json --ephemeral - codex explore --prompt "lookup"',
  }, null, 2));

  await writeFile(join(sessionsDir, 'rollout-2026-05-14T18-55-20-codex-old.jsonl'), [
    {
      timestamp: '2026-05-14T09:55:20.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-old',
        timestamp: '2026-05-14T09:55:20.000Z',
        cwd: projectRoot,
        base_instructions: { text: '<!-- Codex:RUNTIME:START -->\n**Session:** codex-visible | 2026-05-14T09:55:08.458Z\n<!-- Codex:RUNTIME:END -->' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-15T14-15-24-codex-linked.jsonl'), [
    {
      timestamp: '2026-05-15T05:15:24.388Z',
      type: 'session_meta',
      payload: {
        id: 'codex-linked',
        timestamp: '2026-05-15T05:15:24.388Z',
        cwd: projectRoot,
        thread_source: 'user',
        base_instructions: { text: '<!-- Codex:RUNTIME:START -->\n**Session:** codex-visible | 2026-05-14T09:55:08.458Z\n<!-- Codex:RUNTIME:END -->' },
      },
    },
    { timestamp: '2026-05-15T07:34:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '변경사항 커밋 푸시' }] } },
    { timestamp: '2026-05-15T07:35:20.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '커밋은 이미 완료됐고 push는 인증정보 없어 실패했습니다.' }] } },
    { timestamp: '2026-05-15T07:35:27.306Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '커밋은 이미 완료됐고 push는 인증정보 없어 실패했습니다.' } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-15T16-20-00-codex-helper.jsonl'), [
    {
      timestamp: '2026-05-15T07:20:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-helper',
        timestamp: '2026-05-15T07:20:00.000Z',
        cwd: projectRoot,
        originator: 'codex_exec',
        base_instructions: { text: '# Codex Explore Lightweight Instructions\n\nread-only only' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: runRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const active = sessions.find((session) => session.lifecycleSessionId === 'codex-visible');
  assert.equal(active?.codexSessionId, 'codex-linked');
  assert.equal(active?.sessionLogMatchSource, 'runtime-codex-session');
  assert.deepEqual(
    active.associatedCodexLogs.map((log) => log.codexSessionId),
    ['codex-linked', 'codex-old'],
  );
  assert.equal(sessions.some((session) => session.lifecycleSessionId === 'codex-linked'), false);

  const events = await routeSessionEvents(active, { projectRoot: active.lifecycleRoot });
  assert.equal(events.some((event) => event.eventId === 'codex-linked:message-2' && event.type === 'CommandSubmitted'), true);
  assert.equal(events.some((event) => event.eventId === 'codex-linked:message-3' && event.type === 'FinalAnswer'), true);
  assert.equal(events.some((event) => event.eventId === 'codex-linked:message-3:idle' && event.type === 'SessionIdle'), true);
});

test.skip('session index keeps runtime-owned Codex logs attached to their Codex session thread owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-owner-active-log-'));
  const projectRoot = join(root, 'docs');
  const oldRunRoot = join(root, 'codex-runs', 'run-old');
  const newRunRoot = join(root, 'codex-runs', 'run-new');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '14');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(oldRunRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(oldRunRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(newRunRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(newRunRoot, '.codex', 'state'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  for (const [runRoot, sessionId, createdAt] of [
    [oldRunRoot, 'codex-old', '2026-05-14T01:00:00.000Z'],
    [newRunRoot, 'codex-new', '2026-05-14T01:18:14.000Z'],
  ]) {
    await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
      launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
      created_at: createdAt,
      cwd: runRoot,
      source_cwd: projectRoot,
    }, null, 2));
    await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
      { event: 'session_start', session_id: sessionId, pid: sessionId === 'codex-old' ? 1001 : 2001, timestamp: createdAt },
    ].map((line) => JSON.stringify(line)).join('\n'));
  }

  await writeFile(join(oldRunRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-old',
    native_session_id: 'codex-old',
    started_at: '2026-05-14T01:00:00.000Z',
    cwd: projectRoot,
    pid: 1002,
    pid_cmdline: `${process.execPath} codex -c model_instructions_file="${oldRunRoot}/.codex/state/sessions/codex-old/AGENTS.md"`,
  }, null, 2));
  await writeFile(join(newRunRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-new',
    native_session_id: 'codex-new',
    started_at: '2026-05-14T01:18:17.000Z',
    cwd: projectRoot,
    pid: 2002,
    pid_cmdline: `${process.execPath} codex -c model_instructions_file="${newRunRoot}/.codex/state/sessions/codex-new/AGENTS.md"`,
  }, null, 2));

  await writeFile(join(sessionsDir, 'rollout-2026-05-14T10-00-00-codex-old.jsonl'), [
    { timestamp: '2026-05-14T01:00:00.000Z', type: 'session_meta', payload: { id: 'codex-old', timestamp: '2026-05-14T01:00:00.000Z', cwd: projectRoot } },
    { timestamp: '2026-05-14T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T10-18-17-codex-new.jsonl'), [
    {
      timestamp: '2026-05-14T01:19:17.635Z',
      type: 'session_meta',
      payload: {
        id: 'codex-new',
        timestamp: '2026-05-14T01:18:17.000Z',
        cwd: projectRoot,
        base_instructions: {
          text: [
            '<!-- Codex:RUNTIME:START -->',
            '<session_context>',
            '**Session:** codex-new | 2026-05-14T01:18:14.000Z',
            '**tmux:** codex-docs-101814',
            '</session_context>',
            '<!-- Codex:RUNTIME:END -->',
          ].join('\n'),
        },
      },
    },
    { timestamp: '2026-05-14T01:19:17.670Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new prompt' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T10-19-30-codex-ambiguous.jsonl'), [
    { timestamp: '2026-05-14T01:19:30.000Z', type: 'session_meta', payload: { id: 'codex-ambiguous', timestamp: '2026-05-14T01:19:30.000Z', cwd: projectRoot } },
    { timestamp: '2026-05-14T01:19:31.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ambiguous prompt' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T11-09-38-codex-subagent.jsonl'), [
    {
      timestamp: '2026-05-14T02:09:38.468Z',
      type: 'session_meta',
      payload: {
        id: 'codex-subagent',
        timestamp: '2026-05-14T02:09:38.073Z',
        cwd: projectRoot,
        thread_source: 'subagent',
        agent_nickname: 'Maxwell',
        agent_role: 'architect',
        source: { subagent: { thread_spawn: { parent_thread_id: 'codex-new' } } },
        base_instructions: {
          text: [
            '<!-- Codex:RUNTIME:START -->',
            '<session_context>',
            '**Session:** codex-new | 2026-05-14T01:18:14.000Z',
            '**tmux:** codex-docs-101814',
            '</session_context>',
            '<!-- Codex:RUNTIME:END -->',
          ].join('\n'),
        },
      },
    },
    { timestamp: '2026-05-14T02:09:52.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'APPROVED — subagent verdict' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: oldRunRoot,
    projectRoots: [oldRunRoot, newRunRoot],
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  const oldSession = sessions.find((session) => session.lifecycleSessionId === 'codex-old');
  const newSession = sessions.find((session) => session.lifecycleSessionId === 'codex-new');
  assert.equal(oldSession?.codexSessionId, 'codex-old');
  assert.equal(newSession?.codexSessionId, 'codex-new');
  assert.equal(newSession?.sessionLogOwnerMatch, 'runtime-codex-session');
  assert.equal(newSession?.runtimeBridgeSessionId, 'codex-new');
  assert.equal(oldSession?.associatedCodexLogs.some((log) => log.codexSessionId === 'codex-new'), false);
  assert.equal(oldSession?.associatedCodexLogs.some((log) => log.codexSessionId === 'codex-ambiguous'), false);
  assert.equal(newSession?.associatedCodexLogs.some((log) => log.codexSessionId === 'codex-ambiguous'), false);
  assert.equal(newSession?.associatedCodexLogs.some((log) => log.codexSessionId === 'codex-subagent'), false);

  const oldEvents = await routeSessionEvents(oldSession, { projectRoot: oldSession.lifecycleRoot });
  const newEvents = await routeSessionEvents(newSession, { projectRoot: newSession.lifecycleRoot });
  assert.equal(oldEvents.some((event) => event.eventId === 'codex-new:message-2' && event.type === 'CommandSubmitted'), false);
  assert.equal(newEvents.some((event) => event.eventId === 'codex-new:message-2' && event.type === 'CommandSubmitted'), true);
  assert.equal(newEvents.some((event) => event.eventId === 'codex-ambiguous:message-2' && event.type === 'CommandSubmitted'), false);
  assert.equal(newEvents.some((event) => /subagent verdict/.test(event.text || '')), false);
});

test.skip('session index routes resumed Codex prompts through the current Codex tmux session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-current-resume-thread-'));
  const projectRoot = join(root, 'news-insight');
  const oldRunRoot = join(root, 'codex-runs', 'run-old');
  const newRunRoot = join(root, 'codex-runs', 'run-new');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '25');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(oldRunRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(oldRunRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(newRunRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(newRunRoot, '.codex', 'state'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(oldRunRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-24T15:45:40.000Z',
    cwd: oldRunRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(newRunRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-24T17:17:31.000Z',
    cwd: newRunRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(oldRunRoot, '.codex', 'logs', 'codex-2026-05-24.jsonl'), [
    { event: 'session_start', session_id: 'codex-old-thread', pid: 1001, timestamp: '2026-05-24T15:45:40.000Z' },
    { event: 'session_end', session_id: 'codex-old-thread', pid: 1001, timestamp: '2026-05-24T16:45:40.000Z', reason: 'session_exit' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(newRunRoot, '.codex', 'logs', 'codex-2026-05-24.jsonl'), [
    { event: 'session_start', session_id: 'codex-current-thread', pid: 2001, timestamp: '2026-05-24T17:17:31.000Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));

  await writeFile(join(newRunRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-current-thread',
    native_session_id: 'codex-resumed-thread',
    started_at: '2026-05-24T17:17:31.684Z',
    cwd: projectRoot,
    pid: 2002,
    pid_cmdline: `${process.execPath} codex -c model_instructions_file="${newRunRoot}/.codex/state/sessions/codex-current-thread/AGENTS.md"`,
  }, null, 2));

  await writeFile(join(sessionsDir, 'rollout-2026-05-25T00-45-50-codex-resumed-thread.jsonl'), [
    {
      timestamp: '2026-05-24T15:45:50.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-resumed-thread',
        timestamp: '2026-05-24T15:45:50.000Z',
        cwd: projectRoot,
        base_instructions: {
          text: [
            '<!-- Codex:RUNTIME:START -->',
            '<session_context>',
            '**Session:** codex-old-thread | 2026-05-24T15:45:40.000Z',
            '**tmux:** codex-news-insight-004540',
            '</session_context>',
            '<!-- Codex:RUNTIME:END -->',
          ].join('\n'),
        },
      },
    },
    { timestamp: '2026-05-24T15:45:51.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] } },
    { timestamp: '2026-05-24T17:18:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '실패했던 뉴스 인사이트 마무리는 못하나?' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "list-panes" ]; then
  printf 'codex-news-insight-021728\\t%%77\\t2002\\t0\\t%s\\n' ${JSON.stringify(projectRoot)}
elif [ "$1" = "list-sessions" ]; then
  printf 'codex-news-insight-021728\\t1779643051\\t1\\n'
fi
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: newRunRoot,
      projectRoots: [oldRunRoot, newRunRoot],
      codexHome,
      discoverTmuxProjectRoots: true,
    });
    const matches = sessions.filter((session) => session.codexSessionId === 'codex-resumed-thread');
    assert.equal(matches.length, 1);
    const [session] = matches;
    const oldSession = sessions.find((candidate) => candidate.lifecycleSessionId === 'codex-old-thread');
    assert.ok(oldSession);
    assert.equal(oldSession.status, 'ended');
    assert.notEqual(oldSession.codexSessionId, 'codex-resumed-thread');
    assert.equal(session.lifecycleSessionId, 'codex-current-thread');
    assert.equal(session.tmuxId, 'codex-news-insight-021728');
    assert.equal(session.status, 'active');
    assert.equal(session.resumedCodexSession, true);
    assert.equal(session.runtimeBridgeSessionId, 'codex-old-thread');

    const oldEvents = await routeSessionEvents(oldSession, { projectRoot: oldSession.lifecycleRoot });
    const events = await routeSessionEvents(session, { projectRoot: session.lifecycleRoot });
    assert.equal(oldEvents.some((event) => event.eventId === 'codex-resumed-thread:message-3' && event.type === 'CommandSubmitted'), false);
    assert.equal(oldEvents.some((event) => event.type === 'CommandSubmitted' && event.text === '실패했던 뉴스 인사이트 마무리는 못하나?'), false);
    assert.equal(events.some((event) => event.eventId === 'codex-resumed-thread:message-3' && event.type === 'CommandSubmitted'), true);
  });
});

test('router emits remapped SessionStart only after the primary Codex log has a real user command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remap-prompt-gate-'));
  const noPromptLog = join(root, 'rollout-no-prompt.jsonl');
  const promptedLog = join(root, 'rollout-prompted.jsonl');
  await writeFile(noPromptLog, [
    { timestamp: '2026-05-10T12:00:00.000Z', type: 'session_meta', payload: { id: 'codex-no-prompt', timestamp: '2026-05-10T12:00:00.000Z', cwd: root } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(promptedLog, [
    { timestamp: '2026-05-10T12:00:00.000Z', type: 'session_meta', payload: { id: 'codex-prompted', timestamp: '2026-05-10T12:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-10T12:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '새 세션에서 첫 프롬프트' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const base = {
    bridgeSessionId: 'codex-remapped',
    lifecycleSessionId: 'codex-visible',
    startedAt: '2026-05-10T11:59:00.000Z',
    hasBridgeLifecycle: true,
    project: 'codex-bridge',
  };
  const beforePrompt = await routeSessionEvents({
    ...base,
    codexSessionId: 'codex-no-prompt',
    threadId: 'codex-no-prompt',
    sessionLogPath: noPromptLog,
    sessionLogMatchSource: 'active-codex-log',
  }, { projectRoot: root });
  assert.equal(beforePrompt.some((event) => event.type === 'SessionStart' && event.source === 'notification'), false);

  const afterPrompt = await routeSessionEvents({
    ...base,
    codexSessionId: 'codex-prompted',
    threadId: 'codex-prompted',
    sessionLogPath: promptedLog,
    sessionLogMatchSource: 'active-codex-log',
  }, { projectRoot: root });
  assert.equal(
    afterPrompt.find((event) => event.type === 'SessionStart' && event.source === 'notification')?.eventId,
    'codex-visible:start',
  );
});

test('session index treats project-root native-only codex exec starts as non-lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-project-native-only-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await mkdir(join(root, '.codex', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-06.jsonl'), [
    { event: 'session_start', session_id: 'codex-native-a', native_session_id: 'codex-native-a', pid: 1616883, timestamp: '2026-05-06T11:06:16.075Z' },
    { event: 'session_start', session_id: 'codex-native-b', native_session_id: 'codex-native-b', pid: 1646344, timestamp: '2026-05-06T11:08:14.057Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(root, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-native-b',
    native_session_id: 'codex-native-b',
    started_at: '2026-05-06T11:08:14.057Z',
    cwd: root,
    pid: 1646344,
    pid_cmdline: 'codex exec --json --ephemeral -',
  }, null, 2));

  const sessions = await buildSessionIndex({
    projectRoot: root,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.hasBridgeLifecycle === true), false);

  const events = (await Promise.all(sessions.map((session) => (
    routeSessionEvents(session, { projectRoot: root })
  )))).flat();
  assert.deepEqual(events.filter((event) => event.type === 'SessionStart' && event.source === 'notification'), []);
});

test('session index treats bridge session-history entries as lifecycle records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-history-native-only-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-native-history',
    native_session_id: 'codex-native-history',
    started_at: '2026-05-06T08:25:04.135Z',
    ended_at: '2026-05-06T09:29:53.518Z',
    cwd: root,
    pid: 3451614,
  }) + '\n');

  const sessions = await buildSessionIndex({
    projectRoot: root,
    codexHome,
    discoverTmuxProjectRoots: false,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].hasBridgeLifecycle, true);

  const events = await routeSessionEvents(sessions[0], { projectRoot: root });
  assert.equal(events.some((event) => event.type === 'SessionStart' || event.type === 'SessionEnd'), true);
});

test.skip('session index routes Codex team worker worktrees to the leader project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-team-worker-project-'));
  const projectRoot = join(root, 'chiz-crab');
  const workerRoot = join(projectRoot, '.codex', 'team', 'extractor-safety', 'worktrees', 'worker-1');
  const codexHome = join(root, 'codex-home');
  await mkdir(join(workerRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(workerRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-team-worker-1',
    native_session_id: 'codex-team-worker-1',
    started_at: '2026-05-06T07:12:28.000Z',
    cwd: workerRoot,
    pid: 1234,
  }) + '\n');

  const sessions = await buildSessionIndex({
    projectRoot: workerRoot,
    codexHome,
    discoverTmuxProjectRoots: false,
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].codexSessionId, 'codex-team-worker-1');
  assert.equal(sessions[0].cwd, workerRoot);
  assert.equal(sessions[0].sourceCwd, projectRoot);
  assert.equal(sessions[0].project, 'chiz-crab');
  assert.equal(inferSessionKind(sessions[0]), 'codex-team');
});

test.skip('session index remembers sandboxed isolated roots after the tmux pane closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sandboxed-remember-'));
  const bridgeRoot = join(root, 'bridge');
  const projectRoot = join(root, 'chiz-crab');
  const runsDir = join(root, 'codex-runs');
  const runRoot = join(runsDir, 'run-20260506110000-dead');
  const codexHome = join(root, 'codex-home');
  const registryPath = join(bridgeRoot, '.codex', 'state', 'discovered-roots.json');
  const tmuxFlag = join(root, 'tmux-on');
  await mkdir(join(bridgeRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(tmuxFlag, 'on');

  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T11:00:00.000Z',
    cwd: runRoot,
    source_cwd: projectRoot,
    argv: ['--dangerously-bypass-approvals-and-sandbox'],
  }, null, 2));
  await writeFile(join(runsDir, 'registry.jsonl'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-06T11:00:00.000Z',
    cwd: runRoot,
    source_cwd: projectRoot,
    argv: ['--dangerously-bypass-approvals-and-sandbox'],
  }) + '\n');
  await writeFile(join(runRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'codex-sandboxed-live',
    native_session_id: 'codex-sandboxed-live',
    started_at: '2026-05-06T11:00:00.000Z',
    cwd: projectRoot,
    pid: 1001,
  }) + '\n');

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
PROJECT_ROOT=${JSON.stringify(projectRoot)}
TMUX_FLAG=${JSON.stringify(tmuxFlag)}
case "$1" in
  list-panes)
    if [ -f "$TMUX_FLAG" ]; then
      printf 'codex-chiz-crab\\t%%42\\t1001\\t0\\t%s\\n' "$PROJECT_ROOT"
    fi
    ;;
  list-sessions)
    if [ -f "$TMUX_FLAG" ]; then
      printf 'codex-chiz-crab\\t1778065200\\t1\\n'
    fi
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const activeSessions = await buildSessionIndex({
      projectRoot: bridgeRoot,
      codexHome,
      codexRunsDir: runsDir,
      discoverTmuxProjectRoots: true,
      discoveredProjectRootsPath: registryPath,
      now: '2026-05-06T11:01:00.000Z',
    });
    const active = activeSessions.find((session) => session.codexSessionId === 'codex-sandboxed-live');
    assert.equal(active?.cwd, projectRoot);
    assert.equal(active?.lifecycleRoot, runRoot);
    assert.equal(active?.status, 'active');

    await writeFile(join(runRoot, '.codex', 'logs', 'session-history.jsonl'), JSON.stringify({
      session_id: 'codex-sandboxed-live',
      native_session_id: 'codex-sandboxed-live',
      started_at: '2026-05-06T11:00:00.000Z',
      ended_at: '2026-05-06T11:05:00.000Z',
      cwd: projectRoot,
      pid: 1001,
    }) + '\n');
    await rm(tmuxFlag);

    const endedSessions = await buildSessionIndex({
      projectRoot: bridgeRoot,
      codexHome,
      codexRunsDir: runsDir,
      discoverTmuxProjectRoots: true,
      discoveredProjectRootsPath: registryPath,
      now: '2026-05-06T11:06:00.000Z',
    });
    const ended = endedSessions.find((session) => session.codexSessionId === 'codex-sandboxed-live');
    assert.equal(ended?.cwd, projectRoot);
    assert.equal(ended?.lifecycleRoot, runRoot);
    assert.equal(ended?.status, 'ended');
    assert.equal(ended?.endedAt, '2026-05-06T11:05:00.000Z');
  });
});

test.skip('session scan limit keeps the newest ended lifecycle sessions ahead of stale active-looking sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-limit-ended-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push({
      session_id: `old-active-looking-${index}`,
      native_session_id: `codex-old-active-looking-${index}`,
      started_at: `2026-05-04T20:${String(index).padStart(2, '0')}:00.000Z`,
      cwd: root,
      pid: 1000 + index,
    });
  }
  history.push({
    session_id: 'codex-newly-ended',
    native_session_id: 'codex-newly-ended',
    started_at: '2026-05-05T13:04:45.653Z',
    ended_at: '2026-05-05T13:06:04.996Z',
    cwd: root,
    pid: 2182798,
  });
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), history.map((line) => JSON.stringify(line)).join('\n'));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
case "$1" in
  list-panes)
    printf 'current-live-tmux\\t%%55\\t4242\\t0\\t%s\\n' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'current-live-tmux\\t1777987000\\t1\\n'
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: root,
      codexHome,
      discoverTmuxProjectRoots: false,
      sessionScanLimit: 15,
    });
    const ended = sessions.find((session) => session.codexSessionId === 'codex-newly-ended');
    assert.equal(ended?.status, 'ended');
    assert.equal(ended?.endedAt, '2026-05-05T13:06:04.996Z');

    const events = await routeSessionEvents(ended, { projectRoot: root });
    assert.equal(events.find((event) => event.type === 'SessionEnd' && event.source === 'notification')?.eventId, 'codex-newly-ended:end');
  });
});

test('session scan limit keeps lifecycle sessions ahead of newer native-only batch starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-limit-native-only-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  const records = [
    {
      event: 'session_start',
      session_id: 'owned-visible-session',
      timestamp: '2026-05-06T09:31:19.615Z',
      pid: 513878,
    },
    {
      event: 'session_start_reconciled',
      session_id: 'owned-visible-session',
      native_session_id: 'codex-owned-visible-session',
      timestamp: '2026-05-06T09:32:49.281Z',
      pid: 514032,
    },
  ];
  for (let index = 0; index < 20; index += 1) {
    records.push({
      event: 'session_start',
      session_id: `codex-native-batch-${index}`,
      native_session_id: `codex-native-batch-${index}`,
      timestamp: `2026-05-06T11:${String(index).padStart(2, '0')}:00.000Z`,
      pid: 1600000 + index,
    });
  }
  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-06.jsonl'), records.map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: root,
    codexHome,
    discoverTmuxProjectRoots: false,
    sessionScanLimit: 15,
  });
  assert.ok(sessions.some((session) => session.lifecycleSessionId === 'owned-visible-session' && session.hasBridgeLifecycle === true));

  const lifecycle = sessions.filter((session) => session.hasBridgeLifecycle === true);
  const events = (await Promise.all(lifecycle.map((session) => routeSessionEvents(session, { projectRoot: root })))).flat();
  assert.equal(
    events.find((event) => event.type === 'SessionStart' && event.source === 'notification')?.eventId,
    'owned-visible-session:start',
  );
});

test.skip('session scan limit keeps an ended lifecycle whose Codex log receives new user commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-limit-resumed-log-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '20');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });

  const resumedCodexId = 'codex-resumed-after-end';
  const history = [
    {
      session_id: 'codex-resumed-after-end',
      native_session_id: resumedCodexId,
      started_at: '2026-05-20T10:00:00.000Z',
      ended_at: '2026-05-20T10:05:00.000Z',
      cwd: root,
      pid: 100,
    },
  ];
  for (let index = 0; index < 12; index += 1) {
    history.push({
      session_id: `codex-newer-ended-${index}`,
      native_session_id: `codex-newer-ended-${index}`,
      started_at: `2026-05-20T11:${String(index).padStart(2, '0')}:00.000Z`,
      ended_at: `2026-05-20T11:${String(index).padStart(2, '0')}:30.000Z`,
      cwd: root,
      pid: 200 + index,
    });
  }
  await writeFile(join(root, '.codex', 'logs', 'session-history.jsonl'), history.map((line) => JSON.stringify(line)).join('\n'));
  const resumedPromptText = 'resumed session prompt';
  await writeFile(join(sessionsDir, `rollout-2026-05-20T10-00-00-${resumedCodexId}.jsonl`), [
    { timestamp: '2026-05-20T10:00:00.000Z', type: 'session_meta', payload: { id: resumedCodexId, timestamp: '2026-05-20T10:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-20T12:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: resumedPromptText }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const sessions = await buildSessionIndex({
    projectRoot: root,
    codexHome,
    discoverTmuxProjectRoots: false,
    sessionScanLimit: 5,
  });
  const resumed = sessions.find((session) => session.codexSessionId === resumedCodexId);
  assert.ok(resumed);
  assert.equal(resumed.endedAt, null);
  assert.equal(resumed.status, 'unknown');

  const events = await routeSessionEvents(resumed, { projectRoot: root });
  assert.equal(events.some((event) => event.type === 'CommandSubmitted' && event.text === resumedPromptText), true);
  assert.equal(events.some((event) => event.type === 'SessionEnd'), false);
});

test('Codex task_started events are TurnStart and do not synthesize SessionStart for unmapped logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-turnstart-'));
  const logPath = join(root, 'rollout-2026-05-04T17-01-47-019df3f0.jsonl');
  await writeFile(logPath, [
    { timestamp: '2026-05-04T17:01:47.000Z', type: 'session_meta', payload: { id: '019df3f0', timestamp: '2026-05-04T17:01:47.000Z', cwd: root } },
    { timestamp: '2026-05-04T17:01:47.100Z', type: 'event_msg', payload: { type: 'task_started', message: 'turn started' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const events = await routeSessionEvents({
    bridgeSessionId: '019df3f0',
    codexSessionId: '019df3f0',
    threadId: '019df3f0',
    startedAt: '2026-05-04T17:01:47.000Z',
    sessionLogPath: logPath,
    hasBridgeLifecycle: false,
  }, { projectRoot: root });

  assert.equal(events.some((event) => event.type === 'SessionStart'), false);
  assert.equal(events.filter((event) => event.type === 'TurnStart').length, 1);
});

test('codex explore codex exec logs do not emit fallback completion or idle events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-explore-aux-route-'));
  const logPath = join(root, 'rollout-2026-05-19T16-08-34-019e3f10-a0c7-7101-a822-9863f208ae57.jsonl');
  await writeFile(logPath, [
    {
      timestamp: '2026-05-19T07:08:34.888Z',
      type: 'session_meta',
      payload: {
        id: '019e3f10-a0c7-7101-a822-9863f208ae57',
        timestamp: '2026-05-19T07:08:34.888Z',
        cwd: root,
        originator: 'codex_exec',
        source: 'exec',
        base_instructions: { text: '# Codex Explore Lightweight Instructions\n\nread-only only' },
      },
    },
    { timestamp: '2026-05-19T07:08:40.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '먼저 터미널 권한 문제를 해결한 뒤, 다음 탐색을 실행해 주세요.' }] } },
    { timestamp: '2026-05-19T07:09:00.697Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '먼저 터미널 권한 문제를 해결한 뒤, 다음 탐색을 실행해 주세요.' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const events = await routeSessionEvents({
    bridgeSessionId: '019e3f10-a0c7-7101-a822-9863f208ae57',
    codexSessionId: '019e3f10-a0c7-7101-a822-9863f208ae57',
    threadId: '019e3f10-a0c7-7101-a822-9863f208ae57',
    startedAt: '2026-05-19T07:08:34.888Z',
    sessionLogPath: logPath,
    hasBridgeLifecycle: false,
  }, { projectRoot: root });

  assert.equal(events.some((event) => event.type === 'FinalAnswer'), false);
  assert.equal(events.some((event) => event.type === 'SessionIdle'), false);
  assert.equal(events.some((event) => event.type === 'TurnStart'), false);
});

test('FinalAnswer event id stays stable when delayed task_complete arrives after final message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-final-stable-'));
  const logPath = join(root, 'rollout-2026-05-04T18-29-26-codex-final.jsonl');
  const lines = [
    { timestamp: '2026-05-04T18:29:26.000Z', type: 'session_meta', payload: { id: 'codex-final', timestamp: '2026-05-04T18:29:26.000Z', cwd: root } },
    { timestamp: '2026-05-04T18:35:53.669Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '최종 답변입니다.' }] } },
  ];
  await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join('\n'));

  const beforeTaskComplete = await routeSessionEvents({
    bridgeSessionId: 'codex-final',
    codexSessionId: 'codex-final',
    threadId: 'codex-final',
    startedAt: '2026-05-04T18:29:26.000Z',
    sessionLogPath: logPath,
    hasBridgeLifecycle: false,
  }, { projectRoot: root });

  await writeFile(logPath, [
    ...lines,
    { timestamp: '2026-05-04T18:35:58.919Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '최종 답변입니다.', duration_ms: 1234 } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const afterTaskComplete = await routeSessionEvents({
    bridgeSessionId: 'codex-final',
    codexSessionId: 'codex-final',
    threadId: 'codex-final',
    startedAt: '2026-05-04T18:29:26.000Z',
    sessionLogPath: logPath,
    hasBridgeLifecycle: false,
  }, { projectRoot: root });

  assert.equal(beforeTaskComplete.filter((event) => event.type === 'FinalAnswer').length, 1);
  assert.equal(afterTaskComplete.filter((event) => event.type === 'FinalAnswer').length, 1);
  assert.equal(
    beforeTaskComplete.find((event) => event.type === 'FinalAnswer')?.eventId,
    'codex-final:message-2',
  );
  assert.equal(
    afterTaskComplete.find((event) => event.type === 'FinalAnswer')?.eventId,
    'codex-final:message-2',
  );
  assert.equal(
    afterTaskComplete.find((event) => event.type === 'SessionIdle')?.eventId,
    'codex-final:message-2:idle',
  );
});

test('Codex lifecycle event ids stay stable after native session reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-lifecycle-id-'));
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  const startedAt = '2026-05-04T18:02:38.660Z';

  const beforeReconcile = await routeSessionEvents({
    bridgeSessionId: 'codex-1777917758600-msnnty',
    codexSessionId: 'codex-1777917758600-msnnty',
    lifecycleSessionId: 'codex-1777917758600-msnnty',
    startedAt,
    hasBridgeLifecycle: true,
  }, { projectRoot: root });

  const afterReconcile = await routeSessionEvents({
    bridgeSessionId: '019df428-1750-7023-9cd3-cb8d888ead5e',
    codexSessionId: '019df428-1750-7023-9cd3-cb8d888ead5e',
    lifecycleSessionId: 'codex-1777917758600-msnnty',
    startedAt,
    hasBridgeLifecycle: true,
  }, { projectRoot: root });

  assert.equal(
    beforeReconcile.find((event) => event.type === 'SessionStart')?.eventId,
    'codex-1777917758600-msnnty:start',
  );
  assert.equal(
    afterReconcile.find((event) => event.type === 'SessionStart')?.eventId,
    'codex-1777917758600-msnnty:start',
  );
});

test('router ignores stale Codex SessionEnd records from before a restarted session window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-stale-end-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
  await writeFile(join(root, '.codex', 'logs', 'codex-2026-05-04.jsonl'), [
    {
      event: 'session_start',
      session_id: 'new-codex',
      timestamp: '2026-05-04T10:06:00.000Z',
    },
    {
      event: 'session_start_reconciled',
      session_id: 'new-codex',
      native_session_id: 'codex-reused',
      timestamp: '2026-05-04T10:06:10.000Z',
    },
    {
      event: 'session_end',
      session_id: 'old-codex',
      native_session_id: 'codex-reused',
      timestamp: '2026-05-04T10:05:00.000Z',
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const events = await routeSessionEvents({
    bridgeSessionId: 'codex-reused',
    codexSessionId: 'codex-reused',
    lifecycleSessionId: 'new-codex',
    startedAt: '2026-05-04T10:06:00.000Z',
    hasBridgeLifecycle: true,
  }, { projectRoot: root });

  assert.equal(events.some((event) => event.type === 'SessionEnd'), false);
  assert.ok(events.every((event) => event.timestamp !== '2026-05-04T10:05:00.000Z'));

  const sessions = await buildSessionIndex({ projectRoot: root, codexHome, discoverTmuxProjectRoots: false });
  const restarted = sessions.find((session) => session.codexSessionId === 'codex-reused');
  assert.equal(restarted?.lifecycleSessionId, 'new-codex');
  assert.equal(restarted?.endedAt, null);
});

test.skip('session index marks sandboxed owned lifecycle ended only after conservative observed-exit guards pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-observed-end-'));
  const sourceRoot = join(root, 'project');
  const runRoot = join(root, 'codex-runs', 'run-20260514010000-dead');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '14');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-14T01:00:00.000Z',
    cwd: runRoot,
    source_cwd: sourceRoot,
  }));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
    {
      event: 'session_start',
      session_id: 'codex-observed-end',
      timestamp: '2026-05-14T01:00:00.000Z',
      cwd: runRoot,
      pid: 99999999,
    },
    {
      event: 'session_start_reconciled',
      session_id: 'codex-observed-end',
      native_session_id: 'codex-observed-end',
      timestamp: '2026-05-14T01:00:05.000Z',
      cwd: runRoot,
      pid: 99999999,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-14T01-00-05-codex-observed-end.jsonl'), [
    { timestamp: '2026-05-14T01:00:05.000Z', type: 'session_meta', payload: { id: 'codex-observed-end', timestamp: '2026-05-14T01:00:05.000Z', cwd: runRoot } },
    { timestamp: '2026-05-14T01:02:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'done' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, '#!/bin/sh\nexit 0\n');
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: sourceRoot,
      projectRoots: [runRoot],
      codexHome,
      discoverTmuxProjectRoots: false,
      now: '2026-05-14T01:10:00.000Z',
    });
    const observed = sessions.find((session) => session.lifecycleSessionId === 'codex-observed-end');
    assert.equal(observed?.status, 'ended');
    assert.equal(observed?.endedAt, '2026-05-14T01:10:00.000Z');
    assert.equal(observed?.endedAtSource, 'bridge-observed-exit');
    assert.equal(observed?.endReason, 'bridge_observed_session_exit');

    const events = await routeSessionEvents(observed, { projectRoot: observed.lifecycleRoot });
    const end = events.find((event) => event.type === 'SessionEnd');
    assert.equal(end?.eventId, 'codex-observed-end:end');
    assert.equal(end?.timestamp, '2026-05-14T01:10:00.000Z');
    assert.equal(end?.reason, 'bridge_observed_session_exit');
  });
});

test.skip('session index does not observe-end sandboxed sessions while the known pid is still alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-observed-live-pid-'));
  const sourceRoot = join(root, 'project');
  const runRoot = join(root, 'codex-runs', 'run-20260514010000-live');
  const codexHome = join(root, 'codex-home');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-14T01:00:00.000Z',
    cwd: runRoot,
    source_cwd: sourceRoot,
  }));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), [
    {
      event: 'session_start',
      session_id: 'codex-live-pid',
      timestamp: '2026-05-14T01:00:00.000Z',
      cwd: runRoot,
      pid: process.pid,
    },
    {
      event: 'session_start_reconciled',
      session_id: 'codex-live-pid',
      native_session_id: 'codex-live-pid',
      timestamp: '2026-05-14T01:00:05.000Z',
      cwd: runRoot,
      pid: process.pid,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, '#!/bin/sh\nexit 0\n');
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: sourceRoot,
      projectRoots: [runRoot],
      codexHome,
      discoverTmuxProjectRoots: false,
      now: '2026-05-14T01:10:00.000Z',
    });
    const active = sessions.find((session) => session.lifecycleSessionId === 'codex-live-pid');
    assert.equal(active?.endedAt, null);
    assert.equal(active?.status, 'unknown');
  });
});

test.skip('session index observes ended sandboxed sessions when current state is stale and pid is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-observed-stale-current-'));
  const sourceRoot = join(root, 'project');
  const runRoot = join(root, 'codex-runs', 'run-20260514020000-stale');
  const codexHome = join(root, 'codex-home');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-14T02:00:00.000Z',
    cwd: runRoot,
    source_cwd: sourceRoot,
  }));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), JSON.stringify({
    event: 'session_start',
    session_id: 'codex-stale-current',
    timestamp: '2026-05-14T02:00:00.000Z',
    cwd: sourceRoot,
    pid: 99999999,
  }) + '\n');
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-stale-current',
    started_at: '2026-05-14T02:00:00.000Z',
    cwd: sourceRoot,
    pid: 99999999,
  }, null, 2));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, '#!/bin/sh\nexit 0\n');
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: sourceRoot,
      projectRoots: [runRoot],
      codexHome,
      discoverTmuxProjectRoots: false,
      now: '2026-05-14T02:10:00.000Z',
    });
    const observed = sessions.find((session) => session.lifecycleSessionId === 'codex-stale-current');
    assert.equal(observed?.status, 'ended');
    assert.equal(observed?.endedAt, '2026-05-14T02:10:00.000Z');
    assert.equal(observed?.endedAtSource, 'bridge-observed-exit');

    const events = await routeSessionEvents(observed, { projectRoot: observed.lifecycleRoot });
    assert.equal(events.find((event) => event.type === 'SessionEnd')?.eventId, 'codex-stale-current:end');
  });
});

test.skip('session index does not observe-end current sandboxed sessions without a known pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-observed-no-pid-'));
  const sourceRoot = join(root, 'project');
  const runRoot = join(root, 'codex-runs', 'run-20260514021000-no-pid');
  const codexHome = join(root, 'codex-home');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(runRoot, '.codex', 'logs'), { recursive: true });
  await mkdir(join(runRoot, '.codex', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(runRoot, '.codexbox-run.json'), JSON.stringify({
    launcher: 'codex --dangerously-bypass-approvals-and-sandbox',
    created_at: '2026-05-14T02:10:00.000Z',
    cwd: runRoot,
    source_cwd: sourceRoot,
  }));
  await writeFile(join(runRoot, '.codex', 'logs', 'codex-2026-05-14.jsonl'), JSON.stringify({
    event: 'session_start',
    session_id: 'codex-no-pid',
    timestamp: '2026-05-14T02:10:00.000Z',
    cwd: sourceRoot,
  }) + '\n');
  await writeFile(join(runRoot, '.codex', 'state', 'session.json'), JSON.stringify({
    session_id: 'codex-no-pid',
    started_at: '2026-05-14T02:10:00.000Z',
    cwd: sourceRoot,
  }, null, 2));

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, '#!/bin/sh\nexit 0\n');
  await chmod(fakeTmuxBin, 0o755);

  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const sessions = await buildSessionIndex({
      projectRoot: sourceRoot,
      projectRoots: [runRoot],
      codexHome,
      discoverTmuxProjectRoots: false,
      now: '2026-05-14T02:20:00.000Z',
    });
    const current = sessions.find((session) => session.lifecycleSessionId === 'codex-no-pid');
    assert.equal(current?.endedAt, null);
    assert.equal(current?.status, 'unknown');
  });
});
