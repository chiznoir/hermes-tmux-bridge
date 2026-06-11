function isRawSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function hasExplicitThreadName(session = {}, options = {}) {
  return Boolean(String(options.discordThreadName || session.discordThreadName || '').trim());
}

function hasHumanSessionThreadName(session = {}) {
  return Boolean(String(session.tmuxId || session.omxSessionId || session.session_id || session.lifecycleOwner || '').trim());
}

function shouldCreateThreadForSession(session = null, options = {}) {
  if (!session || Object.keys(session).length === 0) return true;
  if (session.isAuxiliaryCodexLog === true) return false;
  if (session.backend === 'gjc' || session.lifecycleOwner === 'gjc' || session.gjcSessionId) return true;
  if (session.hasOmxLifecycle === false) return options.createMissingDiscordThreadForCodexOnly === true;
  if (hasExplicitThreadName(session, options)) return true;
  const omxSessionId = session.omxSessionId || session.session_id;
  const codexSessionId = session.codexSessionId || session.codex_session_id || session.threadId || session.thread_id;
  if (session.hasOmxLifecycle === true && omxSessionId && codexSessionId && omxSessionId === codexSessionId && !session.lifecycleOwner) {
    return false;
  }
  const bridgeSessionId = session.bridgeSessionId || session.bridge_session_id;
  const candidate = session.tmuxId || omxSessionId || bridgeSessionId || codexSessionId || session.tmuxPaneId;
  if (!hasHumanSessionThreadName(session) && isRawSessionId(candidate)) {
    return false;
  }
  return true;
}

function isGjcSession(session = {}) {
  return session.backend === 'gjc' || session.lifecycleOwner === 'gjc' || Boolean(session.gjcSessionId);
}

export function shouldCreateMissingSessionThread(event = {}, options = {}) {
  if (options.createMissingDiscordThreadForAllEvents === true) return true;
  if (!shouldCreateThreadForSession(options.session, options)) return false;
  if (event.type === 'SessionEnd') return options.createMissingDiscordThreadForSessionEnd === true;
  if (event.type === 'FinalAnswer' || event.type === 'AgentResponse' || event.type === 'SessionIdle') {
    if (isGjcSession(options.session)) return true;
    return options.createMissingDiscordThreadForFinalAnswer === true
      || options.createMissingDiscordThreadForTerminalOutput === true;
  }
  return event.type === 'SessionStart' || event.type === 'CommandSubmitted' || event.type === 'AskPermission';
}

export function projectChannelTerminalTarget(channel = {}) {
  return {
    ok: true,
    channelId: channel.channelId,
    map: null,
    reason: 'terminal-event-without-session-thread',
    thread: {
      threadId: null,
      channelId: channel.channelId || null,
      threadName: null,
      mappingStatus: 'project-channel-terminal-event',
    },
  };
}


export function missingSessionThreadTarget(reason = 'missing-session-thread') {
  return {
    ok: false,
    channelId: null,
    map: null,
    reason,
    suppressDelivery: true,
    thread: {
      threadId: null,
      channelId: null,
      threadName: null,
      mappingStatus: 'missing-session-thread-suppressed',
    },
  };
}
