import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeEventIndex,
  compactEventIndex,
  eventIndexStats,
  markDeliveryFailed,
  markDeliveryPrepared,
  markSkippedBeforeDeliveries,
  markDeliverySent,
  normalizeEventId,
  openEventIndex,
  pendingEvents,
  upsertEvents,
} from '../src/control-plane/event-index.js';

test('normalizeEventId hashes fallback text instead of embedding large payloads', () => {
  const text = `${'대용량 프롬프트 '.repeat(400)}끝부분`;
  const eventId = normalizeEventId(
    { bridgeSessionId: 'bridge-1' },
    {
      type: 'CommandSubmitted',
      source: 'codex-log',
      timestamp: '2026-05-06T08:00:00.000Z',
      text,
    },
  );

  assert.equal(eventId.length < 120, true);
  assert.match(eventId, /^bridge-1:codex-log:CommandSubmitted:2026-05-06T08:00:00\.000Z:text:/);
  assert.doesNotMatch(eventId, /끝부분|대용량 프롬프트/);
});

test('markDeliverySent stores Discord delivery target metadata idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-delivery-target-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'bridge-1', project: 'docs' },
      event: {
        eventId: 'event-1',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: 'prompt',
      },
    }]);
    markDeliverySent(index.db, 'event-1', 'discord-fast', {
      targetChannelId: 'thread-1',
      targetThreadId: 'thread-1',
      targetThreadName: 'codex-docs-101814',
      targetKind: 'session-thread',
    });

    const row = Object.fromEntries(Object.entries(index.db.prepare(`
      SELECT target_channel_id, target_thread_id, target_thread_name, target_kind
      FROM deliveries
      WHERE event_id = 'event-1' AND sink = 'discord-fast'
    `).get()));
    assert.deepEqual(row, {
      target_channel_id: 'thread-1',
      target_thread_id: 'thread-1',
      target_thread_name: 'codex-docs-101814',
      target_kind: 'session-thread',
    });
  } finally {
    closeEventIndex(index);
  }
});

