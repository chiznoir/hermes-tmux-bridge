import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAuxiliaryCodexSession } from './codex-log.js';
import { isAuxiliaryGjcSession } from './gjc.js';
import { listSessions } from './control-plane/registry.js';
import { routeSessionEvents } from './control-plane/event-router.js';
import { appendAudit } from './control-plane/audit-log.js';
import {
  closeEventIndex,
  compactEventIndexIfNeeded,
  eventIdsInIndex,
  markLegacySentDeliveries,
  markSkippedBeforeDeliveries,
  markDeliveryFailed,
  markDeliveryPrepared,
  markDeliverySent,
  openEventIndex,
  pendingEvents,
  upsertEvents,
  filterEventsByCodexLogCursor,
  getGjcLogCursor,
  advanceGjcLogCursor,
  shouldUseGjcLogCursorForPoll,
  recordGjcLogCursorError,
} from './control-plane/event-index.js';
import { ensureDirFor } from './jsonl.js';
import {
  discordBotToken,
  discordThreadNameForSession,
  ensureDiscordTextChannelByName,
  ensureDiscordThreadByName,
} from './discord-channels.js';
import { ensureHermesDiscordChannelAllowed, waitForHermesGatewayAfterRestart } from './hermes-config.js';
import {
  channelNameForProject,
  discordThreadForSession,
  readProjectChannelMap,
  resolveProjectChannel,
  updateProjectChannel,
  updateSessionDiscordThread,
} from './project-channels.js';
import { formatDuration } from './duration.js';
import { bridgeStatePath } from './bridge-paths.js';
import { stripSyntheticNotificationContext } from './synthetic-context.js';
import { readCodexLog } from './codex-log.js';
import { limitUserCommandNotificationText } from './notification-text.js';
import { normalizeEventId } from './event-ids.js';
import { codexOwnerSessions, currentOwnerSessionForPendingEvent } from './session-owner.js';
import { missingSessionThreadTarget, shouldCreateMissingSessionThread } from './session-thread-target.js';
import { hydrateEventBodyText, spoolEventBodyIfNeeded } from './event-body-store.js';
import { deliveryFailureAlertMessage, deliveryFailureErrorMessage } from './delivery-failure-alert.js';
import { DISCORD_SAFE_MESSAGE_CHARS } from './delivery-text.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_EVENT_TYPES = new Set(['AskPermission', 'FinalAnswer']);
const DEFAULT_MAX_EVENTS_PER_POLL = 3;
const DEFAULT_TEXT_PREVIEW_CHARS = 3000;
const DEFAULT_AUTO_CREATE_CHANNELS = true;
const DEFAULT_NOTIFICATION_MODE = 'direct';
const DEFAULT_SESSION_SCAN_LIMIT = 15;
const DEFAULT_HERMES_WEBHOOK_RETRY_MAX_ATTEMPTS = 120;
export { DISCORD_SAFE_MESSAGE_CHARS };
const CHUNK_ORDINAL_RESERVE_CHARS = 32;

function statePath(projectRoot = process.cwd(), options = {}) {
  return process.env.BRIDGE_HERMES_WEBHOOK_STATE_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-hermes-webhook-sink.json', options)
      : null)
    || join(projectRoot, '.omx', 'state', 'bridge-hermes-webhook-sink.json');
}

async function readState(path) {
  if (!existsSync(path)) return { sentEventIds: [], lastRunAt: null };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return {
      sentEventIds: Array.isArray(parsed.sentEventIds) ? parsed.sentEventIds : [],
      lastRunAt: parsed.lastRunAt || null,
    };
  } catch {
    return { sentEventIds: [], lastRunAt: null };
  }
}

async function writeState(path, sentEventIds) {
  await ensureDirFor(path);
  await writeFile(path, JSON.stringify({ sentEventIds: [...sentEventIds].slice(-5000), lastRunAt: new Date().toISOString() }, null, 2), 'utf8');
}

function eventTypesFromEnv() {
  const raw = process.env.BRIDGE_HERMES_WEBHOOK_EVENT_TYPES || '';
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? new Set(values) : DEFAULT_EVENT_TYPES;
}

function priorTerminalLifecycleDeliveryBlocks(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'priorTerminalLifecycleDeliveryBlocks')
    ? options.priorTerminalLifecycleDeliveryBlocks
    : process.env.BRIDGE_HERMES_TERMINAL_LIFECYCLE_BLOCK;
  if (!isTruthyEnv(enabled, true)) return [];
  const graceValue = process.env.BRIDGE_HERMES_TERMINAL_LIFECYCLE_WAIT_MS ?? options.priorTerminalLifecycleGraceMs;
  const parsedGraceMs = Number.parseInt(graceValue, 10);
  return [{
    sink: options.lifecycleDeliverySink || process.env.BRIDGE_HERMES_LIFECYCLE_SINK || 'discord-fast',
    eventTypes: new Set(['SessionStart', 'CommandSubmitted']),
    appliesToEventTypes: new Set(['FinalAnswer', 'AgentResponse', 'SessionEnd', 'SessionIdle']),
    gjcOnly: true,
    missingDeliveryGraceMs: Number.isFinite(parsedGraceMs) && parsedGraceMs >= 0
      ? parsedGraceMs
      : null,
  }];
}

function eventMatchesPriorDeliveryBlocker(event = {}, blocks = []) {
  return blocks.some((block) => [...(block?.eventTypes || [])].includes(event.type));
}

function isGjcSession(session = {}) {
  return session.backend === 'gjc'
    || session.lifecycleOwner === 'gjc'
    || Boolean(session.gjcSessionId);
}

function isActiveGjcSession(session = {}) {
  return session.status === 'active' || Boolean(session.tmuxId || session.tmuxPaneId || session.gjcProfile === '1');
}

function isTerminalEvent(event = {}) {
  return event.type === 'FinalAnswer'
    || event.type === 'AgentResponse'
    || event.type === 'SessionEnd'
    || event.type === 'SessionIdle';
}

