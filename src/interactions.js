import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDirFor, readJsonl } from './jsonl.js';
import { nextAssistantAfter, readCodexLog, userMessages } from './codex-log.js';
import { bridgeStatePath } from './bridge-paths.js';

export function bridgeLogPath(_projectRoot = process.cwd(), options = {}) {
  const projectRoot = _projectRoot;
  return process.env.BRIDGE_LOG_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-interactions.jsonl', options)
      : join(projectRoot, '.codex', 'logs', 'bridge-interactions.jsonl'));
}

export async function recordCommand(session, commandText, options = {}) {
  const now = new Date().toISOString();
  const entry = {
    interactionId: options.interactionId || randomUUID(),
    codexSessionId: session.codexSessionId,
    lifecycleSessionId: session.lifecycleSessionId,
    threadId: session.threadId,
    tmuxId: session.tmuxId,
    tmuxPaneId: session.tmuxPaneId,
    commandText,
    dryRun: options.dryRun === true,
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : undefined,
    submittedAt: now,
    source: 'bridge',
  };
  const path = bridgeLogPath(options.projectRoot, options);
  await ensureDirFor(path);
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function isDryRunBridgeCommand(record = {}) {
  const text = String(record.commandText || '').trim().toLowerCase();
  return record.dryRun === true
    || record.metadata?.dryRun === true
    || text === 'bridge binding smoke check';
}


function commandWithinSessionWindow(record = {}, session = {}) {
  const submittedMs = Date.parse(record.submittedAt || '');
  if (!Number.isFinite(submittedMs)) return true;
  const startMs = Date.parse(session.startedAt || '');
  if (Number.isFinite(startMs) && submittedMs < startMs - 60000) return false;
  const endMs = Date.parse(session.endedAt || '');
  if (Number.isFinite(endMs) && submittedMs > endMs + 120000) return false;
  return true;
}

export async function readBridgeCommands(session, options = {}) {
  const records = await readJsonl(bridgeLogPath(options.projectRoot, options));
  return records.filter((record) => {
    if (isDryRunBridgeCommand(record)) return false;
    if (!commandWithinSessionWindow(record, session)) return false;
    return [record.codexSessionId, record.lifecycleSessionId, record.threadId, record.tmuxId, record.tmuxPaneId]
      .filter(Boolean)
      .some((value) => [session.codexSessionId, session.lifecycleSessionId, session.threadId, session.tmuxId, session.tmuxPaneId].includes(value));
  });
}

export async function buildInteractions(session, options = {}) {
  const log = session.sessionLogPath ? await readCodexLog(session.sessionLogPath) : null;
  const bridgeCommands = await readBridgeCommands(session, options);
  const interactions = [];
  for (const command of bridgeCommands) {
    const response = log ? nextAssistantAfter(log, command.submittedAt) : null;
    interactions.push({
      interactionId: command.interactionId,
      commandText: command.commandText,
      submittedAt: command.submittedAt,
      responseText: response?.text || '',
      responseCompletedAt: response?.timestamp || null,
      confidence: response ? 'inferred' : 'inferred',
    });
  }

  if (log) {
    for (const message of userMessages(log)) {
      if (interactions.some((item) => item.commandText === message.text && item.submittedAt === message.timestamp)) continue;
      const response = nextAssistantAfter(log, message.timestamp);
      interactions.push({
        interactionId: `codex-${message.lineNumber}`,
        commandText: message.text,
        submittedAt: message.timestamp,
        responseText: response?.text || '',
        responseCompletedAt: response?.timestamp || null,
        confidence: 'exact',
      });
    }
  }

  return interactions.sort((a, b) => Date.parse(a.submittedAt || 0) - Date.parse(b.submittedAt || 0));
}
