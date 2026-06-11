import { latestAssistantMessage, readCodexLog } from './codex-log.js';
import { launchGjcTmuxSession, buildGjcLaunchRequest } from './gjc-lifecycle.js';
import { latestGjcAssistantMessage, readGjcLog } from './gjc-log.js';
import { buildInteractions, recordCommand } from './interactions.js';
import { latestQuestionRequest, recordQuestionAnswer, recordQuestionRequest } from './question-answers.js';
import { isManagedTmuxTarget, killTmuxSession, sendToTmux, targetForSession } from './tmux.js';
import { getSessionById, listSessions } from './control-plane/registry.js';
import { appendAudit, readAuditLog } from './control-plane/audit-log.js';
import { decideBackend, normalizeCommandMode } from './control-plane/policy.js';
import { lockKeyForSession } from './control-plane/locks.js';
import { routeSessionEvents } from './control-plane/event-router.js';
import { readProjectChannelMap, resolveProjectChannel, updateProjectChannel } from './project-channels.js';
import { normalizeCommandTextForDispatch } from './command-normalizer.js';
import {
  GJC_CLARIFY_BACKEND,
  GJC_CLARIFY_KIND,
  appendGjcClarifyDecision,
  answerBodyForGjcClarify,
  gjcClarifyAnswerCommand,
  gjcClarifyQuestionId,
  latestGjcClarifyDecision,
  parseGjcClarifyRequest,
  readGjcClarifyDecisions,
  resolveGjcClarifyAutoAnswer,
} from './gjc-clarify.js';
import {
  TMUX_SEND_APPROVAL_KIND,
  appendApprovalDecision,
  approvalGateFromBody,
  approvalMarkerBase,
  approvalResponseFromQuestion,
  buildApprovalQuestionBody,
  classifyApprovalAnswer,
  latestApprovalDecision,
  readApprovalDecisions,
} from './tmux-send-approvals.js';
import {
  cancelGjcWorkflow,
  completeGjcWorkflow,
  createGjcWorkflow,
  getGjcWorkflow,
  workflowLockKeyFromBody,
} from './gjc-workflows.js';

const COMMAND_SUBMITTED_EVENT_TYPES = new Set(['CommandSubmitted']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method) {
  return MUTATING_METHODS.has(method);
}

function isFalseyParam(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase());
}

function isTruthyParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isTruthyBodyValue(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isFalseyBodyValue(value) {
  return value === false || value === 0 || ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase());
}

function positiveInt(value, defaultValue = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sessionListOptions(url, indexOptions = {}) {
  const next = { ...indexOptions };
  const limitParam = url.searchParams.get('limit') || url.searchParams.get('sessionScanLimit');
  if (limitParam && String(limitParam).toLowerCase() === 'all') {
    delete next.sessionScanLimit;
  } else {
    next.sessionScanLimit = positiveInt(limitParam, next.sessionScanLimit);
  }
  const includeCodexOnly = ['includeCodexOnly', 'includeNativeOnly', 'includeUnmappedSessions']
    .some((name) => isTruthyParam(url.searchParams.get(name)));
  if (includeCodexOnly) {
    next.includeCodexOnlySessions = true;
  }
  return next;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error('invalid_json');
    error.status = 400;
    error.code = 'invalid_json';
    error.cause = cause;
    throw error;
  }
}

function publicSession(session) {
  return {
    bridgeSessionId: session.bridgeSessionId,
    gjcSessionId: session.gjcSessionId || null,
    codexThreadId: session.codexThreadId,
    codexSessionId: session.codexSessionId,
    threadId: session.threadId || null,
    tmuxId: session.tmuxId,
    project: session.project,
    kind: session.kind,
    backend: session.backend || null,
    status: session.status,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    omxSessionId: session.omxSessionId,
    hasOmxLifecycle: session.hasOmxLifecycle === true,
    lifecycleOwner: session.lifecycleOwner || null,
    tmuxPaneId: session.tmuxPaneId,
    sessionLogPath: session.sessionLogPath,
    sources: session.sources || [],
  };
}

function resolveCommandNotificationFlushers(options = {}) {
  return Array.isArray(options.commandNotificationFlushers)
    ? options.commandNotificationFlushers.filter((flusher) => typeof flusher === 'function')
    : [];
}

function triggerCommandSubmittedNotifications(options = {}, interaction = {}) {
  const flushers = resolveCommandNotificationFlushers(options);
  if (flushers.length === 0) return;
  for (const flusher of flushers) {
    try {
      const result = flusher({
        reason: 'command-submitted',
        interactionId: interaction.interactionId || null,
        bootSince: interaction.submittedAt || new Date().toISOString(),
        eventTypes: new Set(COMMAND_SUBMITTED_EVENT_TYPES),
      });
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.error('[bridge-command-notification-flush]', error?.message || error);
        });
      }
    } catch (error) {
      console.error('[bridge-command-notification-flush]', error?.message || error);
    }
  }
}

function signalPriority(signal = {}) {
  if (signal.state === 'ask') return 50;
  if (signal.state === 'final') return 40;
  if (signal.state === 'idle') return 30;
  if (signal.state === 'working') return 20;
  return 0;
}

function latestSignal(signals = []) {
  return signals
    .filter((signal) => signal.timestamp)
    .sort((left, right) => {
      const delta = Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0);
      if (delta !== 0) return delta;
      return signalPriority(right) - signalPriority(left);
    })[0] || null;
}

async function readSessionLog(session = {}) {
  if (!session.sessionLogPath) return null;
  if (session.backend === 'gjc' || session.gjcSessionId) return readGjcLog(session.sessionLogPath);
  return readCodexLog(session.sessionLogPath);
}

function gjcSignals(log = {}) {
  const signals = [];
  for (const message of log.messages || []) {
    if (message.role === 'user') {
      signals.push({ state: 'working', latestEventType: 'CommandSubmitted', timestamp: message.timestamp });
    } else if (message.role === 'assistant' && message.phase === 'final_answer') {
      signals.push({ state: 'idle', lastSignal: 'final', latestEventType: 'SessionIdle', timestamp: message.timestamp });
    } else if (message.role === 'assistant' && (message.stopReason === 'toolUse' || message.hasToolCall || message.hasThinking || message.phase === 'commentary')) {
      signals.push({ state: 'working', latestEventType: 'Commentary', timestamp: message.timestamp });
    }
  }
  return signals;
}

