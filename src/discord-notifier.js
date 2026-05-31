import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAuxiliaryCodexSession } from './codex-log.js';
import { listSessions } from './control-plane/registry.js';
import { routeSessionEvents } from './control-plane/event-router.js';
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
} from './control-plane/event-index.js';
import { ensureDirFor } from './jsonl.js';
import { formatDuration } from './duration.js';
import { bridgeStatePath } from './bridge-paths.js';
import { stripSyntheticNotificationContext } from './synthetic-context.js';
import {
  discordBotToken,
  discordThreadNameForSession,
  ensureDiscordTextChannelByName,
  ensureDiscordThreadByName,
} from './discord-channels.js';
import {
  discordThreadForSession,
  readProjectChannelMap,
  resolveProjectChannel,
  updateProjectChannel,
  updateSessionDiscordThread,
} from './project-channels.js';
import { userCommandNotificationChunks, userCommandNotificationMaxChars } from './notification-text.js';
import { normalizeEventId } from './event-ids.js';
import { codexOwnerSessions, currentOwnerSessionForPendingEvent } from './session-owner.js';
import { missingSessionThreadTarget, shouldCreateMissingSessionThread } from './session-thread-target.js';
import { deliveryFailureAlertMessage, deliveryFailureErrorMessage } from './delivery-failure-alert.js';
import { ensureHermesDiscordChannelAllowed, waitForHermesGatewayAfterRestart } from './hermes-config.js';
import { DISCORD_SAFE_MESSAGE_CHARS, enforceDiscordSafeMessageLimit, truncateText } from './delivery-text.js';

const DEFAULT_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 100;
const DISCORD_SAFE_CONTENT_LIMIT = DISCORD_SAFE_MESSAGE_CHARS;
const SAFE_CHUNK_SIZE = DISCORD_SAFE_CONTENT_LIMIT;
export const FAST_EVENT_TYPES = new Set(['SessionStart', 'SessionLinked', 'SessionEnd', 'CommandSubmitted']);
const DEFAULT_EVENT_TYPES = FAST_EVENT_TYPES;
const DEFAULT_DELIVERY_SINK = 'discord-fast';
const DEFAULT_MAX_EVENTS_PER_POLL = 3;
const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;
const DEFAULT_DISCORD_POST_TIMEOUT_MS = 3000;
const DEFAULT_DISCORD_RATE_LIMIT_INLINE_WAIT_MAX_MS = 1000;
const DEFAULT_FINAL_BLOCK_MS = 10000;
const DEFAULT_TIME_ZONE = 'Asia/Seoul';
const DEFAULT_SESSION_SCAN_LIMIT = 80;

function statePath(projectRoot = process.cwd(), options = {}) {
  return process.env.BRIDGE_NOTIFY_STATE_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-discord-notifier.json', options)
      : join(projectRoot, '.codex', 'state', 'bridge-discord-notifier.json'));
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

function deliverySink(options = {}) {
  return String(options.deliverySink || process.env.BRIDGE_NOTIFY_DELIVERY_SINK || DEFAULT_DELIVERY_SINK).trim() || DEFAULT_DELIVERY_SINK;
}

function eventTypesFromEnv() {
  const raw = process.env.BRIDGE_NOTIFY_EVENT_TYPES || '';
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? new Set(values) : DEFAULT_EVENT_TYPES;
}

function truthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function deliveryMaxAttempts(options = {}) {
  return positiveInt(
    process.env.BRIDGE_NOTIFY_DELIVERY_MAX_ATTEMPTS
      || process.env.BRIDGE_DELIVERY_MAX_ATTEMPTS
      || process.env.BRIDGE_DELIVERY_RETRY_MAX_ATTEMPTS
      || options.deliveryMaxAttempts
      || options.maxAttempts
      || options.retryMaxAttempts,
    DEFAULT_DELIVERY_MAX_ATTEMPTS,
  );
}

function priorFinalAnswerDeliveryBlocks(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'priorFinalAnswerDeliveryBlocks')
    ? options.priorFinalAnswerDeliveryBlocks
    : process.env.BRIDGE_FINAL_BLOCK;
  if (!truthyEnv(enabled, true)) return [];
  const parsedGraceMs = Number.parseInt(process.env.BRIDGE_FINAL_WAIT_MS ?? options.priorFinalAnswerGraceMs, 10);
  return [{
    sink: options.finalAnswerDeliverySink || process.env.BRIDGE_FINAL_SINK || 'hermes',
    eventTypes: new Set(['FinalAnswer', 'AskPermission']),
    missingDeliveryGraceMs: Number.isFinite(parsedGraceMs) && parsedGraceMs >= 0
      ? parsedGraceMs
      : DEFAULT_FINAL_BLOCK_MS,
  }];
}

function eventMatchesPriorDeliveryBlocker(event = {}, blocks = []) {
  return blocks.some((block) => [...(block?.eventTypes || [])].includes(event.type));
}

