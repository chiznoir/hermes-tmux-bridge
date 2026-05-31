import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonlStreaming, listFilesRecursive } from './jsonl.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return asString(value.text) || asString(value.content) || '';
}

function extractCodexRuntimeContext(text) {
  const source = String(text || '');
  if (!source) return {};
  const block = source.match(/<!--\s*Codex:RUNTIME:START\s*-->([\s\S]*?)<!--\s*Codex:RUNTIME:END\s*-->/i)?.[1] || source;
  const runtimeBridgeSessionId = block.match(/\*\*Session:\*\*\s*`?([^`\s|]+)/i)?.[1] || null;
  const runtimeTmuxId = block.match(/\*\*tmux:\*\*\s*`?([^`\s|]+)/i)?.[1] || null;
  if (!runtimeBridgeSessionId && !runtimeTmuxId) return {};
  return {
    runtimeBridgeSessionId,
    runtimeTmuxId,
    runtimeSessionContextSource: 'codex-runtime-block',
  };
}

function collectText(value, fragments = []) {
  if (typeof value === 'string') {
    if (value.trim()) fragments.push(value);
    return fragments;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, fragments);
    return fragments;
  }
  if (!value || typeof value !== 'object') return fragments;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'base_instructions' || key === 'developer_instructions' || key === 'type' || key === 'role') continue;
    collectText(child, fragments);
  }
  return fragments;
}

export function codexSessionsRoot(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  return join(codexHome, 'sessions');
}

