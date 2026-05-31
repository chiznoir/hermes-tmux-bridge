import { bridgeStatePath } from '../bridge-paths.js';
import { readJsonl } from '../jsonl.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function bridgeLifecycleLogPath(options = {}) {
  return options.sessionHistoryPath || process.env.BRIDGE_SESSION_HISTORY_PATH || bridgeStatePath('session-history.jsonl', options);
}

export async function readBridgeLogRecords(_projectRoot = process.cwd(), options = {}) {
  const records = [];
  let lineNumber = 0;
  for (const record of await readJsonl(bridgeLifecycleLogPath(options))) {
    lineNumber += 1;
    records.push({ ...record, sourceFile: bridgeLifecycleLogPath(options), lineNumber });
  }
  return records;
}

export async function readBridgeSessionHistory(projectRoot = process.cwd(), options = {}) {
  return (await readBridgeLogRecords(projectRoot, options)).map((entry) => ({
    lifecycleSessionId: asString(entry.session_id) || asString(entry.lifecycleSessionId),
    codexSessionId: asString(entry.codex_session_id) || asString(entry.native_session_id) || asString(entry.codexSessionId),
    startedAt: asString(entry.started_at) || (entry.event === 'session_start' ? asString(entry.timestamp) : null),
    endedAt: asString(entry.ended_at) || (entry.event === 'session_end' ? asString(entry.timestamp) : null),
    cwd: asString(entry.cwd),
    pid: entry.pid,
    tmuxId: asString(entry.tmux_id) || asString(entry.tmuxId),
    tmuxPaneId: asString(entry.tmux_pane_id) || asString(entry.tmuxPaneId),
    source: 'bridge-lifecycle',
  })).filter((entry) => entry.lifecycleSessionId || entry.codexSessionId);
}

export function bridgeRecordToRouterEvent(record) {
  const timestamp = asString(record.timestamp) || asString(record._ts) || asString(record.started_at) || asString(record.ended_at);
  const sessionId = asString(record.codex_session_id) || asString(record.native_session_id) || asString(record.session_id) || 'unknown';
  const eventName = asString(record.event) || 'bridge_event';
  return {
    eventId: `bridge-lifecycle:${sessionId}:${record.lineNumber || timestamp || eventName}`,
    type: eventName === 'session_start' ? 'SessionStart' : eventName === 'session_end' ? 'SessionEnd' : 'BridgeLifecycle',
    timestamp,
    source: 'bridge-lifecycle',
    text: record.message || record.command || eventName,
    backend: 'bridge',
  };
}