function eventSortKey(event = {}) {
  const ms = Date.parse(event.timestamp || '');
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function isTruthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function hermesWebhookRetryMaxAttempts(options = {}) {
  return positiveInt(
    process.env.BRIDGE_HERMES_WEBHOOK_RETRY_MAX_ATTEMPTS
      || options.hermesWebhookRetryMaxAttempts
      || options.webhookRetryMaxAttempts,
    DEFAULT_HERMES_WEBHOOK_RETRY_MAX_ATTEMPTS,
  );
}

function includeUnmappedCodexLogs(options = {}) {
  return options.includeUnmappedCodexLogs
    ?? isTruthyEnv(
      process.env.BRIDGE_HERMES_WEBHOOK_INCLUDE_UNMAPPED_CODEX_LOGS
        ?? process.env.BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS,
      false,
    );
}

function sessionScanLimit(options = {}) {
  return positiveInt(
    process.env.BRIDGE_HERMES_WEBHOOK_SESSION_SCAN_LIMIT
      || process.env.BRIDGE_NOTIFY_SESSION_SCAN_LIMIT
      || process.env.BRIDGE_SESSION_SCAN_LIMIT
      || options.sessionScanLimit,
    DEFAULT_SESSION_SCAN_LIMIT,
  );
}

function suppressTeamWorkerNotifications(options = {}) {
  if (options.allowTeamWorkerNotifications === true) return false;
  const explicit = options.suppressTeamWorkerNotifications
    ?? process.env.BRIDGE_HERMES_SUPPRESS_TEAM_WORKER_NOTIFICATIONS
    ?? process.env.BRIDGE_SUPPRESS_TEAM_WORKER_NOTIFICATIONS;
  return isTruthyEnv(explicit, true);
}

function shouldPollSession(session = {}, options = {}) {
  if (session.kind === 'omx-team' && suppressTeamWorkerNotifications(options)) return false;
  if (session.isAuxiliaryCodexLog === true && session.hasOmxLifecycle !== true) return false;
  if (isAuxiliaryGjcSession(session)) return false;
  if (isNativeOnlyLifecyclePollution(session)) return false;
  if (session.backend === 'gjc' || session.lifecycleOwner === 'gjc' || session.gjcSessionId) {
    return true;
  }
  if (session.hasOmxLifecycle === false && options.allowCodexOnlySessionMonitoring !== true) return false;
  if (options.allowUnmappedCodexLogNotifications === true || includeUnmappedCodexLogs(options)) return true;
  return session.hasOmxLifecycle !== false;
}

function isNativeOnlyLifecyclePollution(session = {}) {
  if (session.lifecycleOwner) return false;
  const omxSessionId = session.omxSessionId || session.session_id;
  const codexSessionId = session.codexSessionId || session.codex_session_id || session.threadId || session.thread_id;
  return session.hasOmxLifecycle === true
    && omxSessionId
    && codexSessionId
    && omxSessionId === codexSessionId;
}

function suppressAskPermissionForSession(session = {}, options = {}) {
  const enabled = options.suppressAskPermissionInYolo
    ?? isTruthyEnv(process.env.BRIDGE_SUPPRESS_ASK_PERMISSION_IN_YOLO, true);
  if (!enabled) return false;
  const approvalPolicy = String(session.approvalPolicy || session.approval_policy || '').toLowerCase();
  const sandboxPolicyType = String(session.sandboxPolicyType || session.sandbox_policy_type || session.sandboxPolicy?.type || '').toLowerCase();
  const permissionProfileType = String(session.permissionProfileType || session.permission_profile_type || session.permissionProfile?.type || '').toLowerCase();
  return approvalPolicy === 'never'
    || permissionProfileType === 'disabled'
    || sandboxPolicyType === 'danger-full-access';
}

export function shouldForwardToHermes(event, options = {}, session = {}) {
  const allowed = options.eventTypes || eventTypesFromEnv();
  if (!allowed.has(event.type)) return false;
  if (event.type === 'AskPermission' && suppressAskPermissionForSession(session, options)) return false;
  if (event.type === 'SessionIdle') return false;
  if ((event.type === 'FinalAnswer' || event.type === 'AgentResponse') && event.phase && event.phase !== 'final_answer') return false;
  if (event.type === 'Idle') return false;
  if ((event.type === 'SessionStart' || event.type === 'SessionEnd') && event.source !== 'notification') return false;
  if (event.source === 'notification' && (event.type === 'Idle' || event.type === 'FinalAnswer' || event.type === 'AgentResponse' || event.type === 'Commentary')) return false;
  return true;
}


function shouldRefreshSkippedEvent(event = {}, session = {}) {
  return event.type === 'SessionStart' && event.source === 'notification' && session.status === 'active';
}

function shouldUseCodexLogCursorForPoll(allowedEventTypes) {
  if (!(allowedEventTypes instanceof Set)) return true;
  if (!allowedEventTypes.has('CommandSubmitted')) return true;
  return allowedEventTypes.has('FinalAnswer') || allowedEventTypes.has('AgentResponse');
}

async function loadProjectChannelMap(options = {}) {
  return readProjectChannelMap(options);
}

function bridgeUrlFromEnv() {
  if (process.env.BRIDGE_PUBLIC_URL) return process.env.BRIDGE_PUBLIC_URL;
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || '3037';
  return `http://${host}:${port}`;
}

function previewText(text, options = {}) {
  const value = String(text || '');
  const max = Number.parseInt(process.env.BRIDGE_HERMES_TEXT_PREVIEW_CHARS || `${options.textPreviewChars || DEFAULT_TEXT_PREVIEW_CHARS}`, 10);
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) {
    return { text: value, truncated: false, length: value.length };
  }
  return { text: value.slice(0, max), truncated: true, length: value.length };
}

function notificationChunkChars(options = {}) {
  return Math.min(
    DISCORD_SAFE_MESSAGE_CHARS,
    positiveInt(
      options.notificationChunkChars || process.env.BRIDGE_HERMES_NOTIFICATION_CHUNK_CHARS,
      DISCORD_SAFE_MESSAGE_CHARS,
    ),
  );
}

function chunkOrdinal(index, total) {
  return total > 1 ? `(${index + 1}/${total})` : '';
}

function withChunkOrdinal(text, index, total) {
  const ordinal = chunkOrdinal(index, total);
  if (!ordinal) return text;
  const value = String(text || '');
  return `${value}${value.endsWith('\n') ? '' : '\n\n'}${ordinal}`;
}

function markdownLines(text) {
  return String(text || '').match(/[^\n]*\n|[^\n]+/g) || [];
}

function fenceLineInfo(line) {
  const source = String(line || '').replace(/\n$/, '');
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(source);
  if (!match) return null;
  return {
    indent: match[1] || '',
    marker: match[2],
    rest: match[3] || '',
  };
}

