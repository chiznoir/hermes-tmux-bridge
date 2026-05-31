import { basename, resolve } from 'node:path';

export function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function projectNameFromCwd(cwd) {
  return cwd ? basename(cwd) : 'unknown';
}

export function teamWorkerSourceCwd(cwd) {
  const normalized = String(cwd || '').trim().replaceAll('\\', '/');
  const marker = '/.codex/team/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex <= 0) return null;
  return normalized.slice(0, markerIndex);
}

export function projectCwdForSession(cwd, sourceCwd, lifecycleRoot) {
  return teamWorkerSourceCwd(sourceCwd)
    || sourceCwd
    || teamWorkerSourceCwd(cwd)
    || teamWorkerSourceCwd(lifecycleRoot)
    || cwd;
}

export function compactSessionEntry(entry = {}) {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

export function mergeSessionEntry(previous = {}, entry = {}) {
  const compact = compactSessionEntry(entry);
  const merged = {
    ...previous,
    ...compact,
    lifecycleSessionId: entry.lifecycleSessionId || previous.lifecycleSessionId,
    codexSessionId: entry.codexSessionId || previous.codexSessionId,
    hasBridgeLifecycle: previous.hasBridgeLifecycle === true || entry.hasBridgeLifecycle === true,
    lifecycleOwner: entry.lifecycleOwner || previous.lifecycleOwner,
  };
  const startMs = Date.parse(merged.startedAt || '');
  const endMs = Date.parse(merged.endedAt || '');
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs < startMs) {
    delete merged.endedAt;
    delete merged.endedAtSource;
    delete merged.endReason;
    if (entry.endedAt && previous.lifecycleSessionId && entry.lifecycleSessionId && entry.lifecycleSessionId !== previous.lifecycleSessionId) {
      merged.lifecycleSessionId = previous.lifecycleSessionId;
      merged.lifecycleOwner = previous.lifecycleOwner;
      if (previous.pid !== undefined) merged.pid = previous.pid;
      if (previous.cwd) merged.cwd = previous.cwd;
    }
  }
  return merged;
}

export function sessionIndexKey(entry = {}) {
  if (entry.hasBridgeLifecycle === true && entry.lifecycleSessionId) {
    return entry.lifecycleSessionId;
  }
  return entry.codexSessionId || entry.lifecycleSessionId;
}

export function isNativeOnlyStartRecord(record = {}) {
  const sessionId = asString(record.session_id);
  const nativeSessionId = asString(record.native_session_id);
  return record.event === 'session_start' && sessionId && nativeSessionId && sessionId === nativeSessionId;
}

export function isOwnedReconcileRecord(record = {}) {
  const sessionId = asString(record.session_id);
  const nativeSessionId = asString(record.native_session_id);
  return record.event === 'session_start_reconciled' && sessionId && nativeSessionId && sessionId !== nativeSessionId;
}

export function replacedNativeSessionIds(records = []) {
  return new Set(records
    .filter((record) => record.event === 'native_session_replaced')
    .map((record) => asString(record.replaced_by_native_session_id)
      || asString(record.replacedByNativeSessionId)
      || asString(record.native_session_id)
      || asString(record.nativeSessionId))
    .filter(Boolean));
}

export function hasExplicitCodexOwnerMetadata(record = {}) {
  const owner = String(record.lifecycle_owner || record.lifecycleOwner || record.owner || '').toLowerCase();
  return owner === 'codex' || owner === 'codex-bridge' || record.user_facing === true || record.userFacing === true;
}

export function isOwnedLifecycleEntry(record = {}, ownedSessionIds = new Set()) {
  const sessionId = asString(record.session_id) || asString(record.lifecycleSessionId);
  const nativeSessionId = asString(record.native_session_id) || asString(record.nativeSessionId);
  if (!sessionId) return false;
  if (hasExplicitCodexOwnerMetadata(record)) return true;
  if (ownedSessionIds.has(sessionId)) return true;
  if (!nativeSessionId) return true;
  return nativeSessionId !== sessionId;
}

export function mapSet(map, key, value) {
  if (key === undefined || key === null || !value) return;
  map.set(String(key), value);
}

export function firstSetValue(values = new Set()) {
  for (const value of values) return value;
  return null;
}

export function sessionMarkerInCmdline(cmdline, sessionId) {
  if (!cmdline || !sessionId) return false;
  return String(cmdline).includes(`/.codex/state/sessions/${sessionId}/`)
    || String(cmdline).includes(`/sessions/${sessionId}/AGENTS.md`);
}

