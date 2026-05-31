import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDirFor, readJsonl } from '../jsonl.js';
import { bridgeStatePath } from '../bridge-paths.js';

export function auditLogPath(_projectRoot = process.cwd(), options = {}) {
  const projectRoot = _projectRoot;
  return process.env.BRIDGE_AUDIT_LOG_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-audit.jsonl', options)
      : join(projectRoot, '.codex', 'logs', 'bridge-audit.jsonl'));
}

export async function appendAudit(eventType, payload = {}, options = {}) {
  const entry = {
    auditId: options.auditId || randomUUID(),
    eventType,
    timestamp: options.timestamp || new Date().toISOString(),
    source: 'bridge-control-plane',
    ...payload,
  };
  const path = auditLogPath(options.projectRoot, options);
  await ensureDirFor(path);
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function afterSince(record, since) {
  if (!since) return true;
  const lhs = Date.parse(record.timestamp || '');
  const rhs = Date.parse(since);
  if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return true;
  return lhs >= rhs;
}

export async function readAuditLog(filters = {}, options = {}) {
  const limit = Number.isFinite(Number(filters.limit)) ? Number(filters.limit) : 200;
  const records = await readJsonl(auditLogPath(options.projectRoot, options));
  return records
    .filter((record) => !filters.sessionId || [record.sessionId, record.bridgeSessionId, record.codexThreadId, record.lifecycleSessionId].includes(filters.sessionId))
    .filter((record) => !filters.threadId || record.codexThreadId === filters.threadId)
    .filter((record) => !filters.source || record.source === filters.source || record.backend === filters.source)
    .filter((record) => afterSince(record, filters.since))
    .slice(-limit);
}

export function auditEventToRouterEvent(record) {
  return {
    eventId: `audit:${record.auditId}`,
    type: record.eventType,
    timestamp: record.timestamp,
    source: 'audit-log',
    text: record.commandText || record.error || record.eventType,
    backend: record.backend,
  };
}
