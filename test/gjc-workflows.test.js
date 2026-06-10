import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from '../src/server.js';
import {
  buildGjcWorkflowPrompt,
  normalizeGjcWorkflowRequest,
  parseGjcWorkflowResult,
} from '../src/gjc-workflows.js';
import { appendGjcClarifyDecision, resolveGjcClarifyAutoAnswer } from '../src/gjc-clarify.js';
import { questionRequestLockPath, readQuestionRequests, recordQuestionRequest } from '../src/question-answers.js';
import { appendAudit } from '../src/control-plane/audit-log.js';

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gjc-workflows-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  return { root, repo };
}

function slugify(value) {
  return (String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'project');
}

async function writeGjcSessionLog(root, sessionId, assistantText, options = {}) {
  const sessionsRoot = join(root, 'gjc-sessions');
  await mkdir(join(sessionsRoot, 'project'), { recursive: true });
  const logPath = join(sessionsRoot, 'project', `${sessionId}.jsonl`);
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-06-10T09:00:00.000Z', cwd: options.cwd || root, title: 'GJC workflow session' },
    { type: 'message', id: 'gjc-user-1', timestamp: '2026-06-10T09:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'run workflow' }] } },
    { type: 'message', id: options.messageId || 'gjc-clarify-1', timestamp: '2026-06-10T09:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }, stopReason: 'stop' },
  ];
  await writeFile(logPath, lines.map((line) => JSON.stringify(line)).join('\n'));
  return { sessionsRoot, logPath };
}

async function writeManagedTmuxBin(root, sessionId) {
  const callsPath = join(root, '.omx', 'logs', 'fake-gjc-clarify-tmux.log');
  const tmuxBin = join(root, 'fake-gjc-clarify-tmux.sh');
  const failSendKeysPath = join(root, '.omx', 'logs', 'fake-gjc-clarify-tmux.fail-send');
  const project = slugify(basename(root));
  const ownerKey = 'owner-key-clarify';
  const startedAt = '2026-06-10T09:00:00.000Z';
  await writeFile(tmuxBin, `#!/bin/sh
ROOT_PATH=${JSON.stringify(root)}
CALL_LOG=${JSON.stringify(callsPath)}
FAIL_SEND_KEYS=${JSON.stringify(failSendKeysPath)}
case "$1" in
  list-panes)
    printf 'gjc-managed\t%%88\t4242\t0\t%s\t1\tgjc\tgjc\t${project}\t${ownerKey}\t${startedAt}\t${sessionId}\n' "$ROOT_PATH"
    ;;
  list-sessions)
    printf 'gjc-managed\t1777379336\t1\t1\tgjc\tgjc\t${project}\t${ownerKey}\t${startedAt}\t${sessionId}\n'
    ;;
  display-message)
    printf 'gjc-managed\t%%88\t1\tgjc\tgjc\t${project}\t${ownerKey}\t${startedAt}\t${sessionId}\n'
    ;;
  send-keys)
    if [ -f "$FAIL_SEND_KEYS" ]; then
      exit 1
    fi
    printf '%s\n' "$*" >> "$CALL_LOG"
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(tmuxBin, 0o755);
  return { tmuxBin, callsPath, failSendKeysPath };
}

async function withEnv(env, fn) {
  const previous = new Map();
  for (const key of Object.keys(env)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function workflowBody(repo, overrides = {}) {
  return {
    source: { type: 'freeform_task', text: 'Add a status command' },
    targetRepoPath: repo,
    baseRef: 'HEAD',
    verificationCommands: ['npm test'],
    mode: 'verified-pr-only',
    ...overrides,
  };
}

function workflowResultText({ command, status = 'passed' }) {
  return [
    'done',
    '```',
    'GJC_WORKFLOW_RESULT',
    JSON.stringify({
      version: 1,
      status: 'success',
      issueUrl: null,
      branch: 'gjc/feature',
      checks: [{ command, status }],
      summary: 'implemented and tested',
      nextAction: 'none',
    }),
    '```',
  ].join('\n');
}

function clarifyText(payload) {
  return [
    'need clarify',
    '```',
    'GJC_CLARIFY_REQUEST',
    JSON.stringify(payload),
    '```',
  ].join('\n');
}


test('resolveGjcClarifyAutoAnswer preserves non-string fact values as JSON', () => {
  const resolved = resolveGjcClarifyAutoAnswer({
    classificationHint: 'fact',
    question: 'What verification commands are configured?',
    requestedFacts: ['verificationCommands'],
  }, {
    verificationCommands: ['npm test', 'npm run lint'],
  }, {});

  assert.equal(resolved.ok, true);
  assert.equal(resolved.answer, JSON.stringify(['npm test', 'npm run lint']));
});

test('resolveGjcClarifyAutoAnswer refuses decision-like fact wording', () => {
  const resolved = resolveGjcClarifyAutoAnswer({
    classificationHint: 'fact',
    question: 'Which implementation path is acceptable?',
    requestedFacts: ['workflowId'],
  }, {
    workflowId: 'gjcwf-fact-looking-decision',
  }, {});

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'decision-wording');
});

