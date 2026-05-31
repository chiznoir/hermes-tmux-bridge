import { latestAssistantMessage, readCodexLog } from './codex-log.js';
import { buildInteractions, recordCommand } from './interactions.js';
import { latestQuestionRequest, recordQuestionAnswer, recordQuestionRequest } from './question-answers.js';
import { sendToTmux, targetForSession } from './tmux.js';
import { getSessionById, listSessions } from './control-plane/registry.js';
import { appendAudit, readAuditLog } from './control-plane/audit-log.js';
import { decideBackend, normalizeCommandMode } from './control-plane/policy.js';
import { lockKeyForSession } from './control-plane/locks.js';
import { routeSessionEvents } from './control-plane/event-router.js';
import { readProjectChannelMap, resolveProjectChannel, updateProjectChannel } from './project-channels.js';
import { normalizeCommandTextForDispatch } from './command-normalizer.js';
import {
  CODEX_SEND_APPROVAL_KIND,
  appendApprovalDecision,
  approvalGateFromBody,
  approvalMarkerBase,
  approvalResponseFromQuestion,
  buildApprovalQuestionBody,
  classifyApprovalAnswer,
  latestApprovalDecision,
  readApprovalDecisions,
} from './codex-send-approvals.js';

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
  return JSON.parse(raw);
}

function publicSession(session) {
  return {
    bridgeSessionId: session.bridgeSessionId,
    codexThreadId: session.codexThreadId,
    codexSessionId: session.codexSessionId,
    threadId: session.threadId || null,
    tmuxId: session.tmuxId,
    project: session.project,
    kind: session.kind,
    status: session.status,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    lifecycleSessionId: session.lifecycleSessionId,
    hasBridgeLifecycle: session.hasBridgeLifecycle === true,
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
  const log = await readCodexLog(session.sessionLogPath);
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
  const latest = latestSignal(signals);
  if (!latest) {
    return {
      state: session.status === 'active' ? 'unknown' : (session.status || 'unknown'),
      latestEventType: null,
      latestAt: session.lastEventAt || session.startedAt || null,
      source: 'codex-log',
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
    source: 'codex-log',
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
  const log = await readCodexLog(session.sessionLogPath);
  const latest = latestAssistantMessage(log);
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
    lifecycleSessionId: session.lifecycleSessionId,
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
    let delivery;
    if (command.dryRun) {
      delivery = { ok: true, dryRun: true, backend, reason };
    } else {
      const target = targetForSession(session);
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
      kind: CODEX_SEND_APPROVAL_KIND,
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

async function resolveCodexSendApprovalAnswer({ session, body, question, result, projectRoot, lockManager, options }) {
  if (question?.kind !== CODEX_SEND_APPROVAL_KIND || !result.ok || result.duplicate) return null;
  const decision = classifyApprovalAnswer(result.record.answer);
  const base = approvalMarkerBase({ session, question, questionAnswer: result.record, body });

  if (!['send', 'reject', 'modify'].includes(decision.action)) {
    return {
      status: 400,
      delivery: { ok: false, status: 'invalid-approval-answer', backend: 'bridge-codex-send-approval', error: decision.error },
      approval: null,
      error: decision.error,
    };
  }

  const lockKey = `codex-send-approval:${session.bridgeSessionId || session.codexThreadId || 'unknown'}:${question.questionId}`;
  const lock = lockManager.acquire(lockKey, {
    questionId: question.questionId,
    questionAnswerId: result.record.questionAnswerId,
  });
  if (!lock.ok) {
    return {
      status: 409,
      delivery: { ok: false, status: 'lock-conflict', backend: 'bridge-codex-send-approval', error: 'approval already in progress' },
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
          backend: 'bridge-codex-send-approval',
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
        delivery: { ok: true, status: decision.state, backend: 'bridge-codex-send-approval' },
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
      delivery: { ok: true, status: 'send_claimed', backend: 'bridge-codex-send-approval' },
    }, { projectRoot });

    const commandText = question.metadata?.commandText;
    if (typeof commandText !== 'string' || !commandText.trim()) {
      const marker = await appendApprovalDecision({
        ...base,
        state: 'dispatch_failed',
        delivery: { ok: false, status: 'dispatch_failed', backend: 'bridge-codex-send-approval', error: 'approval commandText is missing' },
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
    const marker = await appendApprovalDecision({
      ...base,
      state: dispatched.delivery?.ok ? 'dispatch_succeeded' : 'dispatch_failed',
      interactionId: interaction.interactionId,
      claimedMarkerId: claimed.markerId,
      delivery: dispatched.delivery,
    }, { projectRoot });
    return {
      status: dispatched.status,
      delivery: {
        ...dispatched.delivery,
        status: dispatched.delivery?.ok ? 'dispatch-succeeded' : 'dispatch-failed',
      },
      approval: marker,
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
    lifecycleSessionId: session.lifecycleSessionId,
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
    return {
      status: result.status || 200,
      result,
      delivery: question?.kind === CODEX_SEND_APPROVAL_KIND
        ? { ok: true, status: 'duplicate', backend: 'bridge-codex-send-approval' }
        : undefined,
    };
  }
  await appendAudit('question_answer.accepted', { ...auditBase, questionAnswerId: result.record.questionAnswerId }, { projectRoot });
  const approval = await resolveCodexSendApprovalAnswer({ session, body, question, result, projectRoot, lockManager, options });
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
    lifecycleSessionId: session.lifecycleSessionId,
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

  if (req.method === 'POST' && parts[2] === 'question-answers' && parts.length === 3) {
    await sendQuestionAnswerRoute({ req, res, session, projectRoot, lockManager, options, json });
    return true;
  }

  return false;
}

export async function dispatchBridgeRoute(context) {
  return await sendAuditRoute(context)
    || await sendSessionsRoute(context)
    || await sendProjectChannelRoute(context)
    || await sendSessionRoute(context);
}