export function inheritedOwnedSessionIdForCurrentState(record = {}, lifecycle = {}) {
  const sessionId = asString(record.session_id);
  const nativeSessionId = asString(record.native_session_id);
  if (!sessionId || !nativeSessionId || sessionId !== nativeSessionId) return null;
  const pidOwnedSessionId = lifecycle.ownedSessionIdByPid?.get(String(record.pid));
  if (pidOwnedSessionId) return pidOwnedSessionId;
  for (const ownedSessionId of lifecycle.ownedSessionIds || []) {
    if (sessionMarkerInCmdline(record.pid_cmdline, ownedSessionId)) return ownedSessionId;
  }
  return null;
}

export function latestIso(...values) {
  let best = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values.flat()) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

export function latestCodexLogActivityAt(log = {}) {
  return latestIso(
    log.startedAt,
    log.messages?.map((message) => message.timestamp).filter(Boolean) || [],
    log.events?.map((event) => event.timestamp).filter(Boolean) || [],
  );
}

export function latestCodexUserMessageAt(log = {}) {
  return latestIso((log.messages || [])
    .filter((message) => message.role === 'user')
    .map((message) => message.timestamp)
    .filter(Boolean));
}

export function codexLogHasUserMessageAfter(log = {}, timestamp) {
  const afterMs = Date.parse(timestamp || '');
  if (!Number.isFinite(afterMs)) return false;
  return (log.messages || []).some((message) => {
    if (message.role !== 'user') return false;
    const messageMs = Date.parse(message.timestamp || '');
    return Number.isFinite(messageMs) && messageMs > afterMs;
  });
}

export function preReadSessionSortKey(entry = {}, hook) {
  return latestIso(entry.lastCodexUserMessageAt, entry.lastCodexLogActivityAt, entry.endedAt, hook?.timestamp, entry.startedAt) || '';
}

export function sortableMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

export function preferredEntryForCodexLog(byCodex, log = {}) {
  const direct = byCodex.get(log.codexSessionId);
  const matches = [...byCodex.entries()]
    .filter(([, entry]) => entry.codexSessionId === log.codexSessionId);
  if (direct && !matches.some(([key]) => key === log.codexSessionId)) {
    matches.push([log.codexSessionId, direct]);
  }
  if (matches.length === 0) return null;
  const [key, entry] = matches
    .sort(([, left], [, right]) => {
      const leftCurrentRank = left.isCurrentState === true && left.hasBridgeLifecycle === true && !left.endedAt ? 0 : 1;
      const rightCurrentRank = right.isCurrentState === true && right.hasBridgeLifecycle === true && !right.endedAt ? 0 : 1;
      if (leftCurrentRank !== rightCurrentRank) return leftCurrentRank - rightCurrentRank;
      const leftActiveRank = left.endedAt ? 1 : 0;
      const rightActiveRank = right.endedAt ? 1 : 0;
      if (leftActiveRank !== rightActiveRank) return leftActiveRank - rightActiveRank;
      return sortableMs(right.currentStateStartedAt || right.startedAt) - sortableMs(left.currentStateStartedAt || left.startedAt);
    })[0];
  return { key, entry };
}

export function codexLogResumedInCurrentState(entry = {}, log = {}) {
  if (entry.hasBridgeLifecycle !== true || entry.endedAt) return false;
  if (!entry.lifecycleSessionId || !entry.codexSessionId || entry.lifecycleSessionId === entry.codexSessionId) return false;
  const currentStart = entry.currentStateStartedAt || entry.startedAt;
  const currentStartMs = Date.parse(currentStart || '');
  const logStartMs = Date.parse(log.startedAt || '');
  if (!Number.isFinite(currentStartMs) || !Number.isFinite(logStartMs)) return false;
  if (logStartMs >= currentStartMs - 5000) return false;
  return codexLogHasUserMessageAfter(log, currentStart);
}

export function codexLogAttachmentMetadata(entry = {}, log = {}, fallbackSource = 'id-fragment') {
  const resumedCodexSession = codexLogResumedInCurrentState(entry, log);
  return {
    sessionLogMatchSource: resumedCodexSession ? 'current-state-resumed-codex-log' : fallbackSource,
    resumedCodexSession: resumedCodexSession || undefined,
    resumedCodexSessionStartedAt: resumedCodexSession ? log.startedAt : undefined,
    previousRuntimeBridgeSessionId: resumedCodexSession ? log.runtimeBridgeSessionId : undefined,
  };
}

export function sessionDeduplicationKey(session = {}) {
  return [
    session.lifecycleSessionId || '',
    session.codexSessionId || session.threadId || '',
  ].join('\0');
}

export function sessionDeduplicationRank(session = {}) {
  return [
    session.resumedCodexSession === true ? 1 : 0,
    session.sessionLogOwnerMatch === 'runtime-codex-session' ? 1 : 0,
    session.tmuxId || session.tmuxPaneId ? 1 : 0,
    session.hasBridgeLifecycle === true ? 1 : 0,
    session.status === 'active' ? 1 : session.status === 'unknown' ? 0 : -1,
    sortableMs(session.lastEventAt || session.startedAt),
  ];
}

