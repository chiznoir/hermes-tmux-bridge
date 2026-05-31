import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAuxiliaryCodexLog, readCodexLog } from '../src/codex-log.js';

test('readCodexLog extracts Codex runtime owner from session_meta base instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-runtime-'));
  const logPath = join(root, 'sessions', 'rollout-runtime.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    timestamp: '2026-05-14T01:19:17.635Z',
    type: 'session_meta',
    payload: {
      id: '019e2410-224d-7f93-9ba1-e1af9cf4d9e6',
      timestamp: '2026-05-14T01:18:17.677Z',
      cwd: '/home/user/docs',
      base_instructions: {
        text: [
          '<!-- Codex:RUNTIME:START -->',
          '<session_context>',
          '**Session:** codex-1778721494742-58n1q1 | 2026-05-14T01:18:14.915Z',
          '**tmux:** codex-docs-101814',
          '</session_context>',
          '<!-- Codex:RUNTIME:END -->',
        ].join('\n'),
      },
    },
  }), 'utf8');

  const log = await readCodexLog(logPath);
  assert.equal(log.codexSessionId, '019e2410-224d-7f93-9ba1-e1af9cf4d9e6');
  assert.equal(log.runtimeBridgeSessionId, 'codex-1778721494742-58n1q1');
  assert.equal(log.runtimeTmuxId, 'codex-docs-101814');
  assert.equal(log.runtimeSessionContextSource, 'codex-runtime-block');
});

test('readCodexLog extracts subagent metadata from session_meta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-subagent-'));
  const logPath = join(root, 'sessions', 'rollout-subagent.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    timestamp: '2026-05-14T02:09:38.468Z',
    type: 'session_meta',
    payload: {
      id: '019e243f-2319-70d2-88cf-257541a85b46',
      timestamp: '2026-05-14T02:09:38.073Z',
      cwd: '/home/user/work/codex-bridge',
      thread_source: 'subagent',
      agent_nickname: 'Maxwell',
      agent_role: 'architect',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: '019e2424-8ba1-7e71-a08c-82817511cceb',
          },
        },
      },
    },
  }), 'utf8');

  const log = await readCodexLog(logPath);
  assert.equal(log.threadSource, 'subagent');
  assert.equal(log.agentNickname, 'Maxwell');
  assert.equal(log.agentRole, 'architect');
  assert.equal(log.parentThreadId, '019e2424-8ba1-7e71-a08c-82817511cceb');
});

test('readCodexLog marks codex explore codex exec logs as auxiliary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-explore-'));
  const logPath = join(root, 'sessions', 'rollout-explore.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    timestamp: '2026-05-19T07:08:34.888Z',
    type: 'session_meta',
    payload: {
      id: '019e3f10-a0c7-7101-a822-9863f208ae57',
      timestamp: '2026-05-19T07:08:34.888Z',
      cwd: '/home/user/work/codex-bridge',
      originator: 'codex_exec',
      source: 'exec',
      base_instructions: { text: '# Codex Explore Lightweight Instructions\n\nread-only only' },
    },
  }), 'utf8');

  const log = await readCodexLog(logPath);
  assert.equal(log.originator, 'codex_exec');
  assert.equal(log.sessionSource, 'exec');
  assert.equal(log.isCodexExploreHarness, true);
  assert.equal(isAuxiliaryCodexLog(log), true);
});

test('readCodexLog does not treat normal Codex instructions mentioning codex explore as auxiliary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-normal-explore-mention-'));
  const logPath = join(root, 'sessions', 'rollout-normal.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    timestamp: '2026-05-19T08:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'normal-session',
      timestamp: '2026-05-19T08:00:00.000Z',
      cwd: '/home/user/work/codex-bridge',
      base_instructions: { text: 'Explore Command Preference: Use `codex explore --prompt ...` for simple lookups.' },
    },
  }), 'utf8');

  const log = await readCodexLog(logPath);
  assert.equal(log.isCodexExploreHarness, false);
  assert.equal(isAuxiliaryCodexLog(log), false);
});

test('readCodexLog exposes pending permission calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-pending-permission-'));
  const logPath = join(root, 'sessions', 'rollout-pending-permission.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, [
    {
      timestamp: '2026-05-15T09:18:58.613Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-pending',
        arguments: JSON.stringify({
          cmd: 'git status --short',
          sandbox_permissions: 'require_escalated',
          justification: '상태 확인',
        }),
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'), 'utf8');

  const log = await readCodexLog(logPath);
  const permissionEvents = log.events.filter((event) => event.type === 'ask_permission');

  assert.equal(permissionEvents.length, 1);
  assert.match(permissionEvents[0].text, /exec_command/);
  assert.match(permissionEvents[0].text, /require_escalated/);
});

test('readCodexLog suppresses resolved permission calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-codex-log-resolved-permission-'));
  const logPath = join(root, 'sessions', 'rollout-resolved-permission.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(logPath, [
    {
      timestamp: '2026-05-15T09:18:58.613Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-resolved',
        arguments: JSON.stringify({
          cmd: 'git status --short',
          sandbox_permissions: 'require_escalated',
          justification: '상태 확인',
        }),
      },
    },
    {
      timestamp: '2026-05-15T09:18:58.997Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-resolved',
        output: 'Process exited with code 0',
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'), 'utf8');

  const log = await readCodexLog(logPath);

  assert.equal(log.events.some((event) => event.type === 'ask_permission'), false);
});
