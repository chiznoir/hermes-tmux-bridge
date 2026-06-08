import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandNotificationFlusher, createServer, resolveRuntimeProjectRoot } from '../src/server.js';
import { appendApprovalDecision } from '../src/omx-send-approvals.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '04', '28');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  const codexSessionId = '019dd410-662d-73c1-9a72-5a602d14bd3e';
  const logPath = join(sessionsDir, `rollout-2026-04-28T12-28-57-${codexSessionId}.jsonl`);
  const lines = [
    { timestamp: '2026-04-28T12:28:57.000Z', type: 'session_meta', payload: { id: codexSessionId, timestamp: '2026-04-28T12:28:56.761Z', cwd: root } },
    { timestamp: '2026-04-28T12:28:58.000Z', type: 'event_msg', payload: { type: 'task_started', message: '세션 작업 시작' } },
    { timestamp: '2026-04-28T12:29:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '상태 확인해줘' }] } },
    { timestamp: '2026-04-28T12:29:04.999Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: '중간 작업 메시지입니다.' } },
    { timestamp: '2026-04-28T12:29:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '중간 작업 메시지입니다.' }] } },
    { timestamp: '2026-04-28T12:29:07.000Z', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', arguments: '{\"questions\":[{\"question\":\"승인할까요?\"}]}' } },
    { timestamp: '2026-04-28T12:29:10.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '현재 상태는 정상입니다. '.repeat(100) }] } },
    { timestamp: '2026-04-28T12:29:11.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '현재 상태는 정상입니다. '.repeat(100), duration_ms: 1234 } },
  ];
  await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-1777379336693-sjhnhr',
    native_session_id: codexSessionId,
    started_at: '2026-04-28T12:28:56.761Z',
    cwd: root,
    pid: 123,
  }) + '\n');

  await writeFile(join(root, '.omx', 'logs', 'omx-2026-04-28.jsonl'), JSON.stringify({
    event: 'session_start',
    timestamp: '2026-04-28T12:28:56.761Z',
    session_id: 'omx-1777379336693-sjhnhr',
    native_session_id: codexSessionId,
    cwd: root,
    pid: 123,
  }) + '\n');

  await writeFile(join(root, '.omx', 'logs', 'tmux-hook-2026-04-28.jsonl'), JSON.stringify({
    timestamp: '2026-04-28T12:29:05.000Z',
    thread_id: codexSessionId,
    target: { type: 'pane', value: '%77' },
  }) + '\n');

  const fakeTmuxCallsPath = join(root, '.omx', 'logs', 'fake-tmux-calls.log');
  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
CALL_LOG=${JSON.stringify(fakeTmuxCallsPath)}
case "$1" in
  list-panes)
    printf 'bridge-test	%%77	4242	0	%s
' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'bridge-test	1777379336	1
'
    ;;
  send-keys)
    printf '%s\n' "$*" >> "$CALL_LOG"
    ;;
  *)
    exit 1
    ;;
esac
`)
  await chmod(fakeTmuxBin, 0o755);

  return { root, codexHome, codexSessionId, logPath, fakeTmuxBin, fakeTmuxCallsPath };
}
async function gjcFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gjc-bridge-'));
  const homeRoot = await mkdtemp(join(tmpdir(), 'gjc-home-'));
  const xdgRoot = await mkdtemp(join(tmpdir(), 'gjc-xdg-'));
  const sessionId = '019e9000-4444-7000-dddd-eeeeeeeeeeee';
  const sessionsDir = join(xdgRoot, 'gjc', 'sessions', 'project-a');
  await mkdir(sessionsDir, { recursive: true });
  const logPath = join(sessionsDir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-06-04T12:28:56.761Z', cwd: root, title: 'GJC bridge session' },
    { type: 'message', id: 'gjc-user-1', timestamp: '2026-06-04T12:29:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '상태 확인해줘' }] } },
    {
      type: 'message',
      id: 'gjc-working-1',
      timestamp: '2026-06-04T12:29:04.000Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-gjc-1', name: 'read', arguments: { path: 'README.md' } }] },
      stopReason: 'toolUse',
    },
    {
      type: 'message',
      id: 'gjc-final-1',
      timestamp: '2026-06-04T12:29:10.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '현재 상태는 정상입니다. '.repeat(40) }] },
      stopReason: 'stop',
    },
  ];
  await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join('\n'));
  return { root, homeRoot, xdgRoot, sessionId, logPath };
}

async function writeManagedGjcTmuxBin(root, { managed = true, displayManaged = managed } = {}) {
  const fakeTmuxCallsPath = join(root, '.omx', 'logs', `fake-gjc-tmux-${managed ? 'managed' : 'unmanaged'}-${displayManaged ? 'display-ok' : 'display-fail'}.log`);
  const fakeTmuxBin = join(root, `fake-gjc-tmux-${managed ? 'managed' : 'unmanaged'}-${displayManaged ? 'display-ok' : 'display-fail'}.sh`);
  const projectSlug = 'project-a';
  const ownerKey = 'owner-key-1';
  const startedAt = '2026-06-04T12:28:56.761Z';
  const sessionId = '019e9000-4444-7000-dddd-eeeeeeeeeeee';
  const paneProfile = managed ? '1' : '';
  const paneBranch = managed ? 'gjc' : '';
  const paneBranchSlug = managed ? 'gjc' : '';
  const paneProject = managed ? projectSlug : '';
  const displayProfile = displayManaged ? '1' : '';
  const displayBranch = displayManaged ? 'gjc' : '';
  const displayBranchSlug = displayManaged ? 'gjc' : '';
  const displayProject = displayManaged ? projectSlug : '';
  await writeFile(fakeTmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
CALL_LOG=${JSON.stringify(fakeTmuxCallsPath)}
case "$1" in
  list-panes)
    suffix=''
    case "$*" in *'@gjc-session-id'*) suffix='	${managed ? sessionId : ''}' ;; esac
    printf 'gjc-managed	%%88	4242	0	%s	${paneProfile}	${paneBranch}	${paneBranchSlug}	${paneProject}	${managed ? ownerKey : ''}	${managed ? startedAt : ''}%s
' "$ROOT_PATH" "$suffix"
    ;;
  list-sessions)
    suffix=''
    case "$*" in *'@gjc-session-id'*) suffix='	${managed ? sessionId : ''}' ;; esac
    printf 'gjc-managed	1777379336	1	${paneProfile}	${paneBranch}	${paneBranchSlug}	${paneProject}	${managed ? ownerKey : ''}	${managed ? startedAt : ''}%s
' "$suffix"
    ;;
  display-message)
    suffix=''
    case "$*" in *'@gjc-session-id'*) suffix='	${displayManaged ? sessionId : ''}' ;; esac
    printf 'gjc-managed	%%88	${displayProfile}	${displayBranch}	${displayBranchSlug}	${displayProject}	${displayManaged ? ownerKey : ''}	${displayManaged ? startedAt : ''}%s
' "$suffix"
    ;;
  send-keys)
    printf '%s
' "$*" >> "$CALL_LOG"
    ;;
  kill-session)
    printf '%s
' "$*" >> "$CALL_LOG"
    ;;
  *)
    exit 1
    ;;
esac
`)
  await chmod(fakeTmuxBin, 0o755);
  return { fakeTmuxBin, fakeTmuxCallsPath };
}

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

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function readBridgeAudit(root) {
  const path = join(root, '.omx', 'logs', 'bridge-interactions.jsonl');
  const content = await readFile(path, 'utf8').catch(() => '');
  return content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function readBridgeAuditLog(root) {
  const path = join(root, '.omx', 'logs', 'bridge-audit.jsonl');
  const content = await readFile(path, 'utf8').catch(() => '');
  return content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function readJsonlFile(path) {
  const content = await readFile(path, 'utf8').catch(() => '');
  return content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function registerQuestion(serverOptions, sessionId, body = {}) {
  return request(createServer(serverOptions), `/sessions/${sessionId}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /health returns a stable liveness contract', async () => {
  const { root, codexHome } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('Bearer auth protects bridge APIs while leaving health public', async () => {
  const { root, codexHome } = await fixture();

  const health = await request(createServer({ projectRoot: root, codexHome, authToken: 'secret-token' }), '/health');
  assert.equal(health.status, 200);

  const denied = await request(createServer({ projectRoot: root, codexHome, authToken: 'secret-token' }), '/sessions');
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.json, { error: 'unauthorized' });

  const allowed = await request(createServer({ projectRoot: root, codexHome, authToken: 'secret-token' }), '/sessions', {
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.json.sessions));
});

test('GET /sessions returns mapped Codex/OMX session fields', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  await mkdir(join(root, 'empty-gjc'), { recursive: true });
  await withEnv({ GJC_SESSIONS_ROOT: join(root, 'empty-gjc') }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, '/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions[0].codexSessionId, codexSessionId);
    assert.equal(res.json.sessions[0].threadId, codexSessionId);
    assert.equal(res.json.sessions[0].project, root.split('/').pop());
    assert.equal(res.json.sessions[0].status, 'unknown');
    assert.equal(res.json.sessions[0].activityState, 'idle');
    assert.equal(res.json.sessions[0].activity.latestEventType, 'SessionIdle');
    assert.equal(res.json.sessions[0].activity.lastSignal, 'final');
  });
});
test('GET /sessions surfaces gjc sessions with lifecycle status separate from activityState', async () => {
  const { root, homeRoot, xdgRoot, sessionId } = await gjcFixture();

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined }, async () => {
    const server = createServer({ projectRoot: root });
    const res = await request(server, '/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions[0].gjcSessionId, sessionId);
    assert.equal(res.json.sessions[0].bridgeSessionId, sessionId);
    assert.equal(res.json.sessions[0].status, 'unknown');
    assert.equal(res.json.sessions[0].activityState, 'idle');
    assert.equal(res.json.sessions[0].activity.latestEventType, 'SessionIdle');
    assert.equal(res.json.sessions[0].activity.source, 'gjc-log');
    assert.equal(res.json.sessions[0].lifecycleOwner, 'gjc');
  });
});

test('GET /sessions/:id routes gjc state, events, and latest idle text from gjc JSONL', async () => {
  const { root, homeRoot, xdgRoot, sessionId, logPath } = await gjcFixture();

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined }, async () => {
    const server = createServer({ projectRoot: root });

    const detail = await request(server, `/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.gjcSessionId, sessionId);
    assert.equal(detail.json.status, 'unknown');
    assert.equal(detail.json.activityState, 'idle');

    const state = await request(server, `/sessions/${sessionId}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.json.session.gjcSessionId, sessionId);
    assert.equal(state.json.activity.state, 'idle');
    assert.equal(state.json.activity.latestEventType, 'SessionIdle');

    const events = await request(server, `/sessions/${sessionId}/events`);
    assert.equal(events.status, 200);
    assert.deepEqual(events.json.events.map((event) => event.type), ['CommandSubmitted', 'FinalAnswer', 'SessionIdle']);
    assert.equal(events.json.events[1].source, 'gjc-log');

    const idle = await request(server, `/sessions/${sessionId}/idle/latest`);
    assert.equal(idle.status, 200);
    assert.match(idle.json.fullText, /현재 상태는 정상입니다/);
    assert.equal(idle.json.sourceLogPath, logPath);
  });
});

test('POST /sessions/:id/commands dispatches only to managed GJC tmux targets', async () => {
  const { root, homeRoot, xdgRoot, sessionId } = await gjcFixture();
  const managed = await writeManagedGjcTmuxBin(root, { managed: true, displayManaged: true });
  const unmanaged = await writeManagedGjcTmuxBin(root, { managed: true, displayManaged: false });

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined, TMUX_BIN: managed.fakeTmuxBin }, async () => {
    const res = await request(createServer({ projectRoot: root }), `/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'managed gjc dispatch', submit: false }),
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.delivery.ok, true);
    assert.equal(res.json.interaction.tmuxId, 'gjc-managed');
    const calls = await readFile(managed.fakeTmuxCallsPath, 'utf8');
    assert.match(calls, /send-keys -t %88 -l -- managed gjc dispatch/);
  });

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined, TMUX_BIN: unmanaged.fakeTmuxBin }, async () => {
    const res = await request(createServer({ projectRoot: root }), `/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'should reject unmanaged target', submit: false }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.delivery.ok, false);
    assert.equal(res.json.delivery.reason, 'unmanaged-gjc-target');
    assert.match(res.json.delivery.error, /managed gjc tmux target required/);
  });
});

test('POST /gjc/sessions launches a GJC tmux external-runner and records audit', async () => {
  const { root } = await gjcFixture();
  const calls = [];
  const server = createServer({
    projectRoot: root,
    launchGjcSessionFn: (body, options) => {
      calls.push({ body, projectRoot: options.projectRoot });
      return {
        ok: true,
        backend: 'gjc-tmux',
        pid: 12345,
        requestId: body.requestId,
        cwd: body.cwd,
        worktree: body.worktree,
        args: ['--tmux', '--worktree', body.worktree],
      };
    },
  });
  const res = await request(server, '/gjc/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'launch-1', cwd: root, worktree: join(root, 'worktree-a'), gjcBin: '/tmp/evil-gjc' }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.launch.ok, true);
  assert.equal(res.json.launch.backend, 'gjc-tmux');
  assert.equal(res.json.next.dispatchMode, 'tmux');
  assert.equal(res.json.next.resultSource, 'gjc-jsonl');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cwd, root);
  assert.equal(calls[0].body.gjcBin, 'gjc');

  const audit = await readBridgeAuditLog(root);
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.launch.accepted' && entry.requestId === 'launch-1'));
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.launch.started' && entry.launch?.pid === 12345));
});

test('POST /gjc/sessions reuses an existing managed GJC runner for the same cwd', async () => {
  const { root } = await gjcFixture();
  const server = createServer({
    projectRoot: root,
    listTmuxPanesFn: () => [{
      managed: true,
      paneDead: false,
      tmuxId: 'gjc-managed',
      tmuxPaneId: '%88',
      paneCurrentPath: root,
      gjcBranch: 'gjc',
      gjcProject: root.split('/').pop().replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      gjcSessionId: 'existing-gjc-session',
    }],
  });
  const res = await request(server, '/gjc/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'launch-reuse', cwd: root }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.launch.ok, true);
  assert.equal(res.json.launch.reused, true);
  assert.equal(res.json.launch.tmuxPaneId, '%88');

  const audit = await readBridgeAuditLog(root);
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.launch.reused' && entry.launch?.gjcSessionId === 'existing-gjc-session'));
});

test('POST /gjc/sessions rejects invalid worktree before spawning GJC', async () => {
  const { root } = await gjcFixture();
  const missingWorktree = join(root, 'missing-worktree');
  const res = await request(createServer({ projectRoot: root }), '/gjc/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'launch-invalid-worktree', cwd: root, worktree: missingWorktree }),
  });

  assert.equal(res.status, 502);
  assert.equal(res.json.launch.ok, false);
  assert.equal(res.json.launch.reason, 'invalid-worktree');

  const audit = await readBridgeAuditLog(root);
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.launch.failed' && entry.launch?.reason === 'invalid-worktree'));
});

test('POST /sessions/:id/stop kills only managed GJC tmux sessions and records audit', async () => {
  const { root, homeRoot, xdgRoot, sessionId } = await gjcFixture();
  const managed = await writeManagedGjcTmuxBin(root, { managed: true, displayManaged: true });
  const unmanaged = await writeManagedGjcTmuxBin(root, { managed: true, displayManaged: false });

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined, TMUX_BIN: managed.fakeTmuxBin }, async () => {
    const res = await request(createServer({ projectRoot: root }), `/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.stop.ok, true);
    assert.equal(res.json.stop.target, 'gjc-managed');
    const calls = await readFile(managed.fakeTmuxCallsPath, 'utf8');
    assert.match(calls, /kill-session -t gjc-managed/);

    const audit = await readBridgeAuditLog(root);
    assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.stop.accepted' && entry.gjcSessionId === sessionId));
    assert.ok(audit.some((entry) => entry.eventType === 'gjc.session.stop.completed' && entry.stop?.ok === true));
  });

  await withEnv({ HOME: homeRoot, XDG_DATA_HOME: xdgRoot, GJC_SESSIONS_ROOT: undefined, TMUX_BIN: unmanaged.fakeTmuxBin }, async () => {
    const res = await request(createServer({ projectRoot: root }), `/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.stop.ok, false);
    assert.equal(res.json.stop.reason, 'unmanaged-gjc-target');
  });
});

test('GET /sessions hides Codex-only sessions by default and exposes them on explicit opt-in', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const omxLogPath = join(root, '.omx', 'logs', 'omx-2026-04-28.jsonl');
  const existingLog = await readFile(omxLogPath, 'utf8');
  const nativeOnlySessionId = 'codex-native-exec-only';
  await writeFile(omxLogPath, [
    existingLog.trim(),
    JSON.stringify({
      event: 'session_start',
      timestamp: '2026-04-28T12:30:00.000Z',
      session_id: nativeOnlySessionId,
      native_session_id: nativeOnlySessionId,
      cwd: root,
      pid: 456,
    }),
  ].join('\n') + '\n');
  await mkdir(join(root, 'empty-gjc'), { recursive: true });

  await withEnv({ GJC_SESSIONS_ROOT: join(root, 'empty-gjc') }, async () => {
    const defaultRes = await request(createServer({ projectRoot: root, codexHome }), '/sessions?activity=false');
    assert.equal(defaultRes.status, 200);
    assert.equal(defaultRes.json.meta.includeCodexOnlySessions, false);
    assert.deepEqual(defaultRes.json.sessions.map((session) => session.codexSessionId), [codexSessionId]);

    const debugRes = await request(createServer({ projectRoot: root, codexHome }), '/sessions?activity=false&includeNativeOnly=true');
    assert.equal(debugRes.status, 200);
    assert.equal(debugRes.json.meta.includeCodexOnlySessions, true);
    assert.equal(
      debugRes.json.sessions.find((session) => session.codexSessionId === nativeOnlySessionId)?.hasOmxLifecycle,
      false,
    );
  });
});

test('GET /sessions resolves omx ids and maps tmux hook targets when tmux is available', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin } = await fixture();
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, '/sessions/omx-1777379336693-sjhnhr');

    assert.equal(res.status, 200);
    assert.equal(res.json.codexSessionId, codexSessionId);
    assert.equal(res.json.omxSessionId, 'omx-1777379336693-sjhnhr');
    assert.equal(res.json.tmuxId, 'bridge-test');
    assert.equal(res.json.tmuxPaneId, '%77');
    assert.equal(res.json.status, 'active');
  });
});

test('GET /sessions/:id returns not_found for unknown session id', async () => {
  const { root, codexHome } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, '/sessions/not-found-id');
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'not_found' });
});

test('GET /sessions/:id/state exposes Codex activity without tmux capture', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, `/sessions/${codexSessionId}/state`);
  assert.equal(res.status, 200);
  assert.equal(res.json.session.codexSessionId, codexSessionId);
  assert.equal(res.json.activity.state, 'idle');
  assert.equal(res.json.activity.latestEventType, 'SessionIdle');
  assert.equal(res.json.activity.lastFinalAt, '2026-04-28T12:29:11.000Z');
  assert.equal(res.json.activity.lastAskAt, '2026-04-28T12:29:07.000Z');
  assert.equal(res.json.activity.source, 'codex-log');
});

test('GET /sessions/:id/idle/latest returns untruncated full assistant text', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, `/sessions/${codexSessionId}/idle/latest`);
  assert.equal(res.status, 200);
  assert.equal(res.json.truncated, false);
  assert.match(res.json.fullText, /현재 상태는 정상입니다/);
  assert.ok(res.json.fullText.length > 1200);
  assert.ok(res.json.sourceLogPath.endsWith('.jsonl'));
});



test('GET /sessions/:id/events strips injected AGENTS instructions from user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const injected = [
    '# AGENTS.md instructions for /home/user/work/demo',
    '',
    '<INSTRUCTIONS>',
    '이 규칙 주입문은 사용자 알림에 전달되면 안 됩니다.',
    '</INSTRUCTIONS><environment_context>',
    '  <cwd>/home/user/work/demo</cwd>',
    '</environment_context>',
    '실제 요청만 전달해줘',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: injected }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  const commandEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && event.text === '실제 요청만 전달해줘');

  assert.ok(commandEvent);
  assert.doesNotMatch(commandEvent.text, /AGENTS\.md instructions/);
  assert.doesNotMatch(commandEvent.text, /<INSTRUCTIONS>/);
  assert.doesNotMatch(commandEvent.text, /environment_context/);
});

test('GET /sessions/:id/events suppresses standalone environment_context user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const environmentOnly = [
    '<environment_context>',
    '  <shell>bash</shell>',
    '  <current_date>2026-05-08</current_date>',
    '  <timezone>Asia/Seoul</timezone>',
    '</environment_context>',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: environmentOnly }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);

  assert.equal(events.json.events.some((event) => event.type === 'CommandSubmitted' && /environment_context/.test(event.text)), false);
});

test('GET /sessions/:id/events strips hook prompt internals from user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const hookPromptWithCommand = [
    '<hook_prompt hook_run_id="stop:9:/home/user/.codex/hooks.json">',
    'OMX Ralph is still active; continue the task and gather fresh verification evidence before stopping.',
    '</hook_prompt>',
    '실제 사용자가 보낸 요청만 남겨줘',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: hookPromptWithCommand }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  const commandEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && /실제 사용자가/.test(event.text));

  assert.ok(commandEvent);
  assert.equal(commandEvent.text, '실제 사용자가 보낸 요청만 남겨줘');
  assert.doesNotMatch(commandEvent.text, /hook_prompt|hook_run_id|OMX Ralph is still active/);
});

test('GET /sessions/:id/events suppresses standalone hook prompt user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const hookPromptOnly = [
    '<hook_prompt hook_run_id="stop:9:/home/user/.codex/hooks.json">',
    'OMX Ralph is still active; continue the task and gather fresh verification evidence before stopping.',
    '</hook_prompt>',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: hookPromptOnly }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);

  assert.equal(events.json.events.some((event) => event.type === 'CommandSubmitted' && /hook_prompt|OMX Ralph is still active/.test(event.text)), false);
});

test('GET /sessions/:id/events strips synthetic context from user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const syntheticWithCommand = [
    '<skill>',
    '<name>ralph</name>',
    '<path>/home/user/.codex/skills/ralph/SKILL.md</path>',
    '---',
    'name: ralph',
    'description: synthetic skill body',
    '---',
    '</skill>',
    '<turn_aborted>',
    'The user interrupted the previous turn on purpose.',
    '</turn_aborted>',
    '<subagent_notification>',
    '{"agent_path":"019e-example","status":"shutdown"}',
    '</subagent_notification>',
    '실제 사용자 요청만 알림으로 전달해줘',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: syntheticWithCommand }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  const commandEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && /실제 사용자 요청만/.test(event.text));

  assert.ok(commandEvent);
  assert.equal(commandEvent.text, '실제 사용자 요청만 알림으로 전달해줘');
  assert.doesNotMatch(commandEvent.text, /<skill>|SKILL\.md|turn_aborted|subagent_notification/);
});

test('GET /sessions/:id/events suppresses standalone synthetic user command notifications', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const syntheticOnly = [
    '<skill>',
    '<name>ralph</name>',
    '<path>/home/user/.codex/skills/ralph/SKILL.md</path>',
    '</skill>',
    '<turn_aborted>',
    'The user interrupted the previous turn on purpose.',
    '</turn_aborted>',
    '<subagent_notification>',
    '{"agent_path":"019e-example","status":"shutdown"}',
    '</subagent_notification>',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: syntheticOnly }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);

  assert.equal(events.json.events.some((event) => event.type === 'CommandSubmitted' && /SKILL\.md|turn_aborted|subagent_notification/.test(event.text)), false);
});

test('GET /sessions/:id/events suppresses standalone OMX Explore harness prompts', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const exploreHarnessPrompt = [
    'You are OMX Explore, a low-cost read-only repository exploration harness.',
    'Operate strictly in read-only mode. You may use repository-inspection shell commands only.',
    'Preferred commands: rg, grep, and tightly bounded read-only bash wrappers over rg/grep/ls/find/wc/cat/head/tail.',
    'Do not write, delete, rename, or modify files. Do not run git commands that alter working state.',
    'Always return markdown only.',
    '',
    'Reference behavior contract:',
    '---------------- BEGIN EXPLORE PROMPT ----------------',
    '---',
    'description: "Shell-only repository exploration contract for omx explore"',
    'argument-hint: "task description"',
    '---',
    '<identity>',
    'You are OMX Explore, a low-cost shell-only repository exploration harness.',
    '</identity>',
    '---------------- END EXPLORE PROMPT ----------------',
    '',
    'User request:',
    '[OMX Wiki Status]',
    'Wiki evidence is weak or missing.',
    '',
    '[Original Explore Prompt]',
    'Find where bridge sends commands to tmux. Return concise file/function refs only.',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: exploreHarnessPrompt }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);

  assert.equal(events.json.events.some((event) => event.type === 'CommandSubmitted' && /OMX Explore|BEGIN EXPLORE PROMPT|Original Explore Prompt/.test(event.text)), false);
});

test('GET /sessions/:id/events strips quoted OMX Explore harness prefix but preserves user question', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const quotedHarnessQuestion = [
    '"You are OMX Explore, a low-cost read-only repository exploration harness.',
    'Operate strictly in read-only mode. You may use repository-inspection shell commands only.',
    '',
    'Reference behavior contract:',
    '---------------- BEGIN EXPLORE PROMPT ----------------',
    '---" 이와 같은 프롬프트 전달 User Command 이벤트가 왜 오냐',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: quotedHarnessQuestion }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  const commandEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && /프롬프트 전달/.test(event.text || ''));

  assert.ok(commandEvent);
  assert.equal(commandEvent.text, '이와 같은 프롬프트 전달 User Command 이벤트가 왜 오냐');
  assert.doesNotMatch(commandEvent.text, /OMX Explore|BEGIN EXPLORE PROMPT/);
});

test('GET /sessions/:id/events strips synthetic prompt contract structure without identity sentence anchor', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const genericSyntheticContract = [
    'Wrapper instructions for a repository lookup harness.',
    '',
    'Reference behavior contract:',
    '---------------- BEGIN REPOSITORY LOOKUP PROMPT ----------------',
    '---',
    'description: "Shell-only repository exploration contract for omx explore"',
    'argument-hint: "task description"',
    '---',
    '<identity>',
    'A generated read-only agent prompt lives here.',
    '</identity>',
    '---------------- END REPOSITORY LOOKUP PROMPT ----------------',
    '',
    'User request:',
    '[Original Explore Prompt]',
    'Find the relevant files.',
  ].join('\n');
  await writeFile(logPath, `\n${JSON.stringify({
    timestamp: '2026-04-28T12:29:12.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: genericSyntheticContract }] },
  })}`, { flag: 'a' });

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);

  assert.equal(events.json.events.some((event) => event.type === 'CommandSubmitted' && /generated read-only agent prompt|REPOSITORY LOOKUP PROMPT|Original Explore Prompt/.test(event.text)), false);
});

test('GET /sessions/:id/events does not strip subagent notifications from FinalAnswer text', async () => {
  const { root, codexHome, codexSessionId, logPath } = await fixture();
  const finalAnswer = [
    '<subagent_notification>',
    '{"agent_path":"019e-example","status":"shutdown"}',
    '</subagent_notification>',
    '최종 답변 본문',
  ].join('\n');
  await writeFile(logPath, [
    { timestamp: '2026-04-28T12:28:57.000Z', type: 'session_meta', payload: { id: codexSessionId, timestamp: '2026-04-28T12:28:56.761Z', cwd: root } },
    { timestamp: '2026-04-28T12:29:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '상태 확인해줘' }] } },
    { timestamp: '2026-04-28T12:29:12.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: finalAnswer }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  const finalEvent = events.json.events.find((event) => event.type === 'FinalAnswer' && /최종 답변 본문/.test(event.text || ''));

  assert.ok(finalEvent);
  assert.match(finalEvent.text, /subagent_notification/);
});

test('GET /sessions/:id/events and interactions expose agent response history', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const events = await request(server, `/sessions/${codexSessionId}/events`);
  assert.equal(events.status, 200);
  assert.ok(events.json.events.some((event) => event.source === 'notification' && event.type === 'SessionStart'));
  assert.ok(events.json.events.some((event) => event.source === 'codex-log' && event.type === 'TurnStart'));
  assert.ok(!events.json.events.some((event) => event.source === 'codex-log' && event.type === 'SessionStart'));
  assert.ok(!events.json.events.some((event) => event.source === 'codex-log' && event.type === 'Idle'));
  assert.ok(events.json.events.some((event) => event.source === 'codex-log' && event.type === 'SessionIdle'));
  assert.ok(events.json.events.some((event) => event.type === 'Commentary' && /중간 작업 메시지/.test(event.text || '')));
  assert.equal(events.json.events.filter((event) => event.type === 'Commentary' && /중간 작업 메시지/.test(event.text || '')).length, 1);
  assert.ok(events.json.events.some((event) => event.type === 'CommandSubmitted'));
  assert.ok(events.json.events.some((event) => event.type === 'AskPermission'));
  assert.ok(events.json.events.some((event) => event.type === 'FinalAnswer' && event.phase === 'final_answer'));
  const eventTypes = events.json.events.map((event) => event.type);
  assert.ok(eventTypes.includes('SessionStart'));
  assert.ok(eventTypes.includes('CommandSubmitted'));
  assert.ok(eventTypes.includes('FinalAnswer'));
  assert.ok(eventTypes.includes('Commentary'));
  assert.ok(eventTypes.indexOf('CommandSubmitted') < eventTypes.indexOf('FinalAnswer'));

  const interactions = await request(server, `/sessions/${codexSessionId}/interactions`);
  assert.equal(interactions.status, 200);
  assert.equal(interactions.json.interactions[0].confidence, 'exact');
  assert.match(interactions.json.interactions[0].responseText, /현재 상태는 정상입니다/);
});

test('POST /sessions/:id/commands dryRun records audit-only interaction without user command events', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const prompt = '  테스트 명령\n원문 보존  ';
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandText: prompt, dryRun: true }),
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.delivery.ok, true);
  assert.equal(res.json.delivery.dryRun, true);
  assert.equal(res.json.delivery.backend, 'tmux');
  assert.equal(res.json.delivery.reason, 'auto-tmux-default');
  assert.equal(res.json.interaction.commandText, prompt);
  assert.equal(Object.hasOwn(res.json, 'injectedPrompt'), false);
  assert.equal(Object.hasOwn(res.json, 'userFacingMarkdown'), false);
  assert.equal(res.json.interaction.codexSessionId, codexSessionId);
  assert.equal(res.json.interaction.threadId, codexSessionId);

  const bridgeLog = await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8');
  const bridgeRecord = JSON.parse(bridgeLog.trim());
  assert.equal(bridgeRecord.source, 'bridge');
  assert.equal(bridgeRecord.commandText, prompt);
  assert.equal(bridgeRecord.dryRun, true);
  assert.equal(bridgeRecord.metadata.dryRun, true);
  assert.equal(bridgeRecord.codexSessionId, codexSessionId);
  assert.ok(bridgeRecord.submittedAt);

  const server2 = createServer({ projectRoot: root, codexHome });
  const interactions = await request(server2, `/sessions/${codexSessionId}/interactions`);
  assert.equal(interactions.json.interactions.some((item) => item.commandText === prompt), false);

  const server3 = createServer({ projectRoot: root, codexHome });
  const events = await request(server3, `/sessions/${codexSessionId}/events`);
  const promptEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && event.source === 'bridge-interactions');
  assert.equal(promptEvent, undefined);
});

test('POST /sessions/:id/commands normalizes Hermes operator wrappers before record and dispatch', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const rawPrompt = '치즈 질문: direct 모드가 왜 원문으로 안 갔는지 확인해줘';
  const normalizedPrompt = 'direct 모드가 왜 원문으로 안 갔는지 확인해줘';
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandText: rawPrompt, dryRun: true }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.interaction.commandText, normalizedPrompt);
  assert.equal(res.json.promptNormalization.changed, true);
  assert.ok(res.json.promptNormalization.rules.includes('strip-operator-prefix'));
  assert.equal(res.json.interaction.metadata.promptNormalization.rawCommandText, rawPrompt);

  const bridgeLog = await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8');
  const bridgeRecord = JSON.parse(bridgeLog.trim());
  assert.equal(bridgeRecord.commandText, normalizedPrompt);
  assert.equal(bridgeRecord.metadata.promptNormalization.changed, true);
  assert.equal(bridgeRecord.metadata.promptNormalization.rawCommandText, rawPrompt);
});

test('POST /sessions/:id/commands preserves operator wrappers when raw is requested', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const rawPrompt = '치즈 질문: 그대로 보내';
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandText: rawPrompt, dryRun: true, raw: true }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.interaction.commandText, rawPrompt);
  assert.equal(res.json.promptNormalization.changed, false);
  assert.deepEqual(res.json.promptNormalization.rules, ['raw-preserve-requested']);
});

test('POST /sessions/:id/commands strips synthetic context from User Command notification text', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin } = await fixture();
  const prompt = [
    '<hook_prompt hook_run_id="stop:9:/home/user/.codex/hooks.json">',
    'Internal hook prompt must not be user-facing.',
    '</hook_prompt>',
    '<subagent_notification>',
    '{"agent_path":"019e-example","status":"shutdown"}',
    '</subagent_notification>',
    '전달할 실제 명령',
  ].join('\n');
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: prompt, mode: 'tmux', submit: false }),
    });
    assert.equal(res.status, 202);

    const events = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}/events`);
    const promptEvent = events.json.events.find((event) => event.type === 'CommandSubmitted' && event.source === 'bridge-interactions');
    assert.equal(promptEvent.text, '전달할 실제 명령');
    assert.doesNotMatch(promptEvent.text, /hook_prompt|hook_run_id|subagent_notification|agent_path/);
  });
});


