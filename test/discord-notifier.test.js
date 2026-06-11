import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eventToDiscordChunks, pollDiscordNotifications } from '../src/discord-notifier.js';
import {
  closeEventIndex,
  markDeliveryFailed,
  markDeliveryPrepared,
  markDeliverySent,
  openEventIndex,
  upsertEvents,
} from '../src/control-plane/event-index.js';

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

test('eventToDiscordChunks splits long Codex messages for Discord webhook delivery', () => {
  const session = {
    project: 'omx-bridge',
    omxSessionId: 'omx-session',
    codexThreadId: 'codex-thread',
    tmuxId: 'tmux-session',
  };
  const event = {
    type: 'FinalAnswer',
    source: 'codex-log',
    timestamp: '2026-04-30T00:00:00.000Z',
    text: '긴 응답 '.repeat(900),
  };

  const chunks = eventToDiscordChunks(session, event);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
  assert.match(chunks[0], /# Session Idle/);
  assert.match(chunks[0], /\*\*session:\*\* `omx-session`/);
  assert.match(chunks[0], /\*\*tmux:\*\* `tmux-session`/);
  assert.match(chunks[0], /\*\*project:\*\* `omx-bridge`/);
  assert.doesNotMatch(chunks[0], /\*\*Session:\*\*/);
  assert.doesNotMatch(chunks[0], /\*\*Thread:\*\*/);
  assert.doesNotMatch(chunks[0], /\*\*Time:\*\*/);
  assert.doesNotMatch(chunks[0], /Source: codex-log/);
  assert.match(chunks[0], /```/);
  assert.match(chunks[0], /\(1\/\d+\)$/);
  assert.match(chunks[1], /^```/);
  assert.match(chunks[1], /\(2\/\d+\)$/);
  assert.doesNotMatch(chunks[1], /# Session Idle|# Final Answer/);
  assert.doesNotMatch(chunks[1], /\*\*session:\*\*/);
});

test('eventToDiscordChunks escapes nested code fences', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread' },
    {
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-04-30T00:00:00.000Z',
      text: 'before ```js\nconsole.log(1)\n``` after',
    },
  );
  assert.match(message, /``\u200b`js/);
  assert.doesNotMatch(message, /before ```js/);
});

test('eventToDiscordChunks renders markdown tables as Discord-safe aligned text', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', omxSessionId: 'session-1' },
    {
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-05-14T00:00:00.000Z',
      text: [
        'retry budget:',
        '| 실패 응답 1회 시간 | 3회 실패 후 dead까지 |',
        '|---:|---:|',
        '| 100ms | 약 300ms |',
        '| 500ms | 약 1.5초 |',
      ].join('\n'),
    },
    { allowDiscordFinalAnswerNotifications: true },
  );

  assert.match(message, /실패 응답 1회 시간\s+3회 실패 후 dead까지/);
  assert.match(message, /100ms\s+약 300ms/);
  assert.doesNotMatch(message, /\|---:\|---:\|/);
});


test('pollDiscordNotifications sends opt-in GJC FinalAnswer without codex-only opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-discord-project-'));
  const sessionsRoot = join(root, 'gjc-sessions');
  const statePath = join(root, 'state.json');
  const sessionId = '019e9000-4444-7000-aaaa-ffffffffffff';
  await mkdir(join(sessionsRoot, 'project'), { recursive: true });
  await writeFile(join(sessionsRoot, 'project', `${sessionId}.jsonl`), [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-06-04T10:00:00.000Z', cwd: root, title: 'GJC Discord session' },
    { type: 'message', id: 'gjc-user-1', timestamp: '2026-06-04T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '안녕 테스트 한줄 출력' }] } },
    { type: 'message', id: 'gjc-final-1', timestamp: '2026-06-04T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '안녕 테스트 한줄 출력' }] }, stopReason: 'stop' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  const tmuxBin = join(root, 'fake-gjc-tmux.sh');
  await writeFile(tmuxBin, `#!/bin/sh
case "$1" in
  list-panes)
    printf 'gjc-managed\t%%88\t4242\t0\t%s\t1\tgjc\tgjc\t%s\towner-key\t2026-06-04T10:00:00.000Z\t%s\n' ${JSON.stringify(root)} ${JSON.stringify(basename(root))} ${JSON.stringify(sessionId)}
    ;;
  list-sessions)
    printf 'gjc-managed\t1777379336\t1\t1\tgjc\tgjc\t%s\towner-key\t2026-06-04T10:00:00.000Z\t%s\n' ${JSON.stringify(basename(root))} ${JSON.stringify(sessionId)}
    ;;
  *)
    exit 1
    ;;
esac
`);
  await chmod(tmuxBin, 0o755);

  const posts = [];
  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmuxBin }, async () => {
    const result = await pollDiscordNotifications({
      projectRoot: root,
      discoverTmuxProjectRoots: false,
      statePath,
      webhookUrl: 'https://discord.test/webhook',
      eventTypes: new Set(['FinalAnswer']),
      allowDiscordFinalAnswerNotifications: true,
      replay: true,
      fetchFn: async (_url, request = {}) => {
        posts.push(JSON.parse(request.body));
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
  });

  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /# Session Idle/);
  assert.match(posts[0].content, /안녕 테스트 한줄 출력/);
});

test('pollDiscordNotifications ignores FinalAnswer and SessionIdle by default even when env-like event types include them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-no-final-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-final-blocked',
    native_session_id: 'codex-final-blocked',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(codexHome, 'sessions', 'rollout-2026-05-12T08-00-00-codex-final-blocked.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-final-blocked', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'final text' }] } },
    { timestamp: '2026-05-12T08:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'final text' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'SessionIdle']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});


test('pollDiscordNotifications ignores pre-indexed FinalAnswer and SessionIdle pending events by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-indexed-no-final-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    const session = {
      bridgeSessionId: 'omx-indexed-final-blocked',
      omxSessionId: 'omx-indexed-final-blocked',
      codexThreadId: 'codex-indexed-final-blocked',
      project: 'omx-bridge',
      status: 'active',
    };
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'indexed-final-answer',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-12T08:00:01.000Z',
          text: 'already indexed final answer',
        },
      },
      {
        session,
        event: {
          eventId: 'indexed-session-idle',
          type: 'SessionIdle',
          source: 'notification',
          timestamp: '2026-05-12T08:00:02.000Z',
          text: 'already indexed idle',
        },
      },
    ]);
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    eventIndexPath,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'SessionIdle']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});