test('upsertEvents deduplicates bridge fast command and codex-log command notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-command-dedupe-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  const session = { bridgeSessionId: 'bridge-1', codexSessionId: 'codex-1', project: 'auto-zonedata' };
  try {
    upsertEvents(index.db, [{
      session,
      event: {
        eventId: 'bridge-command:interaction-1',
        type: 'CommandSubmitted',
        source: 'bridge-interactions',
        timestamp: '2026-05-29T10:33:51.583Z',
        text: '$ultragoal',
        interactionId: 'interaction-1',
      },
    }]);
    markDeliverySent(index.db, 'bridge-command:interaction-1', 'hermes');

    upsertEvents(index.db, [{
      session,
      event: {
        eventId: 'codex-1:message-4594',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-29T10:33:52.451Z',
        text: '$ultragoal',
      },
    }]);

    const rows = index.db.prepare(`
      SELECT event_id, event_type, source
      FROM events
      WHERE event_type = 'CommandSubmitted'
      ORDER BY event_id
    `).all();
    assert.deepEqual(rows.map((row) => row.event_id), ['bridge-command:interaction-1']);
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['CommandSubmitted']), limit: 10 }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('upsertEvents keeps separate repeated bridge commands with the same text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-command-repeat-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  const session = { bridgeSessionId: 'bridge-1', codexSessionId: 'codex-1', project: 'auto-zonedata' };
  try {
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'bridge-command:interaction-1',
          type: 'CommandSubmitted',
          source: 'bridge-interactions',
          timestamp: '2026-05-29T10:33:51.000Z',
          text: '$ultragoal',
          interactionId: 'interaction-1',
        },
      },
      {
        session,
        event: {
          eventId: 'bridge-command:interaction-2',
          type: 'CommandSubmitted',
          source: 'bridge-interactions',
          timestamp: '2026-05-29T10:34:10.000Z',
          text: '$ultragoal',
          interactionId: 'interaction-2',
        },
      },
    ]);

    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['CommandSubmitted']), limit: 10 }).map((item) => item.eventId),
      ['bridge-command:interaction-1', 'bridge-command:interaction-2'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('sent delivery target metadata is immutable audit evidence on later retarget attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-sent-target-immutable-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'codex-old', codexSessionId: 'codex-old', lifecycleSessionId: 'codex-old', project: 'docs' },
      event: {
        eventId: 'codex-resumed:message-99',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-24T18:03:22.326Z',
        text: 'resume prompt',
      },
    }]);
    markDeliverySent(index.db, 'codex-resumed:message-99', 'discord-fast', {
      targetChannelId: 'old-thread',
      targetThreadId: 'old-thread',
      targetThreadName: 'codex-docs-old',
      targetKind: 'session-thread',
    });

    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'codex-resumed', codexSessionId: 'codex-resumed', lifecycleSessionId: 'codex-new', project: 'docs' },
      event: {
        eventId: 'codex-resumed:message-99',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-24T18:03:22.326Z',
        text: 'resume prompt',
      },
    }]);
    markDeliveryPrepared(index.db, 'codex-resumed:message-99', 'discord-fast', { chunks: ['# User Command\nresume prompt'] }, {
      targetChannelId: 'new-thread',
      targetThreadId: 'new-thread',
      targetThreadName: 'codex-docs-new',
      targetKind: 'session-thread',
    });
    markDeliverySent(index.db, 'codex-resumed:message-99', 'discord-fast', {
      targetChannelId: 'new-thread',
      targetThreadId: 'new-thread',
      targetThreadName: 'codex-docs-new',
      targetKind: 'session-thread',
    });

    const row = index.db.prepare(`
      SELECT status, target_channel_id, target_thread_id, target_thread_name, target_kind, last_error
      FROM deliveries
      WHERE event_id = 'codex-resumed:message-99' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.status, 'sent');
    assert.equal(row.target_channel_id, 'old-thread');
    assert.equal(row.target_thread_id, 'old-thread');
    assert.equal(row.target_thread_name, 'codex-docs-old');
    assert.equal(row.target_kind, 'session-thread');
    assert.match(row.last_error, /sent delivery target mismatch/);

    markDeliverySent(index.db, 'codex-resumed:message-99', 'discord-fast', {
      targetChannelId: 'old-thread',
      targetThreadId: 'old-thread',
      targetThreadName: 'codex-docs-old',
      targetKind: 'session-thread',
    });
    const idempotentRow = index.db.prepare(`
      SELECT target_thread_id, last_error
      FROM deliveries
      WHERE event_id = 'codex-resumed:message-99' AND sink = 'discord-fast'
    `).get();
    assert.equal(idempotentRow.target_thread_id, 'old-thread');
    assert.match(idempotentRow.last_error, /sent delivery target mismatch/);
  } finally {
    closeEventIndex(index);
  }
});

test('markDeliveryPrepared stores the exact outbound payload snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-delivery-payload-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'bridge-1',
        codexSessionId: 'codex-1',
        tmuxId: 'tmux-docs',
        project: 'docs',
      },
      event: {
        eventId: 'event-1',
        type: 'FinalAnswer',
        source: 'codex-log',
        phase: 'final_answer',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: 'final answer',
      },
    }]);
    const payload = {
      transport: 'discord-channel',
      channelId: 'thread-1',
      chunks: ['# Session Idle\nfinal answer'],
      session: {
        sessionId: 'bridge-1',
        codexSessionId: 'codex-1',
        tmuxId: 'tmux-docs',
        project: 'docs',
      },
    };
    markDeliveryPrepared(index.db, 'event-1', 'discord-fast', payload, {
      targetChannelId: 'thread-1',
      targetThreadId: 'thread-1',
      targetThreadName: 'tmux-docs',
      targetKind: 'session-thread',
    });

    const row = index.db.prepare(`
      SELECT status, payload_json, payload_hash, payload_bytes, payload_preview, prepared_at,
        target_channel_id, target_thread_id, target_thread_name, target_kind
      FROM deliveries
      WHERE event_id = 'event-1' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.status, 'pending');
    assert.deepEqual(JSON.parse(row.payload_json), payload);
    assert.equal(row.payload_hash.length, 64);
    assert.equal(row.payload_bytes, Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    assert.match(row.payload_preview, /Session Idle/);
    assert.ok(row.prepared_at);
    assert.equal(row.target_channel_id, 'thread-1');
    assert.equal(row.target_thread_id, 'thread-1');
    assert.equal(row.target_thread_name, 'tmux-docs');
    assert.equal(row.target_kind, 'session-thread');
    assert.equal(eventIndexStats(index.db).preparedDeliveries, 1);

    markDeliveryFailed(index.db, 'event-1', 'discord-fast', new Error('network down'), { retryBaseMs: 1, retryMaxMs: 1 });
    const failedRow = index.db.prepare(`
      SELECT status, payload_json, payload_hash, last_error, next_attempt_at
      FROM deliveries
      WHERE event_id = 'event-1' AND sink = 'discord-fast'
    `).get();
    assert.equal(failedRow.status, 'failed');
    assert.deepEqual(JSON.parse(failedRow.payload_json), payload);
    assert.equal(failedRow.payload_hash, row.payload_hash);
    assert.equal(failedRow.last_error, 'network down');
    assert.ok(failedRow.next_attempt_at);

    markDeliverySent(index.db, 'event-1', 'discord-fast');
    const sentRow = index.db.prepare(`
      SELECT status, payload_json, payload_hash, sent_at, expires_at
      FROM deliveries
      WHERE event_id = 'event-1' AND sink = 'discord-fast'
    `).get();
    assert.equal(sentRow.status, 'sent');
    assert.deepEqual(JSON.parse(sentRow.payload_json), payload);
    assert.equal(sentRow.payload_hash, row.payload_hash);
    assert.ok(sentRow.sent_at);
    assert.ok(sentRow.expires_at);
  } finally {
    closeEventIndex(index);
  }
});