function codexSignals(log = {}) {
  const signals = [];
  for (const event of log.events || []) {
    if (event.type === 'ask_permission') {
      signals.push({ state: 'ask', latestEventType: 'AskPermission', timestamp: event.timestamp });
    } else if (event.type === 'task_complete') {
      signals.push({ state: 'idle', lastSignal: 'final', latestEventType: 'SessionIdle', timestamp: event.timestamp });
    } else if (event.type === 'task_started') {
      signals.push({ state: 'working', latestEventType: 'TurnStart', timestamp: event.timestamp });
    } else if (event.type === 'agent_message' && event.phase === 'commentary') {
      signals.push({ state: 'working', latestEventType: 'Commentary', timestamp: event.timestamp });
    }
  }
  for (const message of log.messages || []) {
    if (message.role === 'user') {
      signals.push({ state: 'working', latestEventType: 'CommandSubmitted', timestamp: message.timestamp });
    } else if (message.role === 'assistant' && message.phase === 'final_answer') {
      signals.push({ state: 'final', latestEventType: 'FinalAnswer', timestamp: message.timestamp });
    } else if (message.role === 'assistant' && message.phase === 'commentary') {
      signals.push({ state: 'working', latestEventType: 'Commentary', timestamp: message.timestamp });
    }
  }
  return signals;
}

async function sessionActivity(session = {}) {
  if (session.status === 'ended') {
    return {
      state: 'ended',
      latestEventType: 'SessionEnd',
      latestAt: session.endedAt || session.lastEventAt || null,
      source: 'session-index',
    };
  }
  if (!session.sessionLogPath) {
    return {
      state: session.status === 'active' ? 'unknown' : (session.status || 'unknown'),
      latestEventType: null,
      latestAt: session.lastEventAt || session.startedAt || null,
      source: null,
    };
  }
  const log = await readSessionLog(session);
  const signals = session.backend === 'gjc' || session.gjcSessionId ? gjcSignals(log) : codexSignals(log);
  const latest = latestSignal(signals);
  if (!latest) {
    return {
      state: session.status === 'active' ? 'unknown' : (session.status || 'unknown'),
      latestEventType: null,
      latestAt: session.lastEventAt || session.startedAt || null,
      source: session.backend === 'gjc' || session.gjcSessionId ? 'gjc-log' : 'codex-log',
    };
  }
  const lastFinal = latestSignal(signals.filter((signal) => signal.state === 'final' || signal.lastSignal === 'final'));
  const lastAsk = latestSignal(signals.filter((signal) => signal.state === 'ask'));
  const lastPrompt = latestSignal(signals.filter((signal) => signal.latestEventType === 'CommandSubmitted'));
  return {
    state: latest.state,
    lastSignal: latest.lastSignal || latest.state,
    latestEventType: latest.latestEventType,
    latestAt: latest.timestamp,
    lastFinalAt: lastFinal?.timestamp || null,
    lastAskAt: lastAsk?.timestamp || null,
    lastPromptAt: lastPrompt?.timestamp || null,
    source: session.backend === 'gjc' || session.gjcSessionId ? 'gjc-log' : 'codex-log',
  };
}

async function publicSessionWithActivity(session) {
  const publicValue = publicSession(session);
  const activity = await sessionActivity(session);
  return {
    ...publicValue,
    activityState: activity.state,
    activity,
  };
}

async function sessionEvents(session, options = {}) {
  return routeSessionEvents(session, options);
}

async function latestIdle(session) {
  if (!session.sessionLogPath) {
    return { timestamp: null, fullText: '', truncated: false, sourceLogPath: null };
  }
  const log = await readSessionLog(session);
  const latest = session.backend === 'gjc' || session.gjcSessionId
    ? latestGjcAssistantMessage(log)
    : latestAssistantMessage(log);
  return {
    timestamp: latest?.timestamp || null,
    fullText: latest?.text || '',
    truncated: false,
    sourceLogPath: session.sessionLogPath,
  };
}

