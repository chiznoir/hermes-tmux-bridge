import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeStatePath } from './bridge-paths.js';
import { ensureDirFor, readJsonl } from './jsonl.js';

export const GJC_CLARIFY_KIND = 'gjc-clarify';
export const GJC_CLARIFY_MARKER = 'GJC_CLARIFY_REQUEST';
export const GJC_CLARIFY_ANSWER_MARKER = 'GJC_CLARIFY_ANSWER';
export const GJC_CLARIFY_BACKEND = 'bridge-gjc-clarify';

const VALID_TYPES = new Set(['single-answerable', 'multi-answerable', 'free-text']);
const VALID_CLASSIFICATIONS = new Set(['fact', 'decision', 'mixed']);
const FACT_WHITELIST = new Set([
  'workflowId',
  'source.type',
  'source.url',
  'source.text',
  'targetRepoPath',
  'worktreePath',
  'branchName',
  'baseRef',
  'verificationCommands',
  'linkedBridgeSessionId',
  'linkedGjcSessionId',
]);
const DECISION_WORDING = /\b(prefer|choose|decide|scope|approval|approve|permission|should|want|delete|destructive|release|commit|pr|which\s+.*(?:option|approach|implementation|path)|acceptable|allowed|can\s+i|may\s+i|proceed)\b|선호|선택|결정|범위|승인|삭제|파괴|커밋|허용|가능|방식|접근|진행|PR/i;

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (!option || typeof option !== 'object') return null;
    const value = cleanString(option.value);
    if (!value) return null;
    return {
      label: cleanString(option.label) || value,
      value,
      ...(cleanString(option.description) ? { description: cleanString(option.description) } : {}),
    };
  }).filter(Boolean);
}

function extractFirstJsonObject(text, start) {
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return null;
}

export function gjcClarifyQuestionId(workflowId, clarifyId) {
  const digest = createHash('sha256').update(`${workflowId}:${clarifyId}`).digest('hex').slice(0, 24);
  return `gjc-clarify-${digest}`;
}

export function parseGjcClarifyRequest(text = '') {
  const marker = String(text || '').indexOf(GJC_CLARIFY_MARKER);
  if (marker < 0) return { ok: false, status: 404, reason: 'missing-clarify-marker' };
  const raw = extractFirstJsonObject(String(text), marker);
  if (!raw) return { ok: false, status: 400, reason: 'missing-clarify-json' };
  try {
    return normalizeGjcClarifyRequest(JSON.parse(raw), raw);
  } catch (error) {
    return { ok: false, status: 400, reason: 'invalid-clarify-json', error: error.message };
  }
}

export function normalizeGjcClarifyRequest(body = {}, rawJson = null) {
  if (body.version !== 1) return { ok: false, status: 400, reason: 'unsupported-clarify-version' };
  const clarifyId = cleanString(body.clarifyId || body.clarify_id);
  const question = cleanString(body.question);
  const type = cleanString(body.type);
  const classificationHint = cleanString(body.classificationHint || body.classification_hint);
  if (!clarifyId) return { ok: false, status: 400, reason: 'clarifyId is required' };
  if (!question) return { ok: false, status: 400, reason: 'question is required' };
  if (!VALID_TYPES.has(type)) return { ok: false, status: 400, reason: 'clarify type is invalid' };
  if (!VALID_CLASSIFICATIONS.has(classificationHint)) return { ok: false, status: 400, reason: 'classificationHint is invalid' };

  const options = normalizeOptions(body.options);
  if ((type === 'single-answerable' || type === 'multi-answerable') && options.length === 0) {
    return { ok: false, status: 400, reason: 'answerable clarify request requires options' };
  }
  const requestedFacts = Array.isArray(body.requestedFacts || body.requested_facts)
    ? (body.requestedFacts || body.requested_facts).map(cleanString).filter(Boolean)
    : [];
  if (classificationHint === 'fact' && requestedFacts.length === 0) {
    return { ok: false, status: 400, reason: 'fact clarify request requires requestedFacts' };
  }

  return {
    ok: true,
    request: {
      version: 1,
      clarifyId,
      question,
      type,
      options,
      allow_other: body.allow_other === true || body.allowOther === true,
      other_label: cleanString(body.other_label || body.otherLabel) || 'Other',
      classificationHint,
      requestedFacts,
      reason: cleanString(body.reason) || null,
      raw: rawJson ? JSON.parse(rawJson) : cloneObject(body),
    },
  };
}

