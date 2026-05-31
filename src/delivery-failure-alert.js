const DEFAULT_DISCORD_SAFE_MESSAGE_CHARS = 1800;

export function sessionDisplayId(session = {}) {
  return session.lifecycleSessionId || session.bridgeSessionId || session.codexSessionId || session.threadId || 'unknown-session';
}

export function deliveryFailureAlertMessage(session = {}, event = {}, reason = 'unknown', options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_DISCORD_SAFE_MESSAGE_CHARS;
  const lines = [
    '# Bridge Notification Delivery Failed',
    '',
    '원래 알림을 대상 Discord channel/thread로 전송하지 못했습니다. 스레드 오염을 막기 위해 다른 세션이나 프로젝트 채널로 fallback하지 않았습니다.',
    `- event: ${event.type || 'unknown'}`,
    `- session: ${sessionDisplayId(session)}`,
    session.project ? `- project: ${session.project}` : null,
    event.eventId ? `- event_id: ${event.eventId}` : null,
    `- reason: ${reason}`,
    '',
    '원래 알림 본문은 다른 대상에 대신 보내지 않았고, delivery 상태와 실패 사유는 event index에 기록됩니다.',
  ].filter(Boolean).join('\n');
  return lines.length <= maxChars ? lines : lines.slice(0, maxChars);
}

export function deliveryFailureErrorMessage(eventType, alertResult = {}) {
  const base = `Discord session thread missing; refusing project-channel fallback for ${eventType || 'unknown'}`;
  if (alertResult.ok) return `${base}; alert sent to project channel`;
  return `${base}; alert failed: ${alertResult.reason || 'unknown'}`;
}