export function preferSession(left = {}, right = {}) {
  const leftRank = sessionDeduplicationRank(left);
  const rightRank = sessionDeduplicationRank(right);
  for (let index = 0; index < Math.max(leftRank.length, rightRank.length); index += 1) {
    const delta = (rightRank[index] || 0) - (leftRank[index] || 0);
    if (delta > 0) return right;
    if (delta < 0) return left;
  }
  return right;
}

export function dedupeSessions(sessions = []) {
  const byKey = new Map();
  for (const session of sessions) {
    const key = sessionDeduplicationKey(session);
    if (!key.replaceAll('\0', '')) continue;
    byKey.set(key, byKey.has(key) ? preferSession(byKey.get(key), session) : session);
  }
  return [...byKey.values()];
}

export function canonicalStatus(entry, tmuxMatch) {
  if (entry.endedAt) return 'ended';
  if (tmuxMatch) return 'active';
  return 'unknown';
}

export function clearEndedAtForResumedCodexLog(entry = {}, log = {}, options = {}) {
  if (!entry.endedAt || !codexLogHasUserMessageAfter(log, entry.endedAt)) return entry;
  const currentOwnerCodexIds = options.currentOwnerCodexIds || new Set();
  if (
    entry.hasBridgeLifecycle === true
    && log.codexSessionId
    && currentOwnerCodexIds.has(log.codexSessionId)
  ) {
    return entry;
  }
  const resumed = {
    ...entry,
    resumedAfterEndedAt: entry.endedAt,
    resumedAfterEndedAtSource: entry.endedAtSource || null,
  };
  delete resumed.endedAt;
  delete resumed.endedAtSource;
  delete resumed.endReason;
  return resumed;
}

export function canonicalProjectRoot(root) {
  return resolve(String(root || '').trim());
}

export function codexLogOwnerMatchSource(log = {}, entry = {}) {
  if (log.runtimeBridgeSessionId && entry.lifecycleSessionId && log.runtimeBridgeSessionId === entry.lifecycleSessionId) {
    return 'runtime-codex-session';
  }
  return null;
}

export function mergeAssociatedCodexLogs(...groups) {
  const byKey = new Map();
  for (const ref of groups.flat().filter(Boolean)) {
    const key = ref.sessionLogPath || ref.codexSessionId;
    if (!key) continue;
    const previous = byKey.get(key) || {};
    byKey.set(key, {
      ...previous,
      ...ref,
      lastEventAt: latestIso(previous.lastEventAt, ref.lastEventAt),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const activityDelta = sortableMs(right.lastEventAt) - sortableMs(left.lastEventAt);
    if (activityDelta !== 0) return activityDelta;
    return sortableMs(right.startedAt) - sortableMs(left.startedAt);
  });
}

export function lifecycleBoundaryStartMs(entry = {}) {
  const currentStateStartMs = Date.parse(entry.currentStateStartedAt || '');
  if (Number.isFinite(currentStateStartMs)) return currentStateStartMs;
  const startedAtMs = Date.parse(entry.startedAt || '');
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

export function nextLifecycleStartsByEntryKey(entries = []) {
  const starts = entries.map(([key, entry]) => ({
    key,
    cwd: entry.cwd ? canonicalProjectRoot(entry.cwd) : null,
    startedAtMs: lifecycleBoundaryStartMs(entry),
  }));
  const nextStarts = new Map();
  for (const current of starts) {
    if (!current.cwd || !Number.isFinite(current.startedAtMs)) continue;
    const next = starts
      .filter((candidate) => (
        candidate.key !== current.key
        && candidate.cwd === current.cwd
        && Number.isFinite(candidate.startedAtMs)
        && candidate.startedAtMs > current.startedAtMs
      ))
      .sort((left, right) => left.startedAtMs - right.startedAtMs)[0];
    if (next) nextStarts.set(current.key, next.startedAtMs);
  }
  return nextStarts;
}

export function codexLogBeforeNextLifecycle(log = {}, entry = {}, nextStartMs = null) {
  if (codexLogOwnerMatchSource(log, entry)) return true;
  if (!Number.isFinite(nextStartMs)) return true;
  const logStartMs = Date.parse(log.startedAt || '');
  if (!Number.isFinite(logStartMs) || logStartMs >= nextStartMs) return false;
  const latestUserMs = Date.parse(latestCodexUserMessageAt(log) || '');
  return !Number.isFinite(latestUserMs) || latestUserMs < nextStartMs;
}