export function factValueFor(name, workflow = {}, observed = {}) {
  const values = {
    workflowId: workflow.workflowId,
    'source.type': workflow.source?.type,
    'source.url': workflow.source?.url,
    'source.text': workflow.source?.text,
    targetRepoPath: workflow.targetRepoPath,
    worktreePath: workflow.worktreePath,
    branchName: workflow.branchName,
    baseRef: workflow.baseRef,
    verificationCommands: workflow.verificationCommands,
    linkedBridgeSessionId: workflow.linkedBridgeSessionId,
    linkedGjcSessionId: workflow.linkedGjcSessionId,
    latestEventId: observed.latestEventId,
    sourceLogPath: observed.sourceLogPath,
  };
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

export function resolveGjcClarifyAutoAnswer(request = {}, workflow = {}, observed = {}) {
  if (request.classificationHint !== 'fact') return { ok: false, reason: 'not-fact' };
  if (DECISION_WORDING.test(`${request.question}\n${request.reason || ''}`)) {
    return { ok: false, reason: 'decision-wording' };
  }
  const evidence = {};
  for (const fact of request.requestedFacts || []) {
    if (!FACT_WHITELIST.has(fact)) return { ok: false, reason: 'fact-not-whitelisted', fact };
    const value = factValueFor(fact, workflow, observed);
    if (value === undefined || value === null || value === '') return { ok: false, reason: 'fact-unavailable', fact };
    evidence[fact] = value;
  }
  const answer = Object.keys(evidence).length === 1
    ? (typeof Object.values(evidence)[0] === 'string' ? Object.values(evidence)[0] : JSON.stringify(Object.values(evidence)[0]))
    : JSON.stringify(evidence);
  return { ok: true, answer, evidence };
}

export function answerBodyForGjcClarify({ questionId, answer, type, options = [], idempotencyKey, source }) {
  if (type === 'single-answerable') {
    const option = options.find((item) => item.value === answer || item.label === answer);
    if (!option) return { ok: false, reason: 'auto-answer-option-not-found' };
    return {
      ok: true,
      body: { questionId, source, idempotencyKey, answer: { kind: 'option', value: option.value, selected_values: [option.value], selected_labels: [option.label] } },
    };
  }
  if (type === 'multi-answerable') {
    let values;
    try {
      values = JSON.parse(answer);
    } catch {
      values = [answer];
    }
    if (!Array.isArray(values)) values = [answer];
    const selected = values.map(String);
    const optionValues = new Set(options.map((item) => item.value));
    if (selected.some((value) => !optionValues.has(value))) return { ok: false, reason: 'auto-answer-option-not-found' };
    return {
      ok: true,
      body: { questionId, source, idempotencyKey, answer: { kind: 'multi', value: selected, selected_values: selected } },
    };
  }
  return {
    ok: true,
    body: { questionId, source, idempotencyKey, answer: { kind: 'text', value: answer } },
  };
}

export function gjcClarifyAnswerCommand({ clarifyId, answer, source }) {
  return [
    GJC_CLARIFY_ANSWER_MARKER,
    JSON.stringify({ version: 1, clarifyId, answer, source }, null, 2),
  ].join('\n');
}

export function gjcClarifyDecisionsLogPath(projectRoot = process.cwd(), options = {}) {
  return process.env.BRIDGE_GJC_CLARIFY_DECISIONS_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-gjc-clarify-decisions.jsonl', options)
      : join(projectRoot, '.omx', 'state', 'bridge-gjc-clarify-decisions.jsonl'));
}

export async function appendGjcClarifyDecision(marker = {}, options = {}) {
  const record = {
    markerId: marker.markerId || randomUUID(),
    recordedAt: marker.recordedAt || new Date().toISOString(),
    ...marker,
  };
  const path = gjcClarifyDecisionsLogPath(options.projectRoot, options);
  await ensureDirFor(path);
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function readGjcClarifyDecisions(session = {}, questionId, options = {}) {
  const records = await readJsonl(gjcClarifyDecisionsLogPath(options.projectRoot, options));
  return records.filter((record) => {
    return record.questionId === questionId
      && (!session.bridgeSessionId || record.bridgeSessionId === session.bridgeSessionId);
  });
}

export function latestGjcClarifyDecision(records = []) {
  for (const record of [...records].reverse()) {
    if (record.state === 'dispatch_failed') return null;
    if (record.state === 'dispatch_completed' || record.state === 'dispatch_started') return record;
  }
  return null;
}
