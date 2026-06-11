import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { stat } from 'node:fs/promises';
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

export async function readGjcLog(filePath) {
  const meta = {
    gjcSessionId: null,
    threadId: null,
    startedAt: null,
    cwd: null,
    title: null,
    version: null,
    sessionLogPath: filePath,
    lastEventAt: null,
  };
  const messages = [];

  await readJsonlStreaming(filePath, (record, lineNumber) => {
    const timestamp = asString(record.timestamp);
    if (timestamp) meta.lastEventAt = timestamp;

    if (record.type === 'session') {
      meta.gjcSessionId = asString(record.id) || meta.gjcSessionId;
      meta.threadId = meta.gjcSessionId || meta.threadId;
      meta.startedAt = timestamp || asString(record.startedAt) || meta.startedAt;
      meta.cwd = asString(record.cwd) || meta.cwd;
      meta.title = asString(record.title) || meta.title;
      meta.version = Number.isFinite(record.version) ? record.version : meta.version;
      return;
    }

    if (record.type !== 'message' || !record.message || typeof record.message !== 'object') return;
    const message = record.message;
    const role = asString(message.role);
    if (!role) return;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = collectText(content).join('\n').trim();
    messages.push({
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
  });

  return { ...meta, messages };
}

export function latestGjcAssistantMessage(log = {}) {
  return [...(log.messages || [])].reverse().find((message) => message.role === 'assistant' && message.phase === 'final_answer' && message.text)
    || [...(log.messages || [])].reverse().find((message) => message.role === 'assistant' && message.text)
    || null;
}