test('POST /sessions/:id/commands rejects unsupported codex mode without tmux fallback', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'codex backend 제거 확인', mode: 'codex' }),
    });

    assert.equal(res.status, 501);
    assert.equal(res.json.delivery.ok, false);
    assert.equal(res.json.delivery.backend, null);
    assert.equal(res.json.delivery.reason, 'mode-codex-unsupported');
    assert.match(res.json.delivery.error, /unsupported/);
    assert.equal(await readFile(fakeTmuxCallsPath, 'utf8').catch(() => ''), '');

    const audit = await readBridgeAuditLog(root);
    assert.ok(audit.some((entry) => entry.eventType === 'command.accepted' && entry.mode === 'codex'));
    assert.ok(audit.some((entry) => entry.eventType === 'command.failed'
      && entry.delivery?.reason === 'mode-codex-unsupported'
      && entry.backend === null));
  });
});

test('POST /sessions/:id/commands suppresses CommandSubmitted notification flushers for dryRun', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const flushes = [];
  const server = createServer({
    projectRoot: root,
    codexHome,
    commandNotificationFlushers: [
      (payload) => {
        flushes.push(payload);
        return { ok: true };
      },
    ],
  });

  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandText: '즉시 알림 플러시', dryRun: true }),
  });

  assert.equal(res.status, 202);
  assert.equal(flushes.length, 0);
});