function transitionFenceState(fence, line) {
  const info = fenceLineInfo(line);
  if (!info) return fence;

  if (!fence) {
    return {
      marker: info.marker,
      openingLine: `${info.indent}${info.marker}${info.rest}\n`,
      closingLine: `${info.indent}${info.marker}\n`,
    };
  }

  if (info.marker[0] !== fence.marker[0] || info.marker.length < fence.marker.length) return fence;
  return null;
}

function safeTextCutIndex(text, maxLength) {
  const value = String(text || '');
  const limit = Math.max(1, Math.min(maxLength, value.length));
  if (value.length <= limit) return value.length;
  const newline = value.lastIndexOf('\n', limit);
  if (newline > Math.floor(limit * 0.55)) return newline + 1;
  const space = value.lastIndexOf(' ', limit);
  if (space > Math.floor(limit * 0.55)) return space + 1;
  return limit;
}

function splitMarkdownAtSafeBoundaries(text, limit) {
  const bodyLimit = Math.max(200, limit);
  const chunks = [];
  let current = '';
  let fence = null;

  const closingFence = () => (fence ? fence.closingLine : '');
  const currentWithClosingFenceLength = (candidate = current, candidateFence = fence) => (
    candidate.length + (candidateFence ? candidateFence.closingLine.length : 0)
  );
  const flush = () => {
    if (!current) return;
    chunks.push(`${current}${closingFence()}`);
    current = fence ? fence.openingLine : '';
  };
  const appendLongText = (line) => {
    let remaining = String(line || '');
    while (remaining) {
      const available = bodyLimit - currentWithClosingFenceLength();
      if (available <= 0) {
        flush();
        continue;
      }
      const cut = safeTextCutIndex(remaining, available);
      current += remaining.slice(0, cut);
      remaining = remaining.slice(cut);
      if (remaining) flush();
    }
  };

  for (const line of markdownLines(text)) {
    const nextFence = transitionFenceState(fence, line);
    const candidate = `${current}${line}`;
    if (current && currentWithClosingFenceLength(candidate, nextFence) > bodyLimit) flush();

    if (currentWithClosingFenceLength(`${current}${line}`, nextFence) > bodyLimit) {
      appendLongText(line);
      fence = nextFence;
      continue;
    }

    current += line;
    fence = nextFence;
  }

  if (current) chunks.push(`${current}${closingFence()}`);
  return chunks.length > 0 ? chunks : [''];
}

export function splitNotificationMarkdown(messageMarkdown, options = {}) {
  const text = String(messageMarkdown || '');
  const limit = notificationChunkChars(options);
  if (text.length <= limit) return [text];

  const bodyLimit = Math.max(200, limit - CHUNK_ORDINAL_RESERVE_CHARS);
  const chunks = splitMarkdownAtSafeBoundaries(text, bodyLimit);
  return chunks.map((chunk, index) => withChunkOrdinal(chunk, index, chunks.length));
}

export function hermesPayloadNotificationChunks(payload = {}, options = {}) {
  const messageChunks = splitNotificationMarkdown(payload.message_markdown, options);
  if (messageChunks.length <= 1) {
    return [{
      ...payload,
      message_markdown: messageChunks[0] || '',
      notification_chunked: false,
      notification_chunk_index: 1,
      notification_chunk_total: 1,
      notification_subject_included: true,
      parent_event_id: null,
    }];
  }

  const parentEventId = String(payload.event_id || `${Date.now()}`);
  return messageChunks.map((messageMarkdown, index) => ({
    ...payload,
    event_id: `${parentEventId}:chunk-${index + 1}-of-${messageChunks.length}`,
    parent_event_id: parentEventId,
    message_markdown: messageMarkdown,
    notification_chunked: true,
    notification_chunk_index: index + 1,
    notification_chunk_total: messageChunks.length,
    notification_subject_included: index === 0,
    notification_continuation: index > 0,
    notification_title: index === 0 ? payload.notification_title : '',
    notification_summary: '',
  }));
}

function sessionIdFor(session = {}) {
  return session.bridgeSessionId
    || session.omxSessionId
    || session.codexThreadId
    || session.codexSessionId
    || session.threadId
    || session.tmuxPaneId
    || session.tmuxId;
}

function inlineCode(value) {
  return `\`${String(value || 'unknown').replace(/`/g, "'")}\``;
}

export function sessionContextLine(session = {}) {
  return [
    `**session:** ${inlineCode(sessionIdFor(session))}`,
    [
      `**tmux:** ${inlineCode(session.tmuxId || session.tmuxPaneId || session.omxSessionId || session.bridgeSessionId)}`,
      `**project:** ${inlineCode(session.project || 'unknown')}`,
    ].join(' | '),
  ].join('\n');
}

function eventContextLine(session = {}, event = {}) {
  return sessionContextLine(session);
}

function eventTitle(type) {
  if (type === 'SessionStart') return 'Session Start';
  if (type === 'SessionLinked') return 'Session Linked';
  if (type === 'SessionIdle') return 'Session Idle';
  if (type === 'SessionEnd') return 'Session End';
  if (type === 'AskPermission') return 'Ask Permission';
  if (type === 'CommandSubmitted') return 'User Command';
  if (type === 'FinalAnswer' || type === 'AgentResponse') return 'Session Idle';
  return type || 'Event';
}

function notificationMode(options = {}) {
  const raw = String(
    options.notificationMode
    || process.env.BRIDGE_HERMES_NOTIFICATION_MODE
    || DEFAULT_NOTIFICATION_MODE,
  ).trim().toLowerCase();
  if (raw === 'direct') return 'direct';
  return 'summary';
}

function autoCreateDiscordThreads(options = {}) {
  return options.autoCreateDiscordThreads
    ?? isTruthyEnv(process.env.BRIDGE_DISCORD_AUTO_CREATE_THREADS, false);
}

function isSessionLifecycle(type) {
  return type === 'SessionStart' || type === 'SessionLinked' || type === 'SessionIdle' || type === 'SessionEnd';
}

function approvalCommands(event = {}) {
  if (event.type !== 'AskPermission') return [];
  return ['/approve', '/deny', '/approve session', '/approve always'];
}

function compactComponentId(...parts) {
  const digest = createHash('sha256').update(parts.filter(Boolean).join(':')).digest('base64url').slice(0, 18);
  return `omx:${digest}`;
}