function discordPostTimeoutMs(options = {}) {
  return positiveInt(
    process.env.DISCORD_POST_TIMEOUT_MS
      || process.env.BRIDGE_NOTIFY_POST_TIMEOUT_MS
      || options.discordPostTimeoutMs
      || options.postTimeoutMs,
    DEFAULT_DISCORD_POST_TIMEOUT_MS,
  );
}

function discordRateLimitInlineWaitMaxMs(options = {}) {
  return positiveInt(
    process.env.DISCORD_429_MAX_WAIT_MS
      || options.discordRateLimitInlineWaitMaxMs
      || options.rateLimitInlineWaitMaxMs,
    DEFAULT_DISCORD_RATE_LIMIT_INLINE_WAIT_MAX_MS,
  );
}

function discordSleepFn(options = {}) {
  return options.discordSleepFn || options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function includeUnmappedCodexLogs(options = {}) {
  return options.includeUnmappedCodexLogs
    ?? truthyEnv(process.env.BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS, false);
}

function sessionScanLimit(options = {}) {
  return positiveInt(
    process.env.BRIDGE_NOTIFY_SESSION_SCAN_LIMIT
      || process.env.BRIDGE_SESSION_SCAN_LIMIT
      || options.sessionScanLimit,
    DEFAULT_SESSION_SCAN_LIMIT,
  );
}

function suppressTeamWorkerNotifications(options = {}) {
  if (options.allowTeamWorkerNotifications === true) return false;
  const explicit = options.suppressTeamWorkerNotifications
    ?? process.env.BRIDGE_NOTIFY_SUPPRESS_TEAM_WORKER_NOTIFICATIONS
    ?? process.env.BRIDGE_SUPPRESS_TEAM_WORKER_NOTIFICATIONS;
  return truthyEnv(explicit, true);
}

function autoCreateDiscordThreads(options = {}) {
  return options.autoCreateDiscordThreads
    ?? truthyEnv(process.env.BRIDGE_DISCORD_AUTO_CREATE_THREADS, false);
}

function normalizeDiscordUserIds(values = []) {
  return [...new Set(values
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter((value) => /^\d{5,32}$/.test(value)))];
}

function sessionStartMentionUserIds(options = {}) {
  return normalizeDiscordUserIds([
    options.discordMentionUsers,
    options.discordMentionUser,
    options.mentionUsers,
    options.mentionUser,
    options.discordSessionStartMentionUserIds,
    options.discordSessionStartMentionUserId,
    process.env.BRIDGE_DISCORD_MENTION_USERS,
    process.env.BRIDGE_DISCORD_MENTION_USER,
    process.env.BRIDGE_DISCORD_SESSION_START_MENTION_USER_IDS,
    process.env.BRIDGE_DISCORD_SESSION_START_MENTION_USER_ID,
  ]);
}

function sessionStartMentionMarkdown(options = {}) {
  const userIds = sessionStartMentionUserIds(options);
  return userIds.map((userId) => `<@${userId}>`).join(' ');
}

function allowedMentionsForEvent(event = {}, options = {}) {
  if (event.type === 'SessionStart') {
    const users = sessionStartMentionUserIds(options);
    if (users.length > 0) return { users };
  }
  return { parse: [] };
}

function shouldPollSession(session = {}, options = {}) {
  if (session.kind === 'codex-team' && suppressTeamWorkerNotifications(options)) return false;
  if (session.isAuxiliaryCodexLog === true && session.hasBridgeLifecycle !== true) return false;
  if (isNativeOnlyLifecyclePollution(session)) return false;
  if (session.hasBridgeLifecycle === false && options.allowCodexOnlySessionMonitoring !== true) return false;
  if (options.allowUnmappedCodexLogNotifications === true || includeUnmappedCodexLogs(options)) return true;
  return session.hasBridgeLifecycle !== false;
}

function isNativeOnlyLifecyclePollution(session = {}) {
  if (session.lifecycleOwner) return false;
  const lifecycleSessionId = session.lifecycleSessionId || session.session_id;
  const codexSessionId = session.codexSessionId || session.codex_session_id || session.threadId || session.thread_id;
  return session.hasBridgeLifecycle === true
    && lifecycleSessionId
    && codexSessionId
    && lifecycleSessionId === codexSessionId;
}

function formatEventTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (Number.isNaN(date.getTime())) return truncateText(timestamp, 120);
  const timeZone = process.env.BRIDGE_NOTIFY_TIME_ZONE || DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return [value('dayPeriod'), `${value('hour')}:${value('minute')}:${value('second')}`].filter(Boolean).join(' ');
}

function inlineCode(value) {
  return `\`${String(value || '').replaceAll('`', '\\`')}\``;
}

function sessionIdFor(session = {}) {
  return session.bridgeSessionId
    || session.lifecycleSessionId
    || session.codexThreadId
    || session.codexSessionId
    || session.threadId
    || session.tmuxPaneId
    || session.tmuxId;
}

