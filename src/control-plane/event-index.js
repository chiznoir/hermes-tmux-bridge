import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureDirFor } from '../jsonl.js';
import { bridgeStatePath } from '../bridge-paths.js';
import { normalizeEventId as normalizeStableEventId } from '../event-ids.js';
import {
  codexLineNumberFromEventId,
  codexSessionIdFromEventId,
  compactTarget,
  eventTimestampMs,
  falseyEnv,
  isNotificationSessionStart,
  logPathForCodexEvent,
  payloadDigest,
  payloadPreview,
  placeholders,
  positiveInt,
  sessionIdFor,
  sessionLinkedEvent,
  sessionStartMappingChangedAfterReconcile,
  stableStringify,
} from './event-index-utils.js';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_COMPACT_TARGET_EVENTS = 8000;
const DEFAULT_MAX_DELIVERIES = 20000;
const DEFAULT_COMPACT_TARGET_DELIVERIES = 16000;
const DEFAULT_COMPACT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 10 * 1000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

function isoNow() {
  return new Date().toISOString();
}

function retentionExpiresAt(options = {}) {
  const retentionDays = positiveInt(process.env.BRIDGE_EVENT_INDEX_RETENTION_DAYS || options.retentionDays, DEFAULT_RETENTION_DAYS);
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function retryBaseMs(options = {}) {
  return positiveInt(process.env.BRIDGE_DELIVERY_RETRY_BASE_MS || options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
}

function retryMaxMs(options = {}) {
  return positiveInt(process.env.BRIDGE_DELIVERY_RETRY_MAX_MS || options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
}

function retryMaxAttempts(options = {}) {
  return positiveInt(
    process.env.BRIDGE_DELIVERY_MAX_ATTEMPTS || process.env.BRIDGE_DELIVERY_RETRY_MAX_ATTEMPTS || options.maxAttempts || options.retryMaxAttempts,
    DEFAULT_RETRY_MAX_ATTEMPTS,
  );
}

function nextRetryAt(retryCount, options = {}) {
  const exponent = Math.min(Math.max(0, retryCount - 1), 8);
  const delay = Math.min(retryMaxMs(options), retryBaseMs(options) * (2 ** exponent));
  return new Date(Date.now() + delay).toISOString();
}

function runInTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback failures and rethrow the primary error.
    }
    throw error;
  }
}

export function eventIndexPath(projectRoot = process.cwd(), options = {}) {
  return options.eventIndexPath
    || process.env.BRIDGE_EVENT_INDEX_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-event-index.sqlite', options)
      : null)
    || join(projectRoot, '.omx', 'state', 'bridge-event-index.sqlite');
}

export function eventIndexConfig(options = {}) {
  const maxEvents = positiveInt(process.env.BRIDGE_EVENT_INDEX_MAX_EVENTS || options.maxEvents, DEFAULT_MAX_EVENTS);
  const maxDeliveries = positiveInt(process.env.BRIDGE_EVENT_INDEX_MAX_DELIVERIES || options.maxDeliveries, DEFAULT_MAX_DELIVERIES);
  return {
    retentionDays: positiveInt(process.env.BRIDGE_EVENT_INDEX_RETENTION_DAYS || options.retentionDays, DEFAULT_RETENTION_DAYS),
    maxEvents,
    compactTargetEvents: compactTarget(
      process.env.BRIDGE_EVENT_INDEX_COMPACT_TARGET_EVENTS || options.compactTargetEvents,
      maxEvents,
      Math.min(DEFAULT_COMPACT_TARGET_EVENTS, Math.max(1, Math.floor(maxEvents * 0.8))),
    ),
    maxDeliveries,
    compactTargetDeliveries: compactTarget(
      process.env.BRIDGE_EVENT_INDEX_COMPACT_TARGET_DELIVERIES || options.compactTargetDeliveries,
      maxDeliveries,
      Math.min(DEFAULT_COMPACT_TARGET_DELIVERIES, Math.max(1, Math.floor(maxDeliveries * 0.8))),
    ),
    compactIntervalMs: positiveInt(process.env.BRIDGE_EVENT_INDEX_COMPACT_INTERVAL_MS || options.compactIntervalMs, DEFAULT_COMPACT_INTERVAL_MS),
  };
}

export async function openEventIndex(projectRoot = process.cwd(), options = {}) {
  const path = eventIndexPath(projectRoot, options);
  await ensureDirFor(path);
  const db = new DatabaseSync(path);
  initializeEventIndex(db);
  return { db, path };
}

