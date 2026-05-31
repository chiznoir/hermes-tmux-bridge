import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeStatePath } from './bridge-paths.js';
import { readJsonl } from './jsonl.js';
import { isAuxiliaryCodexLog, listCodexSessionLogPaths, readCodexLog } from './codex-log.js';
import { listTmuxPanes, listTmuxSessions } from './tmux.js';
import {
  asString,
  canonicalProjectRoot,
  dedupeSessions,
  latestCodexLogActivityAt,
  latestCodexUserMessageAt,
  latestIso,
  mergeSessionEntry,
  projectCwdForSession,
  projectNameFromCwd,
  sortableMs,
} from './session-utils.js';

const DEFAULT_CODEX_CWD_ATTACH_SCAN_LIMIT = 30;
const DEFAULT_CODEX_CWD_ATTACH_WINDOW_MS = 2 * 60 * 1000;

function numericOption(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericOptionWithDefault(value, defaultValue) {
  return numericOption(value) || defaultValue;
}

function codexCwdAttachScanLimit(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_CODEX_CWD_ATTACH_SCAN_LIMIT || options.codexCwdAttachScanLimit,
    DEFAULT_CODEX_CWD_ATTACH_SCAN_LIMIT,
  );
}

function codexCwdAttachWindowMs(options = {}) {
  return numericOptionWithDefault(
    process.env.BRIDGE_CODEX_CWD_ATTACH_WINDOW_MS || options.codexCwdAttachWindowMs,
    DEFAULT_CODEX_CWD_ATTACH_WINDOW_MS,
  );
}

