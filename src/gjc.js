import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listGjcSessionLogPaths, readGjcLog } from './gjc-log.js';
import { listTmuxPanes, listTmuxSessions } from './tmux.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function sortableMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInt(value, defaultValue = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function projectNameFromCwd(cwd) {
  const value = asString(cwd);
  if (!value) return 'unknown';
  return basename(value) || value;
}

function slugify(value) {
  return (String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'project');
}

function managedTmuxMatch(gjcSessionId, panes = [], sessions = [], log = {}) {
  const exact = panes.find((pane) => pane.managed && pane.paneDead !== true && pane.gjcSessionId === gjcSessionId)
    || sessions.find((session) => session.managed && session.gjcSessionId === gjcSessionId)
    || null;
  if (exact) return exact;

  const cwd = asString(log.cwd);
  if (!cwd) return null;
  const cwdMatches = panes.filter((pane) => pane.paneDead !== true
    && pane.gjcProfile === '1'
    && pane.paneCurrentPath === cwd);
  if (cwdMatches.length !== 1) return null;
  return {
    ...cwdMatches[0],
    managed: false,
    gjcActiveByCwd: true,
  };
}

function isAuxiliaryGjcLogPath(filePath) {
  const parentDir = dirname(filePath || '');
  const parentName = basename(parentDir);
  if (!parentName || parentName === '.' || parentName === '/') return false;
  return existsSync(join(dirname(parentDir), `${parentName}.jsonl`));
}

export function isAuxiliaryGjcSession(session = {}) {
  if (session.isAuxiliaryGjcLog === true) return true;
  if (!session.sessionLogPath) return false;
  return isAuxiliaryGjcLogPath(session.sessionLogPath);
}

function sessionScanLimit(options = {}) {
  return positiveInt(options.sessionScanLimit, null);
}

function latestActivityState(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.phase === 'final_answer') return 'idle';
    if (message.role === 'assistant' && (message.stopReason === 'toolUse' || message.hasToolCall || message.hasThinking)) return 'working';
    if (message.role === 'user') return 'working';
  }
  return 'unknown';
}

function uniqueSessions(sessions = []) {
  const byId = new Map();
  for (const session of sessions) {
    const key = session.gjcSessionId || session.threadId || session.bridgeSessionId;
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || sortableMs(session.lastEventAt || session.startedAt) > sortableMs(previous.lastEventAt || previous.startedAt)) {
      byId.set(key, session);
    }
  }
  return [...byId.values()].sort((left, right) => sortableMs(right.lastEventAt || right.startedAt) - sortableMs(left.lastEventAt || left.startedAt));
}

export async function buildSessionIndex(options = {}) {
  const files = await listGjcSessionLogPaths(options);
  const limit = sessionScanLimit(options);
  const selected = limit ? files.slice(0, limit) : files;
  const tmuxPanes = typeof options.listTmuxPanesFn === 'function' ? options.listTmuxPanesFn() : listTmuxPanes();
  const tmuxSessions = typeof options.listTmuxSessionsFn === 'function' ? options.listTmuxSessionsFn() : listTmuxSessions();
  const sessions = [];
  for (const file of selected) {
    const log = await readGjcLog(file);
    const gjcSessionId = asString(log.gjcSessionId) || asString(log.threadId);
    if (!gjcSessionId) continue;
    const cwd = asString(log.cwd);
    const project = projectNameFromCwd(log.cwd);
    const tmuxMatch = managedTmuxMatch(gjcSessionId, tmuxPanes, tmuxSessions, log);
    const isAuxiliaryGjcLog = isAuxiliaryGjcSession({ sessionLogPath: file });
    sessions.push({
      backend: 'gjc',
      gjcSessionId,
      bridgeSessionId: gjcSessionId,
      threadId: gjcSessionId,
      codexThreadId: gjcSessionId,
      codexSessionId: gjcSessionId,
      startedAt: asString(log.startedAt),
      lastEventAt: asString(log.lastEventAt) || asString(log.startedAt),
      cwd,
      project,
      title: asString(log.title),
      status: tmuxMatch ? 'active' : 'unknown',
      activityState: latestActivityState(log.messages),
      tmuxId: tmuxMatch?.tmuxId || null,
      tmuxPaneId: tmuxMatch?.tmuxPaneId || null,
      gjcProfile: tmuxMatch?.gjcProfile || null,
      gjcBranch: tmuxMatch?.gjcBranch || 'gjc',
      gjcBranchSlug: tmuxMatch?.gjcBranchSlug || slugify('gjc'),
      gjcProject: tmuxMatch?.gjcProject || slugify(project),
      gjcOwnerKey: tmuxMatch?.gjcOwnerKey || null,
      gjcStartedAt: tmuxMatch?.gjcStartedAt || null,
      gjcSessionTag: tmuxMatch?.gjcSessionId || null,
      gjcActiveByCwd: tmuxMatch?.gjcActiveByCwd === true,
      sessionLogPath: file,
      hasOmxLifecycle: false,
      lifecycleOwner: 'gjc',
      isAuxiliaryGjcLog,
      kind: isAuxiliaryGjcLog ? 'gjc-subagent' : 'codex-thread',
      sources: [{ source: 'gjc-log', path: file }],
    });
  }
  return uniqueSessions(sessions);
}

export function resolveSessionId(session = {}, id) {
  return [session.gjcSessionId, session.bridgeSessionId, session.threadId, session.codexThreadId, session.codexSessionId]
    .filter(Boolean)
    .includes(id);
}

export async function getSessionById(id, options = {}) {
  const sessions = await buildSessionIndex(options);
  return sessions.find((session) => resolveSessionId(session, id)) || null;
}