test('resolveGjcClarifyAutoAnswer refuses observed metadata facts', () => {
  const resolved = resolveGjcClarifyAutoAnswer({
    classificationHint: 'fact',
    question: 'What event id did you observe?',
    requestedFacts: ['latestEventId'],
  }, {}, {
    latestEventId: 'gjc-clarify-1',
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'fact-not-whitelisted');
  assert.equal(resolved.fact, 'latestEventId');
});

test('recordQuestionRequest serializes duplicate question ids', async () => {
  const { root } = await fixture();
  const session = { bridgeSessionId: 'question-lock-session' };
  const body = {
    questionId: 'question-lock-id',
    question: 'Pick one',
    type: 'single-answerable',
    options: [{ label: 'One', value: 'one' }],
    metadata: { gjcClarify: { clarifyId: 'lock-test' } },
  };

  const results = await Promise.all([
    recordQuestionRequest(session, body, { projectRoot: root }),
    recordQuestionRequest(session, body, { projectRoot: root }),
  ]);
  assert.equal(results.filter((result) => result.status === 202).length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 1);
  assert.equal((await readQuestionRequests(session, { projectRoot: root })).length, 1);
});

test('recordQuestionRequest reports held filesystem locks without appending', async () => {
  const { root } = await fixture();
  const session = { bridgeSessionId: 'question-file-lock-session' };
  const body = {
    questionId: 'question-file-lock-id',
    question: 'Pick one',
    type: 'single-answerable',
    options: [{ label: 'One', value: 'one' }],
    metadata: { gjcClarify: { clarifyId: 'file-lock-test' } },
  };
  const lockKey = `${session.bridgeSessionId}:${body.questionId}`;
  await mkdir(questionRequestLockPath(lockKey, root), { recursive: true });

  const result = await recordQuestionRequest(session, body, {
    projectRoot: root,
    questionRequestLockTimeoutMs: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.equal((await readQuestionRequests(session, { projectRoot: root })).length, 0);
});

test('normalizeGjcWorkflowRequest generalizes source types while requiring verified gate inputs', async () => {
  const { repo } = await fixture();
  const normalized = normalizeGjcWorkflowRequest(workflowBody(repo, {
    source: { type: 'discord_prompt', text: '기능 추가해줘' },
  }));

  assert.equal(normalized.ok, true);
  assert.equal(normalized.request.source.type, 'discord_prompt');
  assert.match(normalized.request.workflowId, /^gjcwf-/);
  assert.match(normalized.request.branchName, /^gjc\//);
  assert.equal(normalized.request.verificationCommands[0], 'npm test');

  const missingChecks = normalizeGjcWorkflowRequest(workflowBody(repo, { verificationCommands: [] }));
  assert.equal(missingChecks.ok, false);
  assert.match(missingChecks.error, /verificationCommands/);

  const unsupported = normalizeGjcWorkflowRequest(workflowBody(repo, {
    source: { type: 'unknown_source', text: 'x' },
  }));
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /unsupported source/);
});

test('parseGjcWorkflowResult treats malformed or missing result as blocked, never success', () => {
  const ok = parseGjcWorkflowResult([
    'done',
    '```',
    'GJC_WORKFLOW_RESULT',
    JSON.stringify({
      version: 1,
      status: 'success',
      issueUrl: null,
      branch: 'gjc/task',
      checks: [{ command: 'npm test', status: 'passed' }],
      summary: 'ok',
      nextAction: 'none',
    }),
    '```',
  ].join('\n'));
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'success');

  const missing = parseGjcWorkflowResult('plain final answer');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'missing-result-marker');

  const invalidStatus = parseGjcWorkflowResult('GJC_WORKFLOW_RESULT {"version":1,"status":"maybe"}');
  assert.equal(invalidStatus.ok, false);
  assert.equal(invalidStatus.status, 'blocked');
  assert.equal(invalidStatus.reason, 'invalid-result-status');

  const incompleteSuccess = parseGjcWorkflowResult('GJC_WORKFLOW_RESULT {"version":1,"status":"success"}');
  assert.equal(incompleteSuccess.ok, false);
  assert.equal(incompleteSuccess.reason, 'missing-result-branch');
});

test('POST /gjc/workflows creates a canonical workflow and dispatches the GJC prompt through injected hook', async () => {
  const { root, repo } = await fixture();
  const calls = { prepare: [], launch: [], dispatch: [] };
  const server = createServer({
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => {
      calls.prepare.push(request);
      return { ok: true, reused: false, worktreePath: request.worktreePath, branchName: request.branchName };
    },
    launchGjcWorkflowSessionFn: (body) => {
      calls.launch.push(body);
      return {
        ok: true,
        backend: 'gjc-tmux',
        reused: true,
        tmuxId: 'gjc-managed',
        tmuxPaneId: '%88',
        gjcSessionId: 'gjc-session-1',
        cwd: body.cwd,
        worktree: body.worktree,
      };
    },
    dispatchGjcWorkflowPromptFn: ({ workflow, prompt, launch }) => {
      calls.dispatch.push({ workflow, prompt, launch });
      return { ok: true, backend: 'tmux', target: '%88' };
    },
    nowFn: () => '2026-06-10T09:00:00.000Z',
  });

  const res = await request(server, '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, {
      workflowId: 'gjcwf-test-1',
      source: { type: 'github_issue', url: 'https://github.com/acme/repo/issues/42', text: 'Fix bug' },
    })),
  });

  assert.equal(res.status, 202);
  assert.equal(res.json.workflow.workflowId, 'gjcwf-test-1');
  assert.equal(res.json.workflow.state, 'executing');
  assert.equal(res.json.workflow.linkedGjcSessionId, 'gjc-session-1');
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].cwd, repo);
  assert.equal(calls.launch[0].worktree, res.json.workflow.worktreePath);
  assert.equal(calls.dispatch.length, 1);
  assert.match(calls.dispatch[0].prompt, /deep-interview/);
  assert.match(calls.dispatch[0].prompt, /ralplan/);
  assert.match(calls.dispatch[0].prompt, /ultragoal/);
  assert.match(calls.dispatch[0].prompt, /GJC_WORKFLOW_RESULT/);
  assert.equal(res.json.next.resultSource, 'gjc-jsonl');

  const store = JSON.parse(await readFile(join(root, '.omx', 'state', 'gjc-workflows.json'), 'utf8'));
  assert.equal(store.workflows['gjcwf-test-1'].state, 'executing');

  const audit = (await readFile(join(root, '.omx', 'logs', 'bridge-audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.eventType === 'gjc.workflow.accepted' && entry.workflowId === 'gjcwf-test-1'));
});

test('POST /gjc/workflows/:id/clarify auto-answers whitelisted GJC fact requests exactly once', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-auto';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'target-repo',
    question: 'What is the target repo path?',
    type: 'free-text',
    classificationHint: 'fact',
    requestedFacts: ['targetRepoPath'],
    reason: 'Need canonical repo path before planning.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin, TMUX_SUBMIT_DELAY_MS: '0', TMUX_SUBMIT_RETRY_COUNT: '1' }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-auto' })),
    });

    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-auto/clarify', { method: 'POST' });
    assert.equal(clarified.status, 202);
    assert.equal(clarified.json.clarify.status, 'auto-answered');
    assert.equal(clarified.json.clarify.dispatch.ok, true);
    assert.equal(clarified.json.clarify.question.kind, 'gjc-clarify');
    assert.equal(clarified.json.clarify.question.metadata.gjcClarify.answerSource, 'auto-fact');
    assert.equal(clarified.json.clarify.question.metadata.gjcClarify.evidence.targetRepoPath, repo);

    const duplicate = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-auto/clarify', { method: 'POST' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.clarify.status, 'already-finalized');
    assert.equal(duplicate.json.clarify.dispatch.status, 'already-finalized');

    const calls = await readFile(tmux.callsPath, 'utf8');
    assert.equal((calls.match(/GJC_CLARIFY_ANSWER/g) || []).length, 1);
    assert.match(calls, /target-repo/);
    assert.match(calls, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('POST /gjc/workflows/:id/clarify resolves pending-discovery GJC sessions by workflow paths', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-pending-discovery';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'pending-target-repo',
    question: 'What is the target repo path?',
    type: 'free-text',
    classificationHint: 'fact',
    requestedFacts: ['targetRepoPath'],
    reason: 'Need canonical repo path before planning.',
  }), { cwd: repo });
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: (body) => ({
      ok: true,
      backend: 'gjc-tmux',
      status: 'started',
      readiness: 'pending-discovery',
      cwd: body.cwd,
      worktree: body.worktree,
    }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin, TMUX_SUBMIT_DELAY_MS: '0', TMUX_SUBMIT_RETRY_COUNT: '1' }, async () => {
    const created = await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-pending-discovery' })),
    });
    assert.equal(created.status, 202);
    assert.equal(created.json.workflow.linkedGjcSessionId, null);
    assert.equal(created.json.workflow.dispatch.reason, 'gjc session id not yet available');

    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-pending-discovery/clarify', { method: 'POST' });
    assert.equal(clarified.status, 202);
    assert.equal(clarified.json.clarify.status, 'auto-answered');
    assert.equal(clarified.json.clarify.dispatch.ok, true);
    assert.equal(clarified.json.clarify.question.metadata.gjcClarify.evidence.targetRepoPath, repo);
  });
});