export async function listCodexSessionLogPaths(options = {}) {
  const root = options.sessionsRoot || codexSessionsRoot(options.codexHome);
  return listFilesRecursive(root, (_path, name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

export async function readCodexLog(filePath) {
  const meta = {
    codexSessionId: null,
    startedAt: null,
    cwd: null,
    approvalPolicy: null,
    sandboxPolicyType: null,
    permissionProfileType: null,
    runtimeBridgeSessionId: null,
    runtimeTmuxId: null,
    runtimeSessionContextSource: null,
    threadSource: null,
    agentRole: null,
    agentNickname: null,
    parentThreadId: null,
    originator: null,
    sessionSource: null,
    isCodexExploreHarness: false,
  };
  const messages = [];
  const events = [];
  const pendingPermissionCalls = [];
  const completedCallIds = new Set();

  await readJsonlStreaming(filePath, (record, lineNumber) => {
    const timestamp = asString(record.timestamp);
    if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
      meta.codexSessionId = asString(record.payload.id) || meta.codexSessionId;
      meta.startedAt = asString(record.payload.timestamp) || timestamp || meta.startedAt;
      meta.cwd = asString(record.payload.cwd) || meta.cwd;
      const runtime = extractCodexRuntimeContext(textValue(record.payload.base_instructions));
      meta.runtimeBridgeSessionId = runtime.runtimeBridgeSessionId || meta.runtimeBridgeSessionId;
      meta.runtimeTmuxId = runtime.runtimeTmuxId || meta.runtimeTmuxId;
      meta.runtimeSessionContextSource = runtime.runtimeSessionContextSource || meta.runtimeSessionContextSource;
      meta.originator = asString(record.payload.originator) || meta.originator;
      meta.sessionSource = asString(record.payload.source)
        || asString(record.payload.source?.type)
        || meta.sessionSource;
      meta.threadSource = asString(record.payload.thread_source) || meta.threadSource;
      meta.agentRole = asString(record.payload.agent_role) || meta.agentRole;
      meta.agentNickname = asString(record.payload.agent_nickname) || meta.agentNickname;
      meta.parentThreadId = asString(record.payload.source?.subagent?.thread_spawn?.parent_thread_id) || meta.parentThreadId;
      const baseInstructions = textValue(record.payload.base_instructions);
      meta.isCodexExploreHarness = meta.isCodexExploreHarness
        || /(?:^|\n)\s*#\s*Codex Explore Lightweight Instructions\b/i.test(baseInstructions);
      return;
    }

    if (record.type === 'turn_context' && record.payload && typeof record.payload === 'object') {
      meta.approvalPolicy = asString(record.payload.approval_policy) || meta.approvalPolicy;
      const sandboxPolicy = record.payload.sandbox_policy && typeof record.payload.sandbox_policy === 'object'
        ? record.payload.sandbox_policy
        : {};
      const permissionProfile = record.payload.permission_profile && typeof record.payload.permission_profile === 'object'
        ? record.payload.permission_profile
        : {};
      meta.sandboxPolicyType = asString(sandboxPolicy.type) || meta.sandboxPolicyType;
      meta.permissionProfileType = asString(permissionProfile.type) || meta.permissionProfileType;
      return;
    }

    if (record.type === 'event_msg') {
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
      const payloadType = asString(payload.type) || 'event';
      const text = collectText(payload).join('\n').trim();
      events.push({
        eventId: `codex-event-${lineNumber}`,
        type: payloadType,
        timestamp,
        source: 'codex-log',
        text,
        message: asString(payload.message),
        lastAgentMessage: asString(payload.last_agent_message),
        phase: asString(payload.phase),
        durationMs: payload.duration_ms,
        lineNumber,
      });
      return;
    }

    if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') return;
    const payload = record.payload;
    if (payload.type === 'function_call_output') {
      const callId = asString(payload.call_id);
      if (callId) completedCallIds.add(callId);
      return;
    }
    if (payload.type === 'function_call') {
      const name = asString(payload.name);
      const namespace = asString(payload.namespace);
      const args = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {});
      const isPermissionRequest = name === 'request_user_input'
        || /sandbox_permissions"\s*:\s*"require_escalated"/.test(args)
        || /sandbox_permissions["']?\s*[:=]\s*["']require_escalated/.test(args);
      if (isPermissionRequest) {
        pendingPermissionCalls.push({
          callId: asString(payload.call_id),
          eventId: `codex-event-${lineNumber}`,
          type: 'ask_permission',
          timestamp,
          source: 'codex-log',
          text: [namespace ? `${namespace}.${name}` : name, args].filter(Boolean).join('\n'),
          phase: asString(payload.phase),
          lineNumber,
        });
      }
      return;
    }
    if (payload.type !== 'message') return;
    const role = asString(payload.role);
    if (role !== 'assistant' && role !== 'user') return;
    const text = collectText(payload.content).join('\n').trim();
    if (!text) return;
    messages.push({
      id: `message-${lineNumber}`,
      role,
      timestamp,
      text,
      phase: asString(payload.phase),
      lineNumber,
    });
  });

  for (const event of pendingPermissionCalls) {
    if (event.callId && completedCallIds.has(event.callId)) continue;
    const { callId: _callId, ...routerEvent } = event;
    events.push(routerEvent);
  }

  return { ...meta, sessionLogPath: filePath, messages, events };
}

export async function findCodexLogBySessionId(sessionId, options = {}) {
  if (!sessionId) return null;
  const files = await listCodexSessionLogPaths(options);
  const direct = files.find((file) => file.includes(sessionId));
  if (direct) return direct;
  for (const file of files) {
    const log = await readCodexLog(file);
    if (log.codexSessionId === sessionId) return file;
  }
  return null;
}

export function latestAssistantMessage(log) {
  return [...(log.messages || [])].reverse().find((message) => message.role === 'assistant' && message.phase === 'final_answer')
    || [...(log.messages || [])].reverse().find((message) => message.role === 'assistant')
    || null;
}

export function nextAssistantAfter(log, timestamp) {
  const submittedMs = Date.parse(timestamp || '');
  const candidates = (log.messages || []).filter((message) => {
    if (message.role !== 'assistant') return false;
    if (!Number.isFinite(submittedMs)) return true;
    const messageMs = Date.parse(message.timestamp || '');
    return Number.isFinite(messageMs) ? messageMs >= submittedMs : true;
  });
  return candidates.find((message) => message.phase === 'final_answer') || candidates[0] || null;
}

export function userMessages(log) {
  return (log.messages || []).filter((message) => message.role === 'user');
}

export function isAuxiliaryCodexLog(log = {}) {
  if (log.threadSource === 'subagent') return true;
  if (log.isCodexExploreHarness === true) return true;
  const originator = String(log.originator || '').toLowerCase();
  const sessionSource = String(log.sessionSource || '').toLowerCase();
  return originator === 'codex_exec' || sessionSource === 'exec';
}

export async function isAuxiliaryCodexSession(session = {}) {
  if (isAuxiliaryCodexLog(session)) return true;
  if (!session.sessionLogPath) return false;
  try {
    return isAuxiliaryCodexLog(await readCodexLog(session.sessionLogPath));
  } catch {
    return false;
  }
}
