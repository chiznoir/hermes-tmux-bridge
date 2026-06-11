import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { open, stat } from 'node:fs/promises';
import { listFilesRecursive, readJsonlStreaming } from './jsonl.js';

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function xdgDataHome(env = process.env) {
  return env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

function configuredSessionRoots(options = {}, env = process.env) {
  const configured = options.gjcSessionsRoots
    || options.gjcSessionRoots
    || options.gjcSessionsRoot
    || env.GJC_SESSIONS_ROOT
    || '';
  if (Array.isArray(configured)) return configured.filter(Boolean);
  return String(configured)
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function gjcSessionsRoots(options = {}, env = process.env) {
  const configured = configuredSessionRoots(options, env);
  if (configured.length > 0) return [...new Set(configured)];
  return [...new Set([
    join(homedir(), '.gjc', 'agent', 'sessions'),
    join(xdgDataHome(env), 'gjc', 'sessions'),
  ])];
}

async function sortByMtime(paths = []) {
  const entries = await Promise.all(paths.map(async (path) => ({
    path,
    mtimeMs: (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
  })));
  return entries
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.path);
}

export async function listGjcSessionLogPaths(options = {}) {
  const roots = gjcSessionsRoots(options);
  const paths = [];
  for (const root of roots) {
    paths.push(...await listFilesRecursive(root, (_path, name) => name.endsWith('.jsonl')));
  }
  return sortByMtime([...new Set(paths)]);
}

function collectText(content, fragments = []) {
  if (typeof content === 'string') {
    if (content.trim()) fragments.push(content);
    return fragments;
  }
  if (Array.isArray(content)) {
    for (const item of content) collectText(item, fragments);
    return fragments;
  }
  if (!content || typeof content !== 'object') return fragments;
  if ((content.type === 'text' || content.type === 'output_text' || content.type === 'input_text')
    && typeof content.text === 'string'
    && content.text.trim()) {
    fragments.push(content.text);
    return fragments;
  }
  if (typeof content.type === 'string') return fragments;
  for (const [key, child] of Object.entries(content)) {
    if (key === 'type' || key.endsWith('Signature') || key === 'encrypted_content') continue;
    collectText(child, fragments);
  }
  return fragments;
}

function assistantPhase(record = {}, message = {}, content = []) {
  const stopReason = asString(record.stopReason) || asString(message.stopReason);
  const hasToolCall = content.some((item) => item?.type === 'toolCall');
  if (stopReason === 'stop') return 'final_answer';
  if (stopReason === 'toolUse' || hasToolCall) return 'commentary';
  return 'commentary';
}

function emptyGjcLog(filePath) {
  return {
    gjcSessionId: null,
    threadId: null,
    startedAt: null,
    cwd: null,
    title: null,
    version: null,
    sessionLogPath: filePath,
    lastEventAt: null,
    messages: [],
  };
}

function applyGjcRecord(log, record, lineNumber) {
  const timestamp = asString(record.timestamp);
  if (timestamp) log.lastEventAt = timestamp;

  if (record.type === 'session') {
    log.gjcSessionId = asString(record.id) || log.gjcSessionId;
    log.threadId = log.gjcSessionId || log.threadId;
    log.startedAt = timestamp || asString(record.startedAt) || log.startedAt;
    log.cwd = asString(record.cwd) || log.cwd;
    log.title = asString(record.title) || log.title;
    log.version = Number.isFinite(record.version) ? record.version : log.version;
    return;
  }

  if (record.type !== 'message' || !record.message || typeof record.message !== 'object') return;
  const message = record.message;
  const role = asString(message.role);
  if (!role) return;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = collectText(content).join('\n').trim();
  log.messages.push({
    id: asString(record.id) || `message-${lineNumber}`,
    role,
    timestamp,
    text,
    phase: role === 'assistant' ? assistantPhase(record, message, content) : null,
    stopReason: asString(record.stopReason) || asString(message.stopReason),
    hasToolCall: content.some((item) => item?.type === 'toolCall'),
    hasThinking: content.some((item) => item?.type === 'thinking'),
    lineNumber,
  });
}

export async function readGjcLog(filePath) {
  const log = emptyGjcLog(filePath);
  await readJsonlStreaming(filePath, (record, lineNumber) => applyGjcRecord(log, record, lineNumber));
  return log;
}

function cursorByteOffset(cursor = {}) {
  const value = cursor.byteOffset ?? cursor.byte_offset ?? 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function cursorLineNumber(cursor = {}) {
  const value = cursor.lineNumber ?? cursor.line_number ?? 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseGjcDeltaLine(lineText, context) {
  if (!lineText || lineText.trim() === '') return null;
  try {
    const parsed = JSON.parse(lineText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (cause) {
    const error = new Error(`Malformed GJC JSONL at ${context.filePath}:${context.byteOffset}`);
    error.name = 'GjcLogParseError';
    error.code = 'GJC_LOG_MALFORMED_JSONL';
    error.filePath = context.filePath;
    error.byteOffset = context.byteOffset;
    error.lastGoodOffset = context.lastGoodOffset;
    error.cause = cause;
    throw error;
  }
}

export async function readGjcLogDelta(filePath, cursor = {}) {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const fileSize = fileStat.size;
    const fileMtime = new Date(fileStat.mtimeMs).toISOString();
    const requestedOffset = cursorByteOffset(cursor);
    const reset = requestedOffset > fileSize || Number.parseInt(cursor.file_size ?? cursor.fileSize ?? 0, 10) > fileSize;
    const startOffset = reset ? 0 : requestedOffset;
    const byteLength = Math.max(0, fileSize - startOffset);
    const buffer = Buffer.alloc(byteLength);
    if (byteLength > 0) await handle.read(buffer, 0, byteLength, startOffset);

    const log = emptyGjcLog(filePath);
    let position = 0;
    let lastGoodOffset = startOffset;
    let lineNumber = reset ? 0 : cursorLineNumber(cursor);
    let lastGoodLineNumber = lineNumber;
    let partial = null;

    while (position < buffer.length) {
      const newline = buffer.indexOf(0x0a, position);
      const hasNewline = newline !== -1;
      const lineEnd = hasNewline ? newline : buffer.length;
      const lineBuffer = buffer.subarray(position, lineEnd);
      const byteOffset = startOffset + position;
      const nextOffset = startOffset + lineEnd + (hasNewline ? 1 : 0);
      const lineText = lineBuffer.toString('utf8').replace(/\r$/, '');

      if (!hasNewline) {
        try {
          const currentLineNumber = lineNumber + 1;
          const parsed = parseGjcDeltaLine(lineText, { filePath, byteOffset, lastGoodOffset });
          if (parsed) applyGjcRecord(log, parsed, currentLineNumber);
          lineNumber = currentLineNumber;
          lastGoodLineNumber = currentLineNumber;
          lastGoodOffset = nextOffset;
        } catch (error) {
          partial = { byteOffset, bytes: fileSize - byteOffset };
        }
        break;
      }

      const currentLineNumber = lineNumber + 1;
      const parsed = parseGjcDeltaLine(lineText, { filePath, byteOffset, lastGoodOffset });
      if (parsed) applyGjcRecord(log, parsed, currentLineNumber);
      lineNumber = currentLineNumber;
      lastGoodLineNumber = currentLineNumber;
      lastGoodOffset = nextOffset;
      position = nextOffset - startOffset;
    }

    return {
      ...log,
      partial,
      reset,
      cursor: {
        logPath: filePath,
        byteOffset: lastGoodOffset,
        lineNumber: lastGoodLineNumber,
        fileSize,
        fileMtime,
        gjcSessionId: log.gjcSessionId || cursor.gjc_session_id || cursor.gjcSessionId || null,
      },
    };
  } finally {
    await handle.close();
  }
}

export function latestGjcAssistantMessage(log = {}) {
  return [...(log.messages || [])].reverse().find((message) => message.role === 'assistant' && message.phase === 'final_answer' && message.text)
    || [...(log.messages || [])].reverse().find((message) => message.role === 'assistant' && message.text)
    || null;
}