function approvalActionId(command) {
  return String(command || '').replace(/^\//, '').replace(/\s+/g, '-');
}

function approvalActions(session = {}, event = {}) {
  const commands = approvalCommands(event);
  if (commands.length === 0 || !session.bridgeSessionId) return [];
  const endpoint = `/sessions/${encodeURIComponent(session.bridgeSessionId)}/commands`;
  return commands.map((command, index) => ({
    type: 'bridge_command',
    label: command,
    action_id: approvalActionId(command),
    command,
    endpoint,
    body: {
      commandText: command,
      mode: 'tmux',
      submit: true,
      source: 'discord-component',
      componentAction: 'approval',
    },
    discord_component: {
      type: 'button',
      component_type: 2,
      style: command === '/deny' || command === '/approve always' ? 4 : command === '/approve' ? 3 : 2,
      label: command,
      custom_id: compactComponentId('approval', session.bridgeSessionId, event.eventId, event.timestamp, index, command),
      action_id: approvalActionId(command),
      requires_confirmation: command === '/approve always',
    },
  }));
}

function approvalDiscordComponents(actions = []) {
  if (actions.length === 0) return [];
  return [{
    type: 1,
    components: actions.map((action) => ({
      type: 2,
      style: action.discord_component.style,
      label: action.discord_component.label,
      custom_id: action.discord_component.custom_id,
    })),
  }];
}

function sessionEndContextLine(session = {}, event = {}) {
  const rows = [sessionContextLine(session)];
  if (event.durationMs != null) rows.push(`**duration:** ${formatDuration(event.durationMs)}`);
  if (event.reason) rows.push(`**reason:** ${inlineCode(event.reason)}`);
  return rows.filter(Boolean).join('\n');
}

function messageMarkdown(session = {}, event = {}, preview = {}, options = {}) {
  const type = event.type || 'Event';
  const lines = [`# ${eventTitle(type)}`];
  const mode = notificationMode(options);
  const context = type === 'SessionEnd' ? sessionEndContextLine(session, event) : eventContextLine(session, event);
  if (isSessionLifecycle(type)) {
    if (context) lines.push(context);
    return lines.join('\n');
  }

  if (context) lines.push(context);
  const text = String(preview.text || '').trim();
  if ((type === 'AskPermission' || type === 'CommandSubmitted') && text) {
    lines.push('', '```', text.replaceAll('```', '``\u200b`'), '```');
  } else if (mode === 'direct' && (type === 'FinalAnswer' || type === 'AgentResponse') && text) {
    lines.push('', text);
  } else if (mode === 'direct' && (type === 'FinalAnswer' || type === 'AgentResponse') && options.directFullTextUnavailable === true) {
    lines.push('', 'direct 모드 원문 fullText를 사용할 수 없어서, 이 알림은 원문 그대로 전달하지 못했어.');
  }
  const commands = approvalCommands(event);
  if (commands.length > 0) {
    lines.push('', `선택: ${commands.map((command) => `\`${command}\``).join(' · ')}`);
  }
  return lines.join('\n');
}

export function eventToHermesPayload(session = {}, event = {}, options = {}) {
  const type = event.type || 'Event';
  const displayEvent = type === 'CommandSubmitted'
    ? { ...event, text: stripSyntheticNotificationContext(event.text) }
    : event;
  const eventId = normalizeEventId(session, event);
  const project = session.project || 'unknown';
  const mode = notificationMode(options);
  const directText = String(options.directFullText || '').trim();
  const displayText = mode === 'direct' && directText && (type === 'FinalAnswer' || type === 'AgentResponse')
    ? directText
    : displayEvent.text;
  const payloadEvent = displayText === displayEvent.text ? displayEvent : { ...displayEvent, text: displayText };
  const commandNotificationText = type === 'CommandSubmitted'
    ? limitUserCommandNotificationText(displayText, options)
    : null;
  const previewSource = isSessionLifecycle(type) ? '' : displayText;
  const { text, truncated, length } = commandNotificationText || previewText(previewSource, options);
  const preview = { text, truncated, length };
  const markdownPreview = mode === 'direct' && (type === 'FinalAnswer' || type === 'AgentResponse')
    ? { text: displayText, truncated: false, length: String(displayText || '').length }
    : preview;
  const desiredChannelName = options.desiredChannelName || channelNameForProject(project);
  const mappingStatus = options.channelMappingStatus || (options.channelId ? 'project' : 'missing');
  const channelMissing = options.channelMissing ?? mappingStatus !== 'project';
  const autoCreateChannel = options.autoCreateChannel ?? DEFAULT_AUTO_CREATE_CHANNELS;
  const actions = approvalActions(session, event);
  const discordComponents = approvalDiscordComponents(actions);
  return {
    event_type: type,
    event_name: eventTitle(type),
    event_context_line: eventContextLine(session, event),
    notification_title: eventTitle(type),
    notification_summary: '',
    notification_mode: mode,
    direct_full_text_source: options.directFullTextSource || null,
    direct_full_text_unavailable: options.directFullTextUnavailable === true,
    message_markdown: messageMarkdown(session, payloadEvent, markdownPreview, { ...options, notificationMode: mode }),
    event_id: eventId,
    timestamp: payloadEvent.timestamp || new Date().toISOString(),
    source: payloadEvent.source || null,
    phase: payloadEvent.phase || null,
    project,
    channel_id: options.channelId || null,
    default_channel_id: options.defaultChannelId || null,
    fallback_channel_id: options.defaultChannelId || null,
    desired_channel_name: desiredChannelName,
    channel_mapping_status: mappingStatus,
    channel_missing: channelMissing,
    auto_create_channel: autoCreateChannel,
    bridge_url: options.bridgeUrl || bridgeUrlFromEnv(),
    bridge_session_id: session.bridgeSessionId || null,
    session_id: sessionIdFor(session) || null,
    omx_session_id: session.omxSessionId || null,
    codex_session_id: session.codexSessionId || null,
    thread_id: session.codexThreadId || session.threadId || session.codexSessionId || null,
    discord_thread_id: options.discordThreadId || null,
    discord_thread_name: options.discordThreadName || null,
    discord_parent_channel_id: options.discordParentChannelId || null,
    discord_delivery_target_id: options.channelId || null,
    discord_delivery_target_kind: mappingStatus === 'session-thread' ? 'session-thread' : (options.channelId ? 'channel' : null),
    chunk_delivery_channel_id: options.channelId || null,
    tmux_id: session.tmuxId || null,
    tmux_pane_id: session.tmuxPaneId || null,
    session_context_line: sessionContextLine(session),
    kind: session.kind || null,
    status: session.status || null,
    duration_ms: payloadEvent.durationMs ?? null,
    duration: payloadEvent.durationMs == null ? null : formatDuration(payloadEvent.durationMs),
    reason: payloadEvent.reason || null,
    text_preview: text,
    user_prompt_text: type === 'CommandSubmitted' ? String(commandNotificationText?.text || '') : null,
    user_command_text: type === 'CommandSubmitted' ? String(commandNotificationText?.text || '') : null,
    user_prompt_text_truncated: type === 'CommandSubmitted' ? commandNotificationText?.truncated === true : null,
    user_command_text_truncated: type === 'CommandSubmitted' ? commandNotificationText?.truncated === true : null,
    user_command_text_original_length: type === 'CommandSubmitted' ? commandNotificationText?.length ?? 0 : null,
    text_length: length,
    text_truncated: truncated,
    reply_options: approvalCommands(event),
    approval_required: type === 'AskPermission',
    approval_actions: actions,
    actions,
    discord_components: discordComponents,
    component_actions: actions.map((action) => ({
      custom_id: action.discord_component?.custom_id || null,
      action_id: action.action_id,
      kind: 'approval',
      label: action.label,
      endpoint: action.endpoint,
      body: action.body,
      requires_confirmation: action.discord_component?.requires_confirmation === true,
    })),
    read_endpoints: session.bridgeSessionId ? {
      session: `/sessions/${encodeURIComponent(session.bridgeSessionId)}`,
      state: `/sessions/${encodeURIComponent(session.bridgeSessionId)}/state`,
      events: `/sessions/${encodeURIComponent(session.bridgeSessionId)}/events`,
      idle_latest: `/sessions/${encodeURIComponent(session.bridgeSessionId)}/idle/latest`,
      interactions: `/sessions/${encodeURIComponent(session.bridgeSessionId)}/interactions`,
      commands: `/sessions/${encodeURIComponent(session.bridgeSessionId)}/commands`,
    } : null,
    channel_update_endpoint: `/projects/${encodeURIComponent(project)}/channel`,
  };
}

export function buildHermesWebhookRequest(payload, options = {}) {
  const body = JSON.stringify(payload);
  const secret = Object.prototype.hasOwnProperty.call(options, 'secret')
    ? options.secret
    : process.env.BRIDGE_HERMES_WEBHOOK_SECRET || '';
  const headers = {
    'content-type': 'application/json',
    'X-GitHub-Event': payload.event_type || 'Event',
    'X-Request-ID': payload.event_id || `${Date.now()}`,
  };
  if (secret) {
    headers['X-Hub-Signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  return { body, headers };
}

async function resolveHermesDiscordThreadTarget(session = {}, channel = {}, channelMap = {}, options = {}) {
  if (!channel.channelId && options.requireChannel === false) {
    return { ok: true, channelId: null, map: null, thread: null };
  }

  if (!autoCreateDiscordThreads(options)) {
    return { ok: true, channelId: channel.channelId, map: null, thread: null };
  }

  const mapped = discordThreadForSession(session, channelMap, options);
  if (mapped.threadId && (!mapped.channelId || mapped.channelId === channel.channelId)) {
    return { ok: true, channelId: mapped.threadId, map: null, thread: mapped };
  }
  if (mapped.threadId) {
    return {
      ok: false,
      reason: 'mapped-session-thread-parent-mismatch',
      channelId: null,
      map: null,
      thread: mapped,
    };
  }

  if (!channel.channelId) {
    return { ok: false, reason: 'missing-parent-channel-id', channelId: null, map: null, thread: null };
  }

  if (!shouldCreateMissingSessionThread(options.event, { ...options, session })) {
    return missingSessionThreadTarget('missing-session-thread');
  }

  const latestMap = await readProjectChannelMap(options);
  const latestMapped = discordThreadForSession(session, latestMap, options);
  if (latestMapped.threadId && (!latestMapped.channelId || latestMapped.channelId === channel.channelId)) {
    return { ok: true, channelId: latestMapped.threadId, map: latestMap, thread: latestMapped };
  }
  if (latestMapped.threadId) {
    return {
      ok: false,
      reason: 'mapped-session-thread-parent-mismatch',
      channelId: null,
      map: latestMap,
      thread: latestMapped,
    };
  }

  const desiredThreadName = discordThreadNameForSession(session, options);
  const lookup = await ensureDiscordThreadByName(channel.channelId, desiredThreadName, {
    ...options,
    createMissingDiscordThread: options.createMissingDiscordThread !== false,
  });
  if (!lookup.ok || !lookup.threadId) {
    return {
      ok: false,
      reason: lookup.reason || 'discord-thread-unavailable',
      channelId: null,
      map: null,
      thread: null,
      lookup,
    };
  }

  const update = await updateSessionDiscordThread(session, {
    project: session.project,
    parentChannelId: channel.channelId,
    threadId: lookup.threadId,
    threadName: lookup.threadName || lookup.desiredThreadName || desiredThreadName,
  }, options);
  if (!update.ok) {
    return {
      ok: false,
      reason: update.error || 'session-thread-map-update-failed',
      channelId: null,
      map: null,
      thread: null,
      lookup,
      update,
    };
  }

  return {
    ok: true,
    channelId: update.threadId,
    map: update.map,
    thread: {
      key: update.key,
      threadId: update.threadId,
      channelId: update.parentChannelId,
      threadName: update.threadName,
      mappingStatus: 'session-thread',
      created: lookup.created === true,
    },
    lookup,
    update,
  };
}

async function directFullTextForFinalAnswer(session = {}, event = {}, options = {}) {
  const mode = notificationMode(options);
  if (mode !== 'direct') return {};
  if (event.type !== 'FinalAnswer' && event.type !== 'AgentResponse') return {};
  let eventText = '';
  try {
    eventText = String(await hydrateEventBodyText(event, options) || '').trim();
  } catch (error) {
    return {
      directFullTextUnavailable: true,
      directFullTextSource: 'event-body:unavailable',
      directFullTextError: error?.message || String(error),
    };
  }
  if (eventText) {
    return { directFullText: eventText, directFullTextSource: event.bodyRef || event.body_ref ? 'event-body:spool' : 'event:text' };
  }
  if (!session.sessionLogPath) {
    return { directFullTextUnavailable: true };
  }
  try {
    const log = await readCodexLog(session.sessionLogPath);
    const messageId = /(?:^|:)(message-\d+)$/.exec(String(event.eventId || ''))?.[1] || null;
    if (messageId) {
      const message = (log.messages || [])
        .find((candidate) => candidate.id === messageId && candidate.role === 'assistant');
      const text = String(message?.text || '').trim();
      if (text) {
        return {
          directFullText: text,
          directFullTextSource: 'codex-log:event-message-id',
        };
      }
    }
    return { directFullTextUnavailable: true };
  } catch {
    return { directFullTextUnavailable: true };
  }
}

async function postHermesWebhook(webhookUrl, payload, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable for Hermes webhook sink');
  const request = buildHermesWebhookRequest(payload, options);
  const res = await fetchFn(webhookUrl, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const status = Number.parseInt(res.status, 10) || 0;
    throw new HermesWebhookError(`Hermes webhook failed: ${status || 'unknown'} ${body}`.trim(), {
      status,
      body,
      ...classifyHermesWebhookHttpFailure(status),
    });
  }
}

class HermesWebhookError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HermesWebhookError';
    this.status = details.status || null;
    this.body = details.body || '';
    this.category = details.category || 'unknown';
    this.retryable = details.retryable !== false;
  }
}

function classifyHermesWebhookHttpFailure(status) {
  if (status >= 500 || status === 408 || status === 429) {
    return { category: 'gateway-disconnected-retryable', retryable: true };
  }
  if (status >= 400) {
    return { category: 'permanent-http', retryable: false };
  }
  return { category: 'unknown-http', retryable: true };
}

function classifyHermesWebhookException(error = {}) {
  if (error instanceof HermesWebhookError) {
    return {
      category: error.category,
      retryable: error.retryable !== false,
    };
  }
  return {
    category: error?.name === 'AbortError' ? 'gateway-timeout-retryable' : 'gateway-disconnected-retryable',
    retryable: true,
  };
}

async function postDiscordChannelMessage(channelId, content, options = {}) {
  const token = discordBotToken(options);
  if (!token) throw new Error('Discord bot token is required for channel delivery');
  const text = String(content || '');
  if (text.length > DISCORD_SAFE_MESSAGE_CHARS) {
    throw new Error(`Discord message exceeds safe limit: ${text.length}/${DISCORD_SAFE_MESSAGE_CHARS}`);
  }
  const fetchFn = options.discordFetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable for Discord channel delivery');
  const apiBase = options.discordApiBase || 'https://discord.com/api/v10';
  const res = await fetchFn(`${apiBase}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: text, allowed_mentions: options.allowedMentions || { parse: [] } }),
  });
  if (!res?.ok) {
    const body = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
    throw new Error(`Discord channel message failed: ${res?.status || 'unknown'} ${body}`.trim());
  }
}