test('POST /gjc/workflows/:id/clarify blocks conflicting tmux and path session matches', async () => {
  const { root, repo } = await fixture();
  const otherRepo = join(root, 'other-repo');
  await mkdir(otherRepo, { recursive: true });
  const tmuxSessionId = '019e9000-clarify-conflict-tmux';
  const pathSessionId = '019e9000-clarify-conflict-path';
  const payload = clarifyText({
    version: 1,
    clarifyId: 'conflict-target-repo',
    question: 'What is the target repo path?',
    type: 'free-text',
    classificationHint: 'fact',
    requestedFacts: ['targetRepoPath'],
    reason: 'Need canonical repo path before planning.',
  });
  const { sessionsRoot } = await writeGjcSessionLog(root, tmuxSessionId, payload, { cwd: otherRepo });
  await writeGjcSessionLog(root, pathSessionId, payload, { cwd: repo });
  const tmux = await writeManagedTmuxBin(root, tmuxSessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: (body) => ({
      ok: true,
      backend: 'gjc-tmux',
      status: 'started',
      readiness: 'pending-discovery',
      tmuxId: 'gjc-managed',
      tmuxPaneId: '%88',
      cwd: body.cwd,
      worktree: body.worktree,
    }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-conflict' })),
    });

    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-conflict/clarify', { method: 'POST' });
    assert.equal(clarified.status, 409);
    assert.equal(clarified.json.clarify.status, 'blocked');
    assert.equal(clarified.json.clarify.reason, 'linked GJC session not found');
  });
});

