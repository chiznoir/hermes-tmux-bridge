import { findCodexLogBySessionId, isAuxiliaryCodexLog, readCodexLog } from '../codex-log.js';
import { readGjcLog } from '../gjc-log.js';
import { readBridgeCommands } from '../interactions.js';
import { readAuditLog, auditEventToRouterEvent } from './audit-log.js';
import { readOmxLogRecords, omxRecordToRouterEvent } from '../adapters/omx-logs.js';
import { hookRecordToRouterEvent, readTmuxHookRecords } from '../adapters/omx-hooks.js';
import { stripSyntheticNotificationContext } from '../synthetic-context.js';

function codexEventType(event) {
  if (event.type === 'task_started') return 'TurnStart';
  if (event.type === 'task_complete') return 'FinalAnswer';
  if (event.type === 'ask_permission') return 'AskPermission';
  if (event.type === 'agent_message' && event.phase === 'commentary') return 'Commentary';
  return 'FinalAnswer';
}

function matchesSession(session = {}, ...values) {
  const ids = new Set([
    session.bridgeSessionId,
    session.codexThreadId,
    session.codexSessionId,
    session.threadId,
    session.omxSessionId,
    session.tmuxId,
    session.tmuxPaneId,
  ].filter(Boolean));
  return values.flat().filter(Boolean).some((value) => ids.has(value));
}