async function projectChannel(project, body = {}, options = {}) {
  const result = await updateProjectChannel(project, body, options);
  if (!result.ok) return result;
  await appendAudit('project.channel_mapped', {
    project: result.project,
    channelId: result.channelId,
    channelName: result.channelName,
  }, options);
  return result;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

function commandMetadataFromBody(body = {}, extraMetadata = {}) {
  const nested = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const metadata = compactObject({
    ...nested,
    ...extraMetadata,
    dryRun: isTruthyBodyValue(body.dryRun) ? true : undefined,
    source: body.source,
    discordInteractionId: body.discordInteractionId || body.discord_interaction_id,
    componentCustomId: body.componentCustomId || body.component_custom_id,
    componentAction: body.componentAction || body.component_action,
    componentActionId: body.componentActionId || body.component_action_id,
  });
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function commandNormalizeOptionsFromBody(body = {}) {
  const preserveRaw = isTruthyBodyValue(body.raw)
    || isTruthyBodyValue(body.preserveRaw)
    || isFalseyBodyValue(body.normalize);
  return { raw: preserveRaw, normalize: !preserveRaw };
}

function commandNormalizationMetadata(normalization = {}) {
  return {
    promptNormalization: compactObject({
      source: 'bridge-command-normalizer',
      changed: normalization.changed === true,
      rules: Array.isArray(normalization.rules) ? normalization.rules : [],
      rawCommandText: normalization.changed === true ? normalization.rawText : undefined,
    }),
  };
}

function slugifyTmuxToken(value) {
  return (String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'project');
}

function validateManagedGjcTarget(session = {}, target) {
  if (!(session.backend === 'gjc' || session.gjcSessionId)) return { ok: true };
  if (!target) {
    return { ok: false, reason: 'missing-managed-gjc-target', error: 'managed gjc tmux target unavailable for session' };
  }
  const expectations = {
    branch: session.gjcBranch || 'gjc',
    branchSlug: session.gjcBranchSlug || slugifyTmuxToken(session.gjcBranch || 'gjc'),
    project: session.gjcProject || slugifyTmuxToken(session.project || session.cwd || 'project'),
    ownerKey: session.gjcOwnerKey || undefined,
    startedAt: session.gjcStartedAt || undefined,
    sessionId: session.gjcSessionTag || session.gjcSessionId || undefined,
  };
  if (!isManagedTmuxTarget(target, expectations)) {
    return { ok: false, reason: 'unmanaged-gjc-target', error: 'managed gjc tmux target required for session' };
  }
  return { ok: true, expectations };
}

async function dispatchCommand({ session, body, commandText, interaction, projectRoot, lockManager, commandMetadata }) {
  const command = {
    mode: normalizeCommandMode(body.mode),
    visible: body.visible === true,
    dryRun: isTruthyBodyValue(body.dryRun),
  };
  const auditBase = {
    interactionId: interaction.interactionId,
    sessionId: session.bridgeSessionId,
    bridgeSessionId: session.bridgeSessionId,
    codexThreadId: session.codexThreadId,
    omxSessionId: session.omxSessionId,
    commandText,
    mode: command.mode,
    metadata: commandMetadata,
  };
  await appendAudit('command.accepted', auditBase, { projectRoot });

  const decision = decideBackend(session, command);
  if (decision.unsupported) {
    const delivery = {
      ok: false,
      backend: null,
      reason: decision.reason,
      error: 'codex command backend is unsupported in this production bridge; use mode "tmux"',
    };
    await appendAudit('command.failed', { ...auditBase, backend: delivery.backend, delivery, error: delivery.error }, { projectRoot });
    return { status: 501, interaction, delivery };
  }

  const lockKey = lockKeyForSession(session);
  const lock = lockManager.acquire(lockKey, { interactionId: interaction.interactionId, codexThreadId: session.codexThreadId });
  if (!lock.ok) {
    await appendAudit('command.lock_conflict', { ...auditBase, lockKey, error: 'command already in progress for session' }, { projectRoot });
    return {
      status: 409,
      interaction,
      delivery: { ok: false, backend: null, reason: 'lock-conflict', error: 'command already in progress for session' },
    };
  }

  try {
    const backend = decision.backend;
    const reason = decision.reason;
    const target = targetForSession(session);
    const managedTarget = validateManagedGjcTarget(session, target);
    if (!managedTarget.ok) {
      const delivery = { ok: false, backend: 'tmux', reason: managedTarget.reason, error: managedTarget.error, target };
      await appendAudit('command.failed', { ...auditBase, backend: delivery.backend, delivery, error: delivery.error }, { projectRoot });
      return { status: 409, interaction, delivery };
    }
    let delivery;
    if (command.dryRun) {
      delivery = { ok: true, dryRun: true, backend, reason, target };
    } else {
      delivery = {
        ...sendToTmux(target, commandText, { submit: !isFalseyBodyValue(body.submit) }),
        backend: 'tmux',
        reason,
        target,
      };
    }

    const eventType = delivery.ok ? 'command.completed' : 'command.failed';
    await appendAudit(eventType, { ...auditBase, backend: delivery.backend, delivery, error: delivery.error }, { projectRoot });
    return { status: delivery.ok ? 202 : 502, interaction, delivery };
  } finally {
    lock.release?.();
  }
}

function approvalCommandMetadata(question = {}, questionAnswer = {}) {
  const metadata = question.metadata && typeof question.metadata === 'object' ? question.metadata : {};
  const commandMetadata = metadata.commandMetadata && typeof metadata.commandMetadata === 'object' ? metadata.commandMetadata : {};
  return {
    ...commandMetadata,
    approval: compactObject({
      kind: TMUX_SEND_APPROVAL_KIND,
      gate: metadata.gate,
      questionId: question.questionId,
      questionAnswerId: questionAnswer.questionAnswerId,
      discordInteractionId: questionAnswer.discordInteractionId,
    }),
  };
}

function approvalCommandBody(question = {}) {
  const metadata = question.metadata && typeof question.metadata === 'object' ? question.metadata : {};
  return metadata.commandBody && typeof metadata.commandBody === 'object' ? metadata.commandBody : {};
}

async function resolveTmuxSendApprovalAnswer({ session, body, question, result, projectRoot, lockManager, options }) {
  if (question?.kind !== TMUX_SEND_APPROVAL_KIND || !result.ok || result.duplicate) return null;
  const decision = classifyApprovalAnswer(result.record.answer);
  const base = approvalMarkerBase({ session, question, questionAnswer: result.record, body });

  if (!['send', 'reject', 'modify'].includes(decision.action)) {
    return {
      status: 400,
      delivery: { ok: false, status: 'invalid-approval-answer', backend: 'bridge-tmux-send-approval', error: decision.error },
      approval: null,
      error: decision.error,
    };
  }

  const lockKey = `tmux-send-approval:${session.bridgeSessionId || session.codexThreadId || 'unknown'}:${question.questionId}`;
  const lock = lockManager.acquire(lockKey, {
    questionId: question.questionId,
    questionAnswerId: result.record.questionAnswerId,
  });
  if (!lock.ok) {
    return {
      status: 409,
      delivery: { ok: false, status: 'lock-conflict', backend: 'bridge-tmux-send-approval', error: 'approval already in progress' },
      approval: null,
    };
  }

  try {
    const existing = latestApprovalDecision(await readApprovalDecisions(session, question.questionId, { projectRoot }));
    if (existing) {
      return {
        status: existing.state === 'send_claimed' ? 409 : 200,
        delivery: {
          ok: existing.state !== 'dispatch_failed',
          status: 'already-finalized',
          backend: 'bridge-tmux-send-approval',
          state: existing.state,
          interactionId: existing.interactionId || null,
        },
        approval: existing,
      };
    }

    if (decision.action === 'reject' || decision.action === 'modify') {
      const marker = await appendApprovalDecision({
        ...base,
        state: decision.state,
        modificationText: decision.text,
        delivery: { ok: true, status: decision.state, backend: 'bridge-tmux-send-approval' },
      }, { projectRoot });
      return {
        status: 202,
        delivery: marker.delivery,
        approval: marker,
      };
    }

    const claimed = await appendApprovalDecision({
      ...base,
      state: 'send_claimed',
      delivery: { ok: true, status: 'send_claimed', backend: 'bridge-tmux-send-approval' },
    }, { projectRoot });

    const commandText = question.metadata?.commandText;
    if (typeof commandText !== 'string' || !commandText.trim()) {
      const marker = await appendApprovalDecision({
        ...base,
        state: 'dispatch_failed',
        delivery: { ok: false, status: 'dispatch_failed', backend: 'bridge-tmux-send-approval', error: 'approval commandText is missing' },
      }, { projectRoot });
      return { status: 500, delivery: marker.delivery, approval: marker };
    }

    const commandMetadata = approvalCommandMetadata(question, result.record);
    const commandBody = approvalCommandBody(question);
    const interaction = await recordCommand(session, commandText, {
      projectRoot,
      dryRun: isTruthyBodyValue(commandBody.dryRun),
      metadata: commandMetadata,
    });
    if (!isTruthyBodyValue(commandBody.dryRun)) triggerCommandSubmittedNotifications(options, interaction);
    const dispatched = await dispatchCommand({
      session,
      body: commandBody,
      commandText,
      interaction,
      projectRoot,
      lockManager,
      commandMetadata,
    });
    const approvalDelivery = {
      ok: dispatched.delivery?.ok === true,
      status: dispatched.delivery?.ok ? 'dispatch-succeeded' : 'dispatch-failed',
      backend: 'bridge-tmux-send-approval',
      dispatchDelivery: dispatched.delivery,
    };
    const marker = await appendApprovalDecision({
      ...base,
      state: dispatched.delivery?.ok ? 'dispatch_succeeded' : 'dispatch_failed',
      interactionId: interaction.interactionId,
      claimedMarkerId: claimed.markerId,
      delivery: approvalDelivery,
      dispatchDelivery: dispatched.delivery,
    }, { projectRoot });
    return {
      status: dispatched.status,
      delivery: marker.delivery,
      approval: marker,
      interaction,
    };
  } finally {
    lock.release?.();
  }
}

function gjcClarifyAnswerText(answer = {}) {
  if (answer.kind === 'multi') return JSON.stringify(answer.value || answer.selected_values || []);
  if (answer.kind === 'other') return answer.other_text || answer.value || '';
  return Array.isArray(answer.value) ? JSON.stringify(answer.value) : String(answer.value || '');
}

async function reconcileGjcClarifyDispatch({ session, question, existing, projectRoot }) {
  if (existing?.state !== 'dispatch_started' || !existing.interactionId) return null;
  const records = await readAuditLog({ sessionId: session.bridgeSessionId, limit: 500 }, { projectRoot });
  const terminal = [...records].reverse().find((record) => {
    return record.interactionId === existing.interactionId
      && (record.eventType === 'command.completed' || record.eventType === 'command.failed');
  });
  if (!terminal) return null;

  const ok = terminal.eventType === 'command.completed' && terminal.delivery?.ok === true;
  return appendGjcClarifyDecision({
    sessionId: existing.sessionId || session.bridgeSessionId,
    bridgeSessionId: existing.bridgeSessionId || session.bridgeSessionId,
    gjcSessionId: existing.gjcSessionId || session.gjcSessionId || null,
    questionId: existing.questionId || question.questionId,
    questionAnswerId: existing.questionAnswerId || null,
    clarifyId: existing.clarifyId,
    answerSource: existing.answerSource || null,
    state: ok ? 'dispatch_completed' : 'dispatch_failed',
    claimedMarkerId: existing.claimedMarkerId || null,
    dispatchStartedMarkerId: existing.markerId,
    interactionId: existing.interactionId,
    delivery: {
      ok,
      status: ok ? 'dispatch-completed' : 'dispatch-failed',
      backend: GJC_CLARIFY_BACKEND,
      recoveredFromAudit: true,
      auditId: terminal.auditId,
      dispatchDelivery: terminal.delivery,
    },
    dispatchDelivery: terminal.delivery,
  }, { projectRoot });
}

async function resolveGjcClarifyAnswer({ session, body, question, result, projectRoot, lockManager, options }) {
  if (question?.kind !== GJC_CLARIFY_KIND || !result.ok) return null;
  const metadata = question.metadata?.gjcClarify && typeof question.metadata.gjcClarify === 'object'
    ? question.metadata.gjcClarify
    : {};
  const clarifyId = metadata.clarifyId;
  if (!clarifyId) {
    return {
      status: 400,
      delivery: { ok: false, status: 'invalid-clarify-question', backend: GJC_CLARIFY_BACKEND, error: 'gjc clarify metadata is missing' },
      gjcClarify: null,
      error: 'gjc clarify metadata is missing',
    };
  }

  const lockKey = `gjc-clarify:${session.bridgeSessionId || session.gjcSessionId || session.codexThreadId || 'unknown'}:${question.questionId}`;
  const lock = lockManager.acquire(lockKey, {
    questionId: question.questionId,
    questionAnswerId: result.record.questionAnswerId,
  });
  if (!lock.ok) {
    return {
      status: 409,
      delivery: { ok: false, status: 'lock-conflict', backend: GJC_CLARIFY_BACKEND, error: 'gjc clarify answer already in progress' },
      gjcClarify: null,
    };
  }

  try {
    const existing = latestGjcClarifyDecision(await readGjcClarifyDecisions(session, question.questionId, { projectRoot }));
    if (existing) {
      const reconciled = await reconcileGjcClarifyDispatch({ session, question, existing, projectRoot });
      if (reconciled) {
        return {
          status: reconciled.state === 'dispatch_completed' ? 200 : 502,
          delivery: reconciled.delivery,
          gjcClarify: reconciled,
        };
      }
      const completed = existing.state === 'dispatch_completed';
      return {
        status: completed ? 200 : 202,
        delivery: {
          ok: completed,
          status: completed ? 'already-finalized' : 'dispatch-status-unknown',
          backend: GJC_CLARIFY_BACKEND,
          state: existing.state,
          interactionId: existing.interactionId || null,
          error: completed ? undefined : 'gjc clarify dispatch started but no terminal marker was recorded; manual reconciliation required',
        },
        gjcClarify: existing,
      };
    }

    const answerSource = options.gjcClarifyAutoAnswer === true && metadata.answerSource === 'auto-fact' ? 'auto-fact' : 'user';
    const answerText = gjcClarifyAnswerText(result.record.answer);
    const base = {
      sessionId: session.bridgeSessionId,
      bridgeSessionId: session.bridgeSessionId,
      gjcSessionId: session.gjcSessionId || null,
      questionId: question.questionId,
      questionAnswerId: result.record.questionAnswerId,
      clarifyId,
      answerSource,
    };
    const claimed = await appendGjcClarifyDecision({
      ...base,
      state: answerSource === 'auto-fact' ? 'auto_answer_claimed' : 'user_answer_claimed',
    }, { projectRoot });

    const commandText = gjcClarifyAnswerCommand({ clarifyId, answer: answerText, source: answerSource });
    const commandMetadata = {
      gjcClarify: compactObject({
        kind: GJC_CLARIFY_KIND,
        questionId: question.questionId,
        questionAnswerId: result.record.questionAnswerId,
        clarifyId,
        answerSource,
      }),
    };
    const interaction = await recordCommand(session, commandText, {
      projectRoot,
      dryRun: false,
      metadata: commandMetadata,
    });
    triggerCommandSubmittedNotifications(options, interaction);
    const dispatchStarted = await appendGjcClarifyDecision({
      ...base,
      state: 'dispatch_started',
      claimedMarkerId: claimed.markerId,
      interactionId: interaction.interactionId,
      delivery: { ok: false, status: 'dispatch-started', backend: GJC_CLARIFY_BACKEND },
    }, { projectRoot });
    const dispatched = await dispatchCommand({
      session,
      body: { mode: 'tmux', submit: true, dryRun: false },
      commandText,
      interaction,
      projectRoot,
      lockManager,
      commandMetadata,
    });
    const delivery = {
      ok: dispatched.delivery?.ok === true,
      status: dispatched.delivery?.ok ? 'dispatch-completed' : 'dispatch-failed',
      backend: GJC_CLARIFY_BACKEND,
      dispatchDelivery: dispatched.delivery,
    };
    const marker = await appendGjcClarifyDecision({
      ...base,
      state: dispatched.delivery?.ok ? 'dispatch_completed' : 'dispatch_failed',
      claimedMarkerId: claimed.markerId,
      dispatchStartedMarkerId: dispatchStarted.markerId,
      interactionId: interaction.interactionId,
      delivery,
      dispatchDelivery: dispatched.delivery,
    }, { projectRoot });
    return {
      status: dispatched.status,
      delivery: marker.delivery,
      gjcClarify: marker,
      interaction,
    };
  } finally {
    lock.release?.();
  }
}

async function dispatchQuestionAnswer({ session, body, projectRoot, lockManager, options }) {
  const auditBase = {
    sessionId: session.bridgeSessionId,
    bridgeSessionId: session.bridgeSessionId,
    codexThreadId: session.codexThreadId,
    omxSessionId: session.omxSessionId,
    questionId: body.questionId || body.question_id || null,
    answerSource: body.source || 'bridge-question-answer',
    discordInteractionId: body.discordInteractionId || body.discord_interaction_id || null,
    componentCustomId: body.componentCustomId || body.component_custom_id || null,
  };
  const question = await latestQuestionRequest(session, body.questionId || body.question_id, { projectRoot });
  const result = await recordQuestionAnswer(session, body, { projectRoot });
  if (!result.ok) {
    await appendAudit('question_answer.failed', { ...auditBase, error: result.error }, { projectRoot });
    return { status: result.status || 400, result };
  }
  if (result.duplicate) {
    await appendAudit('question_answer.duplicate', { ...auditBase, questionAnswerId: result.record.questionAnswerId }, { projectRoot });
    if (question?.kind === GJC_CLARIFY_KIND) {
      const gjcClarify = await resolveGjcClarifyAnswer({ session, body, question, result, projectRoot, lockManager, options });
      if (gjcClarify?.error) {
        await appendAudit('question_answer.failed', { ...auditBase, questionAnswerId: result.record.questionAnswerId, error: gjcClarify.error }, { projectRoot });
      } else if (gjcClarify) {
        await appendAudit('question_answer.resolved', {
          ...auditBase,
          questionAnswerId: result.record.questionAnswerId,
          duplicate: true,
          gjcClarify: gjcClarify.gjcClarify,
          delivery: gjcClarify.delivery,
        }, { projectRoot });
        return {
          status: gjcClarify.status,
          result,
          delivery: gjcClarify.delivery,
          gjcClarify: gjcClarify.gjcClarify,
          interaction: gjcClarify.interaction,
        };
      }
    }
    return {
      status: result.status || 200,
      result,
      delivery: question?.kind === TMUX_SEND_APPROVAL_KIND
        ? { ok: true, status: 'duplicate', backend: 'bridge-tmux-send-approval' }
        : undefined,
    };
  }
  await appendAudit('question_answer.accepted', { ...auditBase, questionAnswerId: result.record.questionAnswerId }, { projectRoot });
  const approval = await resolveTmuxSendApprovalAnswer({ session, body, question, result, projectRoot, lockManager, options });
  if (approval) {
    if (approval.error) {
      await appendAudit('question_answer.failed', { ...auditBase, questionAnswerId: result.record.questionAnswerId, error: approval.error }, { projectRoot });
    } else {
      await appendAudit('question_answer.resolved', {
        ...auditBase,
        questionAnswerId: result.record.questionAnswerId,
        approval: approval.approval,
        delivery: approval.delivery,
      }, { projectRoot });
    }
    return { status: approval.status, result, delivery: approval.delivery, approval: approval.approval, interaction: approval.interaction };
  }
  const gjcClarify = await resolveGjcClarifyAnswer({ session, body, question, result, projectRoot, lockManager, options });
  if (gjcClarify) {
    if (gjcClarify.error) {
      await appendAudit('question_answer.failed', { ...auditBase, questionAnswerId: result.record.questionAnswerId, error: gjcClarify.error }, { projectRoot });
    } else {
      await appendAudit('question_answer.resolved', {
        ...auditBase,
        questionAnswerId: result.record.questionAnswerId,
        gjcClarify: gjcClarify.gjcClarify,
        delivery: gjcClarify.delivery,
      }, { projectRoot });
    }
    return {
      status: gjcClarify.status,
      result,
      delivery: gjcClarify.delivery,
      gjcClarify: gjcClarify.gjcClarify,
      interaction: gjcClarify.interaction,
    };
  }
  await appendAudit('question_answer.queued', {
    ...auditBase,
    questionAnswerId: result.record.questionAnswerId,
    answer: result.record.answer,
    delivery: { ok: true, status: 'queued', backend: 'bridge-question-answer-queue' },
  }, { projectRoot });
  return { status: result.status || 202, result };
}

async function dispatchQuestionRequest({ session, body, projectRoot }) {
  const result = await recordQuestionRequest(session, body, { projectRoot });
  const auditBase = {
    sessionId: session.bridgeSessionId,
    bridgeSessionId: session.bridgeSessionId,
    codexThreadId: session.codexThreadId,
    omxSessionId: session.omxSessionId,
    questionId: body.questionId || body.question_id || null,
    questionSource: body.source || 'bridge-question-request',
  };
  if (!result.ok) {
    await appendAudit('question_request.failed', { ...auditBase, error: result.error }, { projectRoot });
    return { status: result.status || 400, result };
  }
  await appendAudit('question_request.accepted', {
    ...auditBase,
    questionRequestId: result.record.questionRequestId,
    type: result.record.type,
    allowOther: result.record.allow_other,
  }, { projectRoot });
  return { status: result.status || 202, result };
}

async function workflowGjcSession(workflow = {}, indexOptions = {}) {
  const ids = [
    workflow.linkedBridgeSessionId,
    workflow.linkedGjcSessionId,
    workflow.launch?.gjcSessionId,
    workflow.launch?.bridgeSessionId,
  ].filter(Boolean);
  for (const id of ids) {
    const session = await getSessionById(id, indexOptions);
    if (session) return session;
  }

  const expectedPaths = new Set([
    workflow.launch?.worktree,
    workflow.launch?.cwd,
    workflow.worktreePath,
    workflow.targetRepoPath,
  ].filter(Boolean).map((value) => String(value)));
  const expectedTmux = new Set([
    workflow.launch?.tmuxId,
    workflow.launch?.tmuxPaneId,
  ].filter(Boolean).map((value) => String(value)));
  if (expectedPaths.size === 0 && expectedTmux.size === 0) return null;

  const sessions = (await listSessions(indexOptions)).filter((candidate) => candidate.backend === 'gjc');
  const tmuxMatches = sessions.filter((candidate) => {
    return [candidate.tmuxId, candidate.tmuxPaneId]
      .filter(Boolean)
      .some((value) => expectedTmux.has(String(value)));
  });
  const pathMatches = sessions.filter((candidate) => {
    return [candidate.cwd, candidate.paneCurrentPath]
      .filter(Boolean)
      .some((value) => expectedPaths.has(String(value)));
  });
  if (tmuxMatches.length > 1 || pathMatches.length > 1) return null;
  if (tmuxMatches.length === 1 && pathMatches.length === 1) {
    return tmuxMatches[0].bridgeSessionId === pathMatches[0].bridgeSessionId ? tmuxMatches[0] : null;
  }
  if (tmuxMatches.length === 1) return tmuxMatches[0];
  if (pathMatches.length === 1) return pathMatches[0];
  return null;
}

function observedClarifyMetadata({ workflow, session, message }) {
  return {
    workflowId: workflow.workflowId,
    latestEventId: message?.id || null,
    sourceLogPath: session?.sessionLogPath || null,
  };
}

function clarifyResponse(status, question = null, extra = {}) {
  return {
    clarify: {
      status,
      ...(question ? {
        question,
        answer_endpoint: question.answerEndpoint,
      } : {}),
      ...extra,
    },
  };
}

async function handleGjcWorkflowClarify({ workflow, session, projectRoot, lockManager, options }) {
  if (!session) {
    return { status: 409, body: clarifyResponse('blocked', null, { reason: 'linked GJC session not found' }) };
  }
  const log = await readSessionLog(session);
  const message = latestGjcAssistantMessage(log);
  const parsed = parseGjcClarifyRequest(message?.text || '');
  if (!parsed.ok) {
    return { status: parsed.status === 404 ? 404 : 409, body: clarifyResponse('blocked', null, { reason: parsed.reason, error: parsed.error || null }) };
  }

  const request = parsed.request;
  const observed = observedClarifyMetadata({ workflow, session, message });
  const questionId = gjcClarifyQuestionId(workflow.workflowId, request.clarifyId);
  const auto = resolveGjcClarifyAutoAnswer(request, workflow, observed);
  const questionBody = {
    questionId,
    kind: GJC_CLARIFY_KIND,
    question: request.question,
    type: request.type,
    options: request.options,
    allow_other: request.allow_other,
    other_label: request.other_label,
    source: GJC_CLARIFY_BACKEND,
    metadata: {
      gjcClarify: compactObject({
        version: 1,
        workflowId: workflow.workflowId,
        clarifyId: request.clarifyId,
        classificationHint: request.classificationHint,
        requestedFacts: request.requestedFacts,
        reason: request.reason,
        raw: request.raw,
        latestEventId: observed.latestEventId,
        sourceLogPath: observed.sourceLogPath,
        answerSource: auto.ok ? 'auto-fact' : null,
        evidence: auto.ok ? auto.evidence : null,
      }),
    },
  };
  const question = await dispatchQuestionRequest({ session, body: questionBody, projectRoot });
  if (!question.result.ok) {
    return { status: question.status, body: clarifyResponse('blocked', null, { reason: question.result.error }) };
  }
  if (!auto.ok) {
    return {
      status: 202,
      body: clarifyResponse('question-pending', question.result.record, { render: 'hermes-clarify-required', reason: auto.reason }),
    };
  }

  const idempotencyKey = `gjc-clarify:${workflow.workflowId}:${request.clarifyId}:auto-fact`;
  const answerBody = answerBodyForGjcClarify({
    questionId,
    answer: auto.answer,
    type: request.type,
    options: request.options,
    idempotencyKey,
    source: 'bridge-gjc-clarify-auto',
  });
  if (!answerBody.ok) {
    return {
      status: 202,
      body: clarifyResponse('question-pending', question.result.record, { render: 'hermes-clarify-required', reason: answerBody.reason }),
    };
  }
  const answer = await dispatchQuestionAnswer({
    session,
    body: answerBody.body,
    projectRoot,
    lockManager,
    options: { ...options, gjcClarifyAutoAnswer: true },
  });
  const status = answer.delivery?.ok
    ? (answer.delivery.status === 'already-finalized' ? 'already-finalized' : 'auto-answered')
    : (answer.delivery?.status === 'dispatch-status-unknown' ? 'dispatch-status-unknown' : 'dispatch-failed');
  return {
    status: answer.status,
    body: clarifyResponse(status, question.result.record, {
      answer: answer.result.record,
      dispatch: answer.delivery,
      gjcClarify: answer.gjcClarify,
    }),
  };
}

async function sendAuditRoute({ req, res, url, projectRoot, json }) {
  if (req.method !== 'GET' || url.pathname !== '/audit') return false;
  const filters = Object.fromEntries(url.searchParams.entries());
  json(res, 200, { audit: await readAuditLog(filters, { projectRoot }) });
  return true;
}

async function sendSessionsRoute({ req, res, url, indexOptions, json }) {
  if (req.method !== 'GET' || url.pathname !== '/sessions') return false;
  const listOptions = sessionListOptions(url, indexOptions);
  const sessions = await listSessions(listOptions);
  const includeActivity = !isFalseyParam(url.searchParams.get('activity'));
  const publicSessions = includeActivity
    ? await Promise.all(sessions.map(publicSessionWithActivity))
    : sessions.map(publicSession);
  json(res, 200, {
    sessions: publicSessions,
    meta: {
      activity: includeActivity,
      sessionScanLimit: listOptions.sessionScanLimit || null,
      includeCodexOnlySessions: listOptions.includeCodexOnlySessions === true,
    },
  });
  return true;
}

async function sendGjcSessionsRoute({ req, res, parts, projectRoot, options, lockManager, json }) {
  if (!(req.method === 'POST' && parts[0] === 'gjc' && parts[1] === 'sessions' && parts.length === 2)) return false;
  const body = await readJsonBody(req);
  const launchRequest = typeof options.buildGjcLaunchRequestFn === 'function'
    ? options.buildGjcLaunchRequestFn(body, { ...options, projectRoot })
    : buildGjcLaunchRequest(body, { ...options, projectRoot });
  const lockKey = `gjc-launch:${launchRequest.worktree || launchRequest.cwd}`;
  const lock = lockManager.acquire(lockKey, { operation: 'gjc-session-launch', requestId: launchRequest.requestId });
  if (!lock.ok) {
    await appendAudit('gjc.session.launch.lock_conflict', { lockKey, requestId: launchRequest.requestId, error: 'gjc session launch already in progress' }, { projectRoot });
    json(res, 409, { error: 'gjc session launch already in progress' });
    return true;
  }

  try {
    await appendAudit('gjc.session.launch.accepted', {
      lockKey,
      requestId: launchRequest.requestId,
      cwd: launchRequest.cwd,
      worktree: launchRequest.worktree || null,
      backend: 'gjc-tmux',
    }, { projectRoot });
    const launchBody = {
      ...body,
      requestId: launchRequest.requestId,
      cwd: launchRequest.cwd,
      worktree: launchRequest.worktree,
      gjcBin: launchRequest.bin,
    };
    const launch = await launchGjcTmuxSession(launchBody, { ...options, projectRoot });
    const launchEvent = launch.ok
      ? (launch.reused ? 'gjc.session.launch.reused' : 'gjc.session.launch.started')
      : 'gjc.session.launch.failed';
    await appendAudit(launchEvent, {
      lockKey,
      requestId: launchRequest.requestId,
      backend: 'gjc-tmux',
      launch,
      error: launch.error || null,
    }, { projectRoot });
    json(res, launch.ok ? 202 : 502, {
      launch,
      next: {
        sessionsEndpoint: '/sessions',
        dispatchMode: 'tmux',
        resultSource: 'gjc-jsonl',
      },
    });
    return true;
  } finally {
    lock.release?.();
  }
}

async function sendGjcWorkflowsRoute({ req, res, parts, projectRoot, options, indexOptions, lockManager, json }) {
  if (!(parts[0] === 'gjc' && parts[1] === 'workflows')) return false;

  if (req.method === 'POST' && parts.length === 2) {
    const body = await readJsonBody(req);
    const lockKey = workflowLockKeyFromBody(body, { ...options, projectRoot });
    const lock = lockManager.acquire(lockKey, { operation: 'gjc-workflow-create' });
    if (!lock.ok) {
      await appendAudit('gjc.workflow.lock_conflict', { lockKey, error: 'gjc workflow already in progress' }, { projectRoot });
      json(res, 409, { error: 'gjc workflow already in progress' });
      return true;
    }
    try {
      const result = await createGjcWorkflow(body, { ...options, projectRoot });
      await appendAudit(result.ok ? 'gjc.workflow.accepted' : 'gjc.workflow.failed', {
        lockKey,
        workflowId: result.workflow?.workflowId || body.workflowId || null,
        state: result.workflow?.state || null,
        error: result.error || result.workflow?.failureReason || null,
      }, { projectRoot });
      json(res, result.status || (result.ok ? 202 : 400), result.ok ? {
        workflow: result.workflow,
        duplicate: result.duplicate === true,
        next: {
          sessionsEndpoint: '/sessions',
          dispatchMode: 'tmux',
          resultSource: 'gjc-jsonl',
        },
      } : { error: result.error || result.workflow?.failureReason, workflow: result.workflow });
      return true;
    } finally {
      lock.release?.();
    }
  }

  if (req.method === 'GET' && parts.length === 3) {
    const result = await getGjcWorkflow(parts[2], { ...options, projectRoot });
    json(res, result.status, result.ok ? { workflow: result.workflow } : { error: result.error });
    return true;
  }

  if (req.method === 'POST' && parts[3] === 'clarify' && parts.length === 4) {
    const workflowResult = await getGjcWorkflow(parts[2], { ...options, projectRoot });
    if (!workflowResult.ok) {
      json(res, workflowResult.status, { error: workflowResult.error });
      return true;
    }
    const session = await workflowGjcSession(workflowResult.workflow, indexOptions || {});
    const result = await handleGjcWorkflowClarify({
      workflow: workflowResult.workflow,
      session,
      projectRoot,
      lockManager,
      options,
    });
    await appendAudit(`gjc.workflow.clarify.${result.body.clarify.status}`, {
      workflowId: parts[2],
      status: result.body.clarify.status,
      questionId: result.body.clarify.question?.questionId || null,
      reason: result.body.clarify.reason || null,
    }, { projectRoot });
    json(res, result.status, result.body);
    return true;
  }

  if (req.method === 'POST' && parts[3] === 'complete' && parts.length === 4) {
    const body = await readJsonBody(req);
    const lockKey = `gjc-workflow:${parts[2]}`;
    const lock = lockManager.acquire(lockKey, { operation: 'gjc-workflow-complete' });
    if (!lock.ok) {
      await appendAudit('gjc.workflow.lock_conflict', { lockKey, workflowId: parts[2], error: 'gjc workflow already in progress' }, { projectRoot });
      json(res, 409, { error: 'gjc workflow already in progress' });
      return true;
    }
    try {
      const result = await completeGjcWorkflow(parts[2], body, { ...options, projectRoot });
      await appendAudit(result.ok ? 'gjc.workflow.completed' : 'gjc.workflow.completion_failed', {
        workflowId: parts[2],
        state: result.workflow?.state || null,
        phase: result.workflow?.phase || null,
        error: result.error || result.workflow?.failureReason || null,
      }, { projectRoot });
      json(res, result.status, result.ok ? { workflow: result.workflow } : { error: result.error || result.workflow?.failureReason, workflow: result.workflow });
    } finally {
      lock.release?.();
    }
    return true;
  }

  if (req.method === 'POST' && parts[3] === 'cancel' && parts.length === 4) {
    const lockKey = `gjc-workflow:${parts[2]}`;
    const lock = lockManager.acquire(lockKey, { operation: 'gjc-workflow-cancel' });
    if (!lock.ok) {
      await appendAudit('gjc.workflow.lock_conflict', { lockKey, workflowId: parts[2], error: 'gjc workflow already in progress' }, { projectRoot });
      json(res, 409, { error: 'gjc workflow already in progress' });
      return true;
    }
    try {
      const result = await cancelGjcWorkflow(parts[2], { ...options, projectRoot });
      await appendAudit(result.ok ? 'gjc.workflow.cancelled' : 'gjc.workflow.cancel_failed', {
        workflowId: parts[2],
        state: result.workflow?.state || null,
        error: result.error || null,
      }, { projectRoot });
      json(res, result.status, result.ok ? { workflow: result.workflow } : { error: result.error, workflow: result.workflow });
    } finally {
      lock.release?.();
    }
    return true;
  }

  return false;
}

async function sendProjectChannelRoute({ req, res, parts, projectRoot, json }) {
  if (!(parts[0] === 'projects' && parts[1] && parts[2] === 'channel' && parts.length === 3)) return false;
  const project = parts[1];
  if (req.method === 'GET') {
    const map = await readProjectChannelMap({ projectRoot });
    const resolved = resolveProjectChannel(project, map);
    json(res, 200, { ...resolved, map: { default: map.default || map.default_channel_id || null, projects: map.projects || {} } });
    return true;
  }
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await projectChannel(project, body, { projectRoot });
    json(res, result.status || 200, result.ok ? {
      ok: true,
      project: result.project,
      channelId: result.channelId,
      channelName: result.channelName,
    } : { error: result.error });
    return true;
  }
  return false;
}

async function sendQuestionRequestRoute({ req, res, session, projectRoot, json }) {
  const body = await readJsonBody(req);
  const result = await dispatchQuestionRequest({ session, body, projectRoot });
  if (!result.result.ok) {
    json(res, result.status, { error: result.result.error });
    return;
  }
  json(res, result.status, {
    question: result.result.record,
    answer_endpoint: result.result.record.answerEndpoint,
  });
}

async function sendCommandRoute({ req, res, session, options, projectRoot, lockManager, json }) {
  const body = await readJsonBody(req);
  const rawCommandText = typeof body.commandText === 'string' ? body.commandText : '';
  if (!rawCommandText.trim()) return json(res, 400, { error: 'commandText is required' });
  const approvalGate = approvalGateFromBody(body);
  if (!approvalGate.ok) return json(res, approvalGate.status || 400, { error: approvalGate.error });
  const normalization = normalizeCommandTextForDispatch(rawCommandText, commandNormalizeOptionsFromBody(body));
  const commandText = normalization.text;
  const commandMetadata = commandMetadataFromBody(body, commandNormalizationMetadata(normalization));
  const dryRun = isTruthyBodyValue(body.dryRun);
  const promptNormalization = {
    changed: normalization.changed === true,
    rules: normalization.rules || [],
  };

  if (approvalGate.enabled) {
    const questionBody = buildApprovalQuestionBody({
      session,
      commandText,
      commandMetadata,
      commandBody: compactObject({
        mode: body.mode,
        visible: body.visible === true ? true : undefined,
        dryRun,
        submit: body.submit,
      }),
      gate: approvalGate.gate,
    });
    const question = await dispatchQuestionRequest({ session, body: questionBody, projectRoot });
    if (!question.result.ok) return json(res, question.status, { error: question.result.error });
    return json(res, 202, approvalResponseFromQuestion(question.result.record, promptNormalization));
  }

  const interaction = await recordCommand(session, commandText, {
    projectRoot,
    dryRun,
    metadata: commandMetadata,
  });
  if (!dryRun) triggerCommandSubmittedNotifications(options, interaction);
  const result = await dispatchCommand({
    session,
    body,
    commandText,
    interaction,
    projectRoot,
    lockManager,
    commandMetadata,
  });
  return json(res, result.status, {
    interaction: result.interaction,
    delivery: result.delivery,
    promptNormalization,
  });
}

async function stopGjcSessionRoute({ req, res, session, options, projectRoot, lockManager, json }) {
  const body = await readJsonBody(req);
  if (!(session.backend === 'gjc' || session.gjcSessionId)) {
    return json(res, 409, { error: 'session is not a gjc session' });
  }
  const target = session.tmuxId || targetForSession(session);
  const managedTarget = validateManagedGjcTarget(session, target);
  if (!managedTarget.ok) {
    await appendAudit('gjc.session.stop.failed', {
      sessionId: session.bridgeSessionId,
      bridgeSessionId: session.bridgeSessionId,
      gjcSessionId: session.gjcSessionId,
      target,
      backend: 'tmux',
      error: managedTarget.error,
      stop: { ok: false, backend: 'tmux', reason: managedTarget.reason, error: managedTarget.error, target },
    }, { projectRoot });
    return json(res, 409, {
      stop: { ok: false, backend: 'tmux', reason: managedTarget.reason, error: managedTarget.error, target },
    });
  }

  const lockKey = lockKeyForSession(session);
  const lock = lockManager.acquire(lockKey, { operation: 'gjc-session-stop', gjcSessionId: session.gjcSessionId });
  if (!lock.ok) {
    await appendAudit('gjc.session.stop.lock_conflict', {
      sessionId: session.bridgeSessionId,
      bridgeSessionId: session.bridgeSessionId,
      gjcSessionId: session.gjcSessionId,
      lockKey,
      error: 'command already in progress for session',
    }, { projectRoot });
    return json(res, 409, { stop: { ok: false, reason: 'lock-conflict', error: 'command already in progress for session' } });
  }

  try {
    const auditBase = {
      sessionId: session.bridgeSessionId,
      bridgeSessionId: session.bridgeSessionId,
      gjcSessionId: session.gjcSessionId,
      target,
      backend: 'tmux',
    };
    await appendAudit('gjc.session.stop.accepted', auditBase, { projectRoot });
    const stop = isTruthyBodyValue(body.dryRun)
      ? { ok: true, dryRun: true, backend: 'tmux', target }
      : {
        ...(typeof options.stopGjcSessionFn === 'function'
          ? await options.stopGjcSessionFn(session, { target, projectRoot })
          : killTmuxSession(target)),
        backend: 'tmux',
        target,
      };
    await appendAudit(stop.ok ? 'gjc.session.stop.completed' : 'gjc.session.stop.failed', {
      ...auditBase,
      stop,
      error: stop.error || null,
    }, { projectRoot });
    return json(res, stop.ok ? 202 : 502, { stop });
  } finally {
    lock.release?.();
  }
}

async function sendQuestionAnswerRoute({ req, res, session, projectRoot, lockManager, options, json }) {
  const body = await readJsonBody(req);
  const result = await dispatchQuestionAnswer({ session, body, projectRoot, lockManager, options });
  if (!result.result.ok) {
    json(res, result.status, { error: result.result.error });
    return;
  }
  json(res, result.status, {
    questionAnswer: result.result.record,
    duplicate: result.result.duplicate === true,
    ...(result.approval ? { approval: result.approval } : {}),
    ...(result.gjcClarify ? { gjcClarify: result.gjcClarify } : {}),
    ...(result.interaction ? { interaction: result.interaction } : {}),
    delivery: result.delivery || {
      ok: true,
      status: 'queued',
      backend: 'bridge-question-answer-queue',
    },
  });
}

async function sendSessionRoute({ req, res, parts, indexOptions, projectRoot, options, lockManager, json, notFound }) {
  if (!(parts[0] === 'sessions' && parts[1])) return false;
  const session = await getSessionById(parts[1], indexOptions);
  if (!session) {
    notFound(res);
    return true;
  }

  if (req.method === 'GET' && parts.length === 2) {
    json(res, 200, await publicSessionWithActivity(session));
    return true;
  }

  if (req.method === 'GET' && parts[2] === 'events' && parts.length === 3) {
    json(res, 200, { events: await sessionEvents(session, { projectRoot }) });
    return true;
  }

  if (req.method === 'GET' && parts[2] === 'state' && parts.length === 3) {
    json(res, 200, {
      session: publicSession(session),
      activity: await sessionActivity(session),
    });
    return true;
  }

  if (req.method === 'GET' && parts[2] === 'idle' && parts[3] === 'latest' && parts.length === 4) {
    json(res, 200, await latestIdle(session));
    return true;
  }

  if (req.method === 'GET' && parts[2] === 'interactions' && parts.length === 3) {
    json(res, 200, { interactions: await buildInteractions(session, { projectRoot }) });
    return true;
  }

  if (req.method === 'POST' && parts[2] === 'questions' && parts.length === 3) {
    await sendQuestionRequestRoute({ req, res, session, projectRoot, json });
    return true;
  }

  if (req.method === 'POST' && parts[2] === 'commands' && parts.length === 3) {
    await sendCommandRoute({ req, res, session, options, projectRoot, lockManager, json });
    return true;
  }

  if (req.method === 'POST' && parts[2] === 'stop' && parts.length === 3) {
    await stopGjcSessionRoute({ req, res, session, options, projectRoot, lockManager, json });
    return true;
  }

  if (req.method === 'POST' && parts[2] === 'question-answers' && parts.length === 3) {
    await sendQuestionAnswerRoute({ req, res, session, projectRoot, lockManager, options, json });
    return true;
  }

  return false;
}

export async function dispatchBridgeRoute(context) {
  return await sendAuditRoute(context)
    || await sendSessionsRoute(context)
    || await sendGjcWorkflowsRoute(context)
    || await sendGjcSessionsRoute(context)
    || await sendProjectChannelRoute(context)
    || await sendSessionRoute(context);
}