test('POST /gjc/workflows/:id/clarify blocks ambiguous pending-discovery path matches', async () => {
  const { root, repo } = await fixture();
  const sessionA = '019e9000-clarify-ambiguous-a';
  const sessionB = '019e9000-clarify-ambiguous-b';
  const payload = clarifyText({
    version: 1,
    clarifyId: 'ambiguous-target-repo',
    question: 'What is the target repo path?',
    type: 'free-text',
    classificationHint: 'fact',
    requestedFacts: ['targetRepoPath'],
    reason: 'Need canonical repo path before planning.',
  });
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionA, payload, { cwd: repo });
  await writeGjcSessionLog(root, sessionB, payload, { cwd: repo });
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: (body) => ({
      ok: true,
      backend: 'gjc-tmux',
      status: 'started',
      readiness: 'pending-discovery',
      cwd: body.cwd,
      worktree: body.worktree,
    }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: '/bin/false' }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-ambiguous' })),
    });

    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-ambiguous/clarify', { method: 'POST' });
    assert.equal(clarified.status, 409);
    assert.equal(clarified.json.clarify.status, 'blocked');
    assert.equal(clarified.json.clarify.reason, 'linked GJC session not found');
  });
});

test('POST /gjc/workflows/:id/clarify routes decision-like GJC requests to structured user clarify', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-user';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'scope-choice',
    question: 'Should I also change docs scope?',
    type: 'single-answerable',
    options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    classificationHint: 'fact',
    requestedFacts: ['workflowId'],
    reason: 'Need a scope decision.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-user' })),
    });

    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-user/clarify', { method: 'POST' });
    assert.equal(clarified.status, 202);
    assert.equal(clarified.json.clarify.status, 'question-pending');
    assert.equal(clarified.json.clarify.render, 'hermes-clarify-required');
    assert.equal(clarified.json.clarify.question.type, 'single-answerable');
    assert.equal(clarified.json.clarify.answer_endpoint, `/sessions/${sessionId}/question-answers`);
  });
});

