import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDirFor } from './jsonl.js';

const DEFAULT_AUTO_CREATE_CHANNELS = true;

export function expandHome(path) {
  const value = String(path || '');
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function projectChannelMapPath(options = {}) {
  return expandHome(
    options.projectChannelMapPath
    || process.env.BRIDGE_PROJECT_CHANNEL_MAP
    || process.env.BRIDGE_HERMES_PROJECT_CHANNEL_MAP
    || join(homedir(), '.config', 'hermes-codex-bridge', 'project-channels.json'),
  );
}

export function normalizeProjectKey(project) {
  return String(project || '').trim();
}

export function channelNameForProject(project) {
  const normalized = String(project || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return normalized || 'unknown';
}

function truthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export async function readProjectChannelMap(options = {}) {
  if (options.projectChannelMap && typeof options.projectChannelMap === 'object') return options.projectChannelMap;
  const inline = process.env.BRIDGE_HERMES_PROJECT_CHANNELS || '';
  if (inline.trim()) {
    try {
      const parsed = JSON.parse(inline);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return { projects: {} };
    }
  }
  const path = projectChannelMapPath(options);
  if (!path || !existsSync(path)) return { projects: {} };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? { projects: {}, ...parsed } : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

export async function writeProjectChannelMap(map = {}, options = {}) {
  const path = projectChannelMapPath(options);
  const normalized = { projects: {}, ...map };
  if (!normalized.projects || typeof normalized.projects !== 'object') normalized.projects = {};
  await ensureDirFor(path);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return { path, map: normalized };
}

function projectEntries(map = {}) {
  return map.projects && typeof map.projects === 'object' ? map.projects : map;
}

export function explicitProjectChannelFromMap(project, map = {}) {
  const key = normalizeProjectKey(project);
  if (!key || !map || typeof map !== 'object') return null;
  const projects = projectEntries(map);
  return projects[key] || projects[key.toLowerCase()] || null;
}

export function projectChannelFromMap(project, map = {}) {
  if (!map || typeof map !== 'object') return null;
  return explicitProjectChannelFromMap(project, map) || map.default || map.default_channel_id || null;
}

export function defaultChannelFromMap(map = {}, options = {}) {
  return options.defaultChannelId
    || map?.default
    || map?.default_channel_id
    || process.env.BRIDGE_HERMES_DEFAULT_CHANNEL_ID
    || process.env.BRIDGE_DISCORD_CHANNEL_ID
    || process.env.TARGET_ID
    || null;
}

export function channelForProject(project, map = {}, options = {}) {
  return options.channelId
    || projectChannelFromMap(project, map)
    || defaultChannelFromMap(map, options)
    || null;
}

function sessionThreadEntries(map = {}) {
  return map.sessionThreads && typeof map.sessionThreads === 'object' ? map.sessionThreads : {};
}

export function sessionThreadKey(session = {}, options = {}) {
  return sessionThreadKeys(session, options)[0] || '';
}

export function sessionThreadKeys(session = {}, options = {}) {
  const values = [
    options.discordSessionThreadKey,
    session.discordSessionThreadKey,
    session.lifecycleSessionId,
    session.bridgeSessionId,
    session.codexThreadId,
    session.codexSessionId,
    session.threadId,
    session.tmuxPaneId,
    session.tmuxId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(values)];
}

function sessionThreadEntryForSession(session = {}, map = {}, options = {}) {
  const entries = sessionThreadEntries(map);
  for (const key of sessionThreadKeys(session, options)) {
    if (entries[key]) return { key, entry: entries[key] };
  }
  return { key: sessionThreadKey(session, options), entry: null };
}

export function canonicalSessionThreadKey(session = {}, options = {}) {
  return String(
    options.discordSessionThreadKey
    || session.discordSessionThreadKey
    || session.lifecycleSessionId
    || session.bridgeSessionId
    || session.codexThreadId
    || session.codexSessionId
    || session.threadId
    || session.tmuxPaneId
    || session.tmuxId
    || '',
  ).trim();
}

export function discordThreadForSession(session = {}, map = {}, options = {}) {
  const { key, entry } = sessionThreadEntryForSession(session, map, options);
  if (!key || !entry) {
    return {
      key,
      threadId: null,
      channelId: null,
      threadName: null,
      mappingStatus: key ? 'missing' : 'missing-session-key',
    };
  }

  const normalized = typeof entry === 'object' ? entry : { threadId: entry };
  const threadId = String(normalized.threadId || normalized.thread_id || normalized.channelId || normalized.channel_id || '').trim();
  return {
    key,
    threadId: threadId || null,
    channelId: String(normalized.parentChannelId || normalized.parent_channel_id || normalized.channelId || normalized.channel_id || '').trim() || null,
    threadName: String(normalized.threadName || normalized.thread_name || normalized.name || '').trim() || null,
    project: String(normalized.project || session.project || '').trim() || null,
    mappingStatus: threadId ? 'session-thread' : 'invalid',
    entry: normalized,
  };
}

export function resolveProjectChannel(project, map = {}, options = {}) {
  const explicit = options.channelId || explicitProjectChannelFromMap(project, map);
  const fallback = projectChannelFromMap(project, map)
    || defaultChannelFromMap(map, options)
    || null;
  const defaultChannelId = defaultChannelFromMap(map, options);
  const channelId = explicit || fallback;
  const autoCreate = options.autoCreateChannel ?? truthyEnv(process.env.BRIDGE_HERMES_AUTO_CREATE_CHANNELS, DEFAULT_AUTO_CREATE_CHANNELS);
  return {
    project: normalizeProjectKey(project),
    channelId,
    defaultChannelId,
    desiredChannelName: channelNameForProject(project),
    autoCreateChannel: autoCreate,
    mappingStatus: explicit ? 'project' : (channelId ? 'fallback' : 'missing'),
    channelMissing: !explicit,
  };
}

export async function updateSessionDiscordThread(session = {}, update = {}, options = {}) {
  const key = canonicalSessionThreadKey(session, options);
  const threadId = String(update.threadId || update.thread_id || '').trim();
  const parentChannelId = String(update.parentChannelId || update.parent_channel_id || update.channelId || update.channel_id || '').trim();
  if (!key) return { ok: false, status: 400, error: 'session thread key is required' };
  if (!threadId) return { ok: false, status: 400, error: 'threadId is required' };
  if (!parentChannelId) return { ok: false, status: 400, error: 'parentChannelId is required' };

  const map = await readProjectChannelMap(options);
  map.sessionThreads = sessionThreadEntries(map);
  map.sessionThreads[key] = {
    ...(typeof map.sessionThreads[key] === 'object' ? map.sessionThreads[key] : {}),
    project: String(update.project || session.project || '').trim() || null,
    parentChannelId,
    threadId,
    threadName: String(update.threadName || update.thread_name || '').trim() || null,
    createdAt: update.createdAt || update.created_at || new Date().toISOString(),
  };

  const written = await writeProjectChannelMap(map, options);
  return {
    ok: true,
    status: 200,
    key,
    threadId,
    parentChannelId,
    threadName: map.sessionThreads[key].threadName,
    map: written.map,
    path: written.path,
  };
}

export async function updateProjectChannel(project, update = {}, options = {}) {
  const key = normalizeProjectKey(project);
  const channelId = String(update.channelId || update.channel_id || '').trim();
  if (!key) return { ok: false, status: 400, error: 'project is required' };
  if (!channelId) return { ok: false, status: 400, error: 'channelId is required' };

  const map = await readProjectChannelMap(options);
  const defaultChannelId = defaultChannelFromMap(map, options);
  const allowFallbackMapping = update.allowFallbackMapping === true || update.allow_fallback_mapping === true;
  if (!allowFallbackMapping && defaultChannelId && channelId === defaultChannelId) {
    return { ok: false, status: 400, error: 'refusing to persist fallback channel as project mapping' };
  }

  if (!map.projects || typeof map.projects !== 'object') map.projects = {};
  map.projects[key] = channelId;
  if (update.channelName || update.channel_name) {
    map.channelNames = map.channelNames && typeof map.channelNames === 'object' ? map.channelNames : {};
    map.channelNames[key] = String(update.channelName || update.channel_name).trim();
  }
  const written = await writeProjectChannelMap(map, options);
  return {
    ok: true,
    status: 200,
    project: key,
    channelId,
    channelName: map.channelNames?.[key] || null,
    map: written.map,
    path: written.path,
  };
}
