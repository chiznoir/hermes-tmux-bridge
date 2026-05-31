import { createHash } from 'node:crypto';

export function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function compactTarget(value, maxValue, defaultValue) {
  const parsed = positiveInt(value, defaultValue);
  return Math.min(parsed, Math.max(1, maxValue - 1));
}

export function stableStringify(value) {
  return JSON.stringify(value ?? null);
}

export function payloadPreview(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export function payloadDigest(payloadJson) {
  return createHash('sha256').update(payloadJson).digest('hex');
}

export function sessionIdFor(session = {}) {
  return session.bridgeSessionId || session.lifecycleSessionId || session.codexSessionId || session.threadId || session.tmuxPaneId || session.tmuxId || 'unknown-session';
}

export function sessionNativeId(session = {}) {
  return session.codexSessionId || session.codexThreadId || session.threadId || null;
}

export function isNotificationSessionStart(event = {}) {
  return event.type === 'SessionStart' && event.source === 'notification';
}

export function nativeSessionIdFor(session = {}) {
  return sessionNativeId(session);
}

export function sessionStartMappingChangedAfterReconcile(previousSession = {}, nextSession = {}) {
  if (nextSession.status !== 'active') return false;

  const previousCodexId = previousSession.lifecycleSessionId || null;
  const nextCodexId = nextSession.lifecycleSessionId || null;
  if (!previousCodexId || !nextCodexId || previousCodexId !== nextCodexId) return false;
  if (nextSession.runtimeBridgeSessionId && nextSession.runtimeBridgeSessionId !== nextCodexId && nextSession.resumedCodexSession !== true) {
    return false;
  }

  const previousNativeId = sessionNativeId(previousSession);
  const nextNativeId = sessionNativeId(nextSession);
  if (!previousNativeId || !nextNativeId || previousNativeId === nextNativeId) return false;
  if (previousNativeId === previousCodexId && nextSession.resumedCodexSession !== true) return false;
  if (nextNativeId === nextCodexId) return false;

  return true;
}

export function sessionLinkedEventId(sessionStartEventId, nextSession = {}) {
  const nextNativeId = nativeSessionIdFor(nextSession);
  return [sessionStartEventId, 'linked', nextNativeId].filter(Boolean).join(':');
}

export function sessionLinkedEvent(previousSession = {}, nextSession = {}, sessionStartEvent = {}, sessionStartEventId = '') {
  const previousNativeId = nativeSessionIdFor(previousSession);
  const nextNativeId = nativeSessionIdFor(nextSession);
  const lifecycleSessionId = nextSession.lifecycleSessionId || previousSession.lifecycleSessionId || null;
  return {
    eventId: sessionLinkedEventId(sessionStartEventId, nextSession),
    type: 'SessionLinked',
    timestamp: nextSession.lastEventAt || new Date().toISOString(),
    source: 'notification',
    text: [
      '세션이 새 Codex thread에 연결됐어.',
      lifecycleSessionId ? `Session: ${lifecycleSessionId}` : null,
      previousNativeId ? `Previous Codex: ${previousNativeId}` : null,
      nextNativeId ? `Codex: ${nextNativeId}` : null,
    ].filter(Boolean).join('\n'),
    backend: sessionStartEvent.backend || 'codex',
    previousCodexSessionId: previousNativeId || null,
    codexSessionId: nextNativeId || null,
    lifecycleSessionId,
  };
}

export function eventTimestampMs(event = {}) {
  const ms = Date.parse(event.timestamp || '');
  return Number.isFinite(ms) ? ms : 0;
}

export function falseyEnv(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase());
}

export function codexLineNumberFromEventId(eventId = '') {
  const match = /(?:^|:)(?:message|codex-event)-(\d+)(?::idle)?$/.exec(String(eventId || ''));
  if (!match) return null;
  const line = Number.parseInt(match[1], 10);
  return Number.isFinite(line) && line > 0 ? line : null;
}

export function codexSessionIdFromEventId(eventId = '') {
  const value = String(eventId || '');
  const match = /^(.*?):(?:message|codex-event)-\d+(?::idle)?$/.exec(value);
  return match?.[1] || null;
}

export function logPathForCodexEvent(session = {}, event = {}) {
  const eventCodexSessionId = codexSessionIdFromEventId(event.eventId);
  if (eventCodexSessionId) {
    if (session.codexSessionId === eventCodexSessionId && session.sessionLogPath) return session.sessionLogPath;
    const associated = (session.associatedCodexLogs || [])
      .find((ref) => ref?.codexSessionId === eventCodexSessionId && ref.sessionLogPath);
    if (associated) return associated.sessionLogPath;
  }
  return session.sessionLogPath || null;
}

export function placeholders(values) {
  return values.map(() => '?').join(', ');
}