export function initializeEventIndex(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA auto_vacuum = INCREMENTAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      timestamp TEXT,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT,
      source TEXT,
      phase TEXT,
      event_json TEXT NOT NULL,
      session_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms, event_id);
    CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type, timestamp_ms);
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT NOT NULL,
      sink TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT,
      payload_hash TEXT,
      payload_bytes INTEGER,
      payload_preview TEXT,
      prepared_at TEXT,
      expires_at TEXT,
      PRIMARY KEY (event_id, sink),
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS deliveries_sink_status_idx ON deliveries(sink, status, updated_at);
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_log_cursors (
      log_path TEXT PRIMARY KEY,
      codex_session_id TEXT,
      last_line INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureDeliveryMetadataColumns(db);
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function ensureDeliveryMetadataColumns(db) {
  const columns = tableColumns(db, 'deliveries');
  for (const [column, definition] of [
    ['target_channel_id', 'TEXT'],
    ['target_thread_id', 'TEXT'],
    ['target_thread_name', 'TEXT'],
    ['target_kind', 'TEXT'],
    ['last_attempt_at', 'TEXT'],
    ['next_attempt_at', 'TEXT'],
    ['payload_json', 'TEXT'],
    ['payload_hash', 'TEXT'],
    ['payload_bytes', 'INTEGER'],
    ['payload_preview', 'TEXT'],
    ['prepared_at', 'TEXT'],
    ['expires_at', 'TEXT'],
  ]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${column} ${definition};`);
  }
  db.exec(`
    UPDATE deliveries
    SET
      last_attempt_at = COALESCE(last_attempt_at, updated_at),
      next_attempt_at = COALESCE(next_attempt_at, updated_at)
    WHERE status = 'failed'
      AND (last_attempt_at IS NULL OR next_attempt_at IS NULL);
  `);
  db.prepare(`
    UPDATE deliveries
    SET
      status = 'dead',
      next_attempt_at = NULL,
      expires_at = COALESCE(expires_at, ?),
      updated_at = ?
    WHERE status = 'failed'
      AND retry_count >= ?
  `).run(retentionExpiresAt(), isoNow(), retryMaxAttempts());
}

function sentTargetMismatchSql() {
  return `
    deliveries.status = 'sent'
    AND (
      COALESCE(deliveries.target_channel_id, '') != COALESCE(excluded.target_channel_id, '')
      OR COALESCE(deliveries.target_thread_id, '') != COALESCE(excluded.target_thread_id, '')
      OR COALESCE(deliveries.target_thread_name, '') != COALESCE(excluded.target_thread_name, '')
      OR COALESCE(deliveries.target_kind, '') != COALESCE(excluded.target_kind, '')
    )
  `;
}

function sentTargetMismatchMessage() {
  return 'sent delivery target mismatch; preserved original target metadata';
}

const COMMAND_DUPLICATE_WINDOW_MS = 120 * 1000;

function normalizeComparableCommandText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function commandSourcesRepresentSameDispatch(leftSource, rightSource) {
  const sources = new Set([leftSource, rightSource].filter(Boolean));
  return sources.has('bridge-interactions') && sources.has('codex-log');
}

function findDuplicateCommandEventId(selectCandidates, session, event, eventId) {
  if ((event.type || 'Event') !== 'CommandSubmitted') return eventId;
  const text = normalizeComparableCommandText(event.text);
  const timestampMs = eventTimestampMs(event);
  const sessionId = sessionIdFor(session);
  if (!text || !Number.isFinite(timestampMs) || timestampMs <= 0 || !sessionId) return eventId;

  const candidates = selectCandidates.all(
    sessionId,
    timestampMs - COMMAND_DUPLICATE_WINDOW_MS,
    timestampMs + COMMAND_DUPLICATE_WINDOW_MS,
    eventId,
  );
  let best = null;
  for (const candidate of candidates) {
    let previousEvent = null;
    try {
      previousEvent = JSON.parse(candidate.event_json);
    } catch {
      continue;
    }
    if ((previousEvent.type || 'Event') !== 'CommandSubmitted') continue;
    if (!commandSourcesRepresentSameDispatch(previousEvent.source, event.source)) continue;
    if (normalizeComparableCommandText(previousEvent.text) !== text) continue;
    const delta = Math.abs((candidate.timestamp_ms || 0) - timestampMs);
    if (!best || delta < best.delta || (delta === best.delta && candidate.event_id < best.eventId)) {
      best = { eventId: candidate.event_id, delta };
    }
  }
  return best?.eventId || eventId;
}

export function closeEventIndex(handle) {
  handle?.db?.close?.();
}

export function normalizeEventId(session, event) {
  return normalizeStableEventId(session, event);
}

export function upsertEvents(db, items = []) {
  if (items.length === 0) return 0;
  const now = isoNow();
  const existing = db.prepare(`
    SELECT event_json, session_json
    FROM events
    WHERE event_id = ?
  `);
  const duplicateCommandCandidates = db.prepare(`
    SELECT event_id, event_json, timestamp_ms
    FROM events
    WHERE session_id = ?
      AND event_type = 'CommandSubmitted'
      AND timestamp_ms BETWEEN ? AND ?
      AND event_id != ?
  `);
  const hasSentDelivery = db.prepare(`
    SELECT 1
    FROM deliveries
    WHERE event_id = ?
      AND status = 'sent'
    LIMIT 1
  `);
  const hasLinkedEventForStart = db.prepare(`
    SELECT 1
    FROM events
    WHERE event_type = 'SessionLinked'
      AND substr(event_id, 1, ?) = ?
    LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO events (
      event_id, event_type, timestamp, timestamp_ms, session_id, project, source, phase,
      event_json, session_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      event_type = excluded.event_type,
      timestamp = excluded.timestamp,
      timestamp_ms = excluded.timestamp_ms,
      session_id = excluded.session_id,
      project = excluded.project,
      source = excluded.source,
      phase = excluded.phase,
      event_json = excluded.event_json,
      session_json = excluded.session_json,
      updated_at = excluded.updated_at
  `);
  runInTransaction(db, () => {
    for (const { session, event, eventId: itemEventId } of items) {
      const initialEventId = itemEventId || normalizeEventId(session, event);
      const eventId = findDuplicateCommandEventId(duplicateCommandCandidates, session, event, initialEventId);
      const previous = existing.get(eventId);
      let linkedEvent = null;
      if (previous) {
        try {
          const previousEvent = JSON.parse(previous.event_json);
          const previousSession = JSON.parse(previous.session_json);
          const linkedEventPrefix = `${eventId}:linked:`;
          const shouldEmitLinkedEvent = isNotificationSessionStart(previousEvent)
            && isNotificationSessionStart(event)
            && sessionStartMappingChangedAfterReconcile(previousSession, session)
            && hasSentDelivery.get(eventId)
            && !hasLinkedEventForStart.get(linkedEventPrefix.length, linkedEventPrefix);
          if (shouldEmitLinkedEvent) linkedEvent = sessionLinkedEvent(previousSession, session, event, eventId);
        } catch {
          linkedEvent = null;
        }
      }
      insert.run(
        eventId,
        event.type || 'Event',
        event.timestamp || null,
        eventTimestampMs(event),
        sessionIdFor(session),
        session.project || null,
        event.source || null,
        event.phase || null,
        JSON.stringify({ ...event, eventId }),
        JSON.stringify(session),
        now,
        now,
      );
      if (linkedEvent?.eventId) {
        insert.run(
          linkedEvent.eventId,
          linkedEvent.type,
          linkedEvent.timestamp || null,
          eventTimestampMs(linkedEvent),
          sessionIdFor(session),
          session.project || null,
          linkedEvent.source || null,
          linkedEvent.phase || null,
          JSON.stringify(linkedEvent),
          JSON.stringify(session),
          now,
          now,
        );
      }
    }
  });
  return items.length;
}

export function eventIdsInIndex(db, eventIds = []) {
  const ids = [...new Set([...eventIds].filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = db.prepare(`
    SELECT event_id
    FROM events
    WHERE event_id IN (${placeholders(ids)})
  `).all(...ids);
  return new Set(rows.map((row) => row.event_id));
}

export function markLegacySentDeliveries(db, eventIds = [], sink) {
  const ids = [...new Set([...eventIds].filter(Boolean))];
  if (!sink || ids.length === 0) return 0;
  const now = isoNow();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO deliveries (event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at, expires_at)
    SELECT event_id, ?, 'sent', ?, 0, ?, NULL, NULL, ?, ?
    FROM events
    WHERE event_id = ?
  `);
  let changes = 0;
  runInTransaction(db, () => {
    for (const eventId of ids) {
      changes += insert.run(sink, now, now, now, retentionExpiresAt(), eventId).changes;
    }
  });
  return changes;
}

function existingMaxLineForLog(db, logPath, codexSessionId) {
  const prefix = codexSessionId ? `${codexSessionId}:` : null;
  const rows = db.prepare(`
    SELECT event_id
    FROM events
    WHERE json_extract(session_json, '$.sessionLogPath') = ?
       OR (? IS NOT NULL AND substr(event_id, 1, ?) = ?)
  `).all(logPath, prefix, prefix?.length || 0, prefix);
  return rows.reduce((max, row) => Math.max(max, codexLineNumberFromEventId(row.event_id) || 0), 0);
}

function cursorFilteringEnabled(options = {}) {
  if (options.replay === true) return false;
  if (options.useCodexLogCursor === false) return false;
  return !falseyEnv(process.env.BRIDGE_CODEX_LOG_CURSOR_ENABLED);
}

export function filterEventsByCodexLogCursor(db, session = {}, events = [], options = {}) {
  if (!cursorFilteringEnabled(options) || events.length === 0) return events;

  const passthrough = [];
  const byLog = new Map();
  for (const event of events) {
    if (event.source !== 'codex-log') {
      passthrough.push(event);
      continue;
    }
    const line = codexLineNumberFromEventId(event.eventId);
    const logPath = line ? logPathForCodexEvent(session, event) : null;
    if (!line || !logPath) {
      passthrough.push(event);
      continue;
    }
    const group = byLog.get(logPath) || {
      logPath,
      codexSessionId: codexSessionIdFromEventId(event.eventId) || session.codexSessionId || null,
      events: [],
      maxLine: 0,
    };
    group.events.push({ event, line });
    group.maxLine = Math.max(group.maxLine, line);
    byLog.set(logPath, group);
  }
  if (byLog.size === 0) return events;

  const now = isoNow();
  const select = db.prepare(`
    SELECT last_line
    FROM codex_log_cursors
    WHERE log_path = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO codex_log_cursors (log_path, codex_session_id, last_line, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(log_path) DO UPDATE SET
      codex_session_id = COALESCE(excluded.codex_session_id, codex_log_cursors.codex_session_id),
      last_line = MAX(codex_log_cursors.last_line, excluded.last_line),
      updated_at = excluded.updated_at
  `);

  const kept = [...passthrough];
  runInTransaction(db, () => {
    for (const group of byLog.values()) {
      const cursor = select.get(group.logPath);
      const indexedMaxLine = existingMaxLineForLog(db, group.logPath, group.codexSessionId);
      const lastLine = cursor ? (cursor.last_line || 0) : 0;
      if (!cursor && indexedMaxLine === 0) {
        upsert.run(group.logPath, group.codexSessionId, group.maxLine, now, now);
        continue;
      }
      for (const item of group.events) {
        if (item.line > lastLine) kept.push(item.event);
      }
      upsert.run(group.logPath, group.codexSessionId, Math.max(group.maxLine, lastLine), now, now);
    }
  });

  return kept;
}

export function pendingEvents(db, sink, options = {}) {
  const eventTypes = [...(options.eventTypes || [])].filter(Boolean);
  const now = options.now || isoNow();
  const params = [sink];
  const fifoScope = options.fifoScope || 'session';
  const clauses = [`COALESCE(d.status, 'pending') IN ('pending', 'failed')`];
  clauses.push(`(d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)`);
  params.push(now);
  clauses.push(`NOT EXISTS (
    SELECT 1
    FROM events e2
    JOIN deliveries d2 ON d2.event_id = e2.event_id AND d2.sink = ?
    WHERE d2.status = 'failed'
      ${fifoScope === 'sink' ? '' : 'AND e2.session_id = e.session_id'}
      AND (e2.timestamp_ms < e.timestamp_ms OR (e2.timestamp_ms = e.timestamp_ms AND e2.event_id < e.event_id))
  )`);
  params.push(sink);
  for (const block of options.priorDeliveryBlocks || []) {
    const blockSink = String(block?.sink || '').trim();
    const blockEventTypes = [...(block?.eventTypes || [])].filter(Boolean);
    const appliesToEventTypes = [...(block?.appliesToEventTypes || [])].filter(Boolean);
    if (!blockSink || blockEventTypes.length === 0) continue;
    const missingDeliveryGraceMs = Number.parseInt(block.missingDeliveryGraceMs, 10);
    const nowMs = Date.parse(now);
    const missingDeliveryCutoffMs = Number.isFinite(missingDeliveryGraceMs) && missingDeliveryGraceMs >= 0
      ? (Number.isFinite(nowMs) ? nowMs : Date.now()) - missingDeliveryGraceMs
      : Number.NaN;
    const appliesPredicates = [];
    const appliesParams = [];
    if (appliesToEventTypes.length > 0) {
      appliesPredicates.push(`e.event_type IN (${placeholders(appliesToEventTypes)})`);
      appliesParams.push(...appliesToEventTypes);
    }
    if (block.gjcOnly === true) {
      appliesPredicates.push(`(
        json_extract(e.session_json, '$.backend') = 'gjc'
        OR json_extract(e.session_json, '$.lifecycleOwner') = 'gjc'
        OR json_extract(e.session_json, '$.gjcSessionId') IS NOT NULL
      )`);
    }
    const appliesClause = appliesPredicates.length > 0
      ? `NOT (${appliesPredicates.join(' AND ')}) OR `
      : '';
    clauses.push(`(${appliesClause}NOT EXISTS (
      SELECT 1
      FROM events block_event
      LEFT JOIN deliveries block_delivery
        ON block_delivery.event_id = block_event.event_id
       AND block_delivery.sink = ?
      WHERE block_event.session_id = e.session_id
        AND block_event.event_type IN (${placeholders(blockEventTypes)})
        AND (
          block_event.timestamp_ms < e.timestamp_ms
          OR (block_event.timestamp_ms = e.timestamp_ms AND block_event.event_id < e.event_id)
        )
        AND (
          block_delivery.status IN ('pending', 'failed')
          OR (
            block_delivery.status IS NULL
            AND (? IS NULL OR block_event.timestamp_ms >= ?)
          )
        )
    ))`);
    params.push(
      ...appliesParams,
      blockSink,
      ...blockEventTypes,
      Number.isFinite(missingDeliveryCutoffMs) ? missingDeliveryCutoffMs : null,
      Number.isFinite(missingDeliveryCutoffMs) ? missingDeliveryCutoffMs : null,
    );
  }
  if (eventTypes.length > 0) {
    clauses.push(`e.event_type IN (${placeholders(eventTypes)})`);
    params.push(...eventTypes);
  }
  if (options.skipBefore) {
    const skipMs = Date.parse(options.skipBefore);
    if (Number.isFinite(skipMs)) {
      clauses.push(`(
        e.timestamp_ms >= ?
        OR (
          e.event_type = 'SessionStart'
          AND json_extract(e.session_json, '$.status') = 'active'
          AND d.status = 'pending'
          AND d.updated_at IS NOT NULL
          AND d.updated_at >= ?
        )
        OR (
          e.event_type = 'SessionStart'
          AND json_extract(e.session_json, '$.status') = 'active'
          AND json_extract(e.session_json, '$.codexSessionId') IS NOT NULL
          AND json_extract(e.session_json, '$.omxSessionId') IS NOT NULL
          AND json_extract(e.session_json, '$.codexSessionId') != json_extract(e.session_json, '$.omxSessionId')
          AND e.updated_at >= ?
        )
      )`);
      params.push(skipMs, new Date(skipMs).toISOString(), new Date(skipMs).toISOString());
    }
  }
  const limit = positiveInt(options.limit, 100);
  params.push(limit);
  const rows = db.prepare(`
    SELECT
      e.event_id,
      e.event_json,
      e.session_json,
      COALESCE(d.status, 'pending') AS delivery_status,
      d.retry_count,
      d.last_attempt_at,
      d.next_attempt_at,
      d.last_error,
      d.payload_hash,
      d.payload_bytes,
      d.payload_preview,
      d.prepared_at,
      d.expires_at
    FROM events e
    LEFT JOIN deliveries d ON d.event_id = e.event_id AND d.sink = ?
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      e.timestamp_ms ASC,
      e.event_id ASC
    LIMIT ?
  `).all(...params);
  return rows.map((row) => ({
    eventId: row.event_id,
    deliveryStatus: row.delivery_status,
    retryCount: row.retry_count || 0,
    lastAttemptAt: row.last_attempt_at || null,
    nextAttemptAt: row.next_attempt_at || null,
    lastError: row.last_error || null,
    payloadHash: row.payload_hash || null,
    payloadBytes: row.payload_bytes || 0,
    payloadPreview: row.payload_preview || null,
    preparedAt: row.prepared_at || null,
    expiresAt: row.expires_at || null,
    event: JSON.parse(row.event_json),
    session: JSON.parse(row.session_json),
  }));
}

export function markDeliveryPrepared(db, eventId, sink, payload, metadata = {}) {
  const now = isoNow();
  const payloadJson = stableStringify(payload);
  const targetChannelId = metadata.targetChannelId || metadata.target_channel_id || null;
  const targetThreadId = metadata.targetThreadId || metadata.target_thread_id || null;
  const targetThreadName = metadata.targetThreadName || metadata.target_thread_name || null;
  const targetKind = metadata.targetKind || metadata.target_kind || null;
  db.prepare(`
    INSERT INTO deliveries (
      event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at,
      target_channel_id, target_thread_id, target_thread_name, target_kind,
      payload_json, payload_hash, payload_bytes, payload_preview, prepared_at
    )
    VALUES (?, ?, 'pending', NULL, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, sink) DO UPDATE SET
      status = CASE WHEN deliveries.status IN ('sent', 'dead') THEN deliveries.status ELSE 'pending' END,
      last_attempt_at = excluded.last_attempt_at,
      next_attempt_at = NULL,
      last_error = CASE
        WHEN ${sentTargetMismatchSql()} THEN COALESCE(deliveries.last_error, '${sentTargetMismatchMessage()}')
        WHEN deliveries.status IN ('sent', 'dead') THEN deliveries.last_error
        ELSE NULL
      END,
      updated_at = excluded.updated_at,
      target_channel_id = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_channel_id ELSE excluded.target_channel_id END,
      target_thread_id = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_thread_id ELSE excluded.target_thread_id END,
      target_thread_name = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_thread_name ELSE excluded.target_thread_name END,
      target_kind = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_kind ELSE excluded.target_kind END,
      payload_json = excluded.payload_json,
      payload_hash = excluded.payload_hash,
      payload_bytes = excluded.payload_bytes,
      payload_preview = excluded.payload_preview,
      prepared_at = excluded.prepared_at
  `).run(
    eventId,
    sink,
    now,
    now,
    targetChannelId,
    targetThreadId,
    targetThreadName,
    targetKind,
    payloadJson,
    payloadDigest(payloadJson),
    Buffer.byteLength(payloadJson, 'utf8'),
    payloadPreview(payload),
    now,
  );
}

export function markDeliverySent(db, eventId, sink, metadata = {}) {
  const now = isoNow();
  const expiresAt = metadata.expiresAt || metadata.expires_at || retentionExpiresAt(metadata);
  const targetChannelId = metadata.targetChannelId || metadata.target_channel_id || null;
  const targetThreadId = metadata.targetThreadId || metadata.target_thread_id || null;
  const targetThreadName = metadata.targetThreadName || metadata.target_thread_name || null;
  const targetKind = metadata.targetKind || metadata.target_kind || null;
  db.prepare(`
    INSERT INTO deliveries (
      event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at, expires_at,
      target_channel_id, target_thread_id, target_thread_name, target_kind
    )
    VALUES (?, ?, 'sent', ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, sink) DO UPDATE SET
      status = 'sent',
      sent_at = COALESCE(deliveries.sent_at, excluded.sent_at),
      last_attempt_at = excluded.last_attempt_at,
      next_attempt_at = NULL,
      expires_at = excluded.expires_at,
      last_error = CASE
        WHEN ${sentTargetMismatchSql()} THEN COALESCE(deliveries.last_error, '${sentTargetMismatchMessage()}')
        WHEN deliveries.status = 'sent' THEN deliveries.last_error
        ELSE NULL
      END,
      updated_at = excluded.updated_at,
      target_channel_id = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_channel_id ELSE excluded.target_channel_id END,
      target_thread_id = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_thread_id ELSE excluded.target_thread_id END,
      target_thread_name = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_thread_name ELSE excluded.target_thread_name END,
      target_kind = CASE WHEN deliveries.status = 'sent' THEN deliveries.target_kind ELSE excluded.target_kind END
  `).run(eventId, sink, now, now, now, expiresAt, targetChannelId, targetThreadId, targetThreadName, targetKind);
}

export function markSkippedBeforeDeliveries(db, sink, options = {}) {
  const skipMs = Date.parse(options.skipBefore || '');
  if (!Number.isFinite(skipMs)) return 0;
  const eventTypes = [...(options.eventTypes || [])].filter(Boolean);
  const now = isoNow();
  const expiresAt = retentionExpiresAt(options);
  const reason = `skipped before notifier boot cutoff ${new Date(skipMs).toISOString()}`;
  const typeClause = eventTypes.length > 0 ? `AND e.event_type IN (${placeholders(eventTypes)})` : '';
  const params = [skipMs, ...eventTypes];
  const where = `
    e.timestamp_ms < ?
    ${typeClause}
    AND NOT (
      e.event_type = 'SessionStart'
      AND json_extract(e.session_json, '$.status') = 'active'
    )
  `;
  const update = db.prepare(`
    UPDATE deliveries
    SET
      status = 'dead',
      next_attempt_at = NULL,
      last_error = ?,
      updated_at = ?,
      expires_at = COALESCE(expires_at, ?)
    WHERE sink = ?
      AND status IN ('pending', 'failed')
      AND event_id IN (SELECT e.event_id FROM events e WHERE ${where})
  `);
  const insert = db.prepare(`
    INSERT INTO deliveries (
      event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at, expires_at
    )
    SELECT e.event_id, ?, 'dead', NULL, 0, ?, NULL, ?, ?, ?
    FROM events e
    LEFT JOIN deliveries d ON d.event_id = e.event_id AND d.sink = ?
    WHERE d.event_id IS NULL
      AND ${where}
  `);
  let changes = 0;
  runInTransaction(db, () => {
    changes += update.run(reason, now, expiresAt, sink, ...params).changes;
    changes += insert.run(sink, now, reason, now, expiresAt, sink, ...params).changes;
  });
  return changes;
}


export function markDeliveryDead(db, eventId, sink, error, options = {}) {
  const now = isoNow();
  const expiresAt = retentionExpiresAt(options);
  db.prepare(`
    INSERT INTO deliveries (
      event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at, expires_at
    )
    VALUES (?, ?, 'dead', NULL, 0, ?, NULL, ?, ?, ?)
    ON CONFLICT(event_id, sink) DO UPDATE SET
      status = CASE WHEN deliveries.status = 'sent' THEN deliveries.status ELSE 'dead' END,
      next_attempt_at = CASE WHEN deliveries.status = 'sent' THEN deliveries.next_attempt_at ELSE NULL END,
      last_error = CASE WHEN deliveries.status = 'sent' THEN deliveries.last_error ELSE excluded.last_error END,
      updated_at = CASE WHEN deliveries.status = 'sent' THEN deliveries.updated_at ELSE excluded.updated_at END,
      expires_at = CASE WHEN deliveries.status = 'sent' THEN deliveries.expires_at ELSE COALESCE(deliveries.expires_at, excluded.expires_at) END
  `).run(eventId, sink, now, String(error?.message || error || 'unknown'), now, expiresAt);
}

export function markDeliveryFailed(db, eventId, sink, error, options = {}) {
  const now = isoNow();
  const current = db.prepare(`
    SELECT retry_count
    FROM deliveries
    WHERE event_id = ? AND sink = ?
  `).get(eventId, sink);
  const nextRetryCount = (current?.retry_count || 0) + 1;
  const exhausted = nextRetryCount >= retryMaxAttempts(options);
  const status = exhausted ? 'dead' : 'failed';
  const retryAt = exhausted ? null : (options.nextAttemptAt || nextRetryAt(nextRetryCount, options));
  const expiresAt = exhausted ? retentionExpiresAt(options) : null;
  db.prepare(`
    INSERT INTO deliveries (
      event_id, sink, status, sent_at, retry_count, last_attempt_at, next_attempt_at, last_error, updated_at, expires_at
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, sink) DO UPDATE SET
      status = excluded.status,
      retry_count = excluded.retry_count,
      last_attempt_at = excluded.last_attempt_at,
      next_attempt_at = excluded.next_attempt_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at,
      expires_at = CASE WHEN excluded.status = 'dead' THEN excluded.expires_at ELSE deliveries.expires_at END
  `).run(eventId, sink, status, nextRetryCount, now, retryAt, String(error?.message || error || 'unknown'), now, expiresAt);
  return {
    eventId,
    sink,
    status,
    retryCount: nextRetryCount,
    nextRetryAt: retryAt,
    exhausted,
    error: String(error?.message || error || 'unknown'),
  };
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function compactEvents(db, config) {
  const count = countRows(db, 'events');
  const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  let removedByAge = 0;
  let removedByLimit = 0;
  const deleteOld = db.prepare(`
    DELETE FROM events
    WHERE timestamp_ms < ?
      AND EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.event_id = events.event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.event_id = events.event_id
          AND d.status NOT IN ('sent', 'dead')
      )
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.event_id = events.event_id
          AND d.status IN ('sent', 'dead')
          AND d.expires_at IS NOT NULL
          AND CAST(strftime('%s', d.expires_at) AS INTEGER) * 1000 >= ?
      )
  `);
  removedByAge = deleteOld.run(cutoffMs, Date.now()).changes;

  const afterAge = countRows(db, 'events');
  if (afterAge > config.maxEvents) {
    const excess = afterAge - config.compactTargetEvents;
    const deleteOverflow = db.prepare(`
      DELETE FROM events
      WHERE event_id IN (
        SELECT e.event_id
        FROM events e
        WHERE EXISTS (
          SELECT 1 FROM deliveries d
          WHERE d.event_id = e.event_id
        )
          AND NOT EXISTS (
            SELECT 1 FROM deliveries d
            WHERE d.event_id = e.event_id
              AND d.status NOT IN ('sent', 'dead')
          )
        ORDER BY e.timestamp_ms ASC, e.event_id ASC
        LIMIT ?
      )
    `);
    removedByLimit = deleteOverflow.run(Math.max(0, excess)).changes;
  }
  return { before: count, after: countRows(db, 'events'), removedByAge, removedByLimit };
}

function compactDeliveries(db, config) {
  const count = countRows(db, 'deliveries');
  const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  let removedByAge = 0;
  let removedByLimit = 0;
  removedByAge = db.prepare(`
    DELETE FROM deliveries
    WHERE status IN ('sent', 'dead')
      AND (
        (expires_at IS NOT NULL AND CAST(strftime('%s', expires_at) AS INTEGER) * 1000 < ?)
        OR (expires_at IS NULL AND sent_at IS NOT NULL AND CAST(strftime('%s', sent_at) AS INTEGER) * 1000 < ?)
      )
      AND event_id NOT IN (SELECT event_id FROM events)
  `).run(Date.now(), cutoffMs).changes;

  const afterAge = countRows(db, 'deliveries');
  if (afterAge > config.maxDeliveries) {
    const excess = afterAge - config.compactTargetDeliveries;
    removedByLimit = db.prepare(`
      DELETE FROM deliveries
      WHERE rowid IN (
        SELECT rowid FROM deliveries
        WHERE status IN ('sent', 'dead')
        ORDER BY COALESCE(sent_at, updated_at) ASC, event_id ASC, sink ASC
        LIMIT ?
      )
    `).run(Math.max(0, excess)).changes;
  }
  return { before: count, after: countRows(db, 'deliveries'), removedByAge, removedByLimit };
}

export function compactEventIndex(db, options = {}) {
  const config = eventIndexConfig(options);
  const result = runInTransaction(db, () => {
    const events = compactEvents(db, config);
    const deliveries = compactDeliveries(db, config);
    db.prepare(`INSERT INTO index_meta (key, value) VALUES ('last_compact_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(isoNow());
    return { events, deliveries };
  });
  db.exec('PRAGMA incremental_vacuum;');
  return result;
}

export function compactEventIndexIfNeeded(db, options = {}) {
  const config = eventIndexConfig(options);
  const row = db.prepare(`SELECT value FROM index_meta WHERE key = 'last_compact_at'`).get();
  const lastMs = Date.parse(row?.value || '');
  const dueByTime = !Number.isFinite(lastMs) || Date.now() - lastMs >= config.compactIntervalMs;
  const dueBySize = countRows(db, 'events') > config.maxEvents || countRows(db, 'deliveries') > config.maxDeliveries;
  if (!dueByTime && !dueBySize) return { skipped: true };
  return { skipped: false, ...compactEventIndex(db, config) };
}

export function eventIndexStats(db) {
  const deliveryStatusCounts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM deliveries
    GROUP BY status
    ORDER BY status
  `).all().map((row) => [row.status, row.count]));
  return {
    events: countRows(db, 'events'),
    deliveries: countRows(db, 'deliveries'),
    deliveryStatusCounts,
    preparedDeliveries: db.prepare(`SELECT COUNT(*) AS count FROM deliveries WHERE payload_json IS NOT NULL`).get().count,
    lastCompactAt: db.prepare(`SELECT value FROM index_meta WHERE key = 'last_compact_at'`).get()?.value || null,
  };
}
