import { channelNameForProject } from './project-channels.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_TEXT_CHANNEL_TYPE = 0;
const DISCORD_PUBLIC_THREAD_TYPE = 11;
const DEFAULT_THREAD_AUTO_ARCHIVE_DURATION = 1440;

function cleanEnv(value) {
  return String(value || '').trim();
}

export function discordBotToken(options = {}) {
  return cleanEnv(
    options.discordBotToken
    || process.env.BRIDGE_DISCORD_BOT_TOKEN
    || process.env.DISCORD_BOT_TOKEN,
  );
}

export function discordGuildId(options = {}) {
  return cleanEnv(
    options.discordGuildId
    || process.env.BRIDGE_DISCORD_GUILD_ID
    || process.env.DISCORD_GUILD_ID
    || process.env.DISCORD_SERVER_ID,
  );
}

function discordGuildLookupChannelId(options = {}) {
  return cleanEnv(
    options.discordGuildLookupChannelId
    || options.discordHomeChannelId
    || options.defaultChannelId
    || options.fallbackChannelId
    || process.env.BRIDGE_DISCORD_HOME_CHANNEL
    || process.env.DISCORD_HOME_CHANNEL
    || process.env.BRIDGE_HERMES_DEFAULT_CHANNEL_ID
    || process.env.BRIDGE_DISCORD_CHANNEL_ID
    || process.env.TARGET_ID,
  );
}

export function normalizeDiscordChannelName(name) {
  return String(name || '').trim().toLowerCase();
}

function targetChannelName(nameOrProject) {
  return channelNameForProject(nameOrProject);
}

export function discordThreadNameForSession(session = {}, options = {}) {
  const configured = cleanEnv(options.discordThreadName || session.discordThreadName);
  if (configured) return configured.slice(0, 100);
  const id = cleanEnv(
    session.tmuxId
    || session.lifecycleSessionId
    || session.bridgeSessionId
    || session.codexThreadId
    || session.codexSessionId
    || session.threadId
    || session.tmuxPaneId
    || 'session',
  ).replace(/[^a-zA-Z0-9_-]+/g, '-');
  return (id || 'session').slice(0, 100);
}

function discordProjectChannelParentId(options = {}) {
  return cleanEnv(
    options.discordProjectChannelParentId
    || process.env.BRIDGE_DISCORD_PROJECT_CHANNEL_PARENT_ID,
  );
}

function fallbackChannelId(options = {}) {
  return cleanEnv(options.defaultChannelId || options.fallbackChannelId);
}

function parentIdForCreatedChannel(channels = [], options = {}) {
  const configured = discordProjectChannelParentId(options);
  if (configured) return configured;
  const fallbackId = fallbackChannelId(options);
  if (!fallbackId) return null;
  const fallback = channels.find((channel) => String(channel?.id || '') === fallbackId);
  return cleanEnv(fallback?.parent_id) || null;
}

async function safeJson(res) {
  if (typeof res?.json !== 'function') return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res) {
  if (typeof res?.text !== 'function') return '';
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export async function resolveDiscordGuildId(options = {}) {
  const configuredGuildId = discordGuildId(options);
  if (configuredGuildId) return { ok: true, reason: null, guildId: configuredGuildId, source: 'configured' };

  const token = discordBotToken(options);
  const channelId = discordGuildLookupChannelId(options);
  if (!token || !channelId) {
    return { ok: false, reason: 'missing-discord-channel-lookup-config', guildId: null, source: null };
  }

  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch-unavailable', guildId: null, source: null };
  }

  const apiBase = options.discordApiBase || DISCORD_API_BASE;
  const res = await fetchFn(`${apiBase}/channels/${encodeURIComponent(channelId)}`, {
    method: 'GET',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
    },
  });

  if (!res?.ok) {
    return {
      ok: false,
      reason: 'discord-guild-lookup-failed',
      status: res?.status || null,
      guildId: null,
      source: 'channel',
    };
  }

  const channel = await safeJson(res);
  const guildId = cleanEnv(channel?.guild_id);
  return {
    ok: Boolean(guildId),
    reason: guildId ? null : 'invalid-discord-channel-guild-response',
    guildId: guildId || null,
    source: 'channel',
    channelId,
  };
}

