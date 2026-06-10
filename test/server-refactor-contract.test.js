import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from '../src/server.js';
import {
  closeEventIndex,
  markDeliveryFailed,
  markDeliveryPrepared,
  markDeliverySent,
  openEventIndex,
  pendingEvents,
  upsertEvents,
} from '../src/control-plane/event-index.js';

const execFileAsync = promisify(execFile);

async function requestRaw(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

async function runHelper(args, env) {
  try {
    const result = await execFileAsync('bin/tm-send', args, { env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function readCurlCalls(logPath) {
  const raw = await readFile(logPath, 'utf8');
  return raw.split('\n').filter((line) => line === 'CALL').length;
}

test('raw HTTP JSON responses preserve pretty body, content-type, content-length, auth, and error quirks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-route-contract-'));
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  const authServerOptions = { projectRoot: root, codexHome: join(root, 'codex-home'), authToken: 'secret-token' };

  const health = await requestRaw(createServer(authServerOptions), '/health');
  assert.equal(health.status, 200);
  assert.equal(health.text, prettyJson({ ok: true }));
  assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(Number(health.headers.get('content-length')), Buffer.byteLength(health.text));

  const unauthorized = await requestRaw(createServer(authServerOptions), '/sessions');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.text, prettyJson({ error: 'unauthorized' }));
  assert.equal(unauthorized.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(Number(unauthorized.headers.get('content-length')), Buffer.byteLength(unauthorized.text));

  const notFound = await requestRaw(createServer(authServerOptions), '/does-not-exist', {
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.text, prettyJson({ error: 'not_found' }));
  assert.equal(Number(notFound.headers.get('content-length')), Buffer.byteLength(notFound.text));

  const method = await requestRaw(createServer(authServerOptions), '/does-not-exist', {
    method: 'PUT',
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(method.status, 405);
  assert.equal(method.text, prettyJson({ error: 'method_not_allowed' }));
  assert.equal(Number(method.headers.get('content-length')), Buffer.byteLength(method.text));

  const invalidJson = await requestRaw(createServer(authServerOptions), '/projects/project-a/channel', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    },
    body: '{"commandText":',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.text, prettyJson({ error: 'invalid_json', message: 'invalid_json' }));
  assert.equal(Number(invalidJson.headers.get('content-length')), Buffer.byteLength(invalidJson.text));
});

test('helper CLI scripts keep bridge API selection and payload contracts visible', async () => {
  const send = await readFile('bin/tm-send', 'utf8');
  assert.match(send, /mode must be one of auto\|tmux\|codex/);
  assert.match(send, /--discord-approval/);
  assert.match(send, /--answer-approval/);
  assert.match(send, /--question-id/);
  assert.match(send, /\/sessions\/\$session_id\/question-answers/);
  assert.match(send, /discord-hermes-tmux-send/);
  assert.match(send, /\/sessions\?limit=\$session_list_limit/);
  assert.match(send, /select\(\.project==\$project and \(\.status=="active" or \.tmuxId != null\)\)/);
  assert.match(send, /\{commandText:\$text, mode:\$mode, dryRun:\$dry, submit:\$submit, normalize:\$normalize\}/);
  assert.match(send, /\{approvalGate:\$approval_gate\}/);
  assert.match(send, /-X POST "\$bridge_url\/sessions\/\$session_id\/commands"/);

  const kill = await readFile('bin/tm-kill', 'utf8');
  assert.match(kill, /"\$bridge_url\/sessions"/);
  assert.match(kill, /\.bridgeSessionId==\$id or \.codexSessionId==\$id or \.omxSessionId==\$id or \.tmuxId==\$id or \.tmuxPaneId==\$id/);
  assert.match(kill, /select\(\.project==\$project and \.status!="ended" and \(\.tmuxId != null\)\)/);
  assert.match(kill, /non-interactive use requires --force/);
  assert.match(kill, /tmux kill-session -t "\$managed_session_name"/);
});

test('tm-send approval dispatch is session-only before any curl side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tm-send-approval-cli-'));
  const curlLog = join(root, 'curl.log');
  const fakeCurl = join(root, 'curl');
  await writeFile(curlLog, '');
  await writeFile(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL\\n'
  printf '%s\\n' "$@"
} >> "$CURL_LOG"
if [[ "$*" == *'/sessions?activity=false'* ]]; then
  printf '{"sessions":[{"bridgeSessionId":"sess-project","project":"demo","status":"active","tmuxId":"tmux-1","lastEventAt":"2026-06-10T00:00:00.000Z"}]}'
else
  printf '{"ok":true}'
fi
`);
  await chmod(fakeCurl, 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ''}`,
    CURL_LOG: curlLog,
    OMX_BRIDGE_URL: 'http://bridge.test',
  };

  const missingSession = await runHelper(['--discord-approval', 'hello'], env);
  assert.notEqual(missingSession.code, 0);
  assert.match(missingSession.stderr, /--discord-approval requires --session/);

  const projectOnly = await runHelper(['--project', 'demo', '--discord-approval', 'hello'], env);
  assert.notEqual(projectOnly.code, 0);
  assert.match(projectOnly.stderr, /--discord-approval forbids --project/);

  const mixedTarget = await runHelper(['--session', 'sess-123', '--project', 'demo', '--discord-approval', 'hello'], env);
  assert.notEqual(mixedTarget.code, 0);
  assert.match(mixedTarget.stderr, /--discord-approval forbids --project/);

  assert.equal(await readCurlCalls(curlLog), 0);

  const validApproval = await runHelper(['--session', 'sess-123', '--discord-approval', 'hello'], env);
  assert.equal(validApproval.code, 0);
  let log = await readFile(curlLog, 'utf8');
  assert.equal(await readCurlCalls(curlLog), 1);
  assert.match(log, /http:\/\/bridge\.test\/sessions\/sess-123\/commands/);
  assert.match(log, /"approvalGate":\s*"discord-hermes-tmux-send"/);

  const nonApprovalProject = await runHelper(['--project', 'demo', 'hello'], env);
  assert.equal(nonApprovalProject.code, 0);
  log = await readFile(curlLog, 'utf8');
  assert.equal(await readCurlCalls(curlLog), 3);
  assert.match(log, /http:\/\/bridge\.test\/sessions[?]activity=false&limit=50/);
  assert.match(log, /http:\/\/bridge\.test\/sessions\/sess-project\/commands/);
});

