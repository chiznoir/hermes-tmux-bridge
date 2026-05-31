import { codexSessionIdFromEventId } from './control-plane/event-index-utils.js';

export function codexOwnerSessions(sessions = []) {
  const byCodexId = new Map();
  for (const session of sessions) {
    if (!session?.codexSessionId || session.status === 'ended') continue;
    if (session.endedAt) continue;
    const existing = byCodexId.get(session.codexSessionId);
    if (!existing) {
      byCodexId.set(session.codexSessionId, session);
      continue;
    }
    const existingScore = (existing.status === 'active' ? 4 : 0) + (existing.hasBridgeLifecycle === true ? 2 : 0) + (existing.resumedCodexSession === true ? 1 : 0);
    const score = (session.status === 'active' ? 4 : 0) + (session.hasBridgeLifecycle === true ? 2 : 0) + (session.resumedCodexSession === true ? 1 : 0);
    if (score > existingScore) byCodexId.set(session.codexSessionId, session);
  }
  return byCodexId;
}

export function pendingEventCodexSessionId(session = {}, event = {}, eventId = '') {
  return event.codexSessionId
    || codexSessionIdFromEventId(event.eventId || eventId)
    || session.codexSessionId
    || null;
}

export function currentOwnerSessionForPendingEvent(session = {}, event = {}, eventId = '', liveCodexOwners = new Map()) {
  if (event.source !== 'codex-log') return session;
  const codexSessionId = pendingEventCodexSessionId(session, event, eventId);
  if (!codexSessionId) return session;
  const owner = liveCodexOwners.get(codexSessionId);
  if (!owner) return session;
  if (session.lifecycleSessionId && owner.lifecycleSessionId && session.lifecycleSessionId === owner.lifecycleSessionId) return session;
  if (session.project && owner.project && session.project !== owner.project) return session;
  return owner;
}
