export async function readTmuxHookRecords() {
  return [];
}

export async function readTmuxHookMappings() {
  return new Map();
}

export function hookRecordToRouterEvent(record = {}) {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return {
    eventId: `tmux-hook:${record.lineNumber || timestamp || 'hook'}`,
    type: 'TmuxHook',
    timestamp,
    source: 'tmux-hook',
    text: 'tmux hook event',
    backend: 'tmux',
  };
}