test('event index compacts by high-water/low-water without deleting failed deliveries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-1', project: 'codex-bridge' };
    const items = Array.from({ length: 7 }, (_, index) => ({
      session,
      eventId: `event-${index + 1}`,
      event: {
        eventId: `event-${index + 1}`,
        type: 'FinalAnswer',
        source: 'codex-log',
        phase: 'final_answer',
        timestamp: `2026-05-0${index + 1}T00:00:00.000Z`,
        text: `answer ${index + 1}`,
      },
    }));
    upsertEvents(index.db, items);
    for (const item of items.slice(0, 6)) markDeliverySent(index.db, item.eventId, 'hermes');
    markDeliveryFailed(index.db, 'event-7', 'hermes', new Error('temporary failure'));
    index.db.prepare(`UPDATE deliveries SET next_attempt_at = '2026-05-01T00:00:00.000Z' WHERE event_id = 'event-7'`).run();

    const result = compactEventIndex(index.db, {
      retentionDays: 365,
      maxEvents: 5,
      compactTargetEvents: 3,
      maxDeliveries: 20,
      compactTargetDeliveries: 10,
    });

    assert.equal(result.events.before, 7);
    assert.equal(result.events.after, 3);
    assert.equal(eventIndexStats(index.db).events, 3);
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['FinalAnswer']), limit: 10 }).map((item) => item.eventId),
      ['event-7'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents returns only the older due retry before newer same-session events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-pending-priority-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-1', project: 'codex-bridge' };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'old-failed',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-01T00:00:00.000Z',
          text: 'old failed',
        },
      },
      {
        session,
        event: {
          eventId: 'new-pending',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-01T00:10:00.000Z',
          text: 'new pending',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'old-failed', 'discord-fast', new Error('temporary Discord failure'));
    index.db.prepare(`UPDATE deliveries SET next_attempt_at = '2026-05-01T00:00:00.000Z' WHERE event_id = 'old-failed'`).run();

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['CommandSubmitted']), limit: 10 }).map((item) => ({
        eventId: item.eventId,
        deliveryStatus: item.deliveryStatus,
      })),
      [
        { eventId: 'old-failed', deliveryStatus: 'failed' },
      ],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents holds newer cross-session events behind an older unresolved retry for the same sink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-cross-session-fifo-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [
      {
        session: { bridgeSessionId: 'bridge-old', project: 'codex-bridge' },
        event: {
          eventId: 'old-session-failed',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-01T00:00:00.000Z',
          text: 'old failed',
        },
      },
      {
        session: { bridgeSessionId: 'bridge-new', project: 'codex-bridge' },
        event: {
          eventId: 'new-session-pending',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-01T00:10:00.000Z',
          text: 'new pending',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'old-session-failed', 'discord-fast', new Error('temporary Discord failure'));
    index.db.prepare(`UPDATE deliveries SET next_attempt_at = '2026-05-01T00:00:00.000Z' WHERE event_id = 'old-session-failed'`).run();

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['CommandSubmitted']), fifoScope: 'sink', limit: 10 }).map((item) => item.eventId),
      ['old-session-failed'],
    );
    markDeliverySent(index.db, 'old-session-failed', 'discord-fast');
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['CommandSubmitted']), fifoScope: 'sink', limit: 10 }).map((item) => item.eventId),
      ['new-session-pending'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents holds newer same-session events while an older retry is unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-retry-hold-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-hold', project: 'codex-bridge' };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'older-failed',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-01T00:00:00.000Z',
          text: 'older',
        },
      },
      {
        session,
        event: {
          eventId: 'newer-pending',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-01T00:00:01.000Z',
          text: 'newer',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'older-failed', 'hermes', new Error('temporary failure'), {
      retryBaseMs: 60000,
      retryMaxMs: 60000,
    });
    const delivery = index.db.prepare(`
      SELECT last_attempt_at, next_attempt_at
      FROM deliveries
      WHERE event_id = 'older-failed' AND sink = 'hermes'
    `).get();

    assert.deepEqual(
      pendingEvents(index.db, 'hermes', {
        eventTypes: new Set(['FinalAnswer']),
        now: delivery.last_attempt_at,
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', {
        eventTypes: new Set(['FinalAnswer']),
        now: delivery.next_attempt_at,
        limit: 10,
      }).map((item) => item.eventId),
      ['older-failed'],
    );
    markDeliverySent(index.db, 'older-failed', 'hermes');
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', {
        eventTypes: new Set(['FinalAnswer']),
        now: delivery.next_attempt_at,
        limit: 10,
      }).map((item) => item.eventId),
      ['newer-pending'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents can hold fast commands behind prior final-answer delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-prior-delivery-block-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-queue', project: 'codex-bridge' };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'final-before-queue',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-29T05:55:50.000Z',
          text: 'done',
        },
      },
      {
        session,
        event: {
          eventId: 'queued-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-29T05:55:51.000Z',
          text: 'next prompt',
        },
      },
    ]);
    markDeliveryPrepared(index.db, 'final-before-queue', 'hermes', { chunks: ['done'] });

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['CommandSubmitted']),
        priorDeliveryBlocks: [{
          sink: 'hermes',
          eventTypes: new Set(['FinalAnswer']),
          missingDeliveryGraceMs: 10000,
        }],
        now: '2026-05-29T05:55:52.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );

    markDeliverySent(index.db, 'final-before-queue', 'hermes');
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['CommandSubmitted']),
        priorDeliveryBlocks: [{
          sink: 'hermes',
          eventTypes: new Set(['FinalAnswer']),
          missingDeliveryGraceMs: 10000,
        }],
        now: '2026-05-29T05:55:52.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      ['queued-command'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents keeps delayed prior delivery errors observable before releasing commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-prior-delivery-error-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-queue', project: 'codex-bridge' };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'final-before-queue',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-29T05:55:50.000Z',
          text: 'done',
        },
      },
      {
        session,
        event: {
          eventId: 'queued-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-29T05:55:51.000Z',
          text: 'next prompt',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'final-before-queue', 'hermes', new Error('Hermes timeout'), {
      maxAttempts: 2,
      nextAttemptAt: '2026-05-29T05:56:00.000Z',
    });
    const options = {
      eventTypes: new Set(['CommandSubmitted']),
      priorDeliveryBlocks: [{
        sink: 'hermes',
        eventTypes: new Set(['FinalAnswer']),
        missingDeliveryGraceMs: 10000,
      }],
      now: '2026-05-29T05:56:01.000Z',
      limit: 10,
    };

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', options).map((item) => item.eventId),
      [],
    );
    const failed = index.db.prepare(`
      SELECT status, last_error
      FROM deliveries
      WHERE event_id = 'final-before-queue' AND sink = 'hermes'
    `).get();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.last_error, 'Hermes timeout');

    markDeliveryFailed(index.db, 'final-before-queue', 'hermes', new Error('Hermes timeout again'), {
      maxAttempts: 2,
    });
    const dead = index.db.prepare(`
      SELECT status, last_error
      FROM deliveries
      WHERE event_id = 'final-before-queue' AND sink = 'hermes'
    `).get();
    assert.equal(dead.status, 'dead');
    assert.equal(dead.last_error, 'Hermes timeout again');
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', options).map((item) => item.eventId),
      ['queued-command'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents only grace-holds missing prior delivery rows briefly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-prior-delivery-grace-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = { bridgeSessionId: 'bridge-queue', project: 'codex-bridge' };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'final-not-yet-picked-up',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-29T05:55:50.000Z',
          text: 'done',
        },
      },
      {
        session,
        event: {
          eventId: 'queued-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-29T05:55:51.000Z',
          text: 'next prompt',
        },
      },
    ]);
    const options = {
      eventTypes: new Set(['CommandSubmitted']),
      priorDeliveryBlocks: [{
        sink: 'hermes',
        eventTypes: new Set(['FinalAnswer']),
        missingDeliveryGraceMs: 10000,
      }],
      limit: 10,
    };

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        ...options,
        now: '2026-05-29T05:55:52.000Z',
      }).map((item) => item.eventId),
      [],
    );
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        ...options,
        now: '2026-05-29T05:56:01.000Z',
      }).map((item) => item.eventId),
      ['queued-command'],
    );
  } finally {
    closeEventIndex(index);
  }
});