async function postDeliveryFailureAlert(channelId, session = {}, event = {}, reason = 'unknown', options = {}) {
  if (!channelId || !discordBotToken(options)) return { ok: false, reason: 'missing-alert-channel-or-bot-token' };
  try {
    await postDiscordChannelMessage(channelId, deliveryFailureAlertMessage(session, event, reason, {
      maxChars: DISCORD_SAFE_MESSAGE_CHARS,
    }), {
      ...options,
      allowedMentions: { parse: [] },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

function isDirectFinalAnswerDiscordDelivery(event = {}, target = {}, options = {}) {
  if (notificationMode(options) !== 'direct') return false;
  if (event.type !== 'FinalAnswer' && event.type !== 'AgentResponse') return false;
  if (!target.channelId || !discordBotToken(options)) return false;
  if (target.thread && target.thread.mappingStatus !== 'session-thread') return false;
  return true;
}

async function deliverDirectPayloadsToDiscord(target = {}, chunkPayloads = [], options = {}) {
  if (!target.channelId) {
    throw new Error('Direct FinalAnswer delivery requires a Discord target channel');
  }
  if (!discordBotToken(options)) {
    throw new Error('Direct FinalAnswer delivery requires a Discord bot token');
  }
  for (const chunkPayload of chunkPayloads) {
    await postDiscordChannelMessage(target.channelId, chunkPayload.message_markdown, options);
  }
}

async function autoResolveProjectChannel(project, channel, options = {}) {
  if (channel.mappingStatus === 'project' || !channel.autoCreateChannel) {
    return { channel, mapped: false, reason: 'not-needed' };
  }
  if (options.autoResolveProjectChannels === false) {
    return { channel, mapped: false, reason: 'disabled' };
  }

  const lookup = await ensureDiscordTextChannelByName(channel.desiredChannelName || project, {
    ...options,
    defaultChannelId: channel.defaultChannelId,
    fallbackChannelId: channel.defaultChannelId,
    createMissingDiscordChannel: channel.autoCreateChannel && options.createMissingDiscordChannel !== false,
  });
  if (!lookup.ok || !lookup.channelId) {
    return { channel, mapped: false, reason: lookup.reason || 'not-found', lookup };
  }

  const update = await updateProjectChannel(project, {
    channelId: lookup.channelId,
    channelName: lookup.channelName || lookup.desiredChannelName,
  }, options);
  if (!update.ok) {
    return { channel, mapped: false, reason: update.error || 'map-update-failed', lookup, update };
  }

  const hermesConfig = await ensureHermesDiscordChannelAllowed(update.channelId, options);
  const hermesGateway = await waitForHermesGatewayAfterRestart(hermesConfig, options.webhookUrl, options);

  if (options.auditProjectChannelMapping !== false) {
    await appendAudit('project.channel_auto_mapped', {
      project: update.project,
      channelId: update.channelId,
      channelName: update.channelName,
      desiredChannelName: lookup.desiredChannelName,
      created: lookup.created === true,
      hermesConfigUpdated: hermesConfig.changed === true,
      hermesGatewayRestarted: hermesConfig.restart?.restarted === true,
      hermesGatewayWaited: hermesGateway.waited === true,
    }, options);
  }

  return {
    channel: resolveProjectChannel(project, update.map, options),
    mapped: true,
    reason: null,
    lookup,
    update,
    hermesConfig,
    hermesGateway,
    map: update.map,
  };
}

async function ensureHermesAllowlistForResolvedChannel(channel, options = {}) {
  if (!channel.channelId || channel.mappingStatus !== 'project') {
    return { ok: true, changed: false, reason: 'not-project-channel' };
  }
  return ensureHermesDiscordChannelAllowed(channel.channelId, options);
}

export async function pollHermesWebhookNotifications(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const webhookUrl = Object.prototype.hasOwnProperty.call(options, 'webhookUrl')
    ? options.webhookUrl
    : process.env.BRIDGE_HERMES_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, reason: 'missing-webhook-url', sent: 0 };

  const bootSince = options.bootSince || new Date().toISOString();
  const skipBefore = options.replay === true ? null : bootSince;
  const path = options.statePath || statePath(projectRoot, options);
  const state = await readState(path);
  const sentIds = new Set(state.sentEventIds);
  const index = await openEventIndex(projectRoot, options);
  try {
    const indexedLegacySentIds = eventIdsInIndex(index.db, sentIds);
    markLegacySentDeliveries(index.db, indexedLegacySentIds, 'hermes');
    const sessions = (await listSessions({
      ...options,
      projectRoot,
      discoverTmuxProjectRoots: options.discoverTmuxProjectRoots ?? true,
      includeUnmappedCodexLogs: includeUnmappedCodexLogs(options),
      includeCodexOnlySessions: options.allowCodexOnlySessionMonitoring === true,
      unmappedCodexLogLimit: options.unmappedCodexLogLimit ?? 10,
      sessionScanLimit: sessionScanLimit(options),
    })).filter((session) => shouldPollSession(session, options));
    const liveCodexOwners = codexOwnerSessions(sessions);
    compactEventIndexIfNeeded(index.db, options);
    let channelMap = await loadProjectChannelMap(options);
    const maxEventsPerPoll = Number.parseInt(process.env.BRIDGE_HERMES_WEBHOOK_MAX_EVENTS_PER_POLL || `${options.maxEventsPerPoll || DEFAULT_MAX_EVENTS_PER_POLL}`, 10);
    const allowedEventTypes = options.eventTypes || eventTypesFromEnv();
    const priorDeliveryBlocks = priorTerminalLifecycleDeliveryBlocks(options);
    let sent = 0;
    let skippedNoChannel = 0;
    const indexItems = [];
    const skippedIndexRepairItems = [];
    let terminalLifecycleBlocksNeeded = false;
    const cursorOptions = shouldUseCodexLogCursorForPoll(allowedEventTypes)
      ? options
      : { ...options, useCodexLogCursor: false };
    const useGjcLogCursor = shouldUseGjcLogCursorForPoll(allowedEventTypes, options);
    const gjcLogCursorUpdates = [];

    for (const session of sessions) {
      const gjcCursorMode = useGjcLogCursor && isGjcSession(session) && isActiveGjcSession(session) && Boolean(session.sessionLogPath);
      let routedEvents;
      try {
        routedEvents = await routeSessionEvents(session, {
          ...options,
          projectRoot: session.omxProjectRoot || projectRoot,
          bridgeProjectRoot: projectRoot,
          pollGjcLogCursorMode: gjcCursorMode,
          gjcLogCursor: gjcCursorMode ? getGjcLogCursor(index.db, session.sessionLogPath) : null,
          gjcLogCursorUpdates,
        });
      } catch (error) {
        if (gjcCursorMode && error?.code === 'GJC_LOG_MALFORMED_JSONL') {
          recordGjcLogCursorError(index.db, session.sessionLogPath, error);
          console.error('[bridge-hermes-webhook-sink]', `GJC cursor parse failed for ${session.sessionLogPath}: ${error.message}`);
        }
        throw error;
      }
      const cursorFilteredEvents = filterEventsByCodexLogCursor(index.db, session, routedEvents, cursorOptions);
      const events = await Promise.all(cursorFilteredEvents.map((event) => spoolEventBodyIfNeeded(event, options)));
      for (const event of events) {
        const forward = shouldForwardToHermes(event, { ...options, eventTypes: allowedEventTypes }, session);
        const gjc = isGjcSession(session);
        if (forward && gjc && isTerminalEvent(event)) terminalLifecycleBlocksNeeded = true;
        if (!forward && !(gjc && eventMatchesPriorDeliveryBlocker(event, priorDeliveryBlocks))) continue;
        const eventId = normalizeEventId(session, event);
        if (sentIds.has(eventId) && !indexedLegacySentIds.has(eventId)) continue;
        const eventMs = Date.parse(event.timestamp || '');
        const skipMs = Date.parse(skipBefore || '');
        const indexItem = { session, event: { ...event, eventId }, eventId };
        if (
          skipBefore
          && Number.isFinite(eventMs)
          && Number.isFinite(skipMs)
          && eventMs < skipMs
          && !shouldRefreshSkippedEvent(event, session)
        ) {
          skippedIndexRepairItems.push(indexItem);
          continue;
        }
        indexItems.push(indexItem);
      }
    }

    if (skippedIndexRepairItems.length > 0) {
      const existingSkippedIds = eventIdsInIndex(index.db, skippedIndexRepairItems.map((item) => item.eventId));
      indexItems.push(...skippedIndexRepairItems.filter((item) => existingSkippedIds.has(item.eventId)));
    }
    upsertEvents(index.db, indexItems);
    for (const update of gjcLogCursorUpdates) advanceGjcLogCursor(index.db, update.cursor);
    markSkippedBeforeDeliveries(index.db, 'hermes', {
      ...options,
      eventTypes: allowedEventTypes,
      skipBefore,
    });
    const pending = pendingEvents(index.db, 'hermes', {
      eventTypes: allowedEventTypes,
      priorDeliveryBlocks: terminalLifecycleBlocksNeeded ? priorDeliveryBlocks : [],
      limit: Math.max(1, maxEventsPerPoll) * 10,
      skipBefore,
    });

    pending.sort((a, b) => eventSortKey(a.event) - eventSortKey(b.event));

    for (const pendingItem of pending) {
      let { session, event, eventId } = pendingItem;
      const currentOwnerSession = currentOwnerSessionForPendingEvent(session, event, eventId, liveCodexOwners);
      if (currentOwnerSession !== session) {
        session = currentOwnerSession;
        upsertEvents(index.db, [{ session, event: { ...event, eventId }, eventId }]);
      }
      if (event.source === 'codex-log' && await isAuxiliaryCodexSession(session)) {
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, 'hermes');
        continue;
      }
      if (!shouldPollSession(session, options)) {
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, 'hermes');
        continue;
      }
      let channel = resolveProjectChannel(session.project, channelMap, options);
      if (channel.mappingStatus !== 'project' && channel.autoCreateChannel) {
        const resolved = await autoResolveProjectChannel(session.project, channel, { ...options, projectRoot, webhookUrl });
        channel = resolved.channel;
        if (resolved.map) channelMap = resolved.map;
      }
      if (channel.mappingStatus === 'project') {
        const hermesConfig = await ensureHermesAllowlistForResolvedChannel(channel, { ...options, projectRoot });
        await waitForHermesGatewayAfterRestart(hermesConfig, webhookUrl, options);
      }
      if (!channel.channelId && options.requireChannel !== false) {
        skippedNoChannel += 1;
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, 'hermes');
        continue;
      }
      const target = await resolveHermesDiscordThreadTarget(session, channel, channelMap, { ...options, projectRoot, event });
      if (!target.ok || (!target.channelId && options.requireChannel !== false)) {
        const reason = target.reason || 'unknown';
        if (target.suppressDelivery === true) {
          skippedNoChannel += 1;
          const alertResult = await postDeliveryFailureAlert(channel.channelId, session, event, reason, options);
          const error = new Error(deliveryFailureErrorMessage(event.type, alertResult));
          markDeliveryFailed(index.db, eventId, 'hermes', error, { ...options, maxAttempts: 1 });
          console.error('[bridge-hermes-webhook-sink]', `delivery dead for ${eventId}: ${error.message}`);
          continue;
        }
        const alertResult = await postDeliveryFailureAlert(channel.channelId, session, event, reason, options);
        if (!alertResult.ok) {
          console.error('[bridge-hermes-webhook-sink]', `delivery failure alert failed for ${eventId}: ${alertResult.reason}`);
        }
        markDeliveryFailed(index.db, eventId, 'hermes', new Error(`Discord session thread unavailable: ${reason}`));
        continue;
      }
      if (target.map) channelMap = target.map;
      const directFullText = await directFullTextForFinalAnswer(session, event, options);
      const payload = eventToHermesPayload(session, event, {
        ...options,
        ...directFullText,
        channelId: target.channelId,
        defaultChannelId: channel.defaultChannelId,
        desiredChannelName: channel.desiredChannelName,
        channelMappingStatus: target.thread?.mappingStatus || channel.mappingStatus,
        channelMissing: channel.channelMissing,
        autoCreateChannel: channel.autoCreateChannel,
        discordThreadId: target.thread?.threadId || null,
        discordThreadName: target.thread?.threadName || null,
        discordParentChannelId: target.thread?.channelId || channel.channelId || null,
        bridgeUrl: options.bridgeUrl || process.env.BRIDGE_PUBLIC_URL || bridgeUrlFromEnv(),
      });
      let directDiscordDelivery = false;
      try {
        const chunkPayloads = hermesPayloadNotificationChunks(payload, options);
        directDiscordDelivery = isDirectFinalAnswerDiscordDelivery(event, target, options);
        markDeliveryPrepared(index.db, eventId, 'hermes', {
          transport: directDiscordDelivery ? 'discord-channel' : 'hermes-webhook',
          webhookUrl: directDiscordDelivery ? null : webhookUrl,
          channelId: target.channelId,
          chunkCount: chunkPayloads.length,
          chunks: chunkPayloads,
          event: {
            eventId,
            type: event.type,
            timestamp: event.timestamp,
          },
          session: {
            sessionId: session.omxSessionId || session.bridgeSessionId || session.codexSessionId || session.threadId || null,
            codexSessionId: session.codexSessionId || null,
            tmuxId: session.tmuxId || null,
            project: session.project || null,
          },
        }, {
          targetChannelId: target.channelId,
          targetThreadId: target.thread?.threadId || null,
          targetThreadName: target.thread?.threadName || null,
          targetKind: target.thread?.mappingStatus || (target.channelId ? 'channel' : null),
        });
        if (directDiscordDelivery) {
          await deliverDirectPayloadsToDiscord(target, chunkPayloads, options);
        } else {
          for (const chunkPayload of chunkPayloads) {
            await postHermesWebhook(webhookUrl, chunkPayload, options);
          }
        }
        markDeliverySent(index.db, eventId, 'hermes', {
          targetChannelId: target.channelId,
          targetThreadId: target.thread?.threadId || null,
          targetThreadName: target.thread?.threadName || null,
          targetKind: target.thread?.mappingStatus || (target.channelId ? 'channel' : null),
        });
      } catch (error) {
        const classification = directDiscordDelivery
          ? { category: 'discord-direct-delivery-retryable', retryable: true }
          : classifyHermesWebhookException(error);
        const failureError = new Error(`${classification.category}: ${error?.message || error}`);
        markDeliveryFailed(index.db, eventId, 'hermes', failureError, classification.retryable
          ? { ...options, maxAttempts: hermesWebhookRetryMaxAttempts(options) }
          : { ...options, maxAttempts: 1 });
        throw error;
      }
      sentIds.add(eventId);
      sent += 1;
      if (sent >= Math.max(1, maxEventsPerPoll)) break;
    }

    await writeState(path, sentIds);
    return { ok: true, sent, skippedNoChannel };
  } finally {
    closeEventIndex(index);
  }
}