export async function listDiscordGuildChannels(options = {}) {
  const token = discordBotToken(options);
  const guild = await resolveDiscordGuildId(options);
  const guildId = guild.guildId;
  if (!token || !guild.ok || !guildId) {
    return { ok: false, reason: guild.reason || 'missing-discord-channel-lookup-config', channels: [] };
  }

  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch-unavailable', channels: [] };
  }

  const apiBase = options.discordApiBase || DISCORD_API_BASE;
  const res = await fetchFn(`${apiBase}/guilds/${encodeURIComponent(guildId)}/channels`, {
    method: 'GET',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
    },
  });

  if (!res?.ok) {
    return {
      ok: false,
      reason: 'discord-channel-lookup-failed',
      status: res?.status || null,
      channels: [],
    };
  }

  const channels = await safeJson(res);
  return {
    ok: Array.isArray(channels),
    reason: Array.isArray(channels) ? null : 'invalid-discord-channel-list',
    channels: Array.isArray(channels) ? channels : [],
  };
}

export async function findDiscordTextChannelByName(nameOrProject, options = {}) {
  const desiredName = targetChannelName(nameOrProject);
  const desired = normalizeDiscordChannelName(desiredName);
  const listed = await listDiscordGuildChannels(options);
  if (!listed.ok) {
    return { ...listed, desiredChannelName: desiredName, channel: null, channelId: null, channelName: null };
  }

  const channel = listed.channels.find((candidate) => (
    Number(candidate?.type) === DISCORD_TEXT_CHANNEL_TYPE
    && normalizeDiscordChannelName(candidate?.name) === desired
  ));

  if (!channel) {
    return {
      ok: false,
      reason: 'discord-text-channel-not-found',
      desiredChannelName: desiredName,
      channel: null,
      channelId: null,
      channelName: null,
    };
  }

  return {
    ok: true,
    reason: null,
    desiredChannelName: desiredName,
    channel,
    channelId: String(channel.id || '').trim(),
    channelName: String(channel.name || '').trim(),
  };
}

export async function createDiscordTextChannel(nameOrProject, options = {}) {
  const token = discordBotToken(options);
  const guild = await resolveDiscordGuildId(options);
  const guildId = guild.guildId;
  if (!token || !guild.ok || !guildId) {
    return { ok: false, reason: guild.reason || 'missing-discord-channel-lookup-config', channel: null, channelId: null, channelName: null };
  }

  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch-unavailable', channel: null, channelId: null, channelName: null };
  }

  const desiredChannelName = targetChannelName(nameOrProject);
  const listed = await listDiscordGuildChannels(options);
  const parentId = listed.ok ? parentIdForCreatedChannel(listed.channels, options) : discordProjectChannelParentId(options);
  const apiBase = options.discordApiBase || DISCORD_API_BASE;
  const body = {
    name: desiredChannelName,
    type: DISCORD_TEXT_CHANNEL_TYPE,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(options.discordProjectChannelTopic ? { topic: String(options.discordProjectChannelTopic).slice(0, 1024) } : {}),
  };
  const res = await fetchFn(`${apiBase}/guilds/${encodeURIComponent(guildId)}/channels`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res?.ok) {
    return {
      ok: false,
      reason: 'discord-channel-create-failed',
      status: res?.status || null,
      body: await safeText(res),
      desiredChannelName,
      channel: null,
      channelId: null,
      channelName: null,
    };
  }

  const channel = await safeJson(res);
  if (!channel?.id) {
    return { ok: false, reason: 'invalid-discord-channel-create-response', desiredChannelName, channel: null, channelId: null, channelName: null };
  }

  return {
    ok: true,
    reason: null,
    created: true,
    desiredChannelName,
    channel,
    channelId: String(channel.id || '').trim(),
    channelName: String(channel.name || desiredChannelName).trim(),
  };
}

export async function ensureDiscordTextChannelByName(nameOrProject, options = {}) {
  const found = await findDiscordTextChannelByName(nameOrProject, options);
  if (found.ok) return { ...found, created: false };
  if (found.reason !== 'discord-text-channel-not-found') return found;
  if (options.createMissingDiscordChannel === false) return found;
  return createDiscordTextChannel(nameOrProject, options);
}

function discordThreadAutoArchiveDuration(options = {}) {
  const value = Number.parseInt(
    options.discordThreadAutoArchiveDuration
    || process.env.BRIDGE_DISCORD_THREAD_AUTO_ARCHIVE_MINUTES
    || `${DEFAULT_THREAD_AUTO_ARCHIVE_DURATION}`,
    10,
  );
  return [60, 1440, 4320, 10080].includes(value) ? value : DEFAULT_THREAD_AUTO_ARCHIVE_DURATION;
}