test('POST /sessions/:id/commands triggers CommandSubmitted notification flushers for real commands', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin } = await fixture();
  const flushes = [];
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({
      projectRoot: root,
      codexHome,
      commandNotificationFlushers: [
        (payload) => {
          flushes.push(payload);
          return { ok: true };
        },
      ],
    });

    const res = await request(server, `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '즉시 알림 플러시', mode: 'tmux', submit: false }),
    });

    assert.equal(res.status, 202);
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].reason, 'command-submitted');
    assert.equal(flushes[0].interactionId, res.json.interaction.interactionId);
    assert.equal(flushes[0].bootSince, res.json.interaction.submittedAt);
    assert.deepEqual([...flushes[0].eventTypes], ['CommandSubmitted']);
  });
});

test('createCommandNotificationFlusher flushes terminal Hermes events before fast command notification', async () => {
  const calls = [];
  const flusher = createCommandNotificationFlusher({
    hermesSink: {
      started: true,
      flush: async (payload) => {
        calls.push({ sink: 'hermes', payload });
        return { ok: true };
      },
    },
    notifier: {
      started: true,
      flush: async (payload) => {
        calls.push({ sink: 'discord', payload });
        return { ok: true };
      },
    },
  });

  assert.equal(typeof flusher, 'function');
  await flusher({
    reason: 'command-submitted',
    interactionId: 'interaction-1',
    bootSince: '2026-05-06T08:00:03.000Z',
    eventTypes: new Set(['CommandSubmitted']),
  });

  assert.deepEqual(calls.map((call) => call.sink), ['hermes', 'discord']);
  assert.equal(calls[0].payload.reason, 'pre-command-terminal');
  assert.deepEqual([...calls[0].payload.eventTypes], ['FinalAnswer', 'AgentResponse']);
  assert.equal(calls[1].payload.reason, 'command-submitted');
  assert.deepEqual([...calls[1].payload.eventTypes], ['CommandSubmitted']);
});

test('POST /sessions/:id/commands preserves Discord component metadata for auditability', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandText: '/approve',
      mode: 'tmux',
      dryRun: true,
      source: 'discord-component',
      discordInteractionId: 'discord-interaction-1',
      componentCustomId: 'omx:approval:1',
      componentAction: 'approval',
    }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.interaction.metadata.source, 'discord-component');
  assert.equal(res.json.interaction.metadata.discordInteractionId, 'discord-interaction-1');

  const bridgeLog = await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8');
  const bridgeRecord = JSON.parse(bridgeLog.trim());
  assert.equal(bridgeRecord.metadata.componentCustomId, 'omx:approval:1');

  const auditLog = await readFile(join(root, '.omx', 'logs', 'bridge-audit.jsonl'), 'utf8');
  const audit = auditLog.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.eventType === 'command.accepted'
    && entry.metadata.discordInteractionId === 'discord-interaction-1'));
});

test('POST /sessions/:id/commands with Discord Hermes approval gate registers UI-ready question only', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  const flushes = [];
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const res = await request(createServer({
      projectRoot: root,
      codexHome,
      commandNotificationFlushers: [(payload) => flushes.push(payload)],
    }), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandText: '치즈 질문: 정제된 프롬프트 전송',
        mode: 'tmux',
        submit: false,
        approvalGate: 'discord-hermes-omx-send',
        source: 'discord-hermes',
        discordInteractionId: 'discord-command-1',
      }),
    });

    assert.equal(res.status, 202);
    assert.equal(res.json.delivery.status, 'approval-pending');
    assert.equal(res.json.question.kind, 'omx-send-approval');
    assert.equal(res.json.question.metadata.gate, 'discord-hermes-omx-send');
    assert.equal(res.json.question.metadata.commandText, '정제된 프롬프트 전송');
    assert.equal(res.json.question.metadata.commandMetadata.discordInteractionId, 'discord-command-1');
    assert.equal(res.json.answer_endpoint, `/sessions/${codexSessionId}/question-answers`);
    assert.deepEqual(res.json.component_actions.map((action) => action.action), ['send', 'reject', 'modify']);
    assert.equal(res.json.component_actions[0].endpoint, res.json.answer_endpoint);
    assert.deepEqual(res.json.component_actions[0].body, {
      questionId: res.json.question.questionId,
      answer: { kind: 'option', value: 'send', selected_values: ['send'], selected_labels: ['전송'] },
    });
    assert.equal(res.json.discord_components[0].components.length, 3);
    assert.equal(Object.hasOwn(res.json, 'interaction'), false);

    assert.equal(await readFile(fakeTmuxCallsPath, 'utf8').catch(() => ''), '');
    assert.equal(await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8').catch(() => ''), '');
    assert.equal(flushes.length, 0);

    const questions = await readJsonlFile(join(root, '.omx', 'state', 'bridge-question-requests.jsonl'));
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'omx-send-approval');
  });
});

test('POST /sessions/:id/question-answers approves gated omx-send exactly once', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  const flushes = [];
  const serverOptions = {
    projectRoot: root,
    codexHome,
    commandNotificationFlushers: [(payload) => {
      flushes.push(payload);
      return { ok: true };
    }],
  };
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const gate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandText: '승인 후 한 번만 전송',
        mode: 'tmux',
        submit: false,
        approvalGate: 'discord-hermes-omx-send',
      }),
    });
    const questionId = gate.json.question.questionId;

    const approve = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        source: 'discord-component',
        discordInteractionId: 'approval-click-1',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(approve.status, 202);
    assert.equal(approve.json.delivery.status, 'dispatch-succeeded');
    assert.equal(approve.json.approval.state, 'dispatch_succeeded');
    assert.ok(approve.json.interaction.interactionId);
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].reason, 'command-submitted');
    assert.equal(flushes[0].interactionId, approve.json.interaction.interactionId);

    const duplicate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        source: 'discord-component',
        discordInteractionId: 'approval-click-1',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.duplicate, true);
    assert.equal(duplicate.json.delivery.status, 'duplicate');

    const secondClick = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        source: 'discord-component',
        discordInteractionId: 'approval-click-2',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(secondClick.status, 200);
    assert.equal(secondClick.json.delivery.status, 'already-finalized');

    for (const [discordInteractionId, answer] of [
      ['approval-click-reject-after-send', { kind: 'option', value: 'reject', selected_values: ['reject'] }],
      ['approval-click-modify-after-send', { kind: 'other', other_text: '이미 전송된 뒤 수정' }],
    ]) {
      const late = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionId,
          source: 'discord-component',
          discordInteractionId,
          answer,
        }),
      });
      assert.equal(late.status, 200);
      assert.equal(late.json.delivery.status, 'already-finalized');
    }

    const bridgeRecords = await readJsonlFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'));
    assert.equal(bridgeRecords.length, 1);
    assert.equal(bridgeRecords[0].commandText, '승인 후 한 번만 전송');
    assert.equal(bridgeRecords[0].metadata.approval.questionId, questionId);

    const calls = await readFile(fakeTmuxCallsPath, 'utf8');
    assert.equal((calls.match(/승인 후 한 번만 전송/g) || []).length, 1);

    const decisions = await readJsonlFile(join(root, '.omx', 'state', 'bridge-omx-send-approvals.jsonl'));
    assert.deepEqual(decisions.map((item) => item.state), ['send_claimed', 'dispatch_succeeded']);
  });
});

test('POST /sessions/:id/question-answers rejects or modifies gated omx-send without dispatch', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  const serverOptions = { projectRoot: root, codexHome };
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const rejectGate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '거절 대상', mode: 'tmux', approvalGate: 'discord-hermes-omx-send' }),
    });
    const reject = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: rejectGate.json.question.questionId,
        discordInteractionId: 'reject-click',
        answer: { kind: 'option', value: 'reject', selected_values: ['reject'] },
      }),
    });
    assert.equal(reject.status, 202);
    assert.equal(reject.json.delivery.status, 'rejected');
    const sendAfterReject = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: rejectGate.json.question.questionId,
        discordInteractionId: 'send-after-reject',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(sendAfterReject.status, 200);
    assert.equal(sendAfterReject.json.delivery.status, 'already-finalized');

    const modifyGate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '수정 대상', mode: 'tmux', approvalGate: 'discord-hermes-omx-send' }),
    });
    const modify = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: modifyGate.json.question.questionId,
        discordInteractionId: 'modify-click',
        answer: { kind: 'other', other_text: '이 문장을 추가해서 다시 보여줘' },
      }),
    });
    assert.equal(modify.status, 202);
    assert.equal(modify.json.delivery.status, 'modification_requested');
    assert.equal(modify.json.questionAnswer.answer.kind, 'other');
    assert.equal(modify.json.questionAnswer.answer.other_text, '이 문장을 추가해서 다시 보여줘');
    const sendAfterModify = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: modifyGate.json.question.questionId,
        discordInteractionId: 'send-after-modify',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(sendAfterModify.status, 200);
    assert.equal(sendAfterModify.json.delivery.status, 'already-finalized');

    assert.equal(await readFile(fakeTmuxCallsPath, 'utf8').catch(() => ''), '');
    assert.equal(await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8').catch(() => ''), '');
    const decisions = await readJsonlFile(join(root, '.omx', 'state', 'bridge-omx-send-approvals.jsonl'));
    assert.deepEqual(decisions.map((item) => item.state), ['rejected', 'modification_requested']);
  });
});

test('approval gate rejects unsupported gates and orphan claimed approvals fail closed', async () => {
  const { root, codexHome, codexSessionId, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  const serverOptions = { projectRoot: root, codexHome };
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const unsupported = await request(createServer(serverOptions), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '알 수 없는 gate', approvalGate: 'global-default' }),
    });
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.json.error, /unsupported approvalGate/);

    const gate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'orphan claimed', mode: 'tmux', approvalGate: 'discord-hermes-omx-send' }),
    });
    const questionId = gate.json.question.questionId;
    await appendApprovalDecision({
      sessionId: codexSessionId,
      bridgeSessionId: codexSessionId,
      codexThreadId: codexSessionId,
      questionId,
      state: 'send_claimed',
      questionAnswerId: 'orphan-answer',
      delivery: { ok: true, status: 'send_claimed', backend: 'bridge-omx-send-approval' },
    }, { projectRoot: root });

    const approve = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        discordInteractionId: 'after-orphan',
        answer: { kind: 'option', value: 'send', selected_values: ['send'] },
      }),
    });
    assert.equal(approve.status, 409);
    assert.equal(approve.json.delivery.status, 'already-finalized');
    assert.equal(approve.json.delivery.state, 'send_claimed');
    assert.equal(await readFile(fakeTmuxCallsPath, 'utf8').catch(() => ''), '');
    assert.equal(await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8').catch(() => ''), '');
  });
});

test('POST /sessions/:id/question-answers records single, multi, and other answers idempotently', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const serverOptions = { projectRoot: root, codexHome };
  const singleQuestion = await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-single',
    question: 'Execution lane?',
    type: 'single-answerable',
    options: [{ label: 'Plan first', value: 'ralplan' }],
  });
  assert.equal(singleQuestion.status, 202);
  assert.equal(singleQuestion.json.answer_endpoint, `/sessions/${codexSessionId}/question-answers`);

  const single = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-single',
      source: 'discord-component',
      discordInteractionId: 'dq-1',
      componentCustomId: 'omx:q:1',
      answer: {
        kind: 'option',
        value: 'ralplan',
        selected_labels: ['Plan first'],
        selected_values: ['ralplan'],
      },
    }),
  });
  assert.equal(single.status, 202);
  assert.equal(single.json.delivery.backend, 'bridge-question-answer-queue');
  assert.equal(single.json.questionAnswer.answer.value, 'ralplan');

  const duplicate = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-single',
      source: 'discord-component',
      discordInteractionId: 'dq-1',
      answer: { kind: 'option', value: 'ralplan' },
    }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.questionAnswer.questionAnswerId, single.json.questionAnswer.questionAnswerId);

  await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-concurrent',
    question: 'Concurrent?',
    type: 'single-answerable',
    options: [{ label: 'A', value: 'a' }],
  });
  const [firstConcurrent, secondConcurrent] = await Promise.all([
    request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: 'q-concurrent',
        source: 'discord-component',
        discordInteractionId: 'dq-concurrent',
        answer: { kind: 'option', value: 'a', selected_values: ['a'] },
      }),
    }),
    request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: 'q-concurrent',
        source: 'discord-component',
        discordInteractionId: 'dq-concurrent',
        answer: { kind: 'option', value: 'a', selected_values: ['a'] },
      }),
    }),
  ]);
  assert.deepEqual([firstConcurrent.status, secondConcurrent.status].sort(), [200, 202]);
  assert.equal(
    firstConcurrent.json.questionAnswer.questionAnswerId,
    secondConcurrent.json.questionAnswer.questionAnswerId,
  );

  const multiQuestion = await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-multi',
    question: 'Non-goals?',
    type: 'multi-answerable',
    allow_other: true,
    options: [{ label: 'No new dependencies', value: 'no-new-dependencies' }],
  });
  assert.equal(multiQuestion.status, 202);

  const multi = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-multi',
      source: 'discord-component',
      discordInteractionId: 'dq-2',
      answer: {
        kind: 'multi',
        selected_values: ['no-new-dependencies'],
        other_text: 'No deploy restart',
      },
    }),
  });
  assert.equal(multi.status, 202);
  assert.deepEqual(multi.json.questionAnswer.answer.value, ['no-new-dependencies', '__other__']);
  assert.equal(multi.json.questionAnswer.answer.other_text, 'No deploy restart');

  const otherQuestion = await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-other',
    question: 'Other?',
    type: 'single-answerable',
    allow_other: true,
    options: [{ label: 'Known', value: 'known' }],
  });
  assert.equal(otherQuestion.status, 202);

  const other = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-other',
      source: 'discord-component',
      discordInteractionId: 'dq-3',
      answer: {
        kind: 'other',
        other_text: '직접 입력한 제약',
      },
    }),
  });
  assert.equal(other.status, 202);
  assert.equal(other.json.questionAnswer.answer.value, '직접 입력한 제약');
  assert.deepEqual(other.json.questionAnswer.answer.selected_values, ['__other__']);
  assert.equal(other.json.questionAnswer.answer.other_text, '직접 입력한 제약');

  const queueLog = await readFile(join(root, '.omx', 'state', 'bridge-question-answers.jsonl'), 'utf8');
  assert.equal(queueLog.trim().split('\n').length, 4);

  const auditLog = await readFile(join(root, '.omx', 'logs', 'bridge-audit.jsonl'), 'utf8');
  const audit = auditLog.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.eventType === 'question_answer.queued'
    && entry.discordInteractionId === 'dq-2'
    && entry.answer.other_text === 'No deploy restart'));
});

test('POST /sessions/:id/question-answers rejects stale or invalid structured answers', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const serverOptions = { projectRoot: root, codexHome };
  const missing = await request(createServer(serverOptions), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-missing',
      answer: { kind: 'option', value: 'x' },
    }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'question request is required');

  await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-expired',
    question: 'Expired?',
    type: 'single-answerable',
    expiresAt: '2020-01-01T00:00:00.000Z',
    options: [{ label: 'X', value: 'x' }],
  });
  const expired = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-expired',
      expiresAt: '2020-01-01T00:00:00.000Z',
      answer: { kind: 'option', value: 'x' },
    }),
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.json.error, 'question request expired');

  await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-invalid',
    question: 'Invalid?',
    type: 'multi-answerable',
    options: [{ label: 'A', value: 'a' }],
  });

  const invalid = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-invalid',
      answer: { kind: 'multi' },
    }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'multi answer requires selected values or other_text');

  await registerQuestion(serverOptions, codexSessionId, {
    questionId: 'q-single-strict',
    question: 'One?',
    type: 'single-answerable',
    options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
  });
  const tooMany = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}/question-answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      questionId: 'q-single-strict',
      answer: { kind: 'option', value: 'a', selected_values: ['a', 'b'] },
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error, 'option answer requires exactly one selected value');
});

test('runtime project root ignores BRIDGE_STATE_ROOT storage location', async () => {
  const { root } = await fixture();
  const stateRoot = join(root, 'bridge-state');
  assert.equal(resolveRuntimeProjectRoot({ BRIDGE_STATE_ROOT: stateRoot }, root), root);
  assert.equal(resolveRuntimeProjectRoot({ BRIDGE_STATE_ROOT: stateRoot, PROJECT_ROOT: join(root, 'project') }, root), join(root, 'project'));
});

test('BRIDGE_STATE_ROOT keeps bridge operation logs outside project .omx logs', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const bridgeStateRoot = join(root, 'bridge-state');
  await withEnv({ BRIDGE_STATE_ROOT: bridgeStateRoot }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, `/sessions/${codexSessionId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '상태 루트 분리 확인', dryRun: true }),
    });
    assert.equal(res.status, 202);

    const stateLog = await readFile(join(bridgeStateRoot, 'bridge-interactions.jsonl'), 'utf8');
    assert.match(stateLog, /상태 루트 분리 확인/);
    const projectLog = await readFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), 'utf8').catch(() => '');
    assert.equal(projectLog, '');
  });
});