test('POST /gjc/workflows/:id/clarify treats volatile observed metadata drift as compatible duplicate', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-metadata-drift';
  const payload = {
    version: 1,
    clarifyId: 'scope-drift',
    question: 'Choose implementation scope.',
    type: 'single-answerable',
    options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }],
    classificationHint: 'decision',
    reason: 'Need user choice.',
  };
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText(payload), { messageId: 'gjc-clarify-old' });
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-drift' })),
    });
    const first = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-drift/clarify', { method: 'POST' });
    assert.equal(first.status, 202);
    assert.equal(first.json.clarify.status, 'question-pending');

    await writeGjcSessionLog(root, sessionId, clarifyText(payload), { messageId: 'gjc-clarify-new' });
    const duplicate = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-drift/clarify', { method: 'POST' });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.json.clarify.status, 'question-pending');
    assert.equal(duplicate.json.clarify.question.questionId, first.json.clarify.question.questionId);
  });
});

test('POST /sessions/:id/question-answers cannot spoof auto-fact provenance on auto metadata questions', async () => {
  const { root } = await fixture();
  const sessionId = '019e9000-clarify-auto-spoof';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, 'ready');
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const questionId = 'gjc-clarify-auto-spoof-question';
  await recordQuestionRequest({ bridgeSessionId: sessionId }, {
    questionId,
    kind: 'gjc-clarify',
    question: 'What is the target repo path?',
    type: 'free-text',
    source: 'bridge-gjc-clarify',
    metadata: {
      gjcClarify: {
        version: 1,
        workflowId: 'gjcwf-auto-spoof',
        clarifyId: 'auto-spoof',
        classificationHint: 'fact',
        requestedFacts: ['targetRepoPath'],
        answerSource: 'auto-fact',
      },
    },
  }, { projectRoot: root });

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin, TMUX_SUBMIT_DELAY_MS: '0', TMUX_SUBMIT_RETRY_COUNT: '1' }, async () => {
    const answered = await request(createServer({ projectRoot: root }), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        source: 'bridge-gjc-clarify-auto',
        idempotencyKey: 'auto-spoof-public-answer',
        answer: { kind: 'text', value: '/tmp/repo' },
      }),
    });
    assert.equal(answered.status, 202);
    assert.equal(answered.json.delivery.ok, true);

    const calls = await readFile(tmux.callsPath, 'utf8');
    assert.match(calls, /auto-spoof/);
    assert.match(calls, /\"source\": \"user\"/);
    assert.doesNotMatch(calls, /\"source\": \"auto-fact\"/);
  });
});