export async function listDiscordActiveThreads(channelId, options = {}) {
  const token = discordBotToken(options);
  const parentChannelId = cleanEnv(channelId);
  const guild = await resolveDiscordGuildId(options);
  const guildId = guild.guildId;
  if (!token || !parentChannelId || !guild.ok || !guildId) {
    return {
      ok: false,
      reason: !token ? 'missing-discord-bot-token' : (!parentChannelId ? 'missing-parent-channel-id' : (guild.reason || 'missing-discord-guild-id')),
      threads: [],
    };
  }

  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch-unavailable', threads: [] };
  }

  const apiBase = options.discordApiBase || DISCORD_API_BASE;
  const res = await fetchFn(`${apiBase}/guilds/${encodeURIComponent(guildId)}/threads/active`, {
    method: 'GET',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
    },
  });

  if (!res?.ok) {
    return {
      ok: false,
      reason: 'discord-thread-lookup-failed',
      status: res?.status || null,
      body: await safeText(res),
      threads: [],
    };
  }

  const payload = await safeJson(res);
  const threads = Array.isArray(payload?.threads) ? payload.threads : [];
  return {
    ok: Array.isArray(payload?.threads),
    reason: Array.isArray(payload?.threads) ? null : 'invalid-discord-thread-list',
    threads,
  };
}

export async function findDiscordThreadByName(channelId, threadName, options = {}) {
  const desiredName = cleanEnv(threadName).slice(0, 100);
  const listed = await listDiscordActiveThreads(channelId, options);
  if (!listed.ok) {
    return { ...listed, desiredThreadName: desiredName, thread: null, threadId: null, threadName: null };
  }

  const thread = listed.threads.find((candidate) => (
    cleanEnv(candidate?.parent_id) === cleanEnv(channelId)
    && cleanEnv(candidate?.name) === desiredName
  ));

  if (!thread) {
    return {
      ok: false,
      reason: 'discord-thread-not-found',
      desiredThreadName: desiredName,
      thread: null,
      threadId: null,
      threadName: null,
    };
  }

  return {
    ok: true,
    reason: null,
    desiredThreadName: desiredName,
    thread,
    threadId: cleanEnv(thread.id),
    threadName: cleanEnv(thread.name),
    parentChannelId: cleanEnv(thread.parent_id) || cleanEnv(channelId),
  };
}

export async function createDiscordThread(channelId, threadName, options = {}) {
  const token = discordBotToken(options);
  const parentChannelId = cleanEnv(channelId);
  const desiredThreadName = cleanEnv(threadName).slice(0, 100);
  if (!token || !parentChannelId || !desiredThreadName) {
    return {
      ok: false,
      reason: !token ? 'missing-discord-bot-token' : (!parentChannelId ? 'missing-parent-channel-id' : 'missing-thread-name'),
      thread: null,
      threadId: null,
      threadName: null,
    };
  }

  const fetchFn = options.discordFetchFn || options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch-unavailable', thread: null, threadId: null, threadName: null };
  }

  const apiBase = options.discordApiBase || DISCORD_API_BASE;
  const body = {
    name: desiredThreadName,
    type: DISCORD_PUBLIC_THREAD_TYPE,
    auto_archive_duration: discordThreadAutoArchiveDuration(options),
  };
  const res = await fetchFn(`${apiBase}/channels/${encodeURIComponent(parentChannelId)}/threads`, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res?.ok) {
    return {
      ok: false,
      reason: 'discord-thread-create-failed',
      status: res?.status || null,
      body: await safeText(res),
      desiredThreadName,
      thread: null,
      threadId: null,
      threadName: null,
    };
  }

  const thread = await safeJson(res);
  if (!thread?.id) {
    return { ok: false, reason: 'invalid-discord-thread-create-response', desiredThreadName, thread: null, threadId: null, threadName: null };
  }

  return {
    ok: true,
    reason: null,
    created: true,
    desiredThreadName,
    thread,
    threadId: cleanEnv(thread.id),
    threadName: cleanEnv(thread.name) || desiredThreadName,
    parentChannelId: cleanEnv(thread.parent_id) || parentChannelId,
  };
}

export async function ensureDiscordThreadByName(channelId, threadName, options = {}) {
  const found = await findDiscordThreadByName(channelId, threadName, options);
  if (found.ok) return { ...found, created: false };
  if (found.reason !== 'discord-thread-not-found') return found;
  if (options.createMissingDiscordThread === false) return found;
  return createDiscordThread(channelId, threadName, options);
}
