import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('raw HTTP JSON responses preserve pretty body, content-type, content-length, auth, and error quirks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-route-contract-'));
  await mkdir(join(root, '.codex', 'logs'), { recursive: true });
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
});

test('helper CLI scripts keep bridge API selection and payload contracts visible', async () => {
  const send = await readFile('bin/codex-send', 'utf8');
  assert.match(send, /mode는 auto\|tmux\|codex 중 하나/);
  assert.match(send, /--discord-approval/);
  assert.match(send, /--answer-approval/);
  assert.match(send, /--question-id/);
  assert.match(send, /\/sessions\/\$session_id\/question-answers/);
  assert.match(send, /discord-hermes-codex-send/);
  assert.match(send, /\/sessions\?activity=false&limit=\$session_list_limit/);
  assert.match(send, /select\(\.project==\$project and \.status!="ended"\)/);
  assert.match(send, /\{commandText:\$text, mode:\$mode, dryRun:\$dry, submit:\$submit, normalize:\$normalize\}/);
  assert.match(send, /\{approvalGate:\$approval_gate\}/);
  assert.match(send, /-X POST "\$bridge_url\/sessions\/\$session_id\/commands"/);

  const kill = await readFile('bin/codex-kill', 'utf8');
  assert.match(kill, /"\$bridge_url\/sessions"/);
  assert.match(kill, /\.bridgeSessionId==\$id or \.codexSessionId==\$id or \.lifecycleSessionId==\$id or \.tmuxId==\$id or \.tmuxPaneId==\$id/);
  assert.match(kill, /select\(\.project==\$project and \.status!="ended" and \(\.tmuxId != null\)\)/);
  assert.match(kill, /비대화형 환경에서는 --force가 필요합니다/);
  assert.match(kill, /tmux kill-session -t "\$tmux_id"/);
});

test('event-index schema and delivery transition columns stay contract-frozen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-schema-contract-'));
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
    const session = { bridgeSessionId: 'bridge-1', project: 'codex-bridge', lifecycleSessionId: 'codex-1' };
    upsertEvents(db, [{ eventId: 'event-1', event, session }]);
    markDeliveryPrepared(db, 'event-1', 'contract-sink', { chunks: ['hello'] }, {
      targetChannelId: 'channel-1',
      targetThreadId: 'thread-1',
      targetThreadName: 'codex-thread',
      targetKind: 'session-thread',
    });
    let delivery = db.prepare('SELECT status, retry_count, target_channel_id, target_thread_id, target_thread_name, target_kind, payload_json FROM deliveries WHERE event_id = ? AND sink = ?').get('event-1', 'contract-sink');
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.retry_count, 0);
    assert.equal(delivery.target_channel_id, 'channel-1');
    assert.equal(delivery.target_thread_id, 'thread-1');
    assert.equal(delivery.target_thread_name, 'codex-thread');
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
      targetThreadName: 'codex-thread',
      targetKind: 'session-thread',
    });
    delivery = db.prepare('SELECT status, retry_count, next_attempt_at, last_error, target_channel_id, target_thread_id, target_thread_name, target_kind FROM deliveries WHERE event_id = ? AND sink = ?').get('event-1', 'contract-sink');
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.retry_count, 1);
    assert.equal(delivery.next_attempt_at, null);
    assert.equal(delivery.last_error, null);
    assert.equal(delivery.target_channel_id, 'channel-1');
    assert.equal(delivery.target_thread_id, 'thread-1');
    assert.equal(delivery.target_thread_name, 'codex-thread');
    assert.equal(delivery.target_kind, 'session-thread');
    assert.deepEqual(pendingEvents(db, 'contract-sink'), []);
  } finally {
    closeEventIndex(index);
  }
});
