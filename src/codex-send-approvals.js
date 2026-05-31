import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeStatePath } from './bridge-paths.js';
import { ensureDirFor, readJsonl } from './jsonl.js';

export const CODEX_SEND_APPROVAL_GATE = 'discord-hermes-codex-send';
export const CODEX_SEND_APPROVAL_KIND = 'codex-send-approval';

const SEND_VALUE = 'send';
const REJECT_VALUE = 'reject';
const MODIFY_VALUE = '__other__';
const FINAL_STATES = new Set(['send_claimed', 'dispatch_succeeded', 'dispatch_failed', 'rejected', 'modification_requested']);

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ''));
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function approvalDecisionsLogPath(_projectRoot = process.cwd(), options = {}) {
  const projectRoot = _projectRoot;
  return process.env.BRIDGE_CODEX_SEND_APPROVALS_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-codex-send-approvals.jsonl', options)
      : join(projectRoot, '.codex', 'state', 'bridge-codex-send-approvals.jsonl'));
}

export function approvalGateFromBody(body = {}) {
  const gate = cleanString(body.approvalGate || body.approval_gate);
  if (!gate) return { ok: true, enabled: false, gate: null };
  if (gate !== CODEX_SEND_APPROVAL_GATE) {
    return { ok: false, status: 400, error: `unsupported approvalGate: ${gate}` };
  }
  return { ok: true, enabled: true, gate };
}

export function buildCodexSendApprovalActions(questionId, answerEndpoint = null) {
  const withEndpoint = (action) => ({
    ...action,
    ...(answerEndpoint ? {
      endpoint: answerEndpoint,
      body: { questionId, answer: action.answer },
    } : {}),
  });
  return [
    withEndpoint({
      action: 'send',
      label: '전송',
      style: 'primary',
      custom_id: `codex-send-approval:${questionId}:send`,
      answer: { kind: 'option', value: SEND_VALUE, selected_values: [SEND_VALUE], selected_labels: ['전송'] },
    }),
    withEndpoint({
      action: 'reject',
      label: '거절',
      style: 'danger',
      custom_id: `codex-send-approval:${questionId}:reject`,
      answer: { kind: 'option', value: REJECT_VALUE, selected_values: [REJECT_VALUE], selected_labels: ['거절'] },
    }),
    withEndpoint({
      action: 'modify',
      label: '추가수정',
      style: 'secondary',
      custom_id: `codex-send-approval:${questionId}:modify`,
      answer: { kind: 'other', selected_values: [MODIFY_VALUE] },
      modal: {
        title: '프롬프트 추가수정',
        custom_id: `codex-send-approval:${questionId}:modify-modal`,
        field: { name: 'other_text', label: '수정 요청 또는 추가 지시' },
      },
    }),
  ];
}

export function buildDiscordComponents(questionId) {
  return [{
    type: 1,
    components: buildCodexSendApprovalActions(questionId).map((action) => ({
      type: 2,
      style: action.action === 'send' ? 1 : (action.action === 'reject' ? 4 : 2),
      label: action.label,
      custom_id: action.custom_id,
    })),
  }];
}

export function buildApprovalQuestionBody({ session, commandText, commandMetadata, commandBody, gate = CODEX_SEND_APPROVAL_GATE }) {
  const questionId = `codex-send-approval-${randomUUID()}`;
  return {
    questionId,
    kind: CODEX_SEND_APPROVAL_KIND,
    question: `정제된 프롬프트를 Hermes에서 전송할까요?\n\n${commandText}`,
    type: 'single-answerable',
    allow_other: true,
    other_label: '추가수정',
    source: 'bridge-codex-send-approval',
    options: [
      { label: '전송', value: SEND_VALUE, description: '정제된 프롬프트를 현재 세션으로 전송합니다.' },
      { label: '거절', value: REJECT_VALUE, description: '전송하지 않고 요청을 닫습니다.' },
    ],
    metadata: compactObject({
      gate,
      kind: CODEX_SEND_APPROVAL_KIND,
      commandText,
      commandMetadata: cloneObject(commandMetadata),
      commandBody: cloneObject(commandBody),
      bridgeSessionId: session.bridgeSessionId || null,
      codexThreadId: session.codexThreadId || null,
      lifecycleSessionId: session.lifecycleSessionId || null,
    }),
  };
}

export function approvalResponseFromQuestion(record, promptNormalization = {}) {
  const actions = buildCodexSendApprovalActions(record.questionId, record.answerEndpoint);
  return {
    question: record,
    answer_endpoint: record.answerEndpoint,
    component_actions: actions,
    approval_actions: actions,
    discord_components: buildDiscordComponents(record.questionId),
    delivery: {
      ok: true,
      status: 'approval-pending',
      backend: 'bridge-codex-send-approval',
    },
    promptNormalization,
  };
}

export async function appendApprovalDecision(marker, options = {}) {
  const path = approvalDecisionsLogPath(options.projectRoot, options);
  await ensureDirFor(path);
  const record = {
    markerId: marker.markerId || randomUUID(),
    createdAt: marker.createdAt || new Date().toISOString(),
    ...marker,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readApprovalDecisions(session = {}, questionId, options = {}) {
  const records = await readJsonl(approvalDecisionsLogPath(options.projectRoot, options));
  return records.filter((record) => {
    if (questionId && record.questionId !== questionId) return false;
    const ids = [session.bridgeSessionId, session.codexThreadId, session.codexSessionId, session.lifecycleSessionId].filter(Boolean);
    if (ids.length === 0) return true;
    return [record.sessionId, record.bridgeSessionId, record.codexThreadId, record.lifecycleSessionId].filter(Boolean).some((id) => ids.includes(id));
  });
}

export function latestApprovalDecision(markers = []) {
  return [...markers].reverse().find((marker) => FINAL_STATES.has(marker.state)) || null;
}

export function classifyApprovalAnswer(answer = {}) {
  if (answer.kind === 'other') {
    return { action: 'modify', state: 'modification_requested', text: cleanString(answer.other_text || answer.value) };
  }
  const value = cleanString(answer.value) || cleanString(answer.selected_values?.[0] || answer.selectedValues?.[0]);
  if (value === SEND_VALUE) return { action: 'send', state: 'send_claimed' };
  if (value === REJECT_VALUE) return { action: 'reject', state: 'rejected' };
  return { action: 'unknown', state: 'invalid', error: 'unsupported approval answer' };
}

export function approvalMarkerBase({ session, question, questionAnswer, body }) {
  return compactObject({
    sessionId: session.bridgeSessionId || session.codexThreadId || null,
    bridgeSessionId: session.bridgeSessionId || null,
    codexThreadId: session.codexThreadId || null,
    lifecycleSessionId: session.lifecycleSessionId || null,
    questionId: question.questionId,
    questionAnswerId: questionAnswer.questionAnswerId,
    discordInteractionId: questionAnswer.discordInteractionId || body.discordInteractionId || body.discord_interaction_id || null,
    componentCustomId: questionAnswer.componentCustomId || body.componentCustomId || body.component_custom_id || null,
  });
}