test('markSkippedBeforeDeliveries makes boot-cutoff skips observable and non-pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-skipped-before-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const session = {
      bridgeSessionId: 'codex-cutoff',
      codexSessionId: 'codex-cutoff',
      lifecycleSessionId: 'codex-cutoff',
      project: 'codex-bridge',
      status: 'active',
    };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'old-command-before-boot',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:00.000Z',
          text: 'old command',
        },
      },
      {
        session,
        event: {
          eventId: 'new-command-after-boot',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:02:00.000Z',
          text: 'new command',
        },
      },
    ]);

    const changed = markSkippedBeforeDeliveries(index.db, 'discord-fast', {
      eventTypes: new Set(['CommandSubmitted']),
      skipBefore: '2026-05-14T01:01:00.000Z',
    });
    assert.equal(changed, 1);

    const oldRow = index.db.prepare(`
      SELECT status, last_error
      FROM deliveries
      WHERE event_id = 'old-command-before-boot' AND sink = 'discord-fast'
    `).get();
    assert.equal(oldRow.status, 'dead');
    assert.match(oldRow.last_error, /skipped before notifier boot cutoff/);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['CommandSubmitted']),
        skipBefore: '2026-05-14T01:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      ['new-command-after-boot'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('failed deliveries stay durable but wait until next_attempt_at before retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-retry-window-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'bridge-1', project: 'codex-bridge' },
      event: {
        eventId: 'retry-me',
        type: 'FinalAnswer',
        source: 'codex-log',
        phase: 'final_answer',
        timestamp: '2026-05-01T00:00:00.000Z',
        text: 'answer',
      },
    }]);
    markDeliveryFailed(index.db, 'retry-me', 'hermes', new Error('temporary Hermes failure'), {
      retryBaseMs: 60000,
      retryMaxMs: 60000,
    });

    const delivery = index.db.prepare(`
      SELECT status, retry_count, last_attempt_at, next_attempt_at, last_error
      FROM deliveries
      WHERE event_id = 'retry-me' AND sink = 'hermes'
    `).get();
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.retry_count, 1);
    assert.deepEqual(eventIndexStats(index.db).deliveryStatusCounts, { failed: 1 });
    assert.match(delivery.last_error, /temporary Hermes failure/);
    assert.ok(delivery.last_attempt_at);
    assert.ok(delivery.next_attempt_at);

    assert.deepEqual(
      pendingEvents(index.db, 'hermes', {
        eventTypes: new Set(['FinalAnswer']),
        now: delivery.last_attempt_at,
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', {
        eventTypes: new Set(['FinalAnswer']),
        now: delivery.next_attempt_at,
        limit: 10,
      }).map((item) => item.eventId),
      ['retry-me'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('failed deliveries stop retrying after max attempts and compact after expiry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-retry-dead-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'bridge-dead', project: 'codex-bridge' },
      event: {
        eventId: 'retry-dead',
        type: 'FinalAnswer',
        source: 'codex-log',
        phase: 'final_answer',
        timestamp: '2020-01-01T00:00:00.000Z',
        text: 'answer',
      },
    }]);

    markDeliveryFailed(index.db, 'retry-dead', 'hermes', new Error('temporary failure'), {
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    const first = index.db.prepare(`
      SELECT status, retry_count, next_attempt_at, expires_at
      FROM deliveries
      WHERE event_id = 'retry-dead' AND sink = 'hermes'
    `).get();
    assert.equal(first.status, 'failed');
    assert.equal(first.retry_count, 1);
    assert.ok(first.next_attempt_at);
    assert.equal(first.expires_at, null);

    markDeliveryFailed(index.db, 'retry-dead', 'hermes', new Error('still failing'), {
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    const terminal = index.db.prepare(`
      SELECT status, retry_count, next_attempt_at, last_error, expires_at
      FROM deliveries
      WHERE event_id = 'retry-dead' AND sink = 'hermes'
    `).get();
    assert.equal(terminal.status, 'dead');
    assert.equal(terminal.retry_count, 2);
    assert.equal(terminal.next_attempt_at, null);
    assert.equal(terminal.last_error, 'still failing');
    assert.ok(terminal.expires_at);
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['FinalAnswer']), limit: 10 }).map((item) => item.eventId),
      [],
    );

    index.db.prepare(`
      UPDATE deliveries
      SET expires_at = '2000-01-01T00:00:00.000Z'
      WHERE event_id = 'retry-dead' AND sink = 'hermes'
    `).run();
    compactEventIndex(index.db, {
      retentionDays: 1,
      maxEvents: 100,
      compactTargetEvents: 80,
      maxDeliveries: 100,
      compactTargetDeliveries: 80,
    });
    assert.equal(index.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_id = 'retry-dead'`).get().count, 0);
    assert.equal(index.db.prepare(`SELECT COUNT(*) AS count FROM deliveries WHERE event_id = 'retry-dead'`).get().count, 0);
  } finally {
    closeEventIndex(index);
  }
});

test('event index compaction preserves undelivered pending events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-pending-compact-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    upsertEvents(index.db, [
      {
        session: { bridgeSessionId: 'pending-old', project: 'codex-bridge' },
        event: {
          eventId: 'pending-old:answer',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-01T00:00:00.000Z',
          text: 'still pending',
        },
      },
      {
        session: { bridgeSessionId: 'sent-old', project: 'codex-bridge' },
        event: {
          eventId: 'sent-old:answer',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-01T00:00:01.000Z',
          text: 'already sent',
        },
      },
    ]);
    markDeliverySent(index.db, 'sent-old:answer', 'hermes');

    compactEventIndex(index.db, {
      retentionDays: 1,
      maxEvents: 100,
      compactTargetEvents: 80,
      maxDeliveries: 100,
      compactTargetDeliveries: 80,
    });

    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['FinalAnswer']), limit: 10 }).map((item) => item.eventId),
      ['pending-old:answer'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('event index refreshes pending session mapping after Codex slash command reconciles a new native id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-reconcile-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-new-visible:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-visible',
        lifecycleSessionId: 'codex-new-visible',
        project: 'news-insight',
      },
      event,
    }]);

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-thread',
        codexThreadId: 'codex-new-thread',
        codexSessionId: 'codex-new-thread',
        lifecycleSessionId: 'codex-new-visible',
        project: 'news-insight',
      },
      event,
    }]);

    const [pending] = pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionStart']), limit: 10 });
    assert.equal(pending.eventId, 'codex-new-visible:start');
    assert.equal(pending.session.bridgeSessionId, 'codex-new-thread');
    assert.equal(pending.session.codexSessionId, 'codex-new-thread');
    assert.equal(pending.session.lifecycleSessionId, 'codex-new-visible');
  } finally {
    closeEventIndex(index);
  }
});

test('event index emits SessionLinked instead of resending SessionStart when Codex slash command remaps native id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-requeue-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-visible:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-thread',
        codexThreadId: 'codex-old-thread',
        codexSessionId: 'codex-old-thread',
        lifecycleSessionId: 'codex-visible',
        project: 'codex-bridge',
        status: 'active',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-visible:start', 'hermes');
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionStart']), limit: 10 }).map((item) => item.eventId),
      [],
    );

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-thread',
        codexThreadId: 'codex-new-thread',
        codexSessionId: 'codex-new-thread',
        lifecycleSessionId: 'codex-visible',
        project: 'codex-bridge',
        status: 'active',
      },
      event,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionStart']), limit: 10 }).map((item) => item.eventId),
      [],
    );

    const [pending] = pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionLinked']), limit: 10 });
    assert.equal(pending.eventId, 'codex-visible:start:linked:codex-new-thread');
    assert.equal(pending.event.type, 'SessionLinked');
    assert.equal(pending.event.previousCodexSessionId, 'codex-old-thread');
    assert.equal(pending.event.codexSessionId, 'codex-new-thread');
    assert.equal(pending.session.bridgeSessionId, 'codex-new-thread');
    assert.equal(pending.session.codexSessionId, 'codex-new-thread');

    markDeliverySent(index.db, pending.eventId, 'hermes');
    upsertEvents(index.db, [{
      session: pending.session,
      event,
    }]);
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionLinked']), limit: 10 }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('event index keeps SessionEnd idempotent after native id reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-end-reconcile-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-visible:end',
      type: 'SessionEnd',
      source: 'notification',
      timestamp: '2026-05-14T01:25:00.000Z',
      text: '세션이 종료됐어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-visible',
        lifecycleSessionId: 'codex-visible',
        project: 'docs',
        status: 'ended',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-visible:end', 'discord-fast', {
      targetChannelId: 'thread-old',
      targetThreadId: 'thread-old',
      targetThreadName: 'codex-docs-012500',
      targetKind: 'session-thread',
    });

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-thread',
        codexThreadId: 'codex-new-thread',
        codexSessionId: 'codex-new-thread',
        lifecycleSessionId: 'codex-visible',
        project: 'docs',
        status: 'ended',
      },
      event,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionEnd']), limit: 10 }).map((item) => item.eventId),
      [],
    );
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionLinked']), limit: 10 }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('event index does not emit SessionLinked when runtime owner contradicts the session Codex id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-runtime-owner-mismatch-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-visible:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-thread',
        codexThreadId: 'codex-old-thread',
        codexSessionId: 'codex-old-thread',
        lifecycleSessionId: 'codex-visible',
        project: 'docs',
        status: 'active',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-visible:start', 'discord-fast');

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-thread',
        codexThreadId: 'codex-new-thread',
        codexSessionId: 'codex-new-thread',
        lifecycleSessionId: 'codex-visible',
        runtimeBridgeSessionId: 'codex-other-visible',
        sessionLogOwnerMatch: 'runtime-codex-session',
        project: 'docs',
        status: 'active',
      },
      event,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionLinked']), limit: 10 }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('event index emits SessionLinked for current /resume even when log runtime metadata is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-current-resume-stale-runtime-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-current-thread:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-24T17:17:31.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-thread',
        codexThreadId: 'codex-old-thread',
        codexSessionId: 'codex-old-thread',
        lifecycleSessionId: 'codex-current-thread',
        project: 'news-insight',
        status: 'active',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-current-thread:start', 'discord-fast');

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-resumed-thread',
        codexThreadId: 'codex-resumed-thread',
        codexSessionId: 'codex-resumed-thread',
        lifecycleSessionId: 'codex-current-thread',
        runtimeBridgeSessionId: 'codex-old-ended-thread',
        resumedCodexSession: true,
        project: 'news-insight',
        status: 'active',
      },
      event,
    }]);

    const [pending] = pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionLinked']), limit: 10 });
    assert.equal(pending.eventId, 'codex-current-thread:start:linked:codex-resumed-thread');
    assert.equal(pending.session.lifecycleSessionId, 'codex-current-thread');
    assert.equal(pending.session.codexSessionId, 'codex-resumed-thread');
    assert.equal(pending.session.resumedCodexSession, true);
  } finally {
    closeEventIndex(index);
  }
});

test('event index emits SessionLinked when /resume claims a Codex id after placeholder start was sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-current-resume-placeholder-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-current-thread:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-24T18:00:28.936Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-current-thread',
        codexThreadId: 'codex-current-thread',
        codexSessionId: 'codex-current-thread',
        lifecycleSessionId: 'codex-current-thread',
        project: 'codex-bridge',
        status: 'active',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-current-thread:start', 'discord-fast');

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-resumed-thread',
        codexThreadId: 'codex-resumed-thread',
        codexSessionId: 'codex-resumed-thread',
        lifecycleSessionId: 'codex-current-thread',
        runtimeBridgeSessionId: 'codex-old-ended-thread',
        resumedCodexSession: true,
        project: 'codex-bridge',
        status: 'active',
      },
      event,
    }]);

    const [pending] = pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionLinked']), limit: 10 });
    assert.equal(pending.eventId, 'codex-current-thread:start:linked:codex-resumed-thread');
    assert.equal(pending.event.previousCodexSessionId, 'codex-current-thread');
    assert.equal(pending.event.codexSessionId, 'codex-resumed-thread');
    assert.equal(pending.session.resumedCodexSession, true);
  } finally {
    closeEventIndex(index);
  }
});

test('event index emits only one SessionLinked when active Codex mapping flaps repeatedly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-linked-flap-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-visible:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    const session = (codexSessionId) => ({
      bridgeSessionId: codexSessionId,
      codexThreadId: codexSessionId,
      codexSessionId,
      lifecycleSessionId: 'codex-visible',
      project: 'codex-bridge',
      status: 'active',
    });

    upsertEvents(index.db, [{ session: session('codex-old-thread'), event }]);
    markDeliverySent(index.db, 'codex-visible:start', 'hermes');
    upsertEvents(index.db, [{ session: session('codex-new-thread-1'), event }]);
    const [first] = pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionLinked']), limit: 10 });
    assert.equal(first.eventId, 'codex-visible:start:linked:codex-new-thread-1');
    markDeliverySent(index.db, first.eventId, 'hermes');

    upsertEvents(index.db, [{ session: session('codex-new-thread-2'), event }]);
    assert.deepEqual(
      pendingEvents(index.db, 'hermes', { eventTypes: new Set(['SessionLinked']), limit: 10 }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});


test('event index does not emit SessionLinked when initial native id is discovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-initial-native-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-initial:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-11T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };

    for (const initialSession of [
      {
        bridgeSessionId: 'codex-initial',
        lifecycleSessionId: 'codex-initial',
        project: 'news-insight',
        status: 'active',
      },
      {
        bridgeSessionId: 'codex-placeholder',
        codexThreadId: 'codex-initial',
        codexSessionId: 'codex-initial',
        lifecycleSessionId: 'codex-initial',
        project: 'news-insight',
        status: 'active',
      },
    ]) {
      upsertEvents(index.db, [{ session: initialSession, event }]);
      markDeliverySent(index.db, 'codex-initial:start', 'discord-fast');

      upsertEvents(index.db, [{
        session: {
          bridgeSessionId: '019e127f-089c-7a60-9f95-ab7924dd6fb6',
          codexThreadId: '019e127f-089c-7a60-9f95-ab7924dd6fb6',
          codexSessionId: '019e127f-089c-7a60-9f95-ab7924dd6fb6',
          lifecycleSessionId: 'codex-initial',
          project: 'news-insight',
          status: 'active',
        },
        event,
      }]);

      assert.deepEqual(
        pendingEvents(index.db, 'discord-fast', { eventTypes: new Set(['SessionStart']), limit: 10 }).map((item) => item.eventId),
        [],
      );
    }
  } finally {
    closeEventIndex(index);
  }
});

test('event index does not emit SessionLinked for non-active remaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-non-active-requeue-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const event = {
      eventId: 'codex-ended:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: 'unknown',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-thread',
        codexSessionId: 'codex-old-thread',
        lifecycleSessionId: 'codex-ended',
        project: 'codex-bridge',
        status: 'ended',
      },
      event,
    }]);
    markDeliverySent(index.db, 'codex-ended:start', 'discord-fast');

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new-thread',
        codexSessionId: 'codex-new-thread',
        lifecycleSessionId: 'codex-ended',
        project: 'codex-bridge',
        status: 'ended',
      },
      event,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['SessionStart']),
        skipBefore: '2026-05-09T00:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents includes remapped SessionLinked after skipBefore without replaying old unsent starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-requeue-skipbefore-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const oldEvent = {
      eventId: 'codex-old-unsent:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-unsent',
        codexSessionId: 'codex-old-unsent',
        lifecycleSessionId: 'codex-old-unsent',
        project: 'codex-bridge',
      },
      event: oldEvent,
    }]);

    const remappedEvent = {
      ...oldEvent,
      eventId: 'codex-remapped:start',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-before-new',
        codexSessionId: 'codex-before-new',
        lifecycleSessionId: 'codex-remapped',
        project: 'codex-bridge',
      },
      event: remappedEvent,
    }]);
    markDeliverySent(index.db, 'codex-remapped:start', 'discord-fast');

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['SessionStart']),
        skipBefore: '2026-05-09T00:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );

    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-after-new',
        codexThreadId: 'codex-after-new',
        codexSessionId: 'codex-after-new',
        lifecycleSessionId: 'codex-remapped',
        project: 'codex-bridge',
        status: 'active',
      },
      event: remappedEvent,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['SessionStart']),
        skipBefore: '2026-05-09T00:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      [],
    );
    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['SessionLinked']),
        skipBefore: '2026-05-09T00:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      ['codex-remapped:start:linked:codex-after-new'],
    );
  } finally {
    closeEventIndex(index);
  }
});

test('pendingEvents includes active remapped SessionStart for a new sink without replaying non-remapped starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-event-index-new-sink-remap-'));
  const index = await openEventIndex(root, { eventIndexPath: join(root, 'state', 'events.sqlite') });
  try {
    const oldEvent = {
      eventId: 'codex-active-not-remapped:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-active-not-remapped',
        codexSessionId: 'codex-active-not-remapped',
        lifecycleSessionId: 'codex-active-not-remapped',
        project: 'codex-bridge',
        status: 'active',
      },
      event: oldEvent,
    }]);

    const remappedEvent = {
      eventId: 'codex-active-remapped:start',
      type: 'SessionStart',
      source: 'notification',
      timestamp: '2026-05-09T00:00:00.000Z',
      text: '새 세션을 시작했어.',
    };
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-after-new',
        codexThreadId: 'codex-after-new',
        codexSessionId: 'codex-after-new',
        lifecycleSessionId: 'codex-active-remapped',
        project: 'codex-bridge',
        status: 'active',
      },
      event: remappedEvent,
    }]);

    assert.deepEqual(
      pendingEvents(index.db, 'discord-fast', {
        eventTypes: new Set(['SessionStart']),
        skipBefore: '2026-05-09T00:01:00.000Z',
        limit: 10,
      }).map((item) => item.eventId),
      ['codex-active-remapped:start'],
    );
  } finally {
    closeEventIndex(index);
  }
});