test('event-index schema and delivery transition columns stay contract-frozen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-event-schema-contract-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const db = index.db;
    const columnNames = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.deepEqual(columnNames('events'), [
      'event_id', 'event_type', 'timestamp', 'timestamp_ms', 'session_id', 'project', 'source', 'phase', 'event_json', 'session_json', 'created_at', 'updated_at',
    ]);
    assert.deepEqual(columnNames('deliveries'), [
      'event_id', 'sink', 'status', 'sent_at', 'retry_count', 'last_attempt_at', 'next_attempt_at', 'last_error', 'updated_at', 'payload_json', 'payload_hash', 'payload_bytes', 'payload_preview', 'prepared_at', 'expires_at', 'target_channel_id', 'target_thread_id', 'target_thread_name', 'target_kind',
    ]);
    assert.deepEqual(columnNames('index_meta'), ['key', 'value']);
    assert.deepEqual(columnNames('codex_log_cursors'), ['log_path', 'codex_session_id', 'last_line', 'first_seen_at', 'updated_at']);

    const event = { eventId: 'event-1', type: 'CommandSubmitted', source: 'codex-log', timestamp: '2026-05-06T08:00:00.000Z', text: 'hello' };
    const session = { bridgeSessionId: 'bridge-1', project: 'omx-bridge', omxSessionId: 'omx-1' };
    upsertEvents(db, [{ eventId: 'event-1', event, session }]);
    markDeliveryPrepared(db, 'event-1', 'contract-sink', { chunks: ['hello'] }, {
      targetChannelId: 'channel-1',
      targetThreadId: 'thread-1',
      targetThreadName: 'omx-thread',
      targetKind: 'session-thread',
    });
    let delivery = db.prepare('SELECT status, retry_count, target_channel_id, target_thread_id, target_thread_name, target_kind, payload_json FROM deliveries WHERE event_id = ? AND sink = ?').get('event-1', 'contract-sink');
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.retry_count, 0);
    assert.equal(delivery.target_channel_id, 'channel-1');
    assert.equal(delivery.target_thread_id, 'thread-1');
    assert.equal(delivery.target_thread_name, 'omx-thread');
    assert.equal(delivery.target_kind, 'session-thread');
    assert.match(delivery.payload_json, /"chunks"/);

    markDeliveryFailed(db, 'event-1', 'contract-sink', new Error('temporary'), { maxAttempts: 3, nextAttemptAt: '2026-05-06T08:00:02.000Z' });
    delivery = db.prepare('SELECT status, retry_count, last_error, next_attempt_at FROM deliveries WHERE event_id = ? AND sink = ?').get('event-1', 'contract-sink');
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.retry_count, 1);
    assert.equal(delivery.last_error, 'temporary');
    assert.equal(delivery.next_attempt_at, '2026-05-06T08:00:02.000Z');

    markDeliverySent(db, 'event-1', 'contract-sink', {
      targetChannelId: 'channel-1',
      targetThreadId: 'thread-1',
      targetThreadName: 'omx-thread',
      targetKind: 'session-thread',
    });
    delivery = db.prepare('SELECT status, retry_count, next_attempt_at, last_error, target_channel_id, target_thread_id, target_thread_name, target_kind FROM deliveries WHERE event_id = ? AND sink = ?').get('event-1', 'contract-sink');
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.retry_count, 1);
    assert.equal(delivery.next_attempt_at, null);
    assert.equal(delivery.last_error, null);
    assert.equal(delivery.target_channel_id, 'channel-1');
    assert.equal(delivery.target_thread_id, 'thread-1');
    assert.equal(delivery.target_thread_name, 'omx-thread');
    assert.equal(delivery.target_kind, 'session-thread');
    assert.deepEqual(pendingEvents(db, 'contract-sink'), []);
  } finally {
    closeEventIndex(index);
  }
});