function sorted(events) {
  return events.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

function durationMs(startedAt, endedAt) {
  const startMs = Date.parse(startedAt || '');
  const endMs = Date.parse(endedAt || '');
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
}

function hasValidTimestamp(timestamp) {
  return Number.isFinite(Date.parse(timestamp || ''));
}

function isWithinSessionWindow(timestamp, session = {}) {
  const eventMs = Date.parse(timestamp || '');
  if (!Number.isFinite(eventMs)) return true;
  const startMs = Date.parse(session.startedAt || '');
  if (Number.isFinite(startMs) && eventMs < startMs) return false;
  const endMs = Date.parse(session.endedAt || '');
  if (Number.isFinite(endMs) && eventMs > endMs) return false;
  return true;
}

function normalizeComparableText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function userCommandText(text) {
  return stripSyntheticNotificationContext(text);
}

function realUserCommandMessagesAfter(log = {}, timestamp) {
  const afterMs = Date.parse(timestamp || '');
  return (log.messages || []).filter((message) => {
    if (message.role !== 'user') return false;
    const text = userCommandText(message.text);
    if (!text) return false;
    if (!Number.isFinite(afterMs)) return true;
    const messageMs = Date.parse(message.timestamp || '');
    return Number.isFinite(messageMs) && messageMs >= afterMs;
  });
}

async function hasPrimaryLogUserCommandAfterSessionStart(session = {}) {
  if (!session.sessionLogPath) return false;
  const log = await readCodexLog(session.sessionLogPath);
  if (isAuxiliaryCodexLog(log)) return false;
  return realUserCommandMessagesAfter(log, session.startedAt || log.startedAt).length > 0;
}

async function shouldEmitSessionStart(session = {}) {
  if (!session.startedAt || !hasValidTimestamp(session.startedAt) || session.hasOmxLifecycle === false) return false;
  if (!session.omxSessionId || !session.codexSessionId || session.omxSessionId === session.codexSessionId) return true;
  if (session.sessionLogMatchSource !== 'active-codex-log' && session.sessionLogMatchSource !== 'runtime-omx-session') return true;
  return hasPrimaryLogUserCommandAfterSessionStart(session);
}

function hasNearDuplicateMessage(event, messages = []) {
  if (event.type !== 'agent_message' || event.phase !== 'commentary') return false;
  const eventText = normalizeComparableText(event.message || event.text);
  const eventMs = Date.parse(event.timestamp || '');
  if (!eventText || !Number.isFinite(eventMs)) return false;
  return messages.some((message) => {
    if (message.role !== 'assistant' || message.phase !== 'commentary') return false;
    if (normalizeComparableText(message.text) !== eventText) return false;
    const messageMs = Date.parse(message.timestamp || '');
    return Number.isFinite(messageMs) && Math.abs(messageMs - eventMs) <= 2000;
  });
}

function hasNearDuplicateBridgeCommand(message, bridgeCommands = []) {
  if (message.role !== 'user') return false;
  const messageText = normalizeComparableText(userCommandText(message.text));
  const messageMs = Date.parse(message.timestamp || '');
  if (!messageText || !Number.isFinite(messageMs)) return false;
  return bridgeCommands.some((command) => {
    if (normalizeComparableText(userCommandText(command.commandText)) !== messageText) return false;
    const commandMs = Date.parse(command.submittedAt || '');
    return Number.isFinite(commandMs) && messageMs >= commandMs - 1000 && messageMs - commandMs <= 120000;
  });
}

function bridgeCommandToRouterEvent(session = {}, command = {}) {
  const text = userCommandText(command.commandText);
  if (!text) return null;
  const eventId = command.interactionId
    ? `bridge-command:${command.interactionId}`
    : [
      'bridge-command',
      session.bridgeSessionId || session.codexSessionId || session.omxSessionId || session.tmuxPaneId || session.tmuxId,
      command.submittedAt,
      normalizeComparableText(text),
    ].filter(Boolean).join(':');
  return {
    eventId,
    type: 'CommandSubmitted',
    timestamp: command.submittedAt,
    source: 'bridge-interactions',
    text,
    backend: 'bridge',
    phase: 'user_prompt',
    interactionId: command.interactionId || null,
  };
}

async function readBridgeCommandEvents(session = {}, options = {}) {
  const bridgeCommands = options.bridgeCommands || await readBridgeCommands(session, options);
  return bridgeCommands
    .filter((command) => isWithinSessionWindow(command.submittedAt, session))
    .map((command) => bridgeCommandToRouterEvent(session, command))
    .filter(Boolean);
}

function matchingFinalAnswerMessage(event, messages = []) {
  if (event.type !== 'task_complete') return null;
  const eventText = normalizeComparableText(event.lastAgentMessage || event.text);
  const eventMs = Date.parse(event.timestamp || '');
  if (!Number.isFinite(eventMs)) return null;
  const candidates = [...messages]
    .reverse()
    .filter((message) => {
      if (message.role !== 'assistant' || message.phase !== 'final_answer') return false;
      const messageMs = Date.parse(message.timestamp || '');
      return Number.isFinite(messageMs) && messageMs <= eventMs && eventMs - messageMs <= 60000;
    });
  return candidates.find((message) => eventText && normalizeComparableText(message.text) === eventText)
    || candidates[0]
    || null;
}

function gjcLifecycleSessionId(session = {}, log = {}) {
  return session.bridgeSessionId
    || session.gjcSessionId
    || log.gjcSessionId
    || session.codexSessionId
    || session.threadId
    || 'unknown-gjc-session';
}

function isActiveGjcSession(session = {}) {
  return session.status === 'active' || Boolean(session.tmuxId || session.tmuxPaneId || session.gjcProfile === '1');
}

function latestGjcFinalAnswer(log = {}) {
  return [...(log.messages || [])].reverse()
    .find((message) => message.role === 'assistant' && message.phase === 'final_answer' && message.text) || null;
}

function gjcSessionStartEvent(session = {}, log = {}) {
  const sessionId = gjcLifecycleSessionId(session, log);
  const timestamp = session.startedAt || log.startedAt;
  if (!timestamp || !hasValidTimestamp(timestamp)) return null;
  const project = session.project || log.cwd || session.cwd || 'unknown';
  return {
    eventId: `${sessionId}:start`,
    type: 'SessionStart',
    timestamp,
    source: 'notification',
    text: `새 GJC 세션을 시작했어.\nSession: ${sessionId}\nProject: ${project}\ntmux: ${session.tmuxId || ''}`.trim(),
    backend: 'gjc-jsonl',
  };
}

function gjcSessionEndEvent(session = {}, log = {}) {
  if (isActiveGjcSession(session)) return null;
  const finalAnswer = latestGjcFinalAnswer(log);
  if (!finalAnswer?.timestamp || !hasValidTimestamp(finalAnswer.timestamp)) return null;
  const sessionId = gjcLifecycleSessionId(session, log);
  const project = session.project || log.cwd || session.cwd || 'unknown';
  return {
    eventId: `${sessionId}:end`,
    type: 'SessionEnd',
    timestamp: finalAnswer.timestamp,
    source: 'notification',
    text: `GJC 세션이 종료됐어.\nSession: ${sessionId}\nProject: ${project}\ntmux: ${session.tmuxId || ''}`.trim(),
    backend: 'gjc-jsonl',
    durationMs: durationMs(session.startedAt || log.startedAt, finalAnswer.timestamp),
    reason: 'gjc_final_answer',
  };
}

export function gjcSessionEvents(session = {}, log = {}) {
  const sessionId = gjcLifecycleSessionId(session, log);
  const events = [];
  const startEvent = gjcSessionStartEvent(session, log);
  if (startEvent) events.push(startEvent);
  for (const message of log.messages || []) {
    if (message.role === 'user' && message.text) {
      const text = userCommandText(message.text);
      if (!text) continue;
      events.push({
        eventId: `${sessionId}:${message.id}`,
        type: 'CommandSubmitted',
        source: 'gjc-log',
        timestamp: message.timestamp,
        text,
        backend: 'gjc-jsonl',
      });
      continue;
    }
    if (message.role === 'assistant' && message.phase === 'final_answer' && message.text) {
      events.push({
        eventId: `${sessionId}:${message.id}`,
        type: 'FinalAnswer',
        source: 'gjc-log',
        timestamp: message.timestamp,
        text: message.text,
        backend: 'gjc-jsonl',
        phase: 'final_answer',
      });
      events.push({
        eventId: `${sessionId}:${message.id}:idle`,
        type: 'SessionIdle',
        source: 'gjc-log',
        timestamp: message.timestamp,
        text: '작업 완료. 다음 지시를 기다리는 상태입니다.',
        backend: 'gjc-jsonl',
        phase: 'idle',
      });
    }
  }
  const endEvent = gjcSessionEndEvent(session, log);
  if (endEvent) events.push(endEvent);
  return sorted(events);
}

async function readGjcSessionEvents(session = {}) {
  if (!session.sessionLogPath) return [];
  const log = await readGjcLog(session.sessionLogPath);
  return gjcSessionEvents(session, log);
}

export async function readCodexFallbackEvents(session = {}, options = {}) {
  const logRefs = [
    session.sessionLogPath ? {
      codexSessionId: session.codexSessionId,
      sessionLogPath: session.sessionLogPath,
    } : null,
    ...(Array.isArray(session.associatedCodexLogs) ? session.associatedCodexLogs : []),
  ].filter(Boolean);
  const bridgeCommands = options.bridgeCommands || [];
  const knownCodexIds = new Set([
    ...logRefs.map((ref) => ref?.codexSessionId),
    session.bridgeSessionId,
    session.codexThreadId,
    session.codexSessionId,
    session.threadId,
    session.omxSessionId,
  ].filter(Boolean));
  for (const command of bridgeCommands) {
    if (!command.codexSessionId || knownCodexIds.has(command.codexSessionId)) continue;
    const sessionLogPath = await findCodexLogBySessionId(command.codexSessionId, options);
    if (!sessionLogPath) continue;
    knownCodexIds.add(command.codexSessionId);
    logRefs.push({
      codexSessionId: command.codexSessionId,
      sessionLogPath,
      sessionLogMatchSource: 'bridge-command-target',
    });
  }
  return readCodexFallbackEventsForLogs(session, logRefs, options);
}

async function readCodexFallbackEventsForLogs(session = {}, logRefs = [], options = {}) {
  const events = [];
  const bridgeCommands = options.bridgeCommands || [];
  const seenPaths = new Set();
  for (const ref of logRefs) {
    const sessionLogPath = ref?.sessionLogPath;
    if (!sessionLogPath || seenPaths.has(sessionLogPath)) continue;
    seenPaths.add(sessionLogPath);
    const logSession = {
      ...session,
      codexSessionId: ref.codexSessionId || session.codexSessionId,
      threadId: ref.codexSessionId || session.threadId,
      sessionLogPath,
    };
    events.push(...await readCodexFallbackEventsForLog(logSession, bridgeCommands));
  }
  return events;
}

async function readCodexFallbackEventsForLog(session = {}, bridgeCommands = []) {
  const events = [];
  const log = await readCodexLog(session.sessionLogPath);
  if (isAuxiliaryCodexLog(log)) return events;
  const hasTaskCompleteFinal = log.events.some((event) => event.type === 'task_complete' && (event.lastAgentMessage || event.text));
  for (const event of log.events) {
    if (event.type !== 'task_started' && event.type !== 'task_complete' && event.type !== 'ask_permission' && event.type !== 'agent_message') continue;
    if (event.type === 'agent_message' && event.phase !== 'commentary') continue;
    if (hasNearDuplicateMessage(event, log.messages)) continue;

    const finalMessage = matchingFinalAnswerMessage(event, log.messages);
    const eventId = finalMessage
      ? `${session.codexSessionId}:${finalMessage.id}`
      : `${session.codexSessionId}:${event.eventId}`;
    const base = {
      eventId,
      type: codexEventType(event),
      timestamp: event.timestamp,
      source: 'codex-log',
      text: event.type === 'task_complete' ? (finalMessage?.text || event.lastAgentMessage || event.text) : (event.message || event.text),
      backend: 'jsonl-fallback',
      phase: event.type === 'task_complete' ? 'final_answer' : event.phase,
    };
    events.push(base);

    if (event.type === 'task_complete') {
      events.push({
        eventId: `${eventId}:idle`,
        type: 'SessionIdle',
        timestamp: event.timestamp,
        source: 'codex-log',
        text: '작업 완료. 다음 지시를 기다리는 상태입니다.',
        backend: 'jsonl-fallback',
        phase: 'idle',
      });
    }
  }
  for (const message of log.messages) {
    if (message.role === 'assistant' && message.phase === 'commentary') {
      events.push({
        eventId: `${session.codexSessionId}:${message.id}`,
        type: 'Commentary',
        timestamp: message.timestamp,
        source: 'codex-log',
        text: message.text,
        backend: 'jsonl-fallback',
        phase: message.phase,
      });
      continue;
    }
    if (message.role === 'user' && hasNearDuplicateBridgeCommand(message, bridgeCommands)) continue;
    if (message.role === 'assistant' && (hasTaskCompleteFinal || message.phase !== 'final_answer')) continue;
    const text = message.role === 'user' ? userCommandText(message.text) : message.text;
    if (message.role === 'user' && !text) continue;
    events.push({
      eventId: `${session.codexSessionId}:${message.id}`,
      type: message.role === 'user' ? 'CommandSubmitted' : 'FinalAnswer',
      timestamp: message.timestamp,
      source: 'codex-log',
      text,
      backend: 'jsonl-fallback',
      phase: message.phase,
    });
  }
  return events;
}

export async function readOmxAdapterEvents(session = {}, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const omxRecords = await readOmxLogRecords(projectRoot);
  const hookRecords = await readTmuxHookRecords(projectRoot);
  const events = [];

  for (const record of omxRecords) {
    if (!matchesSession(session, record.session_id, record.native_session_id)) continue;
    if (!isWithinSessionWindow(record.timestamp || record._ts, session)) continue;
    events.push(omxRecordToRouterEvent(record));
  }
  for (const record of hookRecords) {
    const paneId = record.target && typeof record.target === 'object' ? record.target.value : null;
    if (!matchesSession(session, record.thread_id, paneId)) continue;
    if (!isWithinSessionWindow(record.timestamp || record._ts, session)) continue;
    events.push(hookRecordToRouterEvent(record));
  }
  return events;
}

export async function routeSessionEvents(session = {}, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const bridgeProjectRoot = options.bridgeProjectRoot || options.controlPlaneRoot || projectRoot;
  const events = [];

  if (session.backend === 'gjc' || session.gjcSessionId) {
    return readGjcSessionEvents(session);
  }
  const sessionEventId = session.hasOmxLifecycle !== false && session.omxSessionId
    ? session.omxSessionId
    : session.bridgeSessionId || session.codexSessionId || session.threadId || session.tmuxPaneId || session.tmuxId || session.omxSessionId || 'unknown-session';

  if (await shouldEmitSessionStart(session)) {
    events.push({
      eventId: `${sessionEventId}:start`,
      type: 'SessionStart',
      timestamp: session.startedAt,
      source: 'notification',
      text: `새 세션을 시작했어.\nSession: ${session.omxSessionId}\nProject: ${session.project}\ntmux: ${session.tmuxId || ''}`.trim(),
      backend: 'omx',
    });
  }
  if (session.endedAt && session.hasOmxLifecycle !== false) {
    events.push({
      eventId: `${sessionEventId}:end`,
      type: 'SessionEnd',
      timestamp: session.endedAt,
      source: 'notification',
      text: `세션이 종료됐어.\nSession: ${session.omxSessionId}\nProject: ${session.project}\ntmux: ${session.tmuxId || ''}`.trim(),
      backend: 'omx',
      durationMs: durationMs(session.startedAt, session.endedAt),
      reason: session.endReason || 'session_exit',
    });
  }

  const bridgeCommands = await readBridgeCommands(session, { ...options, projectRoot: bridgeProjectRoot });
  events.push(...await readBridgeCommandEvents(session, { ...options, projectRoot: bridgeProjectRoot, bridgeCommands }));
  events.push(...await readCodexFallbackEvents(session, { ...options, bridgeCommands }));
  events.push(...await readOmxAdapterEvents(session, { projectRoot }));

  const auditEvents = await readAuditLog({ sessionId: session.bridgeSessionId, threadId: session.codexThreadId }, { ...options, projectRoot: bridgeProjectRoot });
  for (const record of auditEvents) events.push(auditEventToRouterEvent(record));

  return sorted(events);
}
