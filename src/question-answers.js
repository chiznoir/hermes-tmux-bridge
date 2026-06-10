import { appendFile, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeStatePath } from './bridge-paths.js';
import { ensureDirFor, readJsonl } from './jsonl.js';

const VALID_ANSWER_KINDS = new Set(['option', 'multi', 'text', 'other']);
const VALID_QUESTION_TYPES = new Set(['single-answerable', 'multi-answerable', 'free-text']);
const answerLocks = new Map();
const questionLocks = new Map();

export function questionAnswersLogPath(projectRoot = process.cwd(), options = {}) {
  return process.env.BRIDGE_QUESTION_ANSWERS_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-question-answers.jsonl', options)
      : join(projectRoot, '.omx', 'state', 'bridge-question-answers.jsonl'));
}

export function questionRequestsLogPath(projectRoot = process.cwd(), options = {}) {
  return process.env.BRIDGE_QUESTION_REQUESTS_PATH
    || (process.env.BRIDGE_STATE_ROOT || options.bridgeStateRoot
      ? bridgeStatePath('bridge-question-requests.jsonl', options)
      : join(projectRoot, '.omx', 'state', 'bridge-question-requests.jsonl'));
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function normalizeValue(value) {
  if (Array.isArray(value)) return cleanStringArray(value);
  return cleanString(value);
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

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function comparableMetadata(metadata = {}) {
  const next = stableJson(metadata || {});
  const clarify = next?.gjcClarify;
  if (clarify && typeof clarify === 'object' && !Array.isArray(clarify)) {
    delete clarify.latestEventId;
    delete clarify.sourceLogPath;
    delete clarify.answerSource;
    delete clarify.evidence;
  }
  return next;
}

function compatibleQuestion(existing = {}, next = {}) {
  const comparable = (question = {}) => stableJson({
    questionId: question.questionId,
    kind: question.kind || null,
    question: question.question || '',
    type: question.type || 'free-text',
    options: normalizeOptions(question.options),
    allow_other: question.allow_other === true || question.allowOther === true,
    other_label: question.other_label || question.otherLabel || 'Other',
    source: question.source || 'bridge-question-request',
    expiresAt: question.expiresAt || null,
    metadata: comparableMetadata(question.metadata),
  });
  return JSON.stringify(comparable(existing)) === JSON.stringify(comparable(next));
}

async function withQuestionLock(key, fn) {
  const previous = questionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const ticket = previous.then(() => current, () => current);
  questionLocks.set(key, ticket);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (questionLocks.get(key) === ticket) questionLocks.delete(key);
  }
}

function questionRequestLockRoot(projectRoot = process.cwd(), options = {}) {
  return `${questionRequestsLogPath(projectRoot, options)}.locks`;
}

export function questionRequestLockPath(key, projectRoot = process.cwd(), options = {}) {
  return join(questionRequestLockRoot(projectRoot, options), Buffer.from(String(key)).toString('base64url'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withQuestionFileLock(key, options, fn) {
  const path = questionRequestLockPath(key, options.projectRoot, options);
  const timeoutMs = Number.isFinite(options.questionRequestLockTimeoutMs)
    ? options.questionRequestLockTimeoutMs
    : 5000;
  const deadline = Date.now() + timeoutMs;
  await mkdir(questionRequestLockRoot(options.projectRoot, options), { recursive: true });

  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        return { ok: false, status: 423, error: 'question request lock is already held' };
      }
      await wait(20);
    }
  }

  try {
    return await fn();
  } finally {
    await rmdir(path).catch(() => {});
  }
}

export function normalizeQuestionRequest(body = {}) {
  const questionId = cleanString(body.questionId || body.question_id);
  if (!questionId) return { ok: false, status: 400, error: 'questionId is required' };
  const type = cleanString(body.type) || 'free-text';
  if (!VALID_QUESTION_TYPES.has(type)) return { ok: false, status: 400, error: 'question type is invalid' };
  const options = normalizeOptions(body.options);
  if ((type === 'single-answerable' || type === 'multi-answerable') && options.length === 0) {
    return { ok: false, status: 400, error: 'answerable question requires options' };
  }
  return {
    ok: true,
    question: {
      questionId,
      ...(cleanString(body.kind) ? { kind: cleanString(body.kind) } : {}),
      question: cleanString(body.question) || '',
      type,
      options,
      allow_other: body.allow_other === true || body.allowOther === true,
      other_label: cleanString(body.other_label || body.otherLabel) || 'Other',
      source: cleanString(body.source) || 'bridge-question-request',
      expiresAt: cleanString(body.expiresAt || body.expires_at),
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? { metadata: JSON.parse(JSON.stringify(body.metadata)) }
        : {}),
    },
  };
}