test('POST /sessions/:id/question-answers dispatches user GJC clarify answers once', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-answer';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'scope-choice',
    question: 'Choose implementation scope.',
    type: 'single-answerable',
    options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }],
    classificationHint: 'decision',
    reason: 'Need user choice.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin, TMUX_SUBMIT_DELAY_MS: '0', TMUX_SUBMIT_RETRY_COUNT: '1' }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-answer' })),
    });
    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-answer/clarify', { method: 'POST' });
    const questionId = clarified.json.clarify.question.questionId;

    const answered = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        componentCustomId: `gjc-clarify:${questionId}:small`,
        source: 'bridge-gjc-clarify-auto',
        answer: { kind: 'option', value: 'small', selected_values: ['small'], selected_labels: ['Small'] },
      }),
    });
    assert.equal(answered.status, 202);
    assert.equal(answered.json.delivery.ok, true);
    assert.equal(answered.json.delivery.backend, 'bridge-gjc-clarify');

    const duplicate = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        componentCustomId: `gjc-clarify:${questionId}:small`,
        answer: { kind: 'option', value: 'small', selected_values: ['small'], selected_labels: ['Small'] },
      }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.duplicate, true);

    const calls = await readFile(tmux.callsPath, 'utf8');
    assert.equal((calls.match(/GJC_CLARIFY_ANSWER/g) || []).length, 1);
    assert.match(calls, /scope-choice/);
    assert.match(calls, /small/);
    assert.match(calls, /\"source\": \"user\"/);
    assert.doesNotMatch(calls, /\"source\": \"auto-fact\"/);
  });
});


test('POST /sessions/:id/question-answers does not resend when GJC clarify dispatch status is unknown', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-dispatch-unknown';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'unknown-scope',
    question: 'Choose implementation scope.',
    type: 'single-answerable',
    options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }],
    classificationHint: 'decision',
    reason: 'Need user choice.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-dispatch-unknown' })),
    });
    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-dispatch-unknown/clarify', { method: 'POST' });
    const questionId = clarified.json.clarify.question.questionId;
    await appendGjcClarifyDecision({
      bridgeSessionId: sessionId,
      questionId,
      state: 'dispatch_started',
      interactionId: 'interaction-without-terminal-marker',
      delivery: { ok: false, status: 'dispatch-started', backend: 'bridge-gjc-clarify' },
    }, { projectRoot: root });

    const answered = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        componentCustomId: `gjc-clarify:${questionId}:small`,
        answer: { kind: 'option', value: 'small', selected_values: ['small'], selected_labels: ['Small'] },
      }),
    });
    assert.equal(answered.status, 202);
    assert.equal(answered.json.delivery.ok, false);
    assert.equal(answered.json.delivery.status, 'dispatch-status-unknown');
    const calls = await readFile(tmux.callsPath, 'utf8').catch(() => '');
    assert.equal((calls.match(/GJC_CLARIFY_ANSWER/g) || []).length, 0);
  });
});

test('POST /sessions/:id/question-answers reconciles started GJC clarify dispatch from audit', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-reconcile';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'reconcile-scope',
    question: 'Choose reconcile scope.',
    type: 'single-answerable',
    options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }],
    classificationHint: 'decision',
    reason: 'Need user choice.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-reconcile' })),
    });
    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-reconcile/clarify', { method: 'POST' });
    const questionId = clarified.json.clarify.question.questionId;
    await appendGjcClarifyDecision({
      bridgeSessionId: sessionId,
      questionId,
      state: 'dispatch_started',
      interactionId: 'interaction-with-audit-terminal',
      delivery: { ok: false, status: 'dispatch-started', backend: 'bridge-gjc-clarify' },
    }, { projectRoot: root });
    await appendAudit('command.completed', {
      interactionId: 'interaction-with-audit-terminal',
      sessionId,
      bridgeSessionId: sessionId,
      backend: 'tmux',
      delivery: { ok: true, backend: 'tmux', target: '%88' },
    }, { projectRoot: root });

    const answered = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId,
        componentCustomId: `gjc-clarify:${questionId}:small`,
        answer: { kind: 'option', value: 'small', selected_values: ['small'], selected_labels: ['Small'] },
      }),
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.delivery.ok, true);
    assert.equal(answered.json.delivery.recoveredFromAudit, true);
    assert.equal(answered.json.gjcClarify.state, 'dispatch_completed');
    const calls = await readFile(tmux.callsPath, 'utf8').catch(() => '');
    assert.equal((calls.match(/GJC_CLARIFY_ANSWER/g) || []).length, 0);
  });
});