test('POST /sessions/:id/commands uses tmux target without submit key when submit is false', async () => {
  const { root, codexHome, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, '/sessions/omx-1777379336693-sjhnhr/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'tmux 전달 테스트', submit: false }),
    });

    assert.equal(res.status, 202);
    assert.equal(res.json.delivery.ok, true);
    assert.equal(res.json.interaction.tmuxId, 'bridge-test');
    assert.equal(res.json.interaction.tmuxPaneId, '%77');

    const calls = await readFile(fakeTmuxCallsPath, 'utf8');
    assert.match(calls, /send-keys -t %77 -l -- tmux 전달 테스트/);
    assert.doesNotMatch(calls, /Enter/);
  });
});

test('POST /sessions/:id/commands preserves Codex slash commands as tmux input', async () => {
  for (const slashCommand of ['/new', '/resume 019e-example-thread']) {
    const { root, codexHome, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
    await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
      const server = createServer({ projectRoot: root, codexHome });
      const res = await request(server, '/sessions/omx-1777379336693-sjhnhr/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandText: slashCommand, mode: 'tmux', submit: false }),
      });

      assert.equal(res.status, 202);
      assert.equal(res.json.delivery.ok, true);
      assert.equal(res.json.interaction.commandText, slashCommand);

      const calls = await readFile(fakeTmuxCallsPath, 'utf8');
      assert.match(calls, new RegExp(`send-keys -t %77 -l -- ${slashCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(calls, /omx-new/);
      assert.doesNotMatch(calls, /Enter/);
    });
  }
});

test('POST /sessions/:id/commands treats numeric helper flags as booleans', async () => {
  const { root, codexHome, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const dryRun = await request(createServer({ projectRoot: root, codexHome }), '/sessions/omx-1777379336693-sjhnhr/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '숫자 dry-run 확인', dryRun: 1 }),
    });
    assert.equal(dryRun.status, 202);
    assert.equal(dryRun.json.delivery.ok, true);
    assert.equal(dryRun.json.delivery.dryRun, true);
    assert.equal(await readFile(fakeTmuxCallsPath, 'utf8').catch(() => ''), '');

    const hold = await request(createServer({ projectRoot: root, codexHome }), '/sessions/omx-1777379336693-sjhnhr/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: '숫자 hold 확인', mode: 'tmux', submit: 0 }),
    });
    assert.equal(hold.status, 202);
    assert.equal(hold.json.delivery.ok, true);

    const calls = await readFile(fakeTmuxCallsPath, 'utf8');
    assert.match(calls, /send-keys -t %77 -l -- 숫자 hold 확인/);
    assert.doesNotMatch(calls, /Enter/);
  });
});


test('POST /sessions/:id/commands sends Enter submit key by default', async () => {
  const { root, codexHome, fakeTmuxBin, fakeTmuxCallsPath } = await fixture();
  await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => {
    const server = createServer({ projectRoot: root, codexHome });
    const res = await request(server, '/sessions/omx-1777379336693-sjhnhr/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandText: 'tmux 제출 테스트', mode: 'tmux' }),
    });

    assert.equal(res.status, 202);
    assert.equal(res.json.delivery.ok, true);

    const calls = await readFile(fakeTmuxCallsPath, 'utf8');
    assert.match(calls, /send-keys -t %77 -l -- tmux 제출 테스트/);
    assert.match(calls, /send-keys -t %77 Enter/);
    assert.doesNotMatch(calls, /C-m/);
  });
});

test('POST /sessions/:id/commands rejects missing commandText before audit append', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'commandText is required');
  assert.deepEqual(await readBridgeAudit(root), []);
});

test('POST /sessions/:id/commands records audit before tmux delivery failure', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const server = createServer({ projectRoot: root, codexHome });
  const res = await request(server, `/sessions/${codexSessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandText: 'tmux 없는 세션에 전송', dryRun: false }),
  });
  assert.equal(res.status, 502);
  assert.equal(res.json.delivery.ok, false);
  assert.match(res.json.delivery.error, /missing tmux target/);

  const records = await readBridgeAudit(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].commandText, 'tmux 없는 세션에 전송');
  assert.equal(records[0].codexSessionId, codexSessionId);
});