function threadIdFor(session = {}) {
  return session.codexThreadId || session.codexSessionId;
}

function tmuxProjectMarkdown(session = {}) {
  const parts = [];
  if (session.tmuxId) parts.push(`**tmux:** ${inlineCode(truncateText(session.tmuxId, 120))}`);
  if (session.project) parts.push(`**project:** ${inlineCode(truncateText(session.project, 120))}`);
  return parts.join(' | ');
}

function startMetaMarkdown(session = {}, event = {}) {
  const rows = [];
  const sessionId = sessionIdFor(session);
  const threadId = threadIdFor(session);
  if (sessionId) rows.push(`**session:** ${inlineCode(truncateText(sessionId, 120))}`);
  if (threadId && threadId !== sessionId) rows.push(`**thread:** ${inlineCode(truncateText(threadId, 120))}`);
  const tmuxProject = tmuxProjectMarkdown(session);
  if (tmuxProject) rows.push(tmuxProject);
  if (event.timestamp) rows.push(`**time:** ${formatEventTime(event.timestamp)}`);
  return rows.join('\n');
}

function footerMarkdown(session = {}) {
  const rows = [];
  const sessionId = sessionIdFor(session);
  const tmuxProject = tmuxProjectMarkdown(session);
  if (sessionId) rows.push(`**session:** ${inlineCode(truncateText(sessionId, 120))}`);
  if (tmuxProject) rows.push(tmuxProject);
  return rows.join('\n');
}

function sessionEndMetaMarkdown(session = {}, event = {}) {
  const rows = [];
  const sessionId = sessionIdFor(session);
  if (sessionId) rows.push(`**session:** ${inlineCode(truncateText(sessionId, 120))}`);
  rows.push(`**duration:** ${formatDuration(event.durationMs)}`);
  const tmuxProject = tmuxProjectMarkdown(session);
  if (tmuxProject) rows.push(tmuxProject);
  rows.push(`**reason:** ${event.reason || 'session_exit'}`);
  return rows.join('\n');
}

function eventTitle(type) {
  if (type === 'SessionStart') return '# Session Start';
  if (type === 'SessionLinked') return '# Session Linked';
  if (type === 'SessionIdle') return '# Session Idle';
  if (type === 'SessionEnd') return '# Session Ended';
  if (type === 'AskPermission') return '# Ask Permission';
  if (type === 'CommandSubmitted') return '# User Command';
  if (type === 'FinalAnswer' || type === 'AgentResponse') return '# Session Idle';
  if (type === 'Commentary') return '# Commentary';
  return `# ${type || 'Event'}`;
}

function escapeCodeFence(text) {
  return String(text || '').replaceAll('```', '``\u200b`');
}

function codeBlock(text) {
  return `\`\`\`\n${escapeCodeFence(text)}\n\`\`\``;
}

function isMarkdownTableSeparator(line = '') {
  const cells = String(line).trim().split('|').map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTableRow(line = '') {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function renderPlainTextTable(rows = []) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, [...cell].length);
    });
  }
  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] || 0, ' ')).join('  '))
    .join('\n');
}