async function readCodexLogForBuild(file, options = {}) {
  if (typeof options.readCodexLogFn === 'function') return options.readCodexLogFn(file);
  return readCodexLog(file);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

export function sessionHistoryPath(_projectRoot = process.cwd(), options = {}) {
  return options.sessionHistoryPath
    || process.env.BRIDGE_SESSION_HISTORY_PATH
    || bridgeStatePath('session-history.jsonl', options);
}

function projectSessionHistoryPath(projectRoot = process.cwd()) {
  return join(projectRoot, '.codex', 'logs', 'session-history.jsonl');
}

function sessionHistoryPaths(projectRoot = process.cwd(), options = {}) {
  const paths = [sessionHistoryPath(projectRoot, options)];
  const projectPath = projectSessionHistoryPath(projectRoot);
  if (!paths.includes(projectPath)) paths.push(projectPath);
  return paths;
}

async function projectCodexLifecycleRows(projectRoot = process.cwd()) {
  const dir = join(projectRoot, '.codex', 'logs');
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names
    .filter((name) => /^codex-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => join(dir, name));
  const rows = await Promise.all(files.map((file) => readJsonl(file)));
  return rows.flat()
    .filter((row) => typeof row?.event === 'string' && row.event.startsWith('session_'))
    .map((row) => ({ ...row, _source: 'codex-log' }));
}

export function hasProjectCodexLogs(projectRoot = process.cwd(), options = {}) {
  return sessionHistoryPaths(projectRoot, options).some((path) => existsSync(path));
}

function normalizeLifecycleRecord(record = {}) {
  const event = asString(record.event) || (record.ended_at || record.endedAt ? 'session_end' : 'session_start');
  const sessionId = asString(record.session_id)
    || asString(record.sessionId)
    || asString(record.lifecycle_session_id)
    || asString(record.lifecycleSessionId);
  if (!sessionId) return null;
  const nativeId = asString(record.codex_session_id)
    || asString(record.codexSessionId)
    || asString(record.native_session_id)
    || asString(record.nativeSessionId);
  const timestamp = asString(record.timestamp) || asString(record._ts);
  const startedAt = asString(record.started_at) || asString(record.startedAt) || (event === 'session_start' ? timestamp : null);
  const endedAt = asString(record.ended_at) || asString(record.endedAt) || (event === 'session_end' ? timestamp : null);
  return compactObject({
    lifecycleSessionId: sessionId,
    codexSessionId: nativeId,
    startedAt,
    endedAt,
    endedAtSource: endedAt ? (record._source === 'codex-log' ? 'codex-log-session-end' : 'bridge-session-history') : null,
    endReason: endedAt ? (asString(record.reason) || 'session_exit') : null,
    cwd: asString(record.cwd),
    sourceCwd: asString(record.source_cwd) || asString(record.sourceCwd),
    pid: record.pid,
    tmuxId: asString(record.tmux_id) || asString(record.tmuxId),
    tmuxPaneId: asString(record.tmux_pane_id) || asString(record.tmuxPaneId),
    command: asString(record.command),
    lifecycleRoot: asString(record.lifecycle_root) || asString(record.lifecycleRoot),
    hasBridgeLifecycle: !(
      record._source === 'codex-log'
      && nativeId
      && nativeId === sessionId
      && !asString(record.lifecycle_owner)
      && !asString(record.lifecycleOwner)
    ),
    lifecycleOwner: asString(record.lifecycle_owner) || asString(record.lifecycleOwner) || 'bridge',
  });
}

export async function readSessionHistory(projectRoot = process.cwd(), options = {}) {
  const rows = [
    ...(await Promise.all(sessionHistoryPaths(projectRoot, options).map((path) => readJsonl(path)))).flat(),
    ...(await projectCodexLifecycleRows(projectRoot)),
  ];
  const bySession = new Map();
  for (const row of rows) {
    const entry = normalizeLifecycleRecord(row);
    if (!entry?.lifecycleSessionId) continue;
    const previous = bySession.get(entry.lifecycleSessionId) || {};
    bySession.set(entry.lifecycleSessionId, mergeSessionEntry(previous, entry));
  }
  return [...bySession.values()];
}

function paneExactMatchesLifecycle(pane = {}, entry = {}) {
  if (entry.tmuxPaneId && pane.tmuxPaneId === entry.tmuxPaneId) return true;
  if (entry.tmuxId && pane.tmuxId === entry.tmuxId) return true;
  if (entry.pid && pane.panePid === Number(entry.pid)) return true;
  return false;
}

function paneCwdMatchesLifecycle(pane = {}, entry = {}) {
  if (!entry.cwd || !pane.paneCurrentPath) return false;
  if (canonicalProjectRoot(entry.cwd) !== canonicalProjectRoot(pane.paneCurrentPath)) return false;
  const createdMs = Date.parse(pane.createdAt || '');
  const startedMs = Date.parse(entry.startedAt || '');
  if (Number.isFinite(createdMs) && Number.isFinite(startedMs) && Math.abs(createdMs - startedMs) > 5 * 60 * 1000) return false;
  return true;
}

function tmuxPaneForEntry(entry = {}, panes = []) {
  if (entry.endedAt) return null;
  return panes.find((pane) => !pane.paneDead && paneExactMatchesLifecycle(pane, entry))
    || panes.find((pane) => !pane.paneDead && paneCwdMatchesLifecycle(pane, entry))
    || null;
}

function canonicalStatus(entry = {}, pane = null) {
  if (entry.endedAt) return 'ended';
  if (pane) return 'active';
  return 'unknown';
}

function codexLogWithinLifecycleWindow(log = {}, entry = {}, options = {}) {
  if (!log.codexSessionId || isAuxiliaryCodexLog(log)) return false;
  if (entry.codexSessionId && log.codexSessionId === entry.codexSessionId) return true;
  const entryCwd = entry.cwd ? canonicalProjectRoot(entry.cwd) : null;
  const logCwd = log.cwd ? canonicalProjectRoot(log.cwd) : null;
  if (!entryCwd || !logCwd || entryCwd !== logCwd) return false;
  const logStartMs = Date.parse(log.startedAt || '');
  const startMs = Date.parse(entry.startedAt || '');
  if (!Number.isFinite(logStartMs) || !Number.isFinite(startMs)) return false;
  const windowMs = codexCwdAttachWindowMs(options);
  if (logStartMs < startMs - 5000) return false;
  const endMs = Date.parse(entry.endedAt || '');
  const upperMs = Number.isFinite(endMs) ? endMs : startMs + windowMs;
  return logStartMs <= upperMs;
}

async function readCandidateCodexLogs(codexFiles = [], options = {}) {
  const limit = Math.min(codexFiles.length, codexCwdAttachScanLimit(options));
  const logs = [];
  for (const file of codexFiles.slice(0, limit)) {
    const log = await readCodexLogForBuild(file, options);
    if (!log.codexSessionId || isAuxiliaryCodexLog(log)) continue;
    logs.push({ file, log });
  }
  return logs;
}

function attachCodexLog(entry = {}, logs = [], options = {}) {
  const direct = logs.find(({ file, log }) => (
    entry.codexSessionId && (log.codexSessionId === entry.codexSessionId || file.includes(entry.codexSessionId))
  ));
  const byLifecycleId = direct || logs.find(({ file }) => entry.lifecycleSessionId && file.includes(entry.lifecycleSessionId));
  const byWindow = byLifecycleId || logs
    .filter(({ log }) => codexLogWithinLifecycleWindow(log, entry, options))
    .sort((left, right) => sortableMs(left.log.startedAt) - sortableMs(right.log.startedAt))[0];
  if (!byWindow) return entry;
  return mergeSessionEntry(entry, {
    codexSessionId: byWindow.log.codexSessionId,
    threadId: byWindow.log.codexSessionId,
    sessionLogPath: byWindow.file,
    log: byWindow.log,
    cwd: entry.cwd || byWindow.log.cwd,
    lastCodexLogActivityAt: latestCodexLogActivityAt(byWindow.log),
    lastCodexUserMessageAt: latestCodexUserMessageAt(byWindow.log),
    sessionLogMatchSource: entry.codexSessionId ? 'id-fragment' : 'cwd-window',
  });
}

function sessionFromEntry(entry = {}, panes = []) {
  const pane = tmuxPaneForEntry(entry, panes);
  const cwd = entry.cwd || entry.log?.cwd || pane?.paneCurrentPath || null;
  const projectCwd = projectCwdForSession(cwd, entry.sourceCwd, entry.lifecycleRoot);
  const messageTimes = entry.log?.messages?.map((message) => message.timestamp).filter(Boolean) || [];
  const eventTimes = entry.log?.events?.map((event) => event.timestamp).filter(Boolean) || [];
  const lastEventAt = latestIso(entry.endedAt, entry.lastCodexLogActivityAt, entry.startedAt, messageTimes, eventTimes);
  return {
    codexSessionId: entry.codexSessionId || null,
    threadId: entry.codexSessionId || entry.lifecycleSessionId || null,
    lifecycleSessionId: entry.lifecycleSessionId || entry.codexSessionId || null,
    tmuxId: pane?.tmuxId || entry.tmuxId || null,
    tmuxPaneId: pane?.tmuxPaneId || entry.tmuxPaneId || null,
    project: projectNameFromCwd(projectCwd),
    cwd,
    sourceCwd: entry.sourceCwd || null,
    lifecycleRoot: entry.lifecycleRoot || null,
    status: canonicalStatus(entry, pane),
    startedAt: entry.startedAt || entry.log?.startedAt || null,
    lastEventAt,
    sessionLogPath: entry.sessionLogPath || null,
    sessionLogMatchSource: entry.sessionLogMatchSource || null,
    associatedCodexLogs: entry.associatedCodexLogs || [],
    sessionLogOwnerMatch: entry.sessionLogOwnerMatch || null,
    resumedCodexSession: entry.resumedCodexSession === true || null,
    resumedCodexSessionStartedAt: entry.resumedCodexSessionStartedAt || null,
    previousRuntimeBridgeSessionId: entry.previousRuntimeBridgeSessionId || null,
    runtimeBridgeSessionId: entry.runtimeBridgeSessionId || entry.log?.runtimeBridgeSessionId || null,
    runtimeTmuxId: entry.runtimeTmuxId || entry.log?.runtimeTmuxId || null,
    originator: entry.originator || entry.log?.originator || null,
    sessionSource: entry.sessionSource || entry.log?.sessionSource || null,
    isAuxiliaryCodexLog: isAuxiliaryCodexLog(entry.log || entry),
    hasBridgeLifecycle: entry.hasBridgeLifecycle === true,
    lifecycleOwner: entry.lifecycleOwner || null,
    endedAt: entry.endedAt || null,
    endedAtSource: entry.endedAtSource || null,
    endReason: entry.endReason || null,
    approvalPolicy: entry.log?.approvalPolicy || null,
    sandboxPolicyType: entry.log?.sandboxPolicyType || null,
    permissionProfileType: entry.log?.permissionProfileType || null,
  };
}

export async function buildSessionIndex(options = {}) {
  const lifecycleEntries = await readSessionHistory(options.projectRoot || process.cwd(), options);
  const codexFiles = await listCodexSessionLogPaths(options);
  const codexLogs = await readCandidateCodexLogs(codexFiles, options);
  const sessionsByTmuxId = new Map(listTmuxSessions().map((session) => [session.tmuxId, session]));
  const panes = listTmuxPanes().map((pane) => ({ ...pane, createdAt: sessionsByTmuxId.get(pane.tmuxId)?.createdAt || null }));
  const byKey = new Map();

  for (const rawEntry of lifecycleEntries) {
    const entry = attachCodexLog(rawEntry, codexLogs, options);
    byKey.set(entry.lifecycleSessionId || entry.codexSessionId, entry);
  }

  if (options.includeUnmappedCodexLogs) {
    for (const { file, log } of codexLogs) {
      if ([...byKey.values()].some((entry) => entry.codexSessionId === log.codexSessionId)) continue;
      if (options.cwd && log.cwd !== options.cwd) continue;
      byKey.set(log.codexSessionId, {
        lifecycleSessionId: log.codexSessionId,
        codexSessionId: log.codexSessionId,
        startedAt: log.startedAt,
        cwd: log.cwd,
        sessionLogPath: file,
        log,
        hasBridgeLifecycle: false,
        lifecycleOwner: null,
      });
    }
  }

  return dedupeSessions([...byKey.values()].map((entry) => sessionFromEntry(entry, panes)))
    .sort((a, b) => Date.parse(b.lastEventAt || b.startedAt || 0) - Date.parse(a.lastEventAt || a.startedAt || 0));
}

export function resolveSessionId(session, id) {
  return [
    session.bridgeSessionId,
    session.lifecycleSessionId,
    session.codexSessionId,
    session.threadId,
    session.tmuxId,
    session.tmuxPaneId,
  ].filter(Boolean).includes(id);
}

export async function getSessionById(id, options = {}) {
  const sessions = await buildSessionIndex(options);
  return sessions.find((session) => resolveSessionId(session, id)) || null;
}