test('unknown routes and unsupported mutating methods keep existing error contracts', async () => {
  const { root, codexHome, codexSessionId } = await fixture();
  const missing = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'not_found' });

  const method = await request(createServer({ projectRoot: root, codexHome }), `/sessions/${codexSessionId}`, { method: 'PUT' });
  assert.equal(method.status, 405);
  assert.deepEqual(method.json, { error: 'method_not_allowed' });
});


test('GET and POST /projects/:project/channel resolve and persist project channel mapping', async () => {
  const { root, codexHome } = await fixture();
  const mapPath = join(root, '.omx', 'state', 'project-channels.json');
  await mkdir(join(root, '.omx', 'state'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: {} }));

  await withEnv({ BRIDGE_HERMES_PROJECT_CHANNEL_MAP: mapPath }, async () => {
    const getBefore = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-wiki/channel');
    assert.equal(getBefore.status, 200);
    assert.equal(getBefore.json.channelId, 'fallback-channel');
    assert.equal(getBefore.json.mappingStatus, 'fallback');
    assert.equal(getBefore.json.channelMissing, true);
    assert.equal(getBefore.json.desiredChannelName, 'chiz-wiki');

    const post = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-wiki/channel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'project-channel', channelName: 'chiz-wiki' }),
    });
    assert.equal(post.status, 200);
    assert.equal(post.json.ok, true);
    assert.equal(post.json.project, 'chiz-wiki');
    assert.equal(post.json.channelId, 'project-channel');

    const getAfter = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-wiki/channel');
    assert.equal(getAfter.status, 200);
    assert.equal(getAfter.json.channelId, 'project-channel');
    assert.equal(getAfter.json.mappingStatus, 'project');
    assert.equal(getAfter.json.channelMissing, false);

    const saved = JSON.parse(await readFile(mapPath, 'utf8'));
    assert.equal(saved.projects['chiz-wiki'], 'project-channel');
    assert.equal(saved.channelNames['chiz-wiki'], 'chiz-wiki');

    const auditContent = await readFile(join(root, '.omx', 'logs', 'bridge-audit.jsonl'), 'utf8');
    const audit = auditContent.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(audit.some((entry) => entry.eventType === 'project.channel_mapped' && entry.project === 'chiz-wiki'));
  });
});

test('POST /projects/:project/channel validates channelId', async () => {
  const { root, codexHome } = await fixture();
  const res = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-wiki/channel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: 'channelId is required' });
});

test('POST /projects/:project/channel rejects fallback channel persistence by default', async () => {
  const { root, codexHome } = await fixture();
  const mapPath = join(root, '.omx', 'state', 'project-channels.json');
  await mkdir(join(root, '.omx', 'state'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: {} }));

  await withEnv({ BRIDGE_HERMES_PROJECT_CHANNEL_MAP: mapPath }, async () => {
    const rejected = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-monitor/channel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'fallback-channel' }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.json, { error: 'refusing to persist fallback channel as project mapping' });

    const allowed = await request(createServer({ projectRoot: root, codexHome }), '/projects/chiz-monitor/channel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'fallback-channel', allowFallbackMapping: true }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.channelId, 'fallback-channel');
  });
});