export function normalizeQuestionAnswer(body = {}) {
  const questionId = cleanString(body.questionId || body.question_id);
  if (!questionId) return { ok: false, status: 400, error: 'questionId is required' };

  const answer = body.answer && typeof body.answer === 'object' ? body.answer : null;
  if (!answer) return { ok: false, status: 400, error: 'answer is required' };

  const kind = cleanString(answer.kind) || 'text';
  if (!VALID_ANSWER_KINDS.has(kind)) return { ok: false, status: 400, error: 'answer.kind is invalid' };

  const selectedValues = cleanStringArray(answer.selected_values || answer.selectedValues);
  const selectedLabels = cleanStringArray(answer.selected_labels || answer.selectedLabels);
  const value = normalizeValue(answer.value);
  const otherText = cleanString(answer.other_text || answer.otherText);

  if (kind === 'option') {
    const selected = typeof value === 'string' ? value : selectedValues[0];
    if (!selected) return { ok: false, status: 400, error: 'option answer requires a value' };
    const candidates = new Set([selected, ...selectedValues].filter(Boolean));
    if (candidates.size !== 1) return { ok: false, status: 400, error: 'option answer requires exactly one selected value' };
    return {
      ok: true,
      questionId,
      answer: {
        kind,
        value: selected,
        selected_labels: selectedLabels,
        selected_values: selectedValues.length > 0 ? selectedValues : [selected],
      },
    };
  }

  if (kind === 'multi') {
    const values = Array.isArray(value) && value.length > 0 ? value : selectedValues;
    if (values.length === 0 && !otherText) return { ok: false, status: 400, error: 'multi answer requires selected values or other_text' };
    return {
      ok: true,
      questionId,
      answer: {
        kind,
        value: otherText && !values.includes('__other__') ? [...values, '__other__'] : values,
        selected_labels: selectedLabels,
        selected_values: selectedValues.length > 0 ? selectedValues : values.filter((item) => item !== '__other__'),
        ...(otherText ? { other_text: otherText } : {}),
      },
    };
  }

  const text = otherText || (typeof value === 'string' ? value : null);
  if (!text) return { ok: false, status: 400, error: `${kind} answer requires text` };
  return {
    ok: true,
    questionId,
    answer: {
      kind,
      value: text,
      selected_labels: kind === 'other' && selectedLabels.length === 0 ? ['Other'] : selectedLabels,
      selected_values: kind === 'other' && selectedValues.length === 0 ? ['__other__'] : selectedValues,
      ...(otherText ? { other_text: otherText } : {}),
    },
  };
}

function sessionIds(session = {}) {
  return [
    session.bridgeSessionId,
    session.codexThreadId,
    session.codexSessionId,
    session.threadId,
    session.omxSessionId,
    session.tmuxId,
    session.tmuxPaneId,
  ].filter(Boolean);
}

function matchesSession(record = {}, session = {}) {
  const ids = new Set(sessionIds(session));
  return ids.size === 0 || sessionIds(record).some((id) => ids.has(id));
}

function attachSession(record, session = {}) {
  return {
    ...record,
    bridgeSessionId: session.bridgeSessionId || null,
    codexThreadId: session.codexThreadId || null,
    codexSessionId: session.codexSessionId || null,
    threadId: session.threadId || null,
    omxSessionId: session.omxSessionId || null,
    tmuxId: session.tmuxId || null,
    tmuxPaneId: session.tmuxPaneId || null,
  };
}

export async function recordQuestionRequest(session, body = {}, options = {}) {
  const normalized = normalizeQuestionRequest(body);
  if (!normalized.ok) return normalized;
  const now = options.timestamp || new Date().toISOString();
  const record = attachSession({
    questionRequestId: options.questionRequestId || randomUUID(),
    ...normalized.question,
    answerEndpoint: session.bridgeSessionId ? `/sessions/${encodeURIComponent(session.bridgeSessionId)}/question-answers` : null,
    createdAt: now,
  }, session);
  const lockKey = [
    session.bridgeSessionId || session.codexSessionId || session.omxSessionId || session.tmuxPaneId || 'unknown-session',
    record.questionId,
  ].join(':');
  return withQuestionLock(lockKey, async () => (
    withQuestionFileLock(lockKey, options, async () => {
      const existing = await latestQuestionRequest(session, record.questionId, options);
      if (existing) {
        if (compatibleQuestion(existing, record)) {
          return { ok: true, status: 200, duplicate: true, record: existing };
        }
        return { ok: false, status: 409, error: 'questionId already exists with incompatible content' };
      }
      const path = questionRequestsLogPath(options.projectRoot, options);
      await ensureDirFor(path);
      await appendFile(path, `${JSON.stringify(record)}
`, 'utf8');
      return { ok: true, status: 202, record };
    })
  ));
}

export async function readQuestionRequests(session = {}, options = {}) {
  const records = await readJsonl(questionRequestsLogPath(options.projectRoot, options));
  return records.filter((record) => matchesSession(record, session));
}