function normalizeMarkdownTablesForDiscord(text) {
  const lines = String(text || '').split('\n');
  const output = [];
  for (let index = 0; index < lines.length;) {
    const header = parseMarkdownTableRow(lines[index]);
    const separator = parseMarkdownTableRow(lines[index + 1]);
    if (header && separator && isMarkdownTableSeparator(lines[index + 1])) {
      const rows = [header];
      index += 2;
      while (index < lines.length) {
        const row = parseMarkdownTableRow(lines[index]);
        if (!row) break;
        rows.push(row);
        index += 1;
      }
      output.push(renderPlainTextTable(rows));
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return output.join('\n');
}

function usesContinuationChunkStyle(type) {
  return type === 'SessionIdle' || type === 'FinalAnswer' || type === 'AgentResponse';
}

function chunkOrdinal(index, total) {
  return total > 1 ? `(${index + 1}/${total})` : '';
}

function chunkPrefix(type, basePrefix, index, total) {
  if (total <= 1 || !usesContinuationChunkStyle(type)) return basePrefix;

  if (index > 0) return '';

  if (type === 'SessionIdle') {
    return `${eventTitle(type)}\n\n**Recent output:**\n`;
  }

  return `${eventTitle(type)}\n\n`;
}

function chunkSuffix(type, baseSuffix, index, total) {
  if (total <= 1 || !usesContinuationChunkStyle(type)) return baseSuffix;
  return `${index === 0 ? baseSuffix : ''}\n\n${chunkOrdinal(index, total)}`;
}

export function eventToDiscordChunks(session, event, options = {}) {
  const type = event.type || 'Event';
  const timestamp = event.timestamp || new Date().toISOString();
  const rawText = type === 'CommandSubmitted' ? stripSyntheticNotificationContext(event.text) : event.text;
  const text = normalizeMarkdownTablesForDiscord(String(rawText || '').trim()) || '(empty)';
  const normalizedEvent = { ...event, timestamp };
  const footer = footerMarkdown(session);
  let prefix;
  let suffix = '';

  if (type === 'SessionStart') {
    const meta = startMetaMarkdown(session, normalizedEvent);
    const mention = sessionStartMentionMarkdown(options);
    prefix = [mention || null, eventTitle(type), meta || null].filter(Boolean).join('\n');
    return [`${prefix}\n`].map((content) => enforceDiscordSafeMessageLimit(content));
  }

  if (type === 'SessionLinked') {
    const meta = startMetaMarkdown(session, normalizedEvent);
    const content = [
      eventTitle(type),
      meta || null,
      text && text !== '(empty)' ? `\n${text}` : null,
    ].filter(Boolean).join('\n');
    return [enforceDiscordSafeMessageLimit(content)];
  }

  if (type === 'SessionEnd') {
    const meta = sessionEndMetaMarkdown(session, normalizedEvent);
    const content = [
      eventTitle(type),
      meta || null,
    ].filter(Boolean).join('\n');
    return [enforceDiscordSafeMessageLimit(content)];
  }

  if (type === 'SessionIdle') {
    prefix = `${eventTitle(type)}\n\n**Recent output:**\n`;
    suffix = footer ? `\n\n${footer}` : '';
  } else {
    prefix = `${eventTitle(type)}\n\n`;
    suffix = footer ? `\n\n${footer}` : '';
  }

  const maxBody = Math.max(200, Math.min(SAFE_CHUNK_SIZE, DISCORD_SAFE_CONTENT_LIMIT - prefix.length - suffix.length - 80));

  if (type === 'CommandSubmitted') {
    const limit = userCommandNotificationChunks(text, {
      ...options,
      maxChars: Math.min(maxBody, userCommandNotificationMaxChars(options)),
      notice: `\n\n…\n[알림 잘림: User Command 원문 ${text.length}자 중 최대 3조각까지만 전송했습니다. 전체 원문은 bridge interactions/events에 기록되어 있고 이미 dispatch됐습니다.]`,
    });
    return limit.chunks.map((chunk, index) => {
      const ordinal = chunkOrdinal(index, limit.chunks.length);
      const content = `${index === 0 ? prefix : ''}${codeBlock(chunk || '(empty)')}${index === 0 ? suffix : ''}${ordinal ? `\n\n${ordinal}` : ''}`;
      return enforceDiscordSafeMessageLimit(content);
    });
  }

  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxBody) {
    chunks.push(text.slice(offset, offset + maxBody));
  }
  if (chunks.length === 0) chunks.push('(empty)');

  return chunks.map((chunk, index) => {
    const ordinal = chunkOrdinal(index, chunks.length);
    const part = chunks.length > 1 && !usesContinuationChunkStyle(type) ? `\n${ordinal}` : '';
    const content = `${chunkPrefix(type, prefix, index, chunks.length)}${codeBlock(chunk)}${chunkSuffix(type, suffix, index, chunks.length)}${part}`;
    return enforceDiscordSafeMessageLimit(content);
  });
}

class DiscordPostError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DiscordPostError';
    this.status = details.status || null;
    this.body = details.body || '';
    this.category = details.category || 'unknown';
    this.action = details.action || 'retry';
    this.retryAfterMs = details.retryAfterMs || 0;
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function retryAfterMsFromResponse(res = {}, body = '') {
  const header = headerValue(res.headers, 'retry-after');
  const headerSeconds = Number.parseFloat(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return Math.round(headerSeconds * 1000);
  try {
    const parsed = JSON.parse(body || '{}');
    const seconds = Number.parseFloat(parsed.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  } catch {
    // Non-JSON error bodies are common for mocked or proxy responses.
  }
  return 0;
}

function classifyDiscordHttpFailure(status, retryAfterMs = 0, options = {}) {
  if (status === 429) {
    const inlineMax = discordRateLimitInlineWaitMaxMs(options);
    return retryAfterMs > inlineMax
      ? { category: 'rate-limit-hold', action: 'hold' }
      : { category: 'rate-limit-retry', action: 'retry-after' };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { category: 'permanent-http', action: 'dead' };
  }
  if (status >= 500 || status === 408) {
    return { category: 'transient-http', action: 'retry' };
  }
  if (status >= 400) {
    return { category: 'permanent-http', action: 'dead' };
  }
  return { category: 'unknown-http', action: 'retry' };
}

async function discordPostError(prefix, res, options = {}) {
  const body = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
  const status = Number.parseInt(res?.status, 10) || 0;
  const retryAfterMs = retryAfterMsFromResponse(res, body);
  const classification = classifyDiscordHttpFailure(status, retryAfterMs, options);
  return new DiscordPostError(`${prefix}: ${status || 'unknown'} ${body}`.trim(), {
    status,
    body,
    retryAfterMs,
    ...classification,
  });
}

function classifyDiscordPostException(error = {}) {
  if (error instanceof DiscordPostError) {
    return {
      category: error.category,
      action: error.action,
      retryAfterMs: error.retryAfterMs || 0,
    };
  }
  if (error?.name === 'AbortError' || error?.code === 'discord-post-timeout') {
    return { category: 'timeout', action: 'retry', retryAfterMs: 0 };
  }
  return { category: 'network', action: 'retry', retryAfterMs: 0 };
}

function isoAfterMs(ms) {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

async function fetchWithDiscordTimeout(fetchFn, url, request = {}, options = {}) {
  const timeoutMs = discordPostTimeoutMs(options);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController !== 'function') {
    return fetchFn(url, request);
  }
  const controller = new AbortController();
  const timeoutError = new Error(`Discord post timed out after ${timeoutMs}ms`);
  timeoutError.name = 'AbortError';
  timeoutError.code = 'discord-post-timeout';
  let timeoutId;
  try {
    return await Promise.race([
      fetchFn(url, { ...request, signal: controller.signal }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function postDiscordWebhook(webhookUrl, content, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable for Discord notifier');
  const res = await fetchWithDiscordTimeout(fetchFn, webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: options.allowedMentions || { parse: [] } }),
  }, options);
  if (!res.ok) {
    throw await discordPostError('Discord webhook failed', res, options);
  }
}

async function postDiscordChannelMessage(channelId, content, options = {}) {
  const token = discordBotToken(options);
  if (!token) throw new Error('Discord bot token is required for channel delivery');
  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable for Discord notifier');
  const apiBase = options.discordApiBase || 'https://discord.com/api/v10';
  const res = await fetchWithDiscordTimeout(fetchFn, `${apiBase}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content, allowed_mentions: options.allowedMentions || { parse: [] } }),
  }, options);
  if (!res?.ok) {
    throw await discordPostError('Discord channel message failed', res, options);
  }
}


async function postDeliveryFailureAlert(channelId, session = {}, event = {}, reason = 'unknown', options = {}) {
  if (!channelId) return { ok: false, reason: 'missing-alert-channel' };
  try {
    await postDiscordChannelMessage(channelId, deliveryFailureAlertMessage(session, event, reason, {
      maxChars: DISCORD_SAFE_CONTENT_LIMIT,
    }), {
      ...options,
      allowedMentions: { parse: [] },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

function deliveryFailureAlertChannelId(channel = {}, options = {}) {
  return String(
    options.discordAlertChannelId
      || options.alertChannelId
      || process.env.DISCORD_ALERT_CHANNEL_ID
      || channel?.channelId
      || '',
  ).trim();
}

async function alertDiscordDeliveryDead(channelId, session = {}, event = {}, reason = 'unknown', options = {}) {
  const alertResult = await postDeliveryFailureAlert(channelId, session, event, reason, options);
  if (alertResult.ok) {
    console.error('[bridge-discord-notifier]', `delivery dead alert sent for ${event.eventId || 'unknown-event'}: ${reason}`);
  } else {
    console.error('[bridge-discord-notifier]', `delivery dead alert unavailable for ${event.eventId || 'unknown-event'}: ${alertResult.reason}; original reason: ${reason}`);
  }
  return alertResult;
}

async function postDiscordContentWithBoundedRetry(postContent, { index, eventId, sink, options = {}, chunkIndex = 0, chunkCount = 1 }) {
  const maxAttempts = deliveryMaxAttempts(options);
  const chunkLabel = chunkCount > 1 ? ` chunk ${chunkIndex + 1}/${chunkCount}` : '';
  for (;;) {
    try {
      await postContent();
      return { ok: true };
    } catch (error) {
      const classification = classifyDiscordPostException(error);
      const errorWithContext = new Error(`${classification.category}${chunkLabel}: ${error?.message || error}`);
      if (classification.action === 'hold') {
        const failure = markDeliveryFailed(index.db, eventId, sink, errorWithContext, {
          ...options,
          maxAttempts,
          nextAttemptAt: isoAfterMs(classification.retryAfterMs),
        });
        if (failure.status === 'dead') {
          return { ok: false, error: errorWithContext, failure };
        }
        console.error('[bridge-discord-notifier]', `delivery held for ${eventId}${chunkLabel}: retry after ${classification.retryAfterMs}ms (${error?.message || error})`);
        return { ok: false, held: true, error: errorWithContext, failure };
      }
      const failureOptions = classification.action === 'dead'
        ? { ...options, maxAttempts: 1 }
        : { ...options, maxAttempts };
      const failure = markDeliveryFailed(index.db, eventId, sink, errorWithContext, {
        ...failureOptions,
      });
      if (failure.status === 'dead') {
        return { ok: false, error: errorWithContext, failure };
      }
      if (classification.action === 'retry-after' && classification.retryAfterMs > 0) {
        console.error('[bridge-discord-notifier]', `delivery retry ${failure.retryCount}/${maxAttempts} for ${eventId}${chunkLabel} after ${classification.retryAfterMs}ms (${error?.message || error})`);
        await discordSleepFn(options)(classification.retryAfterMs);
        continue;
      }
      console.error('[bridge-discord-notifier]', `delivery retry ${failure.retryCount}/${maxAttempts} for ${eventId}${chunkLabel}: ${error?.message || error}`);
    }
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

  return {
    channel: resolveProjectChannel(project, update.map, options),
    mapped: true,
    reason: null,
    lookup,
    update,
    map: update.map,
  };
}

async function ensureHermesAllowlistForResolvedChannel(channel, options = {}) {
  if (!channel.channelId || channel.mappingStatus !== 'project') {
    return { ok: true, changed: false, reason: 'not-project-channel' };
  }
  return ensureHermesDiscordChannelAllowed(channel.channelId, options);
}

async function resolveDiscordDeliveryTarget(session = {}, event = {}, channel = {}, channelMap = {}, options = {}) {
  if (!autoCreateDiscordThreads(options)) {
    return { ok: true, channelId: channel.channelId, map: null, thread: null };
  }

  const mapped = discordThreadForSession(session, channelMap, options);
  if (mapped.threadId) {
    if (!mapped.channelId || mapped.channelId === channel.channelId) {
      return { ok: true, channelId: mapped.threadId, map: null, thread: mapped };
    }
    return {
      ok: false,
      reason: 'mapped-session-thread-parent-mismatch',
      channelId: null,
      map: null,
      thread: mapped,
    };
  }
  if (mapped.mappingStatus === 'invalid') {
    return {
      ok: false,
      reason: 'mapped-session-thread-invalid',
      channelId: null,
      map: null,
      thread: mapped,
    };
  }

  if (!channel.channelId) {
    return { ok: false, reason: 'missing-parent-channel-id', channelId: null, map: null, thread: null };
  }

  if (!shouldCreateMissingSessionThread(event, { ...options, session })) {
    return missingSessionThreadTarget('missing-session-thread');
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
    event,
  };
}

function allowDirectFinalAnswerNotifications(options = {}) {
  return options.allowDiscordFinalAnswerNotifications === true
    || truthyEnv(process.env.BRIDGE_NOTIFY_ALLOW_FINAL_ANSWER, false);
}

function shouldNotify(event, options = {}, session = {}) {
  const allowed = options.eventTypes || eventTypesFromEnv();
  if (!allowed.has(event.type)) return false;
  if (event.type === 'SessionIdle') return false;
  if ((event.type === 'FinalAnswer' || event.type === 'AgentResponse') && !allowDirectFinalAnswerNotifications(options)) return false;
  if ((event.type === 'FinalAnswer' || event.type === 'AgentResponse') && event.phase && event.phase !== 'final_answer') return false;
  if (event.type === 'Idle') return false;
  if ((event.type === 'SessionStart' || event.type === 'SessionEnd') && event.source !== 'notification') return false;
  if (event.source === 'notification' && (event.type === 'Idle' || event.type === 'FinalAnswer' || event.type === 'AgentResponse' || event.type === 'Commentary')) return false;
  return true;
}


function shouldRefreshSkippedEvent(event = {}, session = {}) {
  return event.type === 'SessionStart' && event.source === 'notification' && session.status === 'active';
}

export async function pollDiscordNotifications(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const webhookUrl = Object.prototype.hasOwnProperty.call(options, 'webhookUrl')
    ? options.webhookUrl
    : process.env.BRIDGE_DISCORD_WEBHOOK_URL;
  const botToken = discordBotToken(options);
  const useBotChannelDelivery = Boolean(botToken) && options.preferWebhookDelivery !== true;
  if (!webhookUrl && !useBotChannelDelivery) return { ok: false, reason: 'missing-discord-destination', sent: 0 };

  const bootSince = options.bootSince || new Date().toISOString();
  const skipBefore = options.replay === true ? null : bootSince;
  const path = options.statePath || statePath(projectRoot, options);
  const state = await readState(path);
  const sentIds = new Set(state.sentEventIds);
  const sink = deliverySink(options);
  const index = await openEventIndex(projectRoot, options);
  try {
    const indexedLegacySentIds = eventIdsInIndex(index.db, sentIds);
    markLegacySentDeliveries(index.db, indexedLegacySentIds, sink);
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
    let channelMap = useBotChannelDelivery ? await readProjectChannelMap(options) : null;
    const maxEventsPerPoll = Number.parseInt(process.env.BRIDGE_NOTIFY_MAX_EVENTS_PER_POLL || `${options.maxEventsPerPoll || DEFAULT_MAX_EVENTS_PER_POLL}`, 10);
    const allowedEventTypes = options.eventTypes || eventTypesFromEnv();
    const priorDeliveryBlocks = priorFinalAnswerDeliveryBlocks(options);
    let sent = 0;
    let skippedNoChannel = 0;
    let failed = 0;
    const indexItems = [];
    const skippedIndexRepairItems = [];

    for (const session of sessions) {
      const events = await routeSessionEvents(session, {
        ...options,
        projectRoot: session.lifecycleRoot || projectRoot,
        bridgeProjectRoot: projectRoot,
      });
      for (const event of events) {
        const notify = shouldNotify(event, { ...options, eventTypes: allowedEventTypes }, session);
        if (!notify && !eventMatchesPriorDeliveryBlocker(event, priorDeliveryBlocks)) continue;
        const eventId = normalizeEventId(session, event);
        if (notify && sentIds.has(eventId) && !indexedLegacySentIds.has(eventId)) continue;
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
    markSkippedBeforeDeliveries(index.db, sink, {
      ...options,
      eventTypes: allowedEventTypes,
      skipBefore,
    });
    const pending = pendingEvents(index.db, sink, {
      eventTypes: allowedEventTypes,
      fifoScope: 'sink',
      priorDeliveryBlocks,
      limit: Math.max(1, maxEventsPerPoll) * 10,
      skipBefore,
    });

    let stopPollForHeldHead = false;
    for (const pendingItem of pending) {
      let { session, event, eventId } = pendingItem;
      const currentOwnerSession = currentOwnerSessionForPendingEvent(session, event, eventId, liveCodexOwners);
      if (currentOwnerSession !== session) {
        session = currentOwnerSession;
        upsertEvents(index.db, [{ session, event: { ...event, eventId }, eventId }]);
      }
      if (event.source === 'codex-log' && await isAuxiliaryCodexSession(session)) {
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, sink);
        continue;
      }
      if (!shouldNotify(event, { ...options, eventTypes: allowedEventTypes }, session)) {
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, sink);
        continue;
      }
      if (!shouldPollSession(session, options)) {
        sentIds.add(eventId);
        markDeliverySent(index.db, eventId, sink);
        continue;
      }
      try {
        let channel = null;
        let deliveryChannelId = null;
        let deliveryTarget = null;
        if (useBotChannelDelivery) {
          channel = resolveProjectChannel(session.project, channelMap, options);
          if (channel.mappingStatus !== 'project' && channel.autoCreateChannel) {
            const resolved = await autoResolveProjectChannel(session.project, channel, { ...options, projectRoot });
            channel = resolved.channel;
            if (resolved.map) channelMap = resolved.map;
          }
          if (!channel.channelId) {
            failed += 1;
            skippedNoChannel += 1;
            const error = new Error(`missing Discord channel for project ${session.project || 'unknown'}`);
            markDeliveryFailed(index.db, eventId, sink, error, { ...options, maxAttempts: 1 });
            console.error('[bridge-discord-notifier]', `delivery dead for ${eventId}: ${error.message}`);
            continue;
          }
          if (channel.mappingStatus === 'project') {
            const hermesConfig = await ensureHermesAllowlistForResolvedChannel(channel, { ...options, projectRoot });
            await waitForHermesGatewayAfterRestart(hermesConfig, options.webhookUrl, options);
          }
          const target = await resolveDiscordDeliveryTarget(session, event, channel, channelMap, options);
          if (!target.ok || !target.channelId) {
            const reason = target.reason || 'unknown';
            if (target.suppressDelivery === true) {
              failed += 1;
              skippedNoChannel += 1;
              const alertResult = await postDeliveryFailureAlert(channel.channelId, session, event, reason, options);
              const error = new Error(deliveryFailureErrorMessage(event.type, alertResult));
              markDeliveryFailed(index.db, eventId, sink, error, { ...options, maxAttempts: 1 });
              console.error('[bridge-discord-notifier]', `delivery dead for ${eventId}: ${error.message}`);
              continue;
            }
            const alertResult = await postDeliveryFailureAlert(channel.channelId, session, event, reason, options);
            if (!alertResult.ok) {
              console.error('[bridge-discord-notifier]', `delivery failure alert failed for ${eventId}: ${alertResult.reason}`);
            }
            const error = new Error(`Discord session thread unavailable: ${reason}`);
            markDeliveryFailed(index.db, eventId, sink, error, { ...options, maxAttempts: 1 });
            failed += 1;
            console.error('[bridge-discord-notifier]', `delivery dead for ${eventId}: ${error.message}`);
            continue;
          }
          if (target.map) channelMap = target.map;
          deliveryChannelId = target.channelId;
          deliveryTarget = target;
        }
        const allowedMentions = allowedMentionsForEvent(event, options);
        const chunks = eventToDiscordChunks(session, event, options);
        markDeliveryPrepared(index.db, eventId, sink, {
          transport: useBotChannelDelivery ? 'discord-channel' : 'discord-webhook',
          channelId: deliveryChannelId,
          chunkCount: chunks.length,
          chunks,
          chunkManifest: chunks.map((_, index) => ({
            chunkId: `${eventId}:chunk-${index + 1}-of-${chunks.length}`,
            index: index + 1,
            total: chunks.length,
          })),
          chunkDeliveryPolicy: 'mark-sent-only-after-all-chunks; dead-on-exhausted-chunk',
          allowedMentions,
          event: {
            eventId,
            type: event.type,
            timestamp: event.timestamp,
          },
          session: {
            sessionId: session.lifecycleSessionId || session.bridgeSessionId || session.codexSessionId || session.threadId || null,
            codexSessionId: session.codexSessionId || null,
            tmuxId: session.tmuxId || null,
            project: session.project || null,
          },
        }, {
          targetChannelId: deliveryChannelId,
          targetThreadId: deliveryTarget?.thread?.threadId || null,
          targetThreadName: deliveryTarget?.thread?.threadName || null,
          targetKind: deliveryTarget?.thread?.mappingStatus || (deliveryChannelId ? 'channel' : null),
        });
        let stoppedBeforeAllChunks = false;
        let heldCurrentEvent = false;
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const content = chunks[chunkIndex];
          const delivery = await postDiscordContentWithBoundedRetry(
            async () => {
              if (useBotChannelDelivery) {
                await postDiscordChannelMessage(deliveryChannelId, content, { ...options, allowedMentions });
              } else {
                await postDiscordWebhook(webhookUrl, content, { ...options, allowedMentions });
              }
            },
            { index, eventId, sink, options, chunkIndex, chunkCount: chunks.length },
          );
          if (!delivery.ok) {
            failed += 1;
            stoppedBeforeAllChunks = true;
            if (delivery.held) {
              heldCurrentEvent = true;
              stopPollForHeldHead = true;
              console.error('[bridge-discord-notifier]', `delivery held for ${eventId}: ${delivery.error?.message || delivery.error}`);
            } else {
              const reason = `post failure dead${chunks.length > 1 ? ` after chunk ${chunkIndex + 1}/${chunks.length}` : ''}: ${delivery.error?.message || delivery.error}`;
              await alertDiscordDeliveryDead(deliveryFailureAlertChannelId(channel, options), session, { ...event, eventId }, reason, options);
              console.error('[bridge-discord-notifier]', `delivery dead for ${eventId}: ${reason}`);
            }
            break;
          }
        }
        if (stoppedBeforeAllChunks) {
          if (heldCurrentEvent) break;
          continue;
        }
        const terminal = index.db.prepare(`
          SELECT status
          FROM deliveries
          WHERE event_id = ? AND sink = ?
        `).get(eventId, sink);
        if (terminal?.status === 'dead') {
          continue;
        }
        markDeliverySent(index.db, eventId, sink, {
          targetChannelId: deliveryChannelId,
          targetThreadId: deliveryTarget?.thread?.threadId || null,
          targetThreadName: deliveryTarget?.thread?.threadName || null,
          targetKind: deliveryTarget?.thread?.mappingStatus || (deliveryChannelId ? 'channel' : null),
        });
      } catch (error) {
        failed += 1;
        markDeliveryFailed(index.db, eventId, sink, error, { ...options, maxAttempts: 1 });
        console.error('[bridge-discord-notifier]', `delivery dead for ${eventId}: ${error?.message || error}`);
        continue;
      }
      sentIds.add(eventId);
      sent += 1;
      if (sent >= Math.max(1, maxEventsPerPoll)) break;
      if (stopPollForHeldHead) break;
    }

    await writeState(path, sentIds);
    return { ok: failed === 0, sent, failed, skippedNoChannel };
  } finally {
    closeEventIndex(index);
  }
}

export function startDiscordNotifier(options = {}) {
  const webhookUrl = options.webhookUrl || process.env.BRIDGE_DISCORD_WEBHOOK_URL;
  const botToken = discordBotToken(options);
  const envEnabled = (process.env.BRIDGE_NOTIFY_ENABLED || '').toLowerCase() === 'true'
    || (process.env.BRIDGE_DISCORD_FAST_EVENTS_ENABLED || '').toLowerCase() === 'true';
  const enabled = options.enabled ?? envEnabled;
  if (!enabled || (!webhookUrl && !botToken)) return { started: false, reason: enabled ? 'missing-discord-destination' : 'disabled' };

  const intervalMs = positiveInt(process.env.BRIDGE_NOTIFY_INTERVAL_MS || options.intervalMs, DEFAULT_POLL_INTERVAL_MS);
  const bootSince = options.bootSince || new Date().toISOString();
  let running = false;
  let stopped = false;

  const tick = async (tickOptions = {}) => {
    if (running || stopped) {
      return { ok: false, reason: stopped ? 'stopped' : 'busy', sent: 0 };
    }
    running = true;
    try {
      return await pollDiscordNotifications({
        ...options,
        ...tickOptions,
        webhookUrl,
        bootSince: tickOptions.bootSince || bootSince,
      });
    } catch (error) {
      console.error('[bridge-discord-notifier]', error?.message || error);
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