test('POST /sessions/:id/question-answers retries a duplicate GJC clarify answer after dispatch failure', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-retry';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'retry-scope',
    question: 'Choose retry scope.',
    type: 'single-answerable',
    options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }],
    classificationHint: 'decision',
    reason: 'Need user choice.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin, TMUX_SUBMIT_DELAY_MS: '0', TMUX_SUBMIT_RETRY_COUNT: '1' }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-retry' })),
    });
    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-retry/clarify', { method: 'POST' });
    const questionId = clarified.json.clarify.question.questionId;
    const body = {
      questionId,
      componentCustomId: `gjc-clarify:${questionId}:small`,
      mode: 'codex',
      submit: false,
      dryRun: true,
      answer: { kind: 'option', value: 'small', selected_values: ['small'], selected_labels: ['Small'] },
    };

    await writeFile(tmux.failSendKeysPath, 'fail\n');
    const failed = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.delivery.ok, false);
    assert.equal(failed.json.delivery.backend, 'bridge-gjc-clarify');

    await unlink(tmux.failSendKeysPath);
    const retried = await request(createServer(serverOptions), `/sessions/${sessionId}/question-answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(retried.status, 202);
    assert.equal(retried.json.duplicate, true);
    assert.equal(retried.json.delivery.ok, true);
    assert.equal(retried.json.delivery.status, 'dispatch-completed');

    const calls = await readFile(tmux.callsPath, 'utf8');
    assert.equal((calls.match(/GJC_CLARIFY_ANSWER/g) || []).length, 1);
    assert.match(calls, /retry-scope/);
    assert.match(calls, /small/);
  });
});

test('POST /gjc/workflows/:id/clarify blocks invalid GJC clarify request schemas', async () => {
  const { root, repo } = await fixture();
  const sessionId = '019e9000-clarify-invalid';
  const { sessionsRoot } = await writeGjcSessionLog(root, sessionId, clarifyText({
    version: 1,
    clarifyId: 'bad-single',
    question: 'Pick one',
    type: 'single-answerable',
    classificationHint: 'decision',
    reason: 'Missing options should fail closed.',
  }));
  const tmux = await writeManagedTmuxBin(root, sessionId);
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: sessionId }),
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmux.tmuxBin }, async () => {
    await request(createServer(serverOptions), '/gjc/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-clarify-invalid' })),
    });
    const clarified = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-clarify-invalid/clarify', { method: 'POST' });
    assert.equal(clarified.status, 409);
    assert.equal(clarified.json.clarify.status, 'blocked');
    assert.equal(clarified.json.clarify.reason, 'answerable clarify request requires options');
  });
});

test('POST /gjc/workflows is idempotent for an active workflow and avoids duplicate launch', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-dup' };
    },
  };
  const body = workflowBody(repo, { workflowId: 'gjcwf-dup' });

  const first = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const second = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(launches, 1);
});

test('POST /gjc/workflows does not relaunch an existing terminal workflow id', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-terminal' };
    },
    verifyGjcWorkflowFn: (workflow) => ({
      ok: true,
      results: workflow.verificationCommands.map((command) => ({ command, ok: true, status: 0 })),
    }),
  };
  const body = workflowBody(repo, { workflowId: 'gjcwf-terminal' });

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await request(createServer(serverOptions), '/gjc/workflows/gjcwf-terminal/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm test' }) }),
  });
  const retry = await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.workflow.state, 'completed');
  assert.equal(launches, 1);
});

test('POST /gjc/workflows blocks dirty/conflicting worktree without cleanup or launch', async () => {
  const { root, repo } = await fixture();
  let launches = 0;
  const server = createServer({
    projectRoot: root,
    prepareWorkflowWorktreeFn: () => ({
      ok: false,
      state: 'blocked',
      reason: 'dirty-worktree',
      error: 'existing worktree has uncommitted changes',
    }),
    launchGjcWorkflowSessionFn: () => {
      launches += 1;
      return { ok: true };
    },
  });
  const res = await request(server, '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-dirty' })),
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.workflow.state, 'blocked');
  assert.equal(res.json.workflow.failureReason, 'dirty-worktree');
  assert.equal(launches, 0);
});

test('GET and cancel /gjc/workflows/:id expose and terminate only the canonical workflow record', async () => {
  const { root, repo } = await fixture();
  const stops = [];
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-cancel' }),
    stopGjcWorkflowSessionFn: (workflow) => {
      stops.push(workflow.workflowId);
      return { ok: true, backend: 'tmux', target: workflow.linkedBridgeSessionId };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-cancel' })),
  });

  const fetched = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.workflow.workflowId, 'gjcwf-cancel');
  assert.equal(fetched.json.workflow.linkedGjcSessionId, 'gjc-session-cancel');

  const cancelled = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.json.workflow.state, 'cancelled');
  assert.deepEqual(stops, ['gjcwf-cancel']);

  const fetchedAgain = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-cancel');
  assert.equal(fetchedAgain.json.workflow.state, 'cancelled');
  assert.equal(fetchedAgain.json.workflow.stop.ok, true);
});

test('cancel does not mark a linked workflow cancelled when stop fails or is unavailable', async () => {
  const { root, repo } = await fixture();
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-no-stop' }),
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-no-stop' })),
  });

  const cancelled = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-no-stop/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 502);
  assert.notEqual(cancelled.json.workflow.state, 'cancelled');
  assert.equal(cancelled.json.workflow.failureReason, 'no workflow stop hook configured');
});

test('POST /gjc/workflows/:id/complete blocks malformed GJC results before verification', async () => {
  const { root, repo } = await fixture();
  let verifications = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-result' }),
    verifyGjcWorkflowFn: () => {
      verifications += 1;
      return { ok: true, results: [] };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-result-blocked' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-result-blocked/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: 'finished without machine-readable marker' }),
  });

  assert.equal(completed.status, 409);
  assert.equal(completed.json.workflow.state, 'blocked');
  assert.equal(completed.json.workflow.failureReason, 'missing-result-marker');
  assert.equal(verifications, 0);
});

test('POST /gjc/workflows/:id/complete blocks successful results that omit required checks', async () => {
  const { root, repo } = await fixture();
  let verifications = 0;
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-incomplete' }),
    verifyGjcWorkflowFn: () => {
      verifications += 1;
      return { ok: true, results: [] };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-incomplete-checks' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-incomplete-checks/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm run lint' }) }),
  });

  assert.equal(completed.status, 409);
  assert.equal(completed.json.workflow.state, 'blocked');
  assert.equal(completed.json.workflow.failureReason, 'result-checks-incomplete');
  assert.equal(verifications, 0);
});

test('POST /gjc/workflows/:id/complete reruns verification before marking workflow completed', async () => {
  const { root, repo } = await fixture();
  const verified = [];
  const serverOptions = {
    projectRoot: root,
    prepareWorkflowWorktreeFn: (request) => ({ ok: true, worktreePath: request.worktreePath, branchName: request.branchName }),
    launchGjcWorkflowSessionFn: () => ({ ok: true, backend: 'gjc-tmux', gjcSessionId: 'gjc-session-verified' }),
    verifyGjcWorkflowFn: (workflow) => {
      verified.push(workflow.workflowId);
      return {
        ok: true,
        results: workflow.verificationCommands.map((command) => ({ command, ok: true, status: 0 })),
      };
    },
  };

  await request(createServer(serverOptions), '/gjc/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflowBody(repo, { workflowId: 'gjcwf-verified' })),
  });

  const completed = await request(createServer(serverOptions), '/gjc/workflows/gjcwf-verified/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ finalText: workflowResultText({ command: 'npm test' }) }),
  });

  assert.equal(completed.status, 200);
  assert.equal(completed.json.workflow.state, 'completed');
  assert.equal(completed.json.workflow.phase, 'verified');
  assert.deepEqual(verified, ['gjcwf-verified']);
  assert.equal(completed.json.workflow.verificationEvidence[0].command, 'npm test');
});

test('buildGjcWorkflowPrompt preserves verified-only and no-bridge constraints', () => {
  const prompt = buildGjcWorkflowPrompt({
    source: { type: 'freeform_task', text: 'Add feature' },
    targetRepoPath: '/repo',
    worktreePath: '/worktree',
    branchName: 'gjc/feature',
    verificationCommands: ['npm test'],
  });

  assert.match(prompt, /Do not modify GJC source/);
  assert.match(prompt, /Do not enable GJC HTTPS bridge/);
  assert.match(prompt, /Do not start an RPC\/SDK host/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /GJC_WORKFLOW_RESULT/);
});