export async function latestQuestionRequest(session = {}, questionId, options = {}) {
  const id = cleanString(questionId);
  if (!id) return null;
  return [...await readQuestionRequests(session, options)]
    .reverse()
    .find((record) => record.questionId === id) || null;
}

export async function readQuestionAnswers(session = {}, options = {}) {
  const records = await readJsonl(questionAnswersLogPath(options.projectRoot, options));
  return records.filter((record) => matchesSession(record, session));
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms < Date.now();
}

function validateAnswerAgainstQuestion(answer, question) {
  if (!question) return { ok: false, status: 404, error: 'question request is required' };
  if (isExpired(question.expiresAt)) return { ok: false, status: 410, error: 'question request expired' };

  const type = cleanString(question.type) || 'free-text';
  const allowOther = question.allow_other === true || question.allowOther === true;
  const optionValues = new Set(normalizeOptions(question.options).map((option) => option.value));
  const selectedValues = cleanStringArray(answer.selected_values || answer.selectedValues);

  if (type === 'single-answerable') {
    if (answer.kind === 'other' || answer.kind === 'text') {
      return allowOther ? { ok: true } : { ok: false, status: 400, error: 'direct input is not allowed for this question' };
    }
    if (answer.kind !== 'option') return { ok: false, status: 400, error: 'single-answerable question requires option answer' };
    if (selectedValues.length !== 1) return { ok: false, status: 400, error: 'single-answerable question requires exactly one selected value' };
    if (!optionValues.has(answer.value)) return { ok: false, status: 400, error: 'selected value is not a valid option' };
  }

  if (type === 'multi-answerable') {
    if (answer.kind !== 'multi') return { ok: false, status: 400, error: 'multi-answerable question requires multi answer' };
    if (answer.other_text && !allowOther) return { ok: false, status: 400, error: 'direct input is not allowed for this question' };
    const invalid = selectedValues.find((value) => !optionValues.has(value));
    if (invalid) return { ok: false, status: 400, error: 'selected value is not a valid option' };
    if (selectedValues.length === 0 && !answer.other_text) return { ok: false, status: 400, error: 'multi answer requires selected values or other_text' };
  }

  if (type === 'free-text' && (answer.kind === 'option' || answer.kind === 'multi')) {
    return { ok: false, status: 400, error: 'free-text question requires text answer' };
  }

  return { ok: true };
}

async function withAnswerLock(key, fn) {
  const previous = answerLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const ticket = previous.then(() => current, () => current);
  answerLocks.set(key, ticket);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (answerLocks.get(key) === ticket) answerLocks.delete(key);
  }
}

export async function recordQuestionAnswer(session, body = {}, options = {}) {
  const normalized = normalizeQuestionAnswer(body);
  if (!normalized.ok) return normalized;

  const discordInteractionId = cleanString(body.discordInteractionId || body.discord_interaction_id);
  const componentCustomId = cleanString(body.componentCustomId || body.component_custom_id);
  const idempotencyKey = cleanString(body.idempotencyKey || body.idempotency_key || body.gjcClarifyAnswerKey || body.gjc_clarify_answer_key);
  const question = options.questionRequest || await latestQuestionRequest(session, normalized.questionId, options);
  const validation = validateAnswerAgainstQuestion(normalized.answer, question);
  if (!validation.ok) return validation;

  const lockKey = [
    session.bridgeSessionId || session.codexSessionId || session.omxSessionId || session.tmuxPaneId || 'unknown-session',
    normalized.questionId,
    discordInteractionId || componentCustomId || idempotencyKey || 'no-interaction-id',
  ].join(':');

  return withAnswerLock(lockKey, async () => {
    const answerDedupeKey = discordInteractionId || componentCustomId || idempotencyKey;
    if (answerDedupeKey) {
      const existing = (await readQuestionAnswers(session, options)).find((record) => {
        const recordKey = record.discordInteractionId || record.componentCustomId || record.idempotencyKey;
        return recordKey === answerDedupeKey
          && record.questionId === normalized.questionId;
      });
      if (existing) return { ok: true, status: 200, duplicate: true, record: existing };
    }

    const now = options.timestamp || new Date().toISOString();
    const record = attachSession({
      questionAnswerId: options.questionAnswerId || randomUUID(),
      questionRequestId: question.questionRequestId || null,
      questionId: normalized.questionId,
      answer: normalized.answer,
      status: 'queued',
      source: cleanString(body.source) || 'bridge-question-answer',
      discordInteractionId,
      componentCustomId,
      idempotencyKey,
      expiresAt: question.expiresAt || null,
      submittedAt: now,
    }, session);
    const path = questionAnswersLogPath(options.projectRoot, options);
    await ensureDirFor(path);
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    return { ok: true, status: 202, duplicate: false, record };
  });
}