export function startHermesWebhookSink(options = {}) {
  const webhookUrl = options.webhookUrl || process.env.BRIDGE_HERMES_WEBHOOK_URL;
  const envEnabled = (process.env.BRIDGE_HERMES_WEBHOOK_ENABLED || '').toLowerCase() === 'true';
  const enabled = options.enabled ?? envEnabled;
  if (!enabled || !webhookUrl) return { started: false, reason: enabled ? 'missing-webhook-url' : 'disabled' };

  const intervalMs = positiveInt(process.env.BRIDGE_HERMES_WEBHOOK_INTERVAL_MS || options.intervalMs, DEFAULT_POLL_INTERVAL_MS);
  const bootSince = options.bootSince || new Date().toISOString();
  let running = false;
  let stopped = false;

  const tick = async (tickOptions = {}) => {
    if (running || stopped) {
      return { ok: false, reason: stopped ? 'stopped' : 'busy', sent: 0 };
    }
    running = true;
    try {
      return await pollHermesWebhookNotifications({
        ...options,
        ...tickOptions,
        webhookUrl,
        bootSince: tickOptions.bootSince || bootSince,
      });
    } catch (error) {
      console.error('[bridge-hermes-webhook-sink]', error?.message || error);
      return { ok: false, reason: 'poll-error', error: error?.message || String(error), sent: 0 };
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, Math.max(MIN_POLL_INTERVAL_MS, intervalMs));
  void tick();
  return {
    started: true,
    flush: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