test('eventToDiscordChunks formats session lifecycle cleanly', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    { type: 'SessionStart', source: 'codex-log', timestamp: '2026-04-30T00:00:00.000Z', text: 'session started' },
  );
  assert.match(message, /# Session Start/);
  assert.match(message, /\*\*session:\*\* `thread-1`/);
  assert.match(message, /\*\*project:\*\* `omx-bridge`/);
  assert.match(message, /\*\*time:\*\* AM 9:00:00/);
  assert.match(message, /\*\*tmux:\*\* `tmux-1`/);
  assert.doesNotMatch(message, /```/);
});

test('eventToDiscordChunks can mention configured users on SessionStart only', () => {
  const [start] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1' },
    { type: 'SessionStart', source: 'notification', timestamp: '2026-04-30T00:00:00.000Z', text: 'session started' },
    { discordMentionUsers: ['456789012345678901'] },
  );
  const [command] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1' },
    { type: 'CommandSubmitted', source: 'bridge-interactions', timestamp: '2026-04-30T00:00:01.000Z', text: 'prompt' },
    { discordMentionUsers: ['456789012345678901'] },
  );

  assert.match(start, /^<@456789012345678901>\n# Session Start/);
  assert.doesNotMatch(command, /456789012345678901/);
});

test('eventToDiscordChunks formats SessionLinked separately from SessionStart', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', omxSessionId: 'omx-visible', codexThreadId: 'codex-resumed' },
    {
      type: 'SessionLinked',
      source: 'notification',
      timestamp: '2026-04-30T00:00:01.000Z',
      text: ['세션이 새 Codex thread에 연결됐어.', 'Session: omx-visible', 'Codex: codex-resumed'].join('\n'),
    },
    { discordMentionUsers: ['456789012345678901'] },
  );

  assert.match(message, /# Session Linked/);
  assert.match(message, /Codex: codex-resumed/);
  assert.doesNotMatch(message, /456789012345678901/);
});

test('eventToDiscordChunks formats user prompt events', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    {
      type: 'CommandSubmitted',
      source: 'bridge-interactions',
      timestamp: '2026-04-30T00:00:00.000Z',
      text: [
        '<subagent_notification>',
        '{"agent_path":"019e-example","status":"shutdown"}',
        '</subagent_notification>',
        '원문 프롬프트',
        '```bash',
        'git status',
        '```',
      ].join('\n'),
    },
  );
  assert.match(message, /# User Command/);
  assert.match(message, /원문 프롬프트/);
  assert.match(message, /``\u200b`bash/);
  assert.match(message, /\*\*session:\*\* `thread-1`\n\*\*tmux:\*\* `tmux-1` \| \*\*project:\*\* `omx-bridge`/);
  assert.doesNotMatch(message, /subagent_notification|agent_path/);
});

test('eventToDiscordChunks sends up to three continued notifications for long User Command events', () => {
  const chunks = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    {
      type: 'CommandSubmitted',
      source: 'bridge-interactions',
      timestamp: '2026-04-30T00:00:00.000Z',
      text: `${'대용량 프롬프트 '.repeat(400)}끝부분`,
    },
    { userCommandNotificationMaxChars: 500 },
  );

  assert.equal(chunks.length, 3);
  assert.equal(chunks.every((chunk) => chunk.length <= 1800), true);
  assert.match(chunks[0], /# User Command/);
  assert.match(chunks[0], /\*\*session:\*\* `thread-1`/);
  assert.match(chunks[0], /\(1\/3\)$/);
  assert.doesNotMatch(chunks[1], /# User Command|\*\*session:\*\*/);
  assert.match(chunks[1], /\(2\/3\)$/);
  assert.doesNotMatch(chunks[2], /# User Command|\*\*session:\*\*/);
  assert.match(chunks[2], /알림 잘림: User Command 원문/);
  assert.match(chunks[2], /\(3\/3\)$/);
  assert.equal(chunks.some((chunk) => /끝부분/.test(chunk)), false);
});

test('eventToDiscordChunks does not strip subagent notifications from FinalAnswer events', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    {
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-04-30T00:00:00.000Z',
      text: '<subagent_notification>\n{"agent_path":"019e-example"}\n</subagent_notification>\n최종 답변 본문',
    },
  );

  assert.match(message, /subagent_notification/);
  assert.match(message, /최종 답변 본문/);
});

test('eventToDiscordChunks formats idle and commentary events', () => {
  const [idle] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    { type: 'SessionIdle', source: 'codex-log', timestamp: '2026-04-30T00:00:01.000Z', text: '작업 완료. 다음 지시를 기다리는 상태입니다.' },
  );
  const [commentary] = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    { type: 'Commentary', source: 'codex-log', timestamp: '2026-04-30T00:00:02.000Z', text: '중간 상태 공유입니다.' },
  );
  assert.match(idle, /# Session Idle/);
  assert.match(idle, /\*\*Recent output:\*\*/);
  assert.match(idle, /작업 완료/);
  assert.match(idle, /\*\*session:\*\* `thread-1`\n\*\*tmux:\*\* `tmux-1` \| \*\*project:\*\* `omx-bridge`/);
  assert.doesNotMatch(idle, /\*\*Session:\*\*/);
  assert.doesNotMatch(idle, /\*\*Thread:\*\*/);
  assert.match(commentary, /# Commentary/);
  assert.match(commentary, /중간 상태 공유/);
  assert.match(commentary, /\*\*session:\*\* `thread-1`\n\*\*tmux:\*\* `tmux-1` \| \*\*project:\*\* `omx-bridge`/);
});

test('eventToDiscordChunks renders long SessionIdle chunks as one continued notification', () => {
  const chunks = eventToDiscordChunks(
    { project: 'omx-bridge', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    { type: 'SessionIdle', source: 'codex-log', timestamp: '2026-04-30T00:00:01.000Z', text: '작업 완료. 다음 지시를 기다리는 상태입니다. '.repeat(500) },
  );

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
  assert.match(chunks[0], /^# Session Idle\n\n\*\*Recent output:\*\*/);
  assert.match(chunks[0], /\(1\/\d+\)$/);
  assert.match(chunks[1], /^```/);
  assert.match(chunks[1], /\(2\/\d+\)$/);
  assert.doesNotMatch(chunks[1], /# Session Idle/);
  assert.doesNotMatch(chunks[1], /\*\*session:\*\*/);
  assert.ok(chunks.every((chunk, index) => chunk.includes(`(${index + 1}/${chunks.length})`)));
});

test('eventToDiscordChunks formats session end like OMX notification', () => {
  const [message] = eventToDiscordChunks(
    { project: 'omx-bridge', omxSessionId: 'omx-session', codexThreadId: 'thread-1', tmuxId: 'tmux-1' },
    { type: 'SessionEnd', source: 'notification', timestamp: '2026-04-30T00:18:34.000Z', text: 'ended', durationMs: 1114000, reason: 'session_exit' },
  );
  assert.match(message, /# Session Ended/);
  assert.match(message, /\*\*session:\*\* `omx-session`/);
  assert.match(message, /\*\*duration:\*\* 18m 34s/);
  assert.match(message, /\*\*reason:\*\* session_exit/);
  assert.match(message, /\*\*tmux:\*\* `tmux-1`/);
  assert.match(message, /\*\*project:\*\* `omx-bridge`/);
  assert.doesNotMatch(message, /\*\*thread:\*\*/);
});

test('pollDiscordNotifications is a no-op without a Discord destination', async () => {
  const result = await pollDiscordNotifications({
    projectRoot: process.cwd(),
    webhookUrl: '',
  });
  assert.deepEqual(result, { ok: false, reason: 'missing-discord-destination', sent: 0 });
});

test('pollDiscordNotifications ignores unmapped Codex fallback logs by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-unmapped-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '04');
  const statePath = join(root, 'state.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(sessionsDir, 'rollout-2026-05-04T18-48-51-unmapped-sidecar.jsonl'), [
    { timestamp: '2026-05-04T18:48:51.000Z', type: 'session_meta', payload: { id: 'unmapped-sidecar', timestamp: '2026-05-04T18:48:51.000Z', cwd: root } },
    { timestamp: '2026-05-04T18:49:06.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'sidecar explore failed' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    codexHome,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});

test('pollDiscordNotifications suppresses OMX team worker session notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-teamworker-'));
  const projectRoot = join(root, 'chiz-crab');
  const workerRoot = join(projectRoot, '.omx', 'team', 'extractor-safety', 'worktrees', 'worker-1');
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  await mkdir(join(workerRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(workerRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-team-worker-1',
    native_session_id: 'codex-team-worker-1',
    started_at: '2026-05-06T07:12:28.000Z',
    cwd: workerRoot,
    pid: 1234,
  }) + '\n');

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    projectRoots: [workerRoot],
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['SessionStart']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});

test('pollDiscordNotifications sends user prompts by default from Codex log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-prompt-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  const statePath = join(root, 'state.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-discord-prompt-session',
    native_session_id: 'codex-discord-prompt-session',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-06T08-00-00-codex-discord-prompt-session.jsonl'), [
    { timestamp: '2026-05-06T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-discord-prompt-session', timestamp: '2026-05-06T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-06T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '직접 입력한 프롬프트 원문' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 2);
  assert.ok(posts.some((post) => /# User Command/.test(post.content) && /직접 입력한 프롬프트 원문/.test(post.content)));
});

test('pollDiscordNotifications routes fast events to mapped Discord project channels with a bot token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-fast-channel-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-fast-start',
    native_session_id: 'codex-fast-start',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');

  const posts = [];
  const project = basename(root);
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMap: { default: 'fallback-channel', projects: { [project]: 'project-channel' } },
    eventTypes: new Set(['SessionStart']),
    replay: true,
    discordFetchFn: async (url, request = {}) => {
      posts.push({
        url,
        authorization: request.headers?.authorization,
        body: JSON.parse(request.body),
      });
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/project-channel/messages');
  assert.equal(posts[0].authorization, 'Bot test-token');
  assert.match(posts[0].body.content, /# Session Start/);
});

test('pollDiscordNotifications can auto create a Discord session thread inside the mapped project channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-session-thread-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-thread-start',
    native_session_id: 'codex-thread-start',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');

  const project = basename(root);
  await writeFile(mapPath, JSON.stringify({ projects: { [project]: 'project-channel' } }));

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionStart']),
    discordMentionUsers: ['456789012345678901'],
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      const method = request.method || 'GET';
      const body = request.body ? JSON.parse(request.body) : null;
      requests.push({ url, method, body });
      if (method === 'GET' && url.endsWith('/guilds/guild-1/threads/active')) {
        return { ok: true, json: async () => ({ threads: [] }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/project-channel/threads')) {
        assert.equal(body.type, 11);
        assert.equal(body.auto_archive_duration, 1440);
        assert.equal(body.name, 'omx-thread-start');
        return { ok: true, status: 201, json: async () => ({ id: 'session-thread', name: body.name, parent_id: 'project-channel', type: 11 }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/session-thread/messages')) {
        assert.match(body.content, /^<@456789012345678901>\n# Session Start/);
        assert.deepEqual(body.allowed_mentions, { users: ['456789012345678901'] });
        return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
      }
      throw new Error(`unexpected Discord request: ${method} ${url}`);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(requests.filter((request) => request.url.endsWith('/channels/project-channel/threads')).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith('/channels/session-thread/messages')).length, 1);

  const saved = JSON.parse(await readFile(mapPath, 'utf8'));
  const [entry] = Object.values(saved.sessionThreads);
  assert.equal(entry.parentChannelId, 'project-channel');
  assert.equal(entry.threadId, 'session-thread');
  assert.equal(entry.threadName, 'omx-thread-start');
});

test('pollDiscordNotifications repairs Hermes allowlist for parent project channel before thread delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-fast-allowlist-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-fast-allowlist',
    native_session_id: 'codex-fast-allowlist',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(mapPath, JSON.stringify({ projects: { [basename(root)]: 'project-channel' } }));
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: fallback-channel',
    '  allowed_channels: fallback-channel',
    '',
  ].join('\n'));

  const order = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    updateHermesConfig: true,
    eventTypes: new Set(['SessionStart']),
    replay: true,
    autoCreateDiscordThreads: true,
    hermesGatewayRestarter: async () => {
      order.push('restart');
      return { ok: true, restarted: true, command: 'test-restart' };
    },
    discordFetchFn: async (url, request = {}) => {
      const method = request.method || 'GET';
      order.push(`${method} ${url}`);
      const config = await readFile(hermesConfigPath, 'utf8');
      assert.match(config, /free_response_channels: fallback-channel,project-channel/);
      assert.match(config, /allowed_channels: fallback-channel,project-channel/);
      assert.doesNotMatch(config, /session-thread/);
      if (method === 'GET' && url.endsWith('/guilds/guild-1/threads/active')) {
        return { ok: true, json: async () => ({ threads: [] }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/project-channel/threads')) {
        return { ok: true, status: 201, json: async () => ({ id: 'session-thread', name: 'omx-fast-allowlist', parent_id: 'project-channel', type: 11 }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/session-thread/messages')) {
        return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
      }
      throw new Error(`unexpected Discord request: ${method} ${url}`);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(order[0], 'restart');
  assert.ok(order.some((entry) => entry.endsWith('/channels/session-thread/messages')));
  const saved = JSON.parse(await readFile(mapPath, 'utf8'));
  const [entry] = Object.values(saved.sessionThreads);
  assert.equal(entry.parentChannelId, 'project-channel');
  assert.equal(entry.threadId, 'session-thread');
});

test('pollDiscordNotifications reuses a mapped Discord session thread without creating duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-session-thread-reuse-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-thread-reuse',
    native_session_id: 'codex-thread-reuse',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');

  const project = basename(root);
  await writeFile(mapPath, JSON.stringify({
    projects: { [project]: 'project-channel' },
    sessionThreads: {
      'forced-session-key': {
        project,
        parentChannelId: 'project-channel',
        threadId: 'existing-session-thread',
        threadName: `${project.toLowerCase()}-forced-session-key`,
      },
    },
  }));

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    discordAlertChannelId: 'ops-alert-channel',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionStart']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordSessionThreadKey: 'forced-session-key',
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      assert.ok(url.endsWith('/channels/existing-session-thread/messages'));
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
});

test('pollDiscordNotifications sends CommandSubmitted to the owning mapped session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-owner-thread-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({
    projects: { docs: 'project-channel' },
    sessionThreads: {
      'omx-old': {
        project: 'docs',
        parentChannelId: 'project-channel',
        threadId: 'old-session-thread',
        threadName: 'omx-docs-190007',
      },
      'omx-new': {
        project: 'docs',
        parentChannelId: 'project-channel',
        threadId: 'new-session-thread',
        threadName: 'omx-docs-101814',
      },
    },
  }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new',
        codexThreadId: 'codex-new',
        codexSessionId: 'codex-new',
        omxSessionId: 'omx-new',
        runtimeOmxSessionId: 'omx-new',
        sessionLogOwnerMatch: 'runtime-omx-session',
        project: 'docs',
        status: 'active',
        hasOmxLifecycle: true,
      },
      event: {
        eventId: 'codex-new:message-2',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-14T01:19:17.670Z',
        text: 'new prompt',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      assert.ok(url.endsWith('/channels/new-session-thread/messages'));
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /# User Command/);
  assert.match(requests[0].body.content, /new prompt/);
  assert.equal(requests.some((request) => request.url.includes('old-session-thread')), false);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = Object.fromEntries(Object.entries(deliveryIndex.db.prepare(`
      SELECT target_channel_id, target_thread_id, target_thread_name, target_kind
      FROM deliveries
      WHERE event_id = 'codex-new:message-2' AND sink = 'discord-fast'
    `).get()));
    assert.deepEqual(row, {
      target_channel_id: 'new-session-thread',
      target_thread_id: 'new-session-thread',
      target_thread_name: 'omx-docs-101814',
      target_kind: 'session-thread',
    });
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications retargets stale resumed Codex commands to the current OMX session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-resume-current-thread-'));
  const projectRoot = join(root, 'news-insight');
  const oldRunRoot = join(root, 'omx-runs', 'run-old');
  const newRunRoot = join(root, 'omx-runs', 'run-new');
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');

  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(oldRunRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(newRunRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(newRunRoot, '.omx', 'state'), { recursive: true });
  await mkdir(join(codexHome, 'sessions', '2026', '05', '25'), { recursive: true });

  await writeFile(join(oldRunRoot, '.omxbox-run.json'), JSON.stringify({
    launcher: 'omx --madmax',
    created_at: '2026-05-24T15:45:40.000Z',
    cwd: oldRunRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(newRunRoot, '.omxbox-run.json'), JSON.stringify({
    launcher: 'omx --madmax',
    created_at: '2026-05-24T17:17:31.000Z',
    cwd: newRunRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(oldRunRoot, '.omx', 'logs', 'omx-2026-05-24.jsonl'), [
    { event: 'session_start', session_id: 'omx-old-thread', pid: 1001, timestamp: '2026-05-24T15:45:40.000Z' },
    { event: 'session_end', session_id: 'omx-old-thread', pid: 1001, timestamp: '2026-05-24T16:45:40.000Z', reason: 'session_exit' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(newRunRoot, '.omx', 'logs', 'omx-2026-05-24.jsonl'), [
    { event: 'session_start', session_id: 'omx-current-thread', pid: 2001, timestamp: '2026-05-24T17:17:31.000Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(newRunRoot, '.omx', 'state', 'session.json'), JSON.stringify({
    session_id: 'omx-current-thread',
    native_session_id: 'codex-resumed-thread',
    started_at: '2026-05-24T17:17:31.684Z',
    cwd: projectRoot,
    pid: 2002,
  }, null, 2));
  await writeFile(mapPath, JSON.stringify({
    projects: { 'news-insight': 'project-channel' },
    sessionThreads: {
      'omx-old-thread': {
        project: 'news-insight',
        parentChannelId: 'project-channel',
        threadId: 'old-session-thread',
        threadName: 'omx-news-insight-old',
      },
      'omx-current-thread': {
        project: 'news-insight',
        parentChannelId: 'project-channel',
        threadId: 'current-session-thread',
        threadName: 'omx-news-insight-current',
      },
    },
  }));

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-resumed-thread',
        codexThreadId: 'codex-resumed-thread',
        codexSessionId: 'codex-resumed-thread',
        omxSessionId: 'omx-current-thread',
        project: 'news-insight',
        status: 'active',
        hasOmxLifecycle: true,
      },
      event: {
        eventId: 'omx-current-thread:start:linked:codex-resumed-thread',
        type: 'SessionLinked',
        source: 'notification',
        timestamp: '2026-05-24T17:17:59.000Z',
        text: '세션이 새 Codex thread에 연결됐어.\nSession: omx-current-thread\nCodex: codex-resumed-thread',
      },
    }, {
      session: {
        bridgeSessionId: 'codex-resumed-thread',
        codexThreadId: 'codex-resumed-thread',
        codexSessionId: 'codex-resumed-thread',
        omxSessionId: 'omx-old-thread',
        runtimeOmxSessionId: 'omx-old-thread',
        project: 'news-insight',
        status: 'ended',
        hasOmxLifecycle: true,
      },
      event: {
        eventId: 'codex-resumed-thread:message-3',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-24T17:18:00.000Z',
        text: '실패했던 뉴스 인사이트 마무리는 못하나?',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const fakeTmuxBin = join(root, 'fake-tmux.sh');
  await writeFile(fakeTmuxBin, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "list-panes" ]; then
  printf 'omx-news-insight-021728\t%%77\t2002\t0\t%s\n' ${JSON.stringify(projectRoot)}
elif [ "$1" = "list-sessions" ]; then
  printf 'omx-news-insight-021728\t1779643051\t1\n'
fi
`);
  await chmod(fakeTmuxBin, 0o755);

  const requests = [];
  const result = await withEnv({ TMUX_BIN: fakeTmuxBin }, async () => pollDiscordNotifications({
    projectRoot: newRunRoot,
    projectRoots: [oldRunRoot, newRunRoot],
    codexHome,
    discoverTmuxProjectRoots: true,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    discordAlertChannelId: 'ops-alert-channel',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionLinked', 'CommandSubmitted']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      assert.ok(url.endsWith('/channels/current-session-thread/messages'));
      return { ok: true, json: async () => ({ id: `message-${requests.length}` }), text: async () => '' };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.equal(requests.length, 2);
  assert.match(requests[0].body.content, /# Session Linked/);
  assert.match(requests[1].body.content, /# User Command/);
  assert.equal(requests.some((request) => request.url.includes('old-session-thread')), false);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT json_extract(session_json, '$.omxSessionId') AS omx_session_id,
             target_thread_id
      FROM events
      JOIN deliveries USING (event_id)
      WHERE event_id = 'codex-resumed-thread:message-3' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.omx_session_id, 'omx-current-thread');
    assert.equal(row.target_thread_id, 'current-session-thread');
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications sends SessionEnd only to the owning mapped session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-end-thread-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({
    projects: { docs: 'project-channel' },
    sessionThreads: {
      'omx-old': {
        project: 'docs',
        parentChannelId: 'project-channel',
        threadId: 'old-session-thread',
        threadName: 'omx-docs-190007',
      },
      'omx-new': {
        project: 'docs',
        parentChannelId: 'project-channel',
        threadId: 'new-session-thread',
        threadName: 'omx-docs-101814',
      },
    },
  }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new',
        codexThreadId: 'codex-new',
        codexSessionId: 'codex-new',
        omxSessionId: 'omx-new',
        runtimeOmxSessionId: 'omx-new',
        sessionLogOwnerMatch: 'runtime-omx-session',
        project: 'docs',
        status: 'ended',
        hasOmxLifecycle: true,
        isAuxiliaryCodexLog: true,
        originator: 'codex_exec',
        sessionSource: 'exec',
      },
      event: {
        eventId: 'omx-new:end',
        type: 'SessionEnd',
        source: 'notification',
        timestamp: '2026-05-14T01:25:00.000Z',
        text: '세션이 종료됐어.',
        reason: 'session_exit',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionEnd']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      assert.ok(url.endsWith('/channels/new-session-thread/messages'));
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /# Session Ended/);
  assert.equal(requests.some((request) => request.url.includes('old-session-thread')), false);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = Object.fromEntries(Object.entries(deliveryIndex.db.prepare(`
      SELECT target_channel_id, target_thread_id, target_thread_name, target_kind
      FROM deliveries
      WHERE event_id = 'omx-new:end' AND sink = 'discord-fast'
    `).get()));
    assert.deepEqual(row, {
      target_channel_id: 'new-session-thread',
      target_thread_id: 'new-session-thread',
      target_thread_name: 'omx-docs-101814',
      target_kind: 'session-thread',
    });
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications does not fall back to project channel for unmapped SessionEnd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-end-project-channel-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({ projects: { docs: 'project-channel' } }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-ended-only',
        codexThreadId: 'codex-ended-only',
        codexSessionId: 'codex-ended-only',
        omxSessionId: 'codex-ended-only',
        project: 'docs',
        status: 'ended',
        hasOmxLifecycle: true,
        lifecycleOwner: 'omx',
      },
      event: {
        eventId: 'codex-ended-only:end',
        type: 'SessionEnd',
        source: 'notification',
        timestamp: '2026-05-14T10:17:33.368Z',
        text: '세션이 종료됐어.',
        reason: 'session_exit',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionEnd']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'alert-message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(requests[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.match(requests[0].body.content, /SessionEnd/);
  assert.doesNotMatch(requests[0].body.content, /세션이 종료됐어/);
  const savedMap = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(savedMap.sessionThreads, undefined);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = Object.fromEntries(Object.entries(deliveryIndex.db.prepare(`
      SELECT status, retry_count, last_error
      FROM deliveries
      WHERE event_id = 'codex-ended-only:end' AND sink = 'discord-fast'
    `).get()));
    assert.equal(row.status, 'dead');
    assert.equal(row.retry_count, 1);
    assert.match(row.last_error, /refusing project-channel fallback/);
  } finally {
    closeEventIndex(deliveryIndex);
  }
});


test('pollDiscordNotifications does not fall back to project channel for terminal events without a session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-terminal-no-channel-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({ projects: { docs: 'project-channel' } }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-terminal-only',
        codexThreadId: 'codex-terminal-only',
        codexSessionId: 'codex-terminal-only',
        omxSessionId: 'omx-terminal-only',
        project: 'docs',
        status: 'active',
        hasOmxLifecycle: true,
      },
      event: {
        eventId: 'codex-terminal-only:final',
        type: 'FinalAnswer',
        source: 'codex-log',
        timestamp: '2026-05-14T10:17:33.368Z',
        text: '완료 답변',
        phase: 'final_answer',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['FinalAnswer']),
    allowDiscordFinalAnswerNotifications: true,
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'alert-message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(requests[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.match(requests[0].body.content, /FinalAnswer/);
  assert.doesNotMatch(requests[0].body.content, /완료 답변/);
});

test('pollDiscordNotifications records SessionEnd delivery failure instead of falling back from a mismatched mapped thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-end-no-fallback-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({
    projects: { docs: 'project-channel' },
    sessionThreads: {
      'omx-new': {
        project: 'docs',
        parentChannelId: 'other-project-channel',
        threadId: 'existing-session-thread',
        threadName: 'omx-docs-101814',
      },
    },
  }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-new',
        codexThreadId: 'codex-new',
        codexSessionId: 'codex-new',
        omxSessionId: 'omx-new',
        project: 'docs',
        status: 'ended',
        hasOmxLifecycle: true,
        isAuxiliaryCodexLog: true,
        originator: 'codex_exec',
        sessionSource: 'exec',
      },
      event: {
        eventId: 'omx-new:end',
        type: 'SessionEnd',
        source: 'notification',
        timestamp: '2026-05-14T01:25:00.000Z',
        text: '세션이 종료됐어.',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionEnd']),
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      requests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(requests[0].body.content, /# Bridge Notification Delivery Failed/);
  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT status, last_error, target_channel_id, target_thread_id
      FROM deliveries
      WHERE event_id = 'omx-new:end' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.status, 'dead');
    assert.match(row.last_error, /mapped-session-thread-parent-mismatch/);
    assert.equal(row.target_channel_id, null);
    assert.equal(row.target_thread_id, null);
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications holds new same-session events while an older retry is waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-failed-retry-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const session = {
    bridgeSessionId: 'codex-new-command',
    codexThreadId: 'codex-new-command',
    codexSessionId: 'codex-new-command',
    omxSessionId: 'omx-new-command',
    project: 'omx-bridge',
    status: 'active',
    hasOmxLifecycle: true,
  };
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'old-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:00.000Z',
          text: 'old command',
        },
      },
      {
        session,
        event: {
          eventId: 'new-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:30:00.000Z',
          text: 'new command',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'old-command', 'discord-fast', new Error('previous Discord channel failure'), { retryBaseMs: 60_000 });
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    maxEventsPerPoll: 1,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});

test('pollDiscordNotifications holds queued commands behind pending Hermes final delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-cross-sink-final-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const session = {
    bridgeSessionId: 'codex-queue-command',
    codexThreadId: 'codex-queue-command',
    codexSessionId: 'codex-queue-command',
    omxSessionId: 'omx-queue-command',
    project: 'omx-bridge',
    status: 'active',
    hasOmxLifecycle: true,
  };
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'final-before-queue',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-29T05:55:50.000Z',
          text: 'done',
        },
      },
      {
        session,
        event: {
          eventId: 'queued-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-29T05:55:51.000Z',
          text: 'next prompt',
        },
      },
    ]);
    markDeliveryPrepared(index.db, 'final-before-queue', 'hermes', { chunks: ['done'] });
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const held = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });
  assert.equal(held.sent, 0);
  assert.equal(posts.length, 0);

  const releasedIndex = await openEventIndex(root, { eventIndexPath });
  try {
    markDeliverySent(releasedIndex.db, 'final-before-queue', 'hermes');
  } finally {
    closeEventIndex(releasedIndex);
  }
  const released = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(released.sent, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /# User Command/);
  assert.match(posts[0].content, /next prompt/);
});

test('pollDiscordNotifications indexes non-notified final answers as command blockers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-index-final-blocker-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-index-final-blocker',
    native_session_id: 'codex-index-final-blocker',
    started_at: '2026-05-29T05:55:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(codexHome, 'sessions', 'rollout-2026-05-29T05-55-00-codex-index-final-blocker.jsonl'), [
    { timestamp: '2026-05-29T05:55:00.000Z', type: 'session_meta', payload: { id: 'codex-index-final-blocker', timestamp: '2026-05-29T05:55:00.000Z', cwd: root } },
    { timestamp: '2026-05-29T05:55:50.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] } },
    { timestamp: '2026-05-29T05:55:51.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next prompt' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const held = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    priorFinalAnswerGraceMs: 1_000_000_000_000,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });
  assert.equal(held.sent, 0);
  assert.equal(posts.length, 0);

  const index = await openEventIndex(root, { eventIndexPath });
  let finalEventId;
  try {
    const events = index.db.prepare(`
      SELECT event_id, event_type
      FROM events
      WHERE event_id LIKE 'codex-index-final-blocker:message-%'
      ORDER BY event_id
    `).all();
    assert.deepEqual(events.map((event) => event.event_type), ['FinalAnswer', 'CommandSubmitted']);
    finalEventId = events.find((event) => event.event_type === 'FinalAnswer')?.event_id;
    assert.ok(finalEventId);
    const delivery = index.db.prepare(`
      SELECT status
      FROM deliveries
      WHERE event_id = ? AND sink = 'discord-fast'
    `).get(finalEventId);
    assert.equal(delivery, undefined);
    markDeliverySent(index.db, finalEventId, 'hermes');
  } finally {
    closeEventIndex(index);
  }

  const released = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    priorFinalAnswerGraceMs: 1_000_000_000_000,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(released.sent, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /# User Command/);
  assert.match(posts[0].content, /next prompt/);
});

test('pollDiscordNotifications can disable final-answer command blocking with short env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-final-block-env-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const session = {
    bridgeSessionId: 'codex-queue-command',
    codexThreadId: 'codex-queue-command',
    codexSessionId: 'codex-queue-command',
    omxSessionId: 'omx-queue-command',
    project: 'omx-bridge',
    status: 'active',
    hasOmxLifecycle: true,
  };
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session,
        event: {
          eventId: 'final-before-queue',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-29T05:55:50.000Z',
          text: 'done',
        },
      },
      {
        session,
        event: {
          eventId: 'queued-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-29T05:55:51.000Z',
          text: 'next prompt',
        },
      },
    ]);
    markDeliveryPrepared(index.db, 'final-before-queue', 'hermes', { chunks: ['done'] });
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await withEnv({ BRIDGE_FINAL_BLOCK: '0' }, () => pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  }));

  assert.equal(result.sent, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /# User Command/);
  assert.match(posts[0].content, /next prompt/);
});

test('pollDiscordNotifications retries the head event immediately before sending the next event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-immediate-retry-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session: { bridgeSessionId: 'old-session', project: 'omx-bridge', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'old-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:00.000Z',
          text: 'old command',
        },
      },
      {
        session: { bridgeSessionId: 'new-session', project: 'omx-bridge', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'new-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:01.000Z',
          text: 'new command',
        },
      },
    ]);
  } finally {
    closeEventIndex(index);
  }

  const attempts = [];
  let oldAttempts = 0;
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    maxEventsPerPoll: 2,
    deliveryMaxAttempts: 2,
    fetchFn: async (_url, request) => {
      const body = JSON.parse(request.body);
      attempts.push(body.content);
      if (/old command/.test(body.content) && oldAttempts++ === 0) {
        return { ok: false, status: 503, text: async () => 'temporary outage' };
      }
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.match(attempts[0], /old command/);
  assert.match(attempts[1], /old command/);
  assert.match(attempts[2], /new command/);
});

test('pollDiscordNotifications marks the head event dead after bounded retries before advancing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-bounded-dead-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session: { bridgeSessionId: 'old-session', project: 'omx-bridge', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'old-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:00.000Z',
          text: 'old command',
        },
      },
      {
        session: { bridgeSessionId: 'new-session', project: 'omx-bridge', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'new-command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:01.000Z',
          text: 'new command',
        },
      },
    ]);
  } finally {
    closeEventIndex(index);
  }

  const attempts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    maxEventsPerPoll: 2,
    deliveryMaxAttempts: 2,
    fetchFn: async (_url, request) => {
      const body = JSON.parse(request.body);
      attempts.push(body.content);
      if (/old command/.test(body.content)) {
        return { ok: false, status: 503, text: async () => 'still down' };
      }
      return { ok: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.match(attempts[0], /old command/);
  assert.match(attempts[1], /old command/);
  assert.match(attempts[2], /new command/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const rows = deliveryIndex.db.prepare(`
      SELECT event_id, status, retry_count
      FROM deliveries
      WHERE sink = 'discord-fast'
      ORDER BY event_id
    `).all();
    assert.deepEqual(rows.map((row) => [row.event_id, row.status, row.retry_count]), [
      ['new-command', 'sent', 0],
      ['old-command', 'dead', 2],
    ]);
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications marks permanent Discord HTTP failures dead without retry and emits an alert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-permanent-http-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await writeFile(mapPath, JSON.stringify({ projects: { docs: 'project-channel' } }));
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'session-403', project: 'docs', status: 'active', hasOmxLifecycle: true },
      event: {
        eventId: 'session-403:start',
        type: 'SessionStart',
        source: 'notification',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: 'started',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const requests = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    discordAlertChannelId: 'ops-alert-channel',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['SessionStart']),
    replay: true,
    discordFetchFn: async (url, request = {}) => {
      const body = request.body ? JSON.parse(request.body) : null;
      requests.push({ url, body });
      if (body?.content?.includes('# Session Start')) {
        return { ok: false, status: 403, text: async () => 'forbidden' };
      }
      return { ok: true, json: async () => ({ id: 'alert-message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('/channels/ops-alert-channel/messages'));
  assert.match(requests[1].body.content, /# Bridge Notification Delivery Failed/);
  assert.match(requests[1].body.content, /permanent-http/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT status, retry_count, last_error
      FROM deliveries
      WHERE event_id = 'session-403:start' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.status, 'dead');
    assert.equal(row.retry_count, 1);
    assert.match(row.last_error, /permanent-http/);
    assert.match(row.last_error, /403 forbidden/);
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications waits briefly for short Discord 429 Retry-After before retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-short-rate-limit-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'rate-short', project: 'docs', status: 'active', hasOmxLifecycle: true },
      event: {
        eventId: 'rate-short:command',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: 'short rate limit command',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const sleeps = [];
  let attempts = 0;
  const result = await withEnv({
    DISCORD_429_MAX_WAIT_MS: '1000',
  }, () => pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    deliveryMaxAttempts: 3,
    discordSleepFn: async (ms) => { sleeps.push(ms); },
    fetchFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '0.25' : '') },
          text: async () => '{"retry_after":0.25}',
        };
      }
      return { ok: true };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [250]);
});

test('pollDiscordNotifications holds a long Discord 429 without sending later events out of order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-long-rate-limit-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session: { bridgeSessionId: 'rate-old', project: 'docs', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'rate-old:command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:00.000Z',
          text: 'rate limited command',
        },
      },
      {
        session: { bridgeSessionId: 'rate-new', project: 'docs', status: 'active', hasOmxLifecycle: true },
        event: {
          eventId: 'rate-new:command',
          type: 'CommandSubmitted',
          source: 'codex-log',
          timestamp: '2026-05-14T01:00:01.000Z',
          text: 'must not jump the queue',
        },
      },
    ]);
  } finally {
    closeEventIndex(index);
  }

  const attempts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    maxEventsPerPoll: 2,
    discordRateLimitInlineWaitMaxMs: 1000,
    fetchFn: async (_url, request) => {
      attempts.push(JSON.parse(request.body).content);
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '2' : '') },
        text: async () => '{"retry_after":2}',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(attempts.length, 1);
  assert.match(attempts[0], /rate limited command/);
  assert.doesNotMatch(attempts[0], /must not jump/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT status, retry_count, next_attempt_at, last_error
      FROM deliveries
      WHERE event_id = 'rate-old:command' AND sink = 'discord-fast'
    `).get();
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 1);
    assert.match(row.next_attempt_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row.last_error, /rate-limit-hold/);
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications times out a hanging Discord post attempt and retries within the bounded budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-timeout-retry-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'timeout-session', project: 'docs', status: 'active', hasOmxLifecycle: true },
      event: {
        eventId: 'timeout-session:command',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: 'timeout once',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  let attempts = 0;
  const result = await withEnv({
    DISCORD_POST_TIMEOUT_MS: '1',
  }, () => pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    deliveryMaxAttempts: 2,
    fetchFn: async (_url, request) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return { ok: true };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.equal(attempts, 2);
});

test('pollDiscordNotifications keeps multi-chunk delivery unsent when a later chunk is dead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-partial-chunk-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const longCommand = `${'첫 번째 조각 '.repeat(260)}${'두 번째 조각 '.repeat(260)}`;
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: { bridgeSessionId: 'chunk-session', project: 'docs', status: 'active', hasOmxLifecycle: true },
      event: {
        eventId: 'chunk-session:command',
        type: 'CommandSubmitted',
        source: 'codex-log',
        timestamp: '2026-05-14T01:00:00.000Z',
        text: longCommand,
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const attempts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    deliveryMaxAttempts: 2,
    userCommandNotificationMaxChars: 4000,
    fetchFn: async (_url, request) => {
      attempts.push(JSON.parse(request.body).content);
      if (attempts.length === 1) return { ok: true };
      return { ok: false, status: 500, text: async () => 'chunk outage' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(attempts.length, 3);
  assert.match(attempts[0], /\(1\/3\)$/);
  assert.match(attempts[1], /\(2\/3\)$/);
  assert.match(attempts[2], /\(2\/3\)$/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT status, retry_count, last_error, payload_json
      FROM deliveries
      WHERE event_id = 'chunk-session:command' AND sink = 'discord-fast'
    `).get();
    const payload = JSON.parse(row.payload_json);
    assert.equal(row.status, 'dead');
    assert.equal(row.retry_count, 2);
    assert.match(row.last_error, /chunk 2\/3/);
    assert.equal(payload.chunkManifest.length, 3);
    assert.equal(payload.chunkDeliveryPolicy, 'mark-sent-only-after-all-chunks; dead-on-exhausted-chunk');
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollDiscordNotifications does not replay old non-active remapped SessionStart after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-remapped-start-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), [
    JSON.stringify({
      session_id: 'omx-old-unsent',
      native_session_id: 'codex-old-unsent',
      started_at: '2026-05-09T00:00:00.000Z',
      cwd: root,
      pid: 122,
    }),
    JSON.stringify({
      session_id: 'omx-visible',
      native_session_id: 'codex-after-new',
      started_at: '2026-05-09T00:00:00.000Z',
      cwd: root,
      pid: 123,
    }),
  ].join('\n') + '\n');

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-before-new',
        codexThreadId: 'codex-before-new',
        codexSessionId: 'codex-before-new',
        omxSessionId: 'omx-visible',
        project: basename(root),
        status: 'active',
      },
      event: {
        eventId: 'omx-visible:start',
        type: 'SessionStart',
        source: 'notification',
        timestamp: '2026-05-09T00:00:00.000Z',
        text: '새 세션을 시작했어.',
      },
    }]);
    markDeliverySent(index.db, 'omx-visible:start', 'discord-fast');
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['SessionStart']),
    bootSince: '2026-05-09T00:01:00.000Z',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);

  const again = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['SessionStart']),
    bootSince: '2026-05-09T00:01:00.000Z',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(again.sent, 0);
  assert.equal(posts.length, 0);
});


test('pollDiscordNotifications sends all opt-in long FinalAnswer chunks to the same session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-final-thread-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-final-thread',
    native_session_id: 'codex-final-thread',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(codexHome, 'sessions', 'rollout-2026-05-12T08-00-00-codex-final-thread.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-final-thread', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '긴 응답 '.repeat(900) }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  const project = basename(root);
  await writeFile(mapPath, JSON.stringify({
    projects: { [project]: 'project-channel' },
    sessionThreads: {
      'omx-final-thread': { project, parentChannelId: 'project-channel', threadId: 'session-thread', threadName: 'omx-final-thread' },
    },
  }));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['FinalAnswer']),
    allowDiscordFinalAnswerNotifications: true,
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      posts.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 1);
  assert.ok(posts.length > 1);
  assert.ok(posts.every((post) => post.url.endsWith('/channels/session-thread/messages')));
  assert.match(posts[0].body.content, /# Session Idle/);
  assert.doesNotMatch(posts.at(-1).body.content, /# Session Idle|# Final Answer/);
});

test('pollDiscordNotifications keeps opt-in FinalAnswer delivery before a later user command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-near-final-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-discord-near-final',
    native_session_id: 'codex-discord-near-final',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(codexHome, 'sessions', 'rollout-2026-05-12T08-00-00-codex-discord-near-final.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-discord-near-final', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:14.324Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '커밋 전 최종 답변' }] } },
    { timestamp: '2026-05-12T08:00:14.525Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '커밋하고 푸시해' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: 'http://discord.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'CommandSubmitted']),
    allowDiscordFinalAnswerNotifications: true,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 2);
  assert.equal(posts.length, 2);
  assert.match(posts[0].content, /# Session Idle/);
  assert.match(posts[0].content, /커밋 전 최종 답변/);
  assert.match(posts[1].content, /# User Command/);
  assert.match(posts[1].content, /커밋하고 푸시해/);
});

test('pollDiscordNotifications does not create missing threads for opt-in FinalAnswer events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-final-no-thread-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: '019e3f32-811e-7920-a64e-2c7b8b539275',
    native_session_id: 'codex-final-no-thread',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(codexHome, 'sessions', 'rollout-2026-05-12T08-00-00-codex-final-no-thread.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-final-no-thread', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '마지막 응답입니다.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(mapPath, JSON.stringify({ projects: { [basename(root)]: 'project-channel' } }));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['FinalAnswer']),
    allowDiscordFinalAnswerNotifications: true,
    replay: true,
    autoCreateDiscordThreads: true,
    discordFetchFn: async (url, request = {}) => {
      posts.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(posts[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.doesNotMatch(posts[0].body.content, /late answer/);
});

test('pollDiscordNotifications does not auto-create raw-id threads for codex-only command events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-discord-codex-only-command-'));
  const codexHome = join(root, 'codex-home');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const codexSessionId = '019e3f32-811e-7920-a64e-2c7b8b539275';
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await writeFile(join(codexHome, 'sessions', `rollout-2026-05-12T08-00-00-${codexSessionId}.jsonl`), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: codexSessionId, timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '이 명령은 codex-only 로그에서 왔습니다.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(mapPath, JSON.stringify({ projects: { [basename(root)]: 'project-channel' } }));

  const posts = [];
  const result = await pollDiscordNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: '',
    discordBotToken: 'test-token',
    projectChannelMapPath: mapPath,
    eventTypes: new Set(['CommandSubmitted']),
    replay: true,
    autoCreateDiscordThreads: true,
    includeUnmappedCodexLogs: true,
    allowCodexOnlySessionMonitoring: true,
    discordFetchFn: async (url, request = {}) => {
      posts.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(posts[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.doesNotMatch(posts[0].body.content, /raw codex command/);
});
