import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHermesWebhookRequest,
  eventToHermesPayload,
  hermesPayloadNotificationChunks,
  pollHermesWebhookNotifications,
  sessionContextLine,
  shouldForwardToHermes,
  splitNotificationMarkdown,
} from '../src/hermes-webhook-sink.js';
import { ensureHermesDiscordChannelAllowed } from '../src/hermes-config.js';
import { closeEventIndex, getGjcLogCursor, markDeliveryFailed, markDeliverySent, openEventIndex, upsertEvents } from '../src/control-plane/event-index.js';
import { channelForProject, channelNameForProject, resolveProjectChannel } from '../src/project-channels.js';
import { listDiscordGuildChannels, resolveDiscordGuildId } from '../src/discord-channels.js';

process.env.GJC_SESSIONS_ROOT ??= join(tmpdir(), 'hermes-tmux-bridge-empty-gjc-sessions-for-tests');

function localDateTimeSuffix(value) {
  const date = new Date(value);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('');
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  return `${day}-${time}`;
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

test('ensureHermesDiscordChannelAllowed treats YAML continuation channels as already allowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-continuation-'));
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  const original = [
    'discord:',
    '  require_mention: true',
    '  free_response_channels: project-channel',
    '    existing-thread,other-thread',
    '  allowed_channels: project-channel',
    '    existing-thread,other-thread',
    '',
  ].join('\n');
  await writeFile(hermesConfigPath, original);

  const gatewayRestarts = [];
  const result = await ensureHermesDiscordChannelAllowed('existing-thread', {
    hermesConfigPath,
    updateHermesConfig: true,
    hermesGatewayRestarter: async () => {
      gatewayRestarts.push('restart');
      return { ok: true, restarted: true };
    },
  });

  assert.deepEqual(result, { ok: true, changed: false, path: hermesConfigPath });
  assert.equal(gatewayRestarts.length, 0);
  assert.equal(await readFile(hermesConfigPath, 'utf8'), original);
});

test('ensureHermesDiscordChannelAllowed normalizes continuation lists only when adding a missing channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-continuation-add-'));
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: project-channel',
    '    existing-thread,project-channel',
    '  allowed_channels: project-channel',
    '    existing-thread,project-channel',
    '',
  ].join('\n'));

  const gatewayRestarts = [];
  const result = await ensureHermesDiscordChannelAllowed('new-thread', {
    hermesConfigPath,
    updateHermesConfig: true,
    hermesGatewayRestarter: async () => {
      gatewayRestarts.push('restart');
      return { ok: true, restarted: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(gatewayRestarts.length, 1);
  const hermesConfig = await readFile(hermesConfigPath, 'utf8');
  assert.match(hermesConfig, /free_response_channels: project-channel,existing-thread,new-thread/);
  assert.match(hermesConfig, /allowed_channels: project-channel,existing-thread,new-thread/);
  assert.doesNotMatch(hermesConfig, /project-channel,project-channel/);
});

test('ensureHermesDiscordChannelAllowed reads the short env surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-env-surface-'));
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: project-channel',
    '  allowed_channels: project-channel',
    '',
  ].join('\n'));

  const previous = {
    config: process.env.BRIDGE_HERMES_CONFIG,
    allowlist: process.env.BRIDGE_HERMES_ALLOWLIST,
    restart: process.env.BRIDGE_HERMES_RESTART,
    restartCmd: process.env.BRIDGE_HERMES_RESTART_CMD,
  };
  const restore = () => {
    for (const [key, value] of [
      ['BRIDGE_HERMES_CONFIG', previous.config],
      ['BRIDGE_HERMES_ALLOWLIST', previous.allowlist],
      ['BRIDGE_HERMES_RESTART', previous.restart],
      ['BRIDGE_HERMES_RESTART_CMD', previous.restartCmd],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    process.env.BRIDGE_HERMES_CONFIG = hermesConfigPath;
    process.env.BRIDGE_HERMES_ALLOWLIST = 'true';
    process.env.BRIDGE_HERMES_RESTART = 'false';
    process.env.BRIDGE_HERMES_RESTART_CMD = 'should-not-run';

    const result = await ensureHermesDiscordChannelAllowed('new-thread');

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.restart.restarted, false);
    assert.equal(result.restart.reason, 'disabled');
  } finally {
    restore();
  }
});

test('eventToHermesPayload builds project-routed bridge context without full-log dependency', () => {
  const payload = eventToHermesPayload(
    {
      bridgeSessionId: 'bridge-1',
      omxSessionId: 'omx-1',
      codexSessionId: 'thread-1',
      codexThreadId: 'thread-1',
      tmuxId: 'tmux-1',
      project: 'omx-bridge',
      kind: 'omx-tmux',
      status: 'active',
    },
    {
      eventId: 'event-1',
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-05-03T00:00:00.000Z',
      phase: 'final_answer',
      text: 'abcdef',
    },
    { channelId: '567890123456789012', bridgeUrl: 'http://127.0.0.1:3037', textPreviewChars: 3, channelMappingStatus: 'project', channelMissing: false },
  );

  assert.equal(payload.event_type, 'FinalAnswer');
  assert.equal(payload.event_name, 'Session Idle');
  assert.equal(payload.event_context_line, '**session:** `bridge-1`\n**tmux:** `tmux-1` | **project:** `omx-bridge`');
  assert.equal(payload.notification_mode, 'direct');
  assert.match(payload.message_markdown, /# Session Idle/);
  assert.doesNotMatch(payload.message_markdown, /작업 결과가 도착했어/);
  assert.doesNotMatch(payload.message_markdown, /\*\*event:\*\*/);
  assert.match(payload.message_markdown, /abcdef/);
  assert.equal(payload.project, 'omx-bridge');
  assert.equal(payload.channel_id, '567890123456789012');
  assert.equal(payload.default_channel_id, null);
  assert.equal(payload.fallback_channel_id, null);
  assert.equal(payload.desired_channel_name, 'omx-bridge');
  assert.equal(payload.channel_mapping_status, 'project');
  assert.equal(payload.channel_missing, false);
  assert.equal(payload.auto_create_channel, true);
  assert.equal(payload.bridge_session_id, 'bridge-1');
  assert.equal(payload.session_id, 'bridge-1');
  assert.equal(payload.thread_id, 'thread-1');
  assert.equal(payload.tmux_id, 'tmux-1');
  assert.equal(payload.session_context_line, '**session:** `bridge-1`\n**tmux:** `tmux-1` | **project:** `omx-bridge`');
  assert.equal(payload.text_preview, 'abc');
  assert.equal(payload.text_length, 6);
  assert.equal(payload.text_truncated, true);
  assert.equal(payload.read_endpoints.state, '/sessions/bridge-1/state');
  assert.equal(payload.read_endpoints.events, '/sessions/bridge-1/events');
});

test('eventToHermesPayload direct mode embeds FinalAnswer fullText without preview truncation', () => {
  const fullText = '최종 답변 원문입니다. '.repeat(400);
  const payload = eventToHermesPayload(
    {
      bridgeSessionId: 'bridge-1',
      omxSessionId: 'omx-visible-1',
      codexSessionId: 'thread-1',
      codexThreadId: 'thread-1',
      tmuxId: 'omx-project-123456',
      project: 'omx-bridge',
    },
    {
      eventId: 'event-1',
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-05-03T00:00:00.000Z',
      phase: 'final_answer',
      text: '짧은 task_complete preview',
    },
    {
      channelId: 'thread-channel',
      notificationMode: 'direct',
      directFullText: fullText,
      directFullTextSource: 'codex-log:latestAssistantMessage',
      textPreviewChars: 20,
      discordThreadId: 'discord-thread-1',
      discordThreadName: 'omx-project-123456',
      discordParentChannelId: 'project-channel',
      channelMappingStatus: 'session-thread',
    },
  );

  assert.equal(payload.notification_mode, 'direct');
  assert.equal(payload.direct_full_text_source, 'codex-log:latestAssistantMessage');
  assert.equal(payload.discord_thread_id, 'discord-thread-1');
  assert.equal(payload.discord_thread_name, 'omx-project-123456');
  assert.equal(payload.channel_id, 'thread-channel');
  assert.equal(payload.discord_delivery_target_id, 'thread-channel');
  assert.equal(payload.discord_delivery_target_kind, 'session-thread');
  assert.equal(payload.chunk_delivery_channel_id, 'thread-channel');
  assert.equal(payload.text_truncated, true);
  assert.match(payload.message_markdown, /최종 답변 원문입니다/);
  assert.equal(payload.message_markdown.includes(fullText.trim()), true);
});

test('hermesPayloadNotificationChunks splits long direct FinalAnswer payloads at 1800 chars with subject only once', () => {
  const payload = eventToHermesPayload(
    {
      bridgeSessionId: 'bridge-1',
      omxSessionId: 'omx-visible-1',
      codexSessionId: 'thread-1',
      tmuxId: 'omx-project-123456',
      project: 'omx-bridge',
    },
    {
      eventId: 'event-1',
      type: 'FinalAnswer',
      source: 'codex-log',
      timestamp: '2026-05-03T00:00:00.000Z',
      phase: 'final_answer',
      text: '짧은 task_complete preview',
    },
    {
      channelId: 'thread-channel',
      notificationMode: 'direct',
      directFullText: '긴 최종 답변 본문입니다. '.repeat(500),
      directFullTextSource: 'codex-log:latestAssistantMessage',
      discordThreadId: 'discord-thread-1',
      discordThreadName: 'omx-project-123456',
      discordParentChannelId: 'project-channel',
      channelMappingStatus: 'session-thread',
    },
  );

  const chunks = hermesPayloadNotificationChunks(payload);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.message_markdown.length <= 1800), true);
  assert.equal(chunks.every((chunk) => chunk.channel_id === 'thread-channel'), true);
  assert.equal(chunks.every((chunk) => chunk.discord_delivery_target_id === 'thread-channel'), true);
  assert.equal(chunks.every((chunk) => chunk.chunk_delivery_channel_id === 'thread-channel'), true);
  assert.match(chunks[0].message_markdown, /^# Session Idle/);
  assert.match(chunks[0].message_markdown, /\*\*session:\*\* `bridge-1`/);
  assert.doesNotMatch(chunks[1].message_markdown, /# Session Idle/);
  assert.doesNotMatch(chunks[1].message_markdown, /\*\*session:\*\*/);
  assert.equal(chunks[0].event_id, `event-1:chunk-1-of-${chunks.length}`);
  assert.equal(chunks[1].event_id, `event-1:chunk-2-of-${chunks.length}`);
  assert.equal(chunks[0].parent_event_id, 'event-1');
  assert.equal(chunks[0].notification_subject_included, true);
  assert.equal(chunks[1].notification_subject_included, false);
  assert.equal(chunks.every((chunk, index) => chunk.message_markdown.includes(`(${index + 1}/${chunks.length})`)), true);
});

test('splitNotificationMarkdown preserves markdown fence balance and ordinal markers', () => {
  const markdown = [
    '# Session Idle',
    '**session:** `bridge-1`',
    '',
    '```log',
    ...Array.from({ length: 120 }, (_value, index) => `line-${index.toString().padStart(3, '0')} ${'x'.repeat(36)}`),
    '```',
    '',
    'tail paragraph after fence',
  ].join('\n');

  const chunks = splitNotificationMarkdown(markdown, { notificationChunkChars: 500 });

  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.length <= 500), true);
  assert.equal(chunks.every((chunk, index) => chunk.endsWith(`(${index + 1}/${chunks.length})`)), true);
  assert.match(chunks[0], /^# Session Idle/);
  assert.doesNotMatch(chunks[1], /# Session Idle/);
  for (const chunk of chunks) {
    const fenceLines = chunk.split('\n').filter((line) => /^```/.test(line));
    assert.equal(fenceLines.length % 2, 0, `unbalanced fenced code block in chunk:\n${chunk}`);
  }
});

test('Hermes subscription prompt keeps FinalAnswer summaries sufficiently detailed', async () => {
  const promptSource = await readFile(join(process.cwd(), 'scripts', 'install-hermes-stack.sh'), 'utf8');
  const skillSource = await readFile(join(process.cwd(), 'skills', 'hermes-tmux-bridge', 'SKILL.md'), 'utf8');
  const promptMatch = /cat <<'PROMPT'\n([\s\S]*?)\nPROMPT/.exec(promptSource);
  assert.ok(promptMatch, 'subscription prompt heredoc exists');

  for (const source of [promptSource, skillSource]) {
    assert.match(source, /핵심 결론/);
    assert.match(source, /원인\/수정 내용/);
    assert.match(source, /검증 결과/);
    assert.match(source, /남은 주의\/운영 조치/);
  }
  assert.ok(promptMatch[1].length < 4300, 'subscription prompt stays concise enough for webhook runs');
  assert.doesNotMatch(promptMatch[1], /좋은 FinalAnswer 예|좋은 예:/);
  assert.match(promptSource, /8~12줄.*12~20줄.*20~36줄/);
  assert.match(promptSource, /text_truncated=true.*read_endpoints\.idle_latest/);
  assert.match(promptSource, /notification_mode=direct.*summary를 만들지 않는다/s);
  assert.match(promptSource, /알림=응답.*확인 금지/s);
  assert.match(skillSource, /do not send a second transport confirmation/);
  assert.match(promptSource, /direct_full_text_unavailable=true.*실패를 명시/s);
  assert.match(promptSource, /\/sessions(?:`|\/:id\/state)|\/sessions\/:id\/state/);
  assert.match(promptSource, /\/sessions\/:id\/state/);
  assert.match(promptSource, /\/sessions\/:id\/idle\/latest/);
  assert.match(promptSource, /payload\.message_markdown.*골격/);
  assert.match(promptSource, /판단 근거.*수정 포인트/);
  assert.match(promptSource, /대표 묶음.*판단에 필요한 식별자/);
  assert.match(promptSource, /markdown fence(?:가 깨지지 않게| 보존)/);
  assert.match(promptSource, /분할 시 모든 조각 끝에 `\(i\/N\)`.*제목\/컨텍스트는 첫 조각만/);
  assert.match(promptSource, /후속 조각도 같은 `channel_id`\/`discord_delivery_target_id`로만 전송/);
  assert.match(promptSource, /설명 문장은 한국어 중심/);
  assert.match(promptSource, /Document graph.*문서 그래프/);
  assert.match(promptSource, /keyword_fallback.*키워드 fallback 경로/);
  assert.match(promptSource, /영어 명사구를 한국어 문장 안에 길게 이어 붙이지 않는다/);
  assert.match(skillSource, /length-adaptive detail/);
  assert.match(skillSource, /text_truncated=true/);
  assert.match(skillSource, /payload\.message_markdown.*skeleton/);
  assert.match(skillSource, /notification_mode: "direct".*do not summarize/s);
  assert.match(skillSource, /direct_full_text_unavailable.*do not silently fall back/s);
  assert.match(skillSource, /Group file\/config\/commit\/test lists/);
  assert.match(skillSource, /do not collapse evidence/);
  assert.match(skillSource, /Write explanatory prose primarily in Korean/);
  assert.match(skillSource, /continued notification.*end every chunk with an `\(i\/N\)` marker.*Do not repeat `Session Idle`/s);
  assert.match(skillSource, /Document graph.*문서 그래프/);
  assert.match(skillSource, /keyword_fallback.*키워드 fallback 경로/);
});

test('Hermes trigger phrases route to helper CLI and bridge read API', async () => {
  const promptSource = await readFile(join(process.cwd(), 'scripts', 'install-hermes-stack.sh'), 'utf8');
  const skillSource = await readFile(join(process.cwd(), 'skills', 'tm-send', 'SKILL.md'), 'utf8');
  const bridgeSkillSource = await readFile(join(process.cwd(), 'skills', 'hermes-tmux-bridge', 'SKILL.md'), 'utf8');
  const operationsSource = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');
  const tmNewSource = await readFile(join(process.cwd(), 'skills', 'tm-new', 'SKILL.md'), 'utf8');
  const tmKillSource = await readFile(join(process.cwd(), 'skills', 'tm-kill', 'SKILL.md'), 'utf8');
  const sources = [promptSource, skillSource, bridgeSkillSource, tmNewSource, tmKillSource, operationsSource].join('\n');

  assert.match(skillSource, /triggers:/);
  assert.match(sources, /알림 reply|알림에 답장|Notification reply/);
  assert.match(sources, /전달해/);
  assert.match(sources, /세션에 전달/);
  assert.match(sources, /보내/);
  assert.match(sources, /넘겨/);
  assert.match(sources, /세션에 넣어/);
  assert.match(sources, /답장하기/);
  assert.match(sources, /위 내용 전달/);
  assert.match(sources, /이거 반영/);
  assert.match(sources, /답장으로 보낸 거/);
  assert.match(sources, /방금 알림에 대한 말/);
  assert.match(sources, /이건 뭐냐/);
  assert.match(sources, /궁금한데/);
  assert.match(sources, /반영\/수정|반영.*수정/s);
  assert.match(promptSource, /dispatch는 `tm-send` skill/);
  assert.match(bridgeSkillSource, /explain from bridge read endpoints only when the reply has no dispatch\/stop\/start verbs/);
  assert.match(sources, /이 세션/);
  assert.match(sources, /이거/);
  assert.match(sources, /방금 알림/);
  assert.match(sources, /bridge_session_id/);
  assert.match(sources, /channel_mapping_status.*session-thread|session-thread.*channel_mapping_status/s);
  assert.match(sources, /discord_thread_id.*Discord session thread|Discord session thread.*discord_thread_id/s);
  assert.match(sources, /thread_id.*Codex.*discord_thread_id|discord_thread_id.*Discord.*thread_id.*Codex/s);
  assert.match(sources, /project 최신 세션/);
  assert.match(sources, /tm-send --session/);
  assert.match(promptSource, /tm-send --session <bridge_session_id> --discord-approval/);
  assert.match(promptSource, /clarify.*AskUserQuestion/s);
  assert.match(promptSource, /성공 전에는.*버튼에서 전송 누르면 된다/s);
  assert.match(skillSource, /Discord-originated Hermes reply dispatch -> tm-send --discord-approval/);
  assert.match(skillSource, /Hermes Gateway does not automatically render arbitrary terminal-tool JSON `component_actions` as Discord buttons/);
  assert.match(skillSource, /tm-send --session <id> --answer-approval send --question-id <questionId>/);
  assert.match(sources, /전송\/거절\/추가수정|`전송`, `거절`, `추가수정`/);
  assert.match(sources, /원문 알려줘/);
  assert.match(sources, /마지막 답변 원문/);
  assert.match(sources, /raw/);
  assert.match(sources, /full text/);
  assert.match(sources, /\/sessions\/:id\/idle\/latest.*fullText|fullText.*\/sessions\/:id\/idle\/latest/s);
  assert.match(sources, /세션 열려있어/);
  assert.match(sources, /세션 살아있어/);
  assert.match(sources, /현재 세션 확인/);
  assert.match(sources, /GET \/sessions|\/sessions`|\/sessions\/:id\/state/);
  assert.match(sources, /\/sessions\/:id\/state/);
  assert.match(sources, /최근 로그|이벤트/);
  assert.match(sources, /\/sessions\/:id\/events/);
  assert.match(sources, /내가 보낸 이력|명령 이력/);
  assert.match(sources, /\/sessions\/:id\/interactions/);
  assert.match(sources, /새 세션/);
  assert.match(sources, /세션 열어/);
  assert.match(sources, /시작해/);
  assert.match(sources, /tm-new/);
  assert.match(sources, /SessionStart.*트리거가 아니다|SessionStart.*not a new-session trigger|Bridge webhook `SessionStart` payload text is an alert body/s);
  assert.match(sources, /\/new.*Codex.*slash command|Codex.*slash command.*\/new/s);
  assert.match(sources, /\/resume.*Codex.*slash command|Codex.*slash command.*\/resume/s);
  assert.match(sources, /\/new.*tm-send.*그대로|preserve.*\/new.*tm-send/s);
  assert.match(sources, /\/resume.*tm-send.*그대로|preserve.*\/resume.*tm-send/s);
  assert.doesNotMatch(promptSource, /“새 세션”, “세션 열어”, “시작해”, “\/new”는 `tm-new`/);
  assert.doesNotMatch(skillSource, /\/new -> tm-new/);
  assert.doesNotMatch(skillSource, /\/resume -> tm-new/);
  assert.doesNotMatch(skillSource, /or “\/new” -> use `tm-new`/);
  assert.doesNotMatch(operationsSource, /“새 세션”, “세션 열어”, “시작해”, “\/new”는 `tm-new`/);
  assert.match(sources, /세션 종료해/);
  assert.match(sources, /세션 kill/);
  assert.match(sources, /킬/);
  assert.match(sources, /세션 죽여/);
  assert.match(sources, /tm-kill/);
  assert.match(sources, /AskPermission/);
  assert.match(sources, /YOLO|AskPermission/);
});

test('operations docs identify runtime Hermes rule injection surfaces', async () => {
  const operationsSource = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');

  for (const needle of [
    'scripts/install-hermes-stack.sh',
    '~/.hermes/webhook_subscriptions.json',
    'skills/hermes-tmux-bridge/SKILL.md',
    'src/hermes-webhook-sink.js',
    'src/server.js',
    '`tm-new` default는 OMX',
  ]) {
    assert.match(operationsSource, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Hermes docs track current repository helper CLI contract', async () => {
  const sources = [
    await readFile(join(process.cwd(), 'README.md'), 'utf8'),
    await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8'),
    await readFile(join(process.cwd(), 'docs', 'hermes-gateway-integration.md'), 'utf8'),
    await readFile(join(process.cwd(), 'skills', 'hermes-tmux-bridge', 'SKILL.md'), 'utf8'),
    await readFile(join(process.cwd(), 'skills', 'tm-new', 'SKILL.md'), 'utf8'),
    await readFile(join(process.cwd(), 'skills', 'tm-send', 'SKILL.md'), 'utf8'),
    await readFile(join(process.cwd(), 'skills', 'tm-kill', 'SKILL.md'), 'utf8'),
  ].join('\n');

  assert.match(sources, /repository(?:'s)? `bin\/`|repository의 `bin\/`/);
  assert.match(sources, /scripts\/install-omx-cli\.sh --force/);
  assert.match(sources, /scripts\/install-hermes-stack\.sh --non-interactive/);
  assert.match(sources, /tm-new \[a\] \[PROJECT_DIR\].*--json.*--runs PATH.*OMX_ARGS/s);
  assert.match(sources, /tm-new \[a\] --gjc \[PROJECT_DIR\].*--worktree PATH.*GJC_ARGS/s);
  assert.match(sources, /default backend is OMX|기본 backend는 OMX|default new sessions are OMX/s);
  assert.match(sources, /GJC.*tm-new --gjc|tm-new --gjc.*GJC/s);
  assert.match(sources, /Do not create a separate `gjc-new` helper|별도 `gjc-new` helper/s);
  assert.match(sources, /--tmux.*--direct.*--disable codex_hooks/s);
  assert.match(sources, /tm-send --session SESSION_ID.*--dry\|--dry-run.*--hold\|--no-submit/s);
  assert.match(sources, /tm-send --session <bridgeSessionId> --discord-approval/);
  assert.match(sources, /BRIDGE_TMUX_SEND_APPROVALS_PATH/);
  assert.match(sources, /bridge-tmux-send-approvals\.jsonl/);
  assert.doesNotMatch(sources, /discord-hermes-tm-send/);
});

test('Hermes command dispatch rules rely on User Command events and meaning-preserving executable prompt refinement', async () => {
  const promptSource = await readFile(join(process.cwd(), 'scripts', 'install-hermes-stack.sh'), 'utf8');
  const skillSource = await readFile(join(process.cwd(), 'skills', 'tm-send', 'SKILL.md'), 'utf8');
  const bridgeSkillSource = await readFile(join(process.cwd(), 'skills', 'hermes-tmux-bridge', 'SKILL.md'), 'utf8');
  const operationsSource = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');
  const quickstartSource = await readFile(join(process.cwd(), 'docs', 'quickstart.md'), 'utf8');
  const integrationSource = await readFile(join(process.cwd(), 'docs', 'hermes-gateway-integration.md'), 'utf8');

  assert.match(bridgeSkillSource, /CommandSubmitted/);
  assert.match(bridgeSkillSource, /User Command/);
  assert.match(promptSource, /skills\/tm-send\/SKILL\.md/);

  assert.match(operationsSource, /skills\/tm-send\/SKILL\.md/);
  assert.match(operationsSource, /skills\/tm-send\/SKILL\.md.*의미 보존/s);

  for (const source of [skillSource]) {
    assert.match(source, /Prompt refinement before `tm-send`/);
    assert.match(source, /대상 세션 식별\/routing metadata|대상 세션\/routing metadata|target session\/routing metadata/);
    assert.match(source, /실제 전달할 사용자 지시|실제 전달 지시|actual user instruction/);
    assert.match(source, /의미 보존형 작업 지시문|meaning-preserving executable instruction/);
    assert.match(source, /확장\/왜곡 차단|확장.*왜곡 차단|expansion or distortion/);
    assert.match(source, /역할.*섞지|Do not mix|역할을 섞지/s);
    assert.match(source, /payload extraction/);
    assert.match(source, /prompt refinement/);
    assert.match(source, /추가 전달/);
    assert.match(source, /치즈전달/);
    assert.match(source, /사용자요청/);
    assert.match(source, /User says/);
    assert.match(source, /치즈 질문/);
    assert.match(source, /사용자 요청/);
    assert.match(source, /routing metadata|Routing metadata|대상 선택|라우팅 라벨|라우팅 신호/);
    assert.match(source, /bridge_session_id/);
    assert.match(source, /tmux id/);
    assert.match(source, /bridge session id/);
    assert.match(source, /세션명은 X/);
    assert.match(source, /X 세션에 넣어/);
    assert.match(source, /프롬프트 본문에 넣지|not prompt content|Remove routing metadata from the prompt sent to Codex|작업 문장에서는 제거/);
    assert.match(source, /payload instruction|Payload instruction|문제 제기/);
    assert.match(source, /치즈가 물었어|치즈 지시|치즈가 전달하래|the user asked|Final Answer에 대해 이렇게 물었어/);
    assert.match(source, /문장.*경계|문장.*교정|spelling|awkward sentence/);
    assert.match(source, /미사여구|flourish|praise|filler/);
    assert.match(source, /직접.*작업|direct prompt|질문\/지시 자체|사용자의 목소리|direct work/);
    assert.match(source, /따옴표|인용블록|quote block|wrapper/);
    assert.match(source, /원문 복붙|원문 전체를 그대로|raw copy\/paste|raw copy/);
    assert.match(source, /직접 수행|direct work|executable instruction|작업 문장/);
    assert.match(source, /구어체.*메모형|colloquial.*note-style/s);
    assert.match(source, /단순 문장교정.*간결한 실행 지시|간결한 실행 지시.*단순 문장교정|concise executable normalization|mere proofreading/s);
    assert.match(source, /표면 문장|surface(?:-preserving)? (?:cleanup|wording)|surface wording/s);
    assert.match(source, /실행 단위|executable work units/s);
    assert.match(source, /이거.*위 내용.*방금 결과|local deictic phrases/s);
    assert.match(source, /정제 템플릿|prompt-refinement template/s);
    assert.match(source, /원문.*유지|Preserve the original/s);
    assert.match(source, /짧.*한두 문장|[Ss]imple.*one or two (?:cleaner )?(?:direct )?sentences|one-line (?:reply|question).*one or two (?:direct )?sentences/s);
    assert.match(source, /여러 요구.*짧은 불릿|short bullets only when the user already supplied multiple requirements/s);
    assert.match(source, /명시.*강하게 암시|explicitly.*strongly implies|명시·강하게 암시/s);
    assert.match(source, /원문을 대체하는 새 작업|원문을 대체하는 새 결론|invent conclusions\/solutions that replace|원문.*대체.*새 (?:작업|결론)|new priority|새 우선순위/s);
    assert.match(source, /추가 확인 요청이야.*사용자는|사용자는.*추가 확인 요청이야|prefaces such as `추가 확인 요청이야`/s);
    assert.match(source, /의미를 유지한 상태|original meaning first|preserve the original meaning first/s);
    assert.match(source, /간단한 요청.*요구|simple requests or requirements/s);
    assert.match(source, /사용자가 말하지 않은 항목|없는 요구|items.*user did not state/s);
    assert.match(source, /지시하지 않은 파일.*기능.*영역|files, features, or areas the user did not ask for/s);
    assert.match(source, /너무 길게|too long/s);
    assert.match(source, /적당히 요약.*구체 출력 예시|concrete output examples.*fixed section templates|sample Markdown.*expanded acceptance criteria/s);
    assert.match(source, /운영 prefix|operator prefixes|operator framing|routing labels/s);
    assert.match(source, /\/new.*\/resume|\/resume.*\/new|Codex slash commands such as `\/new` and `\/resume`/s);
    assert.match(source, /수정.*검증.*명시.*강하게 암시|modify\/validate steps only when|수정·검증 지시/s);
    assert.match(source, /대상 범위|target scope|의도.*범위/s);
    assert.match(source, /원격\/로컬|remote\/local distinction/);
    assert.match(source, /전체\/일부|all\/some distinction/);
    assert.match(source, /범위 축소|narrow scope|substitute a different task|범위.*축소|범위를 축소\/확대/s);
    assert.match(source, /말투.*명령 강도|tone.*command force/s);
    assert.match(source, /반말.*직설|tone.*command force|말투.*명령 강도/s);
    assert.match(source, /공손체.*문서체|more polite or formal|polite\/formal/s);
    assert.match(source, /원문 그대로.*그대로 전달.*raw|raw.*byte-for-byte|near byte-for-byte/s);
    assert.match(source, /원문을 별도 확인 메시지로 재출력하지|원문 재출력 없이|do not reprint the original prompt|별도 원문 재출력 규칙을 만들지 않는다|original prompt is delivered separately/);
    assert.doesNotMatch(source, /userFacingMarkdown|markdownCodeBlock|preferredMarkdown|markdownQuote/);
  }

  for (const docSource of [quickstartSource, integrationSource]) {
    assert.match(docSource, /subscription_prompt.*scripts\/install-hermes-stack\.sh|scripts\/install-hermes-stack\.sh.*subscription_prompt/);
    assert.match(docSource, /current `subscription_prompt`|현재 `subscription_prompt`/);
    assert.match(docSource, /CommandSubmitted/);
    assert.match(docSource, /User Command/);
    assert.match(docSource, /FinalAnswer/);
    assert.match(docSource, /FinalAnswer.*\(i\/N\)|\(i\/N\).*FinalAnswer/s);
    assert.match(docSource, /hermes-tmux-bridge,tm-new,tm-send,tm-kill/);
    assert.match(docSource, /skills\/tm-send\/SKILL\.md/);
  }
});

test('tm-send dispatch skill cannot bypass prompt refinement when loaded directly', async () => {
  const skillSource = await readFile(join(process.cwd(), 'skills', 'tm-send', 'SKILL.md'), 'utf8');
  const installerSource = await readFile(join(process.cwd(), 'scripts', 'install-hermes-skill.sh'), 'utf8');

  assert.match(skillSource, /direct `skill_view\("tm-send"\).*does not bypass prompt refinement/s);
  assert.match(skillSource, /The exact argument passed to `tm-send` MUST already be the refined prompt/);
  assert.match(skillSource, /Before any `write_file`, temp-file handoff, shell command, or `tm-send` invocation/);
  assert.match(skillSource, /temp file content must be the refined (?:prompt|or raw-bounded payload), never the (?:raw|full raw) Discord reply/);
  assert.match(skillSource, /\[Replying to: \.\.\.\]/);
  assert.match(skillSource, /\[치즈\] 이 메시지를 \.\.\.에 전달해|\[치즈\] 이 메시지를 \.\.\. 에 전달해/);
  assert.match(skillSource, /추가 전달:.*치즈전달:.*사용자요청:.*User says:/s);
  assert.match(skillSource, /meaning-preserving executable instruction/);
  assert.match(skillSource, /not mere proofreading and not raw copy\/paste/);
  assert.match(skillSource, /Use `tm-send --raw` only when the user explicitly requests/);
  assert.match(skillSource, /Discord approval gate/);
  assert.match(skillSource, /Discord reply → Hermes → existing OMX\/GJC bridge session dispatch MUST prefer `tm-send --discord-approval`/);
  assert.match(skillSource, /not a second refinement policy/);
  assert.match(skillSource, /delivery\.status == "approval-pending".*clarify/s);
  assert.match(skillSource, /do not claim buttons exist/);
  assert.match(skillSource, /추가수정.*재정제.*new approval-gated `tm-send`/s);
  assert.match(installerSource, /Helper skills/);
  assert.match(installerSource, /tm-new\|skills\/tm-new/);
  const stackInstallerSource = await readFile(join(process.cwd(), 'scripts', 'install-hermes-stack.sh'), 'utf8');
  assert.match(stackInstallerSource, /--skills hermes-tmux-bridge,tm-new,tm-send,tm-kill/);
  assert.match(stackInstallerSource, /skills: \['hermes-tmux-bridge', 'tm-new', 'tm-send', 'tm-kill'\]/);
});

test('Hermes prompt separates routing metadata from delivered payload instructions', async () => {
  const skillSource = await readFile(join(process.cwd(), 'skills', 'tm-send', 'SKILL.md'), 'utf8');
  const operationsSource = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');

  assert.match(operationsSource, /skills\/tm-send\/SKILL\.md/);
  assert.match(operationsSource, /skills\/tm-send\/SKILL\.md.*의미 보존/s);

  for (const source of [skillSource]) {
    assert.match(source, /1[.)]\s*대상 세션(?: 식별)?\/routing metadata.*2[.)]\s*실제 전달(?:할 사용자)? 지시.*3[.)]\s*의미 보존형 작업 지시문.*4[.)]\s*확장.*왜곡 차단/s);
    assert.match(source, /bridge_session_id.*tmux id.*세션명/s);
    assert.match(source, /이 세션에 전달해.*세션명은 X.*X 세션에 넣어/s);
    assert.match(source, /프롬프트 본문에 넣지|not prompt content|Remove routing metadata from the prompt sent to Codex|작업 문장에서는 제거/);
    assert.match(source, /Routing metadata|routing metadata|대상 선택/);
    assert.match(source, /bridge_session_id.*tmux id.*(?:세션명|explicit session name)/s);
    assert.match(source, /이 세션에 전달해.*세션명은 X.*X 세션에 넣어/s);
    assert.match(source, /프롬프트 본문에 넣지|Remove routing metadata from the prompt sent to Codex/);
    assert.match(source, /Payload instruction|직접 수행할 작업 문장|direct work/);
    assert.match(source, /운영 prefix|operator prefixes|operator framing|메타\/욕설\/감탄/);
    assert.match(source, /실제 질문.*지시.*제약|실제 의미.*제약|의미.*제약|actual question or instruction.*constraints/s);
  }
});

test('eventToHermesPayload exposes approval actions for AskPermission', () => {
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'docs' },
    {
      eventId: 'approval-1',
      type: 'AskPermission',
      source: 'codex-log',
      timestamp: '2026-05-04T00:00:00.000Z',
      text: 'Dangerous command requires approval',
    },
    { channelId: 'channel-1' },
  );

  assert.equal(payload.approval_required, true);
  assert.deepEqual(payload.reply_options, ['/approve', '/deny', '/approve session', '/approve always']);
  assert.equal(payload.approval_actions[0].endpoint, '/sessions/bridge-1/commands');
  assert.equal(payload.approval_actions[0].body.commandText, '/approve');
  assert.equal(payload.approval_actions[0].body.mode, 'tmux');
  assert.equal(payload.approval_actions[0].body.source, 'discord-component');
  assert.equal(payload.approval_actions[0].discord_component.type, 'button');
  assert.match(payload.approval_actions[0].discord_component.custom_id, /^omx:/);
  assert.equal(payload.discord_components[0].type, 1);
  assert.equal(payload.discord_components[0].components[0].type, 2);
  assert.equal(payload.discord_components[0].components[0].style, 3);
  assert.ok(payload.component_actions.some((action) => action.action_id === 'approve-always' && action.requires_confirmation === true));
  assert.match(payload.message_markdown, /선택: `\/approve`/);
});

test('eventToHermesPayload exposes raw user prompts for Hermes', () => {
  const prompt = [
    '<subagent_notification>',
    '{"agent_path":"019e-example","status":"shutdown"}',
    '</subagent_notification>',
    '파일 상태를 확인하고',
    '```bash',
    'git status',
    '```',
  ].join('\n');
  const expected = '파일 상태를 확인하고\n```bash\ngit status\n```';
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'omx-bridge' },
    {
      eventId: 'prompt-1',
      type: 'CommandSubmitted',
      source: 'codex-log',
      timestamp: '2026-05-06T08:00:00.000Z',
      text: prompt,
    },
    { channelId: 'channel-1' },
  );

  assert.equal(payload.event_type, 'CommandSubmitted');
  assert.equal(payload.event_name, 'User Command');
  assert.equal(payload.user_prompt_text, expected);
  assert.equal(payload.user_command_text, expected);
  assert.equal(payload.text_preview, expected);
  assert.match(payload.message_markdown, /# User Command/);
  assert.match(payload.message_markdown, /파일 상태를 확인하고/);
  assert.match(payload.message_markdown, /``\u200b`bash/);
  assert.doesNotMatch(payload.message_markdown, /subagent_notification|agent_path/);
});

test('eventToHermesPayload truncates long User Command notification fields explicitly', () => {
  const prompt = `${'대용량 프롬프트 '.repeat(400)}끝부분`;
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'omx-bridge' },
    {
      eventId: 'prompt-long',
      type: 'CommandSubmitted',
      source: 'codex-log',
      timestamp: '2026-05-06T08:00:00.000Z',
      text: prompt,
    },
    { channelId: 'channel-1', userCommandNotificationMaxChars: 500 },
  );

  assert.equal(payload.user_command_text_truncated, true);
  assert.equal(payload.user_prompt_text_truncated, true);
  assert.equal(payload.user_command_text_original_length, prompt.length);
  assert.equal(payload.text_truncated, true);
  assert.match(payload.user_command_text, /User Command notification truncated/);
  assert.match(payload.message_markdown, /User Command notification truncated/);
  assert.doesNotMatch(payload.user_command_text, /끝부분/);
});

test('eventToHermesPayload keeps generated event_id bounded for long User Command text', () => {
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'omx-bridge' },
    {
      type: 'CommandSubmitted',
      source: 'codex-log',
      timestamp: '2026-05-06T08:00:00.000Z',
      text: `${'대용량 프롬프트 '.repeat(400)}끝부분`,
    },
    { channelId: 'channel-1', userCommandNotificationMaxChars: 500 },
  );

  assert.equal(payload.event_id.length < 120, true);
  assert.doesNotMatch(payload.event_id, /끝부분|대용량 프롬프트/);
});

test('eventToHermesPayload does not strip subagent notifications from FinalAnswer text', () => {
  const finalAnswer = '<subagent_notification>\n{"agent_path":"019e-example"}\n</subagent_notification>\n최종 답변 본문';
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'omx-bridge' },
    {
      eventId: 'final-1',
      type: 'FinalAnswer',
      source: 'codex-log',
      phase: 'final_answer',
      timestamp: '2026-05-06T08:00:00.000Z',
      text: finalAnswer,
    },
    { channelId: 'channel-1', notificationMode: 'direct' },
  );

  assert.equal(payload.text_preview, finalAnswer);
  assert.match(payload.message_markdown, /subagent_notification/);
});

test('eventToHermesPayload formats SessionEnd duration like OMX notification', () => {
  const payload = eventToHermesPayload(
    { bridgeSessionId: 'bridge-1', tmuxId: 'tmux-1', project: 'omx-bridge' },
    {
      eventId: 'end-1',
      type: 'SessionEnd',
      source: 'notification',
      timestamp: '2026-05-04T17:54:57.513Z',
      durationMs: 93784000,
      reason: 'session_exit',
    },
    { channelId: 'channel-1' },
  );

  assert.equal(payload.duration_ms, 93784000);
  assert.equal(payload.duration, '1d 2h 3m 4s');
  assert.match(payload.message_markdown, /\*\*duration:\*\* 1d 2h 3m 4s/);
  assert.doesNotMatch(payload.message_markdown, /duration_ms/);
});

test('sessionContextLine falls back to stable session identifiers', () => {
  assert.equal(
    sessionContextLine({ tmuxPaneId: '%42', bridgeSessionId: 'bridge-1', project: 'hermes-tmux-bridge' }),
    '**session:** `bridge-1`\n**tmux:** `%42` | **project:** `hermes-tmux-bridge`',
  );
  assert.equal(
    sessionContextLine({ bridgeSessionId: 'bridge-1' }),
    '**session:** `bridge-1`\n**tmux:** `bridge-1` | **project:** `unknown`',
  );
});

test('buildHermesWebhookRequest signs payload with GitHub-compatible HMAC header', () => {
  const payload = { event_type: 'SessionIdle', event_id: 'evt-1', text_preview: 'hello' };
  const request = buildHermesWebhookRequest(payload, { secret: 'test-secret' });
  const expected = `sha256=${createHmac('sha256', 'test-secret').update(request.body).digest('hex')}`;
  assert.equal(request.headers['X-GitHub-Event'], 'SessionIdle');
  assert.equal(request.headers['X-Request-ID'], 'evt-1');
  assert.equal(request.headers['X-Hub-Signature-256'], expected);
});

test('channelForProject prefers project map and falls back to default', () => {
  const map = { default: 'default-channel', projects: { 'omx-bridge': 'project-channel' } };
  assert.equal(channelForProject('omx-bridge', map), 'project-channel');
  assert.equal(channelForProject('missing', map), 'default-channel');
  assert.equal(channelForProject('missing', map, { channelId: 'explicit' }), 'explicit');
});

test('resolveProjectChannel marks fallback mappings for Hermes auto-create workflow', () => {
  const map = { default: 'default-channel', projects: { 'omx-bridge': 'project-channel' } };
  assert.equal(channelNameForProject('Feature/Foo Branch'), 'feature-foo-branch');

  const explicit = resolveProjectChannel('omx-bridge', map);
  assert.equal(explicit.channelId, 'project-channel');
  assert.equal(explicit.mappingStatus, 'project');
  assert.equal(explicit.channelMissing, false);

  const fallback = resolveProjectChannel('new-project', map);
  assert.equal(fallback.channelId, 'default-channel');
  assert.equal(fallback.defaultChannelId, 'default-channel');
  assert.equal(fallback.desiredChannelName, 'new-project');
  assert.equal(fallback.mappingStatus, 'fallback');
  assert.equal(fallback.channelMissing, true);
  assert.equal(fallback.autoCreateChannel, true);
});

test('Discord guild id can be derived from a configured channel for auto mapping', async () => {
  const calls = [];
  const guild = await resolveDiscordGuildId({
    discordBotToken: 'test-token',
    defaultChannelId: 'fallback-channel',
    discordFetchFn: async (url, request = {}) => {
      calls.push({ url, method: request.method || 'GET' });
      return { ok: true, json: async () => ({ id: 'fallback-channel', guild_id: 'guild-1' }) };
    },
  });

  assert.equal(guild.ok, true);
  assert.equal(guild.guildId, 'guild-1');
  assert.equal(guild.source, 'channel');

  const listed = await listDiscordGuildChannels({
    discordBotToken: 'test-token',
    defaultChannelId: 'fallback-channel',
    discordFetchFn: async (url, request = {}) => {
      calls.push({ url, method: request.method || 'GET' });
      if (url.endsWith('/channels/fallback-channel')) {
        return { ok: true, json: async () => ({ id: 'fallback-channel', guild_id: 'guild-1' }) };
      }
      return { ok: true, json: async () => [{ id: 'project-channel', name: 'docs', type: 0 }] };
    },
  });

  assert.equal(listed.ok, true);
  assert.deepEqual(listed.channels.map((channel) => channel.id), ['project-channel']);
  assert.match(calls[0].url, /\/channels\/fallback-channel$/);
  assert.match(calls.at(-1).url, /\/guilds\/guild-1\/channels$/);
});

test('shouldForwardToHermes filters noisy events and non-final assistant responses', () => {
  assert.equal(shouldForwardToHermes({ type: 'CommandSubmitted' }, { eventTypes: new Set(['FinalAnswer']) }), false);
  assert.equal(shouldForwardToHermes({ type: 'CommandSubmitted' }, { eventTypes: new Set(['CommandSubmitted']) }), true);
  assert.equal(shouldForwardToHermes({ type: 'FinalAnswer', phase: 'commentary' }, { eventTypes: new Set(['FinalAnswer']) }), false);
  assert.equal(shouldForwardToHermes({ type: 'FinalAnswer', phase: 'final_answer' }, { eventTypes: new Set(['FinalAnswer']) }), true);
  assert.equal(shouldForwardToHermes({ type: 'Commentary', source: 'notification' }, { eventTypes: new Set(['Commentary']) }), false);
  assert.equal(shouldForwardToHermes({ type: 'SessionStart', source: 'omx-log' }, { eventTypes: new Set(['SessionStart']) }), false);
  assert.equal(shouldForwardToHermes({ type: 'SessionEnd', source: 'omx-log' }, { eventTypes: new Set(['SessionEnd']) }), false);
  assert.equal(shouldForwardToHermes({ type: 'SessionEnd', source: 'notification' }, { eventTypes: new Set(['SessionEnd']) }), true);
  assert.equal(shouldForwardToHermes({ type: 'SessionIdle', source: 'codex-log', phase: 'idle' }, { eventTypes: new Set(['SessionIdle']), notificationMode: 'summary' }), false);
  assert.equal(shouldForwardToHermes({ type: 'SessionIdle', source: 'codex-log', phase: 'idle' }, { eventTypes: new Set(['SessionIdle']), notificationMode: 'direct' }), false);
  assert.equal(shouldForwardToHermes(
    { type: 'AskPermission', source: 'codex-log' },
    { eventTypes: new Set(['AskPermission']) },
    { approvalPolicy: 'never', sandboxPolicyType: 'danger-full-access', permissionProfileType: 'disabled' },
  ), false);
  assert.equal(shouldForwardToHermes(
    { type: 'AskPermission', source: 'codex-log' },
    { eventTypes: new Set(['AskPermission']) },
    { approvalPolicy: 'on-request', sandboxPolicyType: 'workspace-write', permissionProfileType: 'managed' },
  ), true);
});

test('pollHermesWebhookNotifications is a no-op without Hermes webhook URL', async () => {
  const result = await pollHermesWebhookNotifications({ projectRoot: process.cwd(), webhookUrl: '' });
  assert.deepEqual(result, { ok: false, reason: 'missing-webhook-url', sent: 0 });
});


test('pollHermesWebhookNotifications advances GJC JSONL byte cursor only for lifecycle-safe polls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-gjc-cursor-'));
  const sessionsRoot = join(root, 'gjc-sessions');
  const logPath = join(sessionsRoot, 'session.jsonl');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const sessionId = 'gjc-cursor-session';
  await mkdir(sessionsRoot, { recursive: true });

  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-06-04T10:00:00.000Z', cwd: root, title: 'GJC Cursor' },
    { type: 'message', id: 'gjc-user-1', timestamp: '2026-06-04T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '첫 요청' }] } },
    { type: 'message', id: 'gjc-final-1', timestamp: '2026-06-04T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '첫 답변' }] }, stopReason: 'stop' },
  ];
  const serializeGjcLog = () => lines.map((line) => JSON.stringify(line)).join('\n');
  const writeGjcLog = async () => writeFile(logPath, serializeGjcLog());
  await writeGjcLog();

  const posts = [];
  const fullLifecycleTypes = new Set(['SessionStart', 'CommandSubmitted', 'FinalAnswer', 'SessionIdle', 'SessionEnd']);
  const pollOptions = {
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    listTmuxPanesFn: () => [{
      paneDead: false,
      gjcProfile: '1',
      paneCurrentPath: root,
      tmuxId: 'gjc-live',
      tmuxPaneId: '%1',
    }],
    listTmuxSessionsFn: () => [],
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: fullLifecycleTypes,
    bootSince: '2026-06-04T09:59:00.000Z',
    requireChannel: false,
    priorTerminalLifecycleDeliveryBlocks: false,
    maxEventsPerPoll: 10,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  };

  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot }, async () => {
    const first = await pollHermesWebhookNotifications(pollOptions);
    assert.equal(first.sent, 3);
    assert.deepEqual(new Set(posts.map((post) => post.event_type)), new Set(['SessionStart', 'CommandSubmitted', 'FinalAnswer']));

    const index = await openEventIndex(root, { eventIndexPath });
    let firstCursor;
    try {
      firstCursor = getGjcLogCursor(index.db, logPath);
      assert.equal(firstCursor.gjc_session_id, sessionId);
      assert.equal(firstCursor.byte_offset, Buffer.byteLength(serializeGjcLog()));
    } finally {
      closeEventIndex(index);
    }

    lines.push(
      { type: 'message', id: 'gjc-user-2', timestamp: '2026-06-04T10:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '둘째 요청' }] } },
      { type: 'message', id: 'gjc-final-2', timestamp: '2026-06-04T10:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '둘째 답변' }] }, stopReason: 'stop' },
    );
    await writeGjcLog();
    const second = await pollHermesWebhookNotifications(pollOptions);
    assert.equal(second.sent, 2);
    const secondPreviews = posts.slice(3).map((post) => post.text_preview);
    assert.equal(secondPreviews.includes('둘째 요청'), true);
    assert.equal(secondPreviews.includes('둘째 답변'), true);

    const afterSecond = await openEventIndex(root, { eventIndexPath });
    let safeCursor;
    try {
      safeCursor = getGjcLogCursor(afterSecond.db, logPath);
      assert.equal(safeCursor.byte_offset, Buffer.byteLength(serializeGjcLog()));
      assert.equal(safeCursor.byte_offset > firstCursor.byte_offset, true);
    } finally {
      closeEventIndex(afterSecond);
    }

    const inactiveEnd = await pollHermesWebhookNotifications({
      ...pollOptions,
      listTmuxPanesFn: () => [],
      bootSince: '2026-06-04T09:59:00.000Z',
    });
    assert.equal(inactiveEnd.sent, 1);
    assert.equal(posts.at(-1).event_type, 'SessionEnd');

    lines.push({ type: 'message', id: 'gjc-user-3', timestamp: '2026-06-04T10:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: '셋째 요청' }] } });
    await writeGjcLog();
    const commandOnly = await pollHermesWebhookNotifications({
      ...pollOptions,
      eventTypes: new Set(['CommandSubmitted']),
      bootSince: '2026-06-04T10:00:05.000Z',
    });
    assert.equal(commandOnly.sent, 1);

    const afterCommandOnly = await openEventIndex(root, { eventIndexPath });
    try {
      assert.equal(getGjcLogCursor(afterCommandOnly.db, logPath).byte_offset, safeCursor.byte_offset);
    } finally {
      closeEventIndex(afterCommandOnly);
    }
  });
});

test('pollHermesWebhookNotifications ignores unmapped Codex fallback logs by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-unmapped-'));
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
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    codexHome,
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'SessionIdle']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});

test('pollHermesWebhookNotifications leaves fast user prompt events out of default Hermes delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-prompt-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  const statePath = join(root, 'state.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-prompt-session',
    native_session_id: 'codex-prompt-session',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-06T08-00-00-codex-prompt-session.jsonl'), [
    { timestamp: '2026-05-06T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-prompt-session', timestamp: '2026-05-06T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-06T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '입력한 프롬프트 원문' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});


test('pollHermesWebhookNotifications keeps FinalAnswer delivery queued before a later user command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-stale-final-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-stale-final',
    native_session_id: 'codex-stale-final',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-06T08-00-00-codex-stale-final.jsonl'), [
    { timestamp: '2026-05-06T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-stale-final', timestamp: '2026-05-06T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-06T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 요청' }] } },
    { timestamp: '2026-05-06T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '첫 답변' }] } },
    { timestamp: '2026-05-06T08:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '다음 요청' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'CommandSubmitted']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 3);
  assert.deepEqual(posts.map((post) => post.event_type), ['CommandSubmitted', 'FinalAnswer', 'CommandSubmitted']);
  assert.deepEqual(posts.map((post) => post.text_preview), ['첫 요청', '첫 답변', '다음 요청']);
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    const rows = index.db.prepare(`
      SELECT event_id, status, last_error
      FROM deliveries
      WHERE sink = 'hermes' AND event_id LIKE 'codex-stale-final:message-%'
      ORDER BY event_id
    `).all();
    assert.deepEqual(rows.map((row) => row.status), ['sent', 'sent', 'sent']);
    assert.deepEqual(rows.map((row) => row.last_error), [null, null, null]);
    assert.equal(rows.some((row) => /message-3$/.test(row.event_id)), true);
    const finalRow = rows.find((row) => /message-3$/.test(row.event_id));
    assert.equal(finalRow.status, 'sent');
  } finally {
    closeEventIndex(index);
  }
});

test('pollHermesWebhookNotifications delivers near-simultaneous FinalAnswer before following user command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-near-simultaneous-final-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-near-final',
    native_session_id: 'codex-near-final',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-06T08-00-00-codex-near-final.jsonl'), [
    { timestamp: '2026-05-06T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-near-final', timestamp: '2026-05-06T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-06T08:00:14.324Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '커밋 전 최종 답변' }] } },
    { timestamp: '2026-05-06T08:00:14.525Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '커밋하고 푸시해' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer', 'CommandSubmitted']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 2);
  assert.deepEqual(posts.map((post) => post.event_type), ['FinalAnswer', 'CommandSubmitted']);
  assert.deepEqual(posts.map((post) => post.text_preview), ['커밋 전 최종 답변', '커밋하고 푸시해']);
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    const rows = index.db.prepare(`
      SELECT event_id, status, last_error
      FROM deliveries
      WHERE sink = 'hermes' AND event_id LIKE 'codex-near-final:message-%'
      ORDER BY event_id
    `).all();
    assert.deepEqual(rows.map((row) => row.status), ['sent', 'sent']);
    assert.deepEqual(rows.map((row) => row.last_error), [null, null]);
    assert.equal(rows.some((row) => /message-2$/.test(row.event_id)), true);
    assert.equal(rows.some((row) => /message-3$/.test(row.event_id)), true);
  } finally {
    closeEventIndex(index);
  }
});

test('pollHermesWebhookNotifications does not let command-only flush consume an unsent FinalAnswer cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-command-cursor-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '06');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const logPath = join(sessionsDir, 'rollout-2026-05-06T08-00-00-codex-command-cursor.jsonl');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-command-cursor',
    native_session_id: 'codex-command-cursor',
    started_at: '2026-05-06T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');

  const writeCodexLog = async (lines) => writeFile(logPath, lines.map((line) => JSON.stringify(line)).join('\n'));
  const baseLines = [
    { timestamp: '2026-05-06T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-command-cursor', timestamp: '2026-05-06T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-06T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 요청' }] } },
  ];
  await writeCodexLog(baseLines);

  const posts = [];
  const fetchFn = async (_url, request) => {
    posts.push(JSON.parse(request.body));
    return { ok: true };
  };

  const first = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    requireChannel: false,
    replay: true,
    fetchFn,
  });
  assert.equal(first.sent, 1);

  await writeCodexLog([
    ...baseLines,
    { timestamp: '2026-05-06T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '첫 답변' }] } },
    { timestamp: '2026-05-06T08:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '다음 요청' }] } },
  ]);

  const commandFlush = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['CommandSubmitted']),
    bootSince: '2026-05-06T08:00:03.000Z',
    requireChannel: false,
    fetchFn,
  });
  assert.equal(commandFlush.sent, 1);

  const finalFlush = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    bootSince: '2026-05-06T08:00:00.000Z',
    requireChannel: false,
    fetchFn,
  });

  assert.equal(finalFlush.sent, 1);
  assert.deepEqual(posts.map((post) => post.event_type), ['CommandSubmitted', 'CommandSubmitted', 'FinalAnswer']);
  assert.deepEqual(posts.map((post) => post.text_preview), ['첫 요청', '다음 요청', '첫 답변']);
});

test('pollHermesWebhookNotifications attaches Codex log to OMX lifecycle when native id is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-cwd-attach-'));
  const projectRoot = join(root, 'docs');
  const runRoot = join(root, 'run-20260508-docs');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '08');
  const statePath = join(root, 'state.json');
  await mkdir(join(runRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(runRoot, '.omxbox-run.json'), JSON.stringify({
    launcher: 'omx --madmax',
    created_at: '2026-05-08T08:44:46.000Z',
    cwd: runRoot,
    source_cwd: projectRoot,
  }, null, 2));
  await writeFile(join(runRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-docs-without-native',
    started_at: '2026-05-07T23:44:46.372Z',
    ended_at: '2026-05-07T23:54:30.498Z',
    cwd: projectRoot,
    pid: 2241855,
  }) + '\n');
  await writeFile(join(runRoot, '.omx', 'logs', 'omx-2026-05-08.jsonl'), [
    { event: 'session_start', session_id: 'omx-docs-without-native', pid: 2241855, timestamp: '2026-05-07T23:44:46.372Z' },
    { event: 'session_end', session_id: 'omx-docs-without-native', timestamp: '2026-05-07T23:54:30.498Z' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-08T08-44-48-codex-docs-real.jsonl'), [
    { timestamp: '2026-05-07T23:44:48.987Z', type: 'session_meta', payload: { id: 'codex-docs-real', timestamp: '2026-05-07T23:44:48.987Z', cwd: projectRoot } },
    { timestamp: '2026-05-07T23:45:06.839Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '경고해결' }] } },
    { timestamp: '2026-05-07T23:49:11.164Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '해결했습니다.' }] } },
    { timestamp: '2026-05-07T23:49:11.205Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '해결했습니다.' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [runRoot],
    discoverTmuxProjectRoots: false,
    discoverMadmaxRuns: false,
    codexHome,
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['CommandSubmitted', 'FinalAnswer']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 2);
  assert.ok(posts.some((post) => post.event_type === 'CommandSubmitted' && post.user_command_text === '경고해결'));
  assert.ok(posts.some((post) => post.event_type === 'FinalAnswer' && post.codex_session_id === 'codex-docs-real'));
});

test('pollHermesWebhookNotifications scans configured extra OMX project roots for SessionStart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-'));
  const docsRoot = join(root, 'docs');
  const statePath = join(root, 'state.json');
  await mkdir(join(docsRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(join(docsRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-docs-072941',
    native_session_id: 'codex-docs-1',
    started_at: '2026-05-04T07:29:41.000Z',
    cwd: docsRoot,
    pid: 123,
  }) + '\n');

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [docsRoot],
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts[0].event_type, 'SessionStart');
  assert.equal(posts[0].tmux_id, null);
  assert.equal(posts[0].project, 'docs');
  assert.match(posts[0].message_markdown, /# Session Start/);
  assert.doesNotMatch(posts[0].message_markdown, /새 세션을 시작했어/);
  assert.equal(posts[0].text_preview, '');
  assert.equal(posts[0].text_length, 0);
  assert.doesNotMatch(posts[0].event_context_line, /\*\*event:\*\*/);
  assert.match(posts[0].message_markdown, /\*\*session:\*\* `codex-docs-1`\n\*\*tmux:\*\* `omx-docs-072941` \| \*\*project:\*\* `docs`/);
});

test('pollHermesWebhookNotifications does not resend non-active SessionStart after Codex slash command remaps native id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-remapped-start-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const startedAt = new Date(Date.now() - 1000).toISOString();
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-visible',
    native_session_id: 'codex-new-thread',
    started_at: startedAt,
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(statePath, JSON.stringify({ sentEventIds: ['omx-visible:start'], lastRunAt: null }));

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-old-thread',
        codexThreadId: 'codex-old-thread',
        codexSessionId: 'codex-old-thread',
        omxSessionId: 'omx-visible',
        project: 'omx-bridge',
      },
      event: {
        eventId: 'omx-visible:start',
        type: 'SessionStart',
        source: 'notification',
        timestamp: startedAt,
        text: '새 세션을 시작했어.',
      },
    }]);
    markDeliverySent(index.db, 'omx-visible:start', 'hermes');
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);

  const again = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(again.sent, 0);
  assert.equal(posts.length, 0);
});

test('pollHermesWebhookNotifications sends pending lifecycle events in global timestamp order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-order-'));
  const statePath = join(root, 'state.json');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), [
    {
      session_id: 'omx-old',
      native_session_id: 'codex-old',
      started_at: '2026-05-04T18:02:38.660Z',
      ended_at: '2026-05-04T18:29:20.735Z',
      cwd: root,
      pid: 4098021,
    },
    {
      session_id: 'omx-new',
      native_session_id: 'codex-new',
      started_at: '2026-05-04T18:29:23.968Z',
      cwd: root,
      pid: 221240,
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(statePath, JSON.stringify({ sentEventIds: ['omx-old:start'], lastRunAt: null }));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart', 'SessionEnd']),
    requireChannel: false,
    replay: true,
    maxEventsPerPoll: 2,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 2);
  assert.deepEqual(posts.map((post) => post.event_id), ['omx-old:end', 'omx-new:start']);
  assert.deepEqual(posts.map((post) => post.event_type), ['SessionEnd', 'SessionStart']);
});

test('pollHermesWebhookNotifications skips auxiliary nested GJC agent logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-hermes-aux-project-'));
  const sessionsRoot = join(root, 'gjc-sessions');
  const statePath = join(root, 'state.json');
  const parentId = '019e9000-5858-7000-aaaa-ffffffffffff';
  const childId = '019e9000-5959-7000-bbbb-ffffffffffff';
  const parentStem = `2026-06-04T10-00-00-000Z_${parentId}`;
  const projectDir = join(sessionsRoot, 'project');
  await mkdir(join(projectDir, parentStem), { recursive: true });
  await writeFile(join(projectDir, `${parentStem}.jsonl`), [
    { type: 'session', version: 3, id: parentId, timestamp: '2026-06-04T10:00:00.000Z', cwd: root, title: 'GJC parent session' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(projectDir, parentStem, '20-ArchitectG005Final.jsonl'), [
    { type: 'session', version: 3, id: childId, timestamp: '2026-06-04T10:00:01.000Z', cwd: root, title: 'GJC child session' },
    { type: 'message', id: 'gjc-child-user-1', timestamp: '2026-06-04T10:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Complete the assignment below, thoroughly' }] } },
    { type: 'message', id: 'gjc-child-final-1', timestamp: '2026-06-04T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'APPROVE' }] }, stopReason: 'stop' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  const tmuxBin = join(root, 'fake-empty-tmux.sh');
  await writeFile(tmuxBin, '#!/bin/sh\nexit 0\n');
  await chmod(tmuxBin, 0o755);

  const posts = [];
  const result = await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot, TMUX_BIN: tmuxBin }, async () => pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['CommandSubmitted', 'FinalAnswer']),
    requireChannel: false,
    replay: true,
    maxEventsPerPoll: 10,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(posts.length, 0);
});


test('pollHermesWebhookNotifications delivers notification lifecycle events for auxiliary OMX-owned logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-aux-life-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        bridgeSessionId: 'codex-aux-ended',
        codexThreadId: 'codex-aux-ended',
        codexSessionId: 'codex-aux-ended',
        omxSessionId: 'omx-aux-ended',
        runtimeOmxSessionId: 'omx-aux-ended',
        project: 'docs',
        status: 'ended',
        hasOmxLifecycle: true,
        isAuxiliaryCodexLog: true,
        originator: 'codex_exec',
        sessionSource: 'exec',
      },
      event: {
        eventId: 'omx-aux-ended:end',
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

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionEnd']),
    requireChannel: false,
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].event_id, 'omx-aux-ended:end');
  assert.equal(posts[0].event_type, 'SessionEnd');
});

test('pollHermesWebhookNotifications auto maps an existing Discord project channel before fallback delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-autochannel-'));
  const docsRoot = join(root, 'docs');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(docsRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: {} }));
  await writeFile(join(docsRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-docs-082941',
    native_session_id: 'codex-docs-2',
    started_at: '2026-05-04T08:29:41.000Z',
    cwd: docsRoot,
    pid: 123,
  }) + '\n');

  const posts = [];
  const discordLookups = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [docsRoot],
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    replay: true,
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url) => {
      discordLookups.push(url);
      return {
        ok: true,
        json: async () => [
          { id: 'ignore-category', name: 'docs', type: 4 },
          { id: 'project-channel', name: 'docs', type: 0 },
          { id: 'other-channel', name: 'other', type: 0 },
        ],
      };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(discordLookups.length, 1);
  assert.equal(posts[0].project, 'docs');
  assert.equal(posts[0].channel_id, 'project-channel');
  assert.equal(posts[0].default_channel_id, 'fallback-channel');
  assert.equal(posts[0].fallback_channel_id, 'fallback-channel');
  assert.equal(posts[0].channel_mapping_status, 'project');
  assert.equal(posts[0].channel_missing, false);

  const saved = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(saved.projects.docs, 'project-channel');
  assert.equal(saved.channelNames.docs, 'docs');
});

test('pollHermesWebhookNotifications does not create missing threads for late FinalAnswer events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-thread-direct-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: project-channel',
    '  allowed_channels: project-channel',
    '',
  ].join('\n'));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-visible-thread',
    native_session_id: 'codex-thread-direct',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-12T08-00-00-codex-thread-direct.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-thread-direct', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '작업해줘' }] } },
    { timestamp: '2026-05-12T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '마지막 FinalAnswer fullText 원문' }] } },
    { timestamp: '2026-05-12T08:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '짧은 완료 이벤트' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const discordRequests = [];
  const gatewayRestarts = [];
  const healthProbes = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    updateHermesConfig: true,
    hermesGatewayRestarter: async () => {
      gatewayRestarts.push('restart');
      return { ok: true, restarted: true, command: 'test-restart' };
    },
    hermesGatewayHealthFetchFn: async (url) => {
      healthProbes.push(url);
      return { ok: true, status: 200 };
    },
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      const method = request.method || 'GET';
      const body = request.body ? JSON.parse(request.body) : null;
      discordRequests.push({ url, method, body });
      return { ok: true, json: async () => ({ id: 'alert-message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(posts.length, 0);
  assert.equal(gatewayRestarts.length, 0);
  assert.deepEqual(healthProbes, []);

  assert.equal(discordRequests.length, 1);
  assert.ok(discordRequests[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(discordRequests[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.match(discordRequests[0].body.content, /FinalAnswer/);
  assert.doesNotMatch(discordRequests[0].body.content, /마지막 FinalAnswer fullText 원문/);
  const saved = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(saved.sessionThreads, undefined);
  const hermesConfig = await readFile(hermesConfigPath, 'utf8');
  assert.match(hermesConfig, /free_response_channels: project-channel/);
  assert.match(hermesConfig, /allowed_channels: project-channel/);
  assert.doesNotMatch(hermesConfig, /session-thread/);
});

test('pollHermesWebhookNotifications bootstraps newly discovered codex logs without backfilling old FinalAnswers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-cursor-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const logPath = join(sessionsDir, 'rollout-2026-05-12T08-00-00-codex-cursor.jsonl');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-cursor',
    native_session_id: 'codex-cursor',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(logPath, [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-cursor', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 작업' }] } },
    { timestamp: '2026-05-12T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '이미 오래전에 끝난 답변' }] } },
    { timestamp: '2026-05-12T08:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '이미 오래전에 끝난 답변' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const commonOptions = {
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    bootSince: '2026-05-12T07:00:00.000Z',
    notificationMode: 'direct',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  };

  const first = await pollHermesWebhookNotifications(commonOptions);
  assert.equal(first.sent, 0);
  assert.equal(posts.length, 0);

  await writeFile(logPath, `${await readFile(logPath, 'utf8')}\n${[
    { timestamp: '2026-05-12T08:10:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '커서 이후 새 답변' }] } },
    { timestamp: '2026-05-12T08:10:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '커서 이후 새 답변' } },
  ].map((line) => JSON.stringify(line)).join('\n')}`);

  const second = await pollHermesWebhookNotifications(commonOptions);
  assert.equal(second.sent, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].message_markdown, /커서 이후 새 답변/);
  assert.doesNotMatch(posts[0].message_markdown, /이미 오래전에 끝난 답변/);
});

test('pollHermesWebhookNotifications spools long FinalAnswer bodies outside SQLite and hydrates them for delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-body-spool-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const longAnswer = `${'0123456789'.repeat(130)}UNIQUE_LONG_FINALANSWER_TAIL`;
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-body-spool',
    native_session_id: 'codex-body-spool',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-12T08-00-00-codex-body-spool.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-body-spool', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: longAnswer }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    notificationMode: 'direct',
    eventBodyInlineBytes: 64,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].message_markdown, /UNIQUE_LONG_FINALANSWER_TAIL/);
  assert.equal(posts[0].direct_full_text_source, 'event-body:spool');

  const index = await openEventIndex(root);
  try {
    const row = index.db.prepare(`SELECT event_json FROM events WHERE event_type = 'FinalAnswer' LIMIT 1`).get();
    const savedEvent = JSON.parse(row.event_json);
    assert.equal(savedEvent.bodyRef?.algorithm, 'sha256');
    assert.equal(savedEvent.text.includes('UNIQUE_LONG_FINALANSWER_TAIL'), false);
    assert.equal((await readFile(savedEvent.bodyRef.path, 'utf8')).includes('UNIQUE_LONG_FINALANSWER_TAIL'), true);
  } finally {
    closeEventIndex(index);
  }
});

test('pollHermesWebhookNotifications ignores omx explore codex exec completion logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-explore-aux-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '19');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(sessionsDir, 'rollout-2026-05-19T16-08-34-019e3f10-a0c7-7101-a822-9863f208ae57.jsonl'), [
    {
      timestamp: '2026-05-19T07:08:34.888Z',
      type: 'session_meta',
      payload: {
        id: '019e3f10-a0c7-7101-a822-9863f208ae57',
        timestamp: '2026-05-19T07:08:34.888Z',
        cwd: root,
        originator: 'codex_exec',
        source: 'exec',
        base_instructions: { text: '# OMX Explore Lightweight Instructions\n\nread-only only' },
      },
    },
    { timestamp: '2026-05-19T07:08:40.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '먼저 터미널 권한 문제를 해결한 뒤, 다음 탐색을 실행해 주세요.' }] } },
    { timestamp: '2026-05-19T07:09:00.697Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '먼저 터미널 권한 문제를 해결한 뒤, 다음 탐색을 실행해 주세요.' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    includeUnmappedCodexLogs: true,
    allowCodexOnlySessionMonitoring: true,
    notificationMode: 'direct',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.deepEqual(posts, []);
});

test('pollHermesWebhookNotifications suppresses legacy pending omx explore completion events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-legacy-explore-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '19');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  const logPath = join(sessionsDir, 'rollout-2026-05-19T16-08-34-019e3f10-a0c7-7101-a822-9863f208ae57.jsonl');
  await writeFile(logPath, [
    {
      timestamp: '2026-05-19T07:08:34.888Z',
      type: 'session_meta',
      payload: {
        id: '019e3f10-a0c7-7101-a822-9863f208ae57',
        timestamp: '2026-05-19T07:08:34.888Z',
        cwd: root,
        originator: 'codex_exec',
        source: 'exec',
        base_instructions: { text: '# OMX Explore Lightweight Instructions\n\nread-only only' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const index = await openEventIndex(root, { stateRoot: root });
  try {
    upsertEvents(index.db, [{
      session: {
        project: root.split('/').pop(),
        codexSessionId: '019e3f10-a0c7-7101-a822-9863f208ae57',
        threadId: '019e3f10-a0c7-7101-a822-9863f208ae57',
        sessionLogPath: logPath,
        hasOmxLifecycle: false,
      },
      eventId: '019e3f10-a0c7-7101-a822-9863f208ae57:message-32',
      event: {
        eventId: '019e3f10-a0c7-7101-a822-9863f208ae57:message-32',
        type: 'FinalAnswer',
        timestamp: '2026-05-19T07:09:00.697Z',
        source: 'codex-log',
        phase: 'final_answer',
        text: '먼저 터미널 권한 문제를 해결한 뒤, 다음 탐색을 실행해 주세요.',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    stateRoot: root,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    includeUnmappedCodexLogs: true,
    allowCodexOnlySessionMonitoring: true,
    notificationMode: 'direct',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 0);
  assert.deepEqual(posts, []);
});

test('pollHermesWebhookNotifications includes bridge command target Codex logs after native remap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-command-target-log-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-visible',
    native_session_id: 'codex-new-native',
    started_at: '2026-05-19T08:33:34.295Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(root, '.omx', 'logs', 'bridge-interactions.jsonl'), JSON.stringify({
    interactionId: 'interaction-1',
    codexSessionId: 'codex-command-target',
    omxSessionId: 'omx-visible',
    threadId: 'codex-command-target',
    tmuxId: 'tmux-visible',
    commandText: '작업을 마무리해줘',
    dryRun: false,
    submittedAt: '2026-05-19T09:05:21.300Z',
    source: 'bridge',
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-19T17-36-51-codex-new-native.jsonl'), [
    {
      timestamp: '2026-05-19T08:36:51.511Z',
      type: 'session_meta',
      payload: {
        id: 'codex-new-native',
        timestamp: '2026-05-19T08:36:51.511Z',
        cwd: root,
        base_instructions: { text: '<!-- OMX:RUNTIME:START -->\n**Session:** omx-visible | 2026-05-19T08:33:34.295Z\n<!-- OMX:RUNTIME:END -->' },
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeFile(join(sessionsDir, 'rollout-2026-05-19T16-08-15-codex-command-target.jsonl'), [
    { timestamp: '2026-05-19T07:08:15.663Z', type: 'session_meta', payload: { id: 'codex-command-target', timestamp: '2026-05-19T07:08:15.663Z', cwd: root } },
    { timestamp: '2026-05-19T09:08:59.828Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '재연결 전 command target 로그의 완료 답변' }] } },
    { timestamp: '2026-05-19T09:09:00.141Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '재연결 전 command target 로그의 완료 답변' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    notificationMode: 'direct',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts[0].event_id, 'codex-command-target:message-2');
  assert.match(posts[0].message_markdown, /재연결 전 command target 로그의 완료 답변/);
});

test('pollHermesWebhookNotifications posts long direct FinalAnswer chunks sequentially to the same target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-direct-chunks-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '12');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({
    projects: { [root.split('/').pop()]: 'project-channel' },
    sessionThreads: {
      'omx-long-direct': {
        project: root.split('/').pop(),
        parentChannelId: 'project-channel',
        threadId: 'session-thread',
        threadName: 'omx-long-direct',
      },
    },
  }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-long-direct',
    native_session_id: 'codex-long-direct',
    started_at: '2026-05-12T08:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-12T08-00-00-codex-long-direct.jsonl'), [
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'session_meta', payload: { id: 'codex-long-direct', timestamp: '2026-05-12T08:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-12T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '긴 결과를 만들어줘' }] } },
    { timestamp: '2026-05-12T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '긴 direct FinalAnswer 원문입니다. '.repeat(700) }] } },
    { timestamp: '2026-05-12T08:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '짧은 완료 이벤트' } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const hermesPosts = [];
  const discordPosts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    fetchFn: async (_url, request) => {
      hermesPosts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      discordPosts.push({ url, body: JSON.parse(request.body) });
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(hermesPosts, []);
  assert.ok(discordPosts.length > 1);
  assert.equal(discordPosts.every((post) => post.url.endsWith('/channels/session-thread/messages')), true);
  assert.equal(discordPosts.every((post) => post.body.content.length <= 1800), true);
  assert.deepEqual(discordPosts.map((post, index) => post.body.content.match(/\((\d+)\/(\d+)\)$/)?.[1]), discordPosts.map((_post, index) => String(index + 1)));
  assert.equal(discordPosts.every((post) => post.body.content.endsWith(`/${discordPosts.length})`)), true);
  assert.equal(discordPosts.every((post) => post.body.allowed_mentions.parse.length === 0), true);
  assert.match(discordPosts[0].body.content, /^# Session Idle/);
  assert.match(discordPosts[0].body.content, /\*\*tmux:\*\* `omx-long-direct`/);
  assert.doesNotMatch(discordPosts[1].body.content, /# Session Idle/);
  assert.doesNotMatch(discordPosts[1].body.content, /\*\*session:\*\*/);
});

test('pollHermesWebhookNotifications creates a GJC session thread for direct FinalAnswer delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-hermes-leading-final-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  const project = root.split('/').pop();
  const sessionId = '019e9000-6060-7000-aaaa-ffffffffffff';
  const startedAt = '2026-06-04T10:00:00.000Z';
  const expectedThreadName = `gjc-${project}-gjc-${localDateTimeSuffix(startedAt)}`;
  await writeFile(mapPath, JSON.stringify({ projects: { [project]: 'project-channel' } }));

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        backend: 'gjc',
        lifecycleOwner: 'gjc',
        hasOmxLifecycle: false,
        gjcSessionId: sessionId,
        bridgeSessionId: sessionId,
        threadId: sessionId,
        project,
        startedAt,
      },
      event: {
        eventId: `${sessionId}:final`,
        type: 'FinalAnswer',
        source: 'gjc-log',
        timestamp: '2026-06-04T10:00:02.000Z',
        text: 'GJC direct 완료 답변',
        phase: 'final_answer',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const hermesPosts = [];
  const discordRequests = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    fetchFn: async (_url, request) => {
      hermesPosts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      const method = request.method || 'GET';
      const body = request.body ? JSON.parse(request.body) : null;
      discordRequests.push({ url, method, body });
      if (method === 'GET' && url.endsWith('/guilds/guild-1/threads/active')) {
        return { ok: true, json: async () => ({ threads: [] }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/project-channel/threads')) {
        assert.equal(body.name, expectedThreadName);
        return { ok: true, status: 201, json: async () => ({ id: 'gjc-direct-thread', name: body.name, parent_id: 'project-channel', type: 11 }), text: async () => '' };
      }
      if (method === 'POST' && url.endsWith('/channels/gjc-direct-thread/messages')) {
        return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
      }
      throw new Error(`unexpected Discord request: ${method} ${url}`);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(result.skippedNoChannel, 0);
  assert.deepEqual(hermesPosts, []);
  assert.equal(discordRequests.filter((request) => request.url.endsWith('/channels/project-channel/threads')).length, 1);
  const posts = discordRequests.filter((request) => request.url.endsWith('/channels/gjc-direct-thread/messages'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /# Session Idle/);
  assert.match(posts[0].body.content, /GJC direct 완료 답변/);
  assert.doesNotMatch(posts[0].body.content, /Bridge Notification Delivery Failed/);
});


test('pollHermesWebhookNotifications holds GJC FinalAnswer until fast lifecycle thread events are delivered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-hermes-lifecycle-order-'));
  const sessionsRoot = join(root, 'gjc-sessions');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  const project = root.split('/').pop();
  const sessionId = '019e9000-7070-7000-aaaa-ffffffffffff';
  const baseMs = Date.now() - 30000;
  const startedAt = new Date(baseMs).toISOString();
  const userAt = new Date(baseMs + 1000).toISOString();
  const finalAt = new Date(baseMs + 2000).toISOString();
  const expectedThreadName = `gjc-${project}-gjc-${localDateTimeSuffix(startedAt)}`;
  await mkdir(join(sessionsRoot, 'project'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [project]: 'project-channel' } }));
  await writeFile(join(sessionsRoot, 'project', `${sessionId}.jsonl`), [
    { type: 'session', version: 3, id: sessionId, timestamp: startedAt, cwd: root, title: 'GJC ordered session' },
    { type: 'message', id: 'gjc-user-1', timestamp: userAt, message: { role: 'user', content: [{ type: 'text', text: '안녕 테스트 한줄 출력' }] } },
    { type: 'message', id: 'gjc-final-1', timestamp: finalAt, message: { role: 'assistant', content: [{ type: 'text', text: '안녕 테스트 한줄 출력' }] }, stopReason: 'stop' },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const firstDiscordRequests = [];
  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot }, async () => {
    const first = await pollHermesWebhookNotifications({
      projectRoot: root,
      discoverTmuxProjectRoots: false,
      statePath,
      eventIndexPath,
      projectChannelMapPath: mapPath,
      webhookUrl: 'http://hermes.test/webhook',
      eventTypes: new Set(['FinalAnswer']),
      replay: true,
      autoCreateDiscordThreads: true,
      notificationMode: 'direct',
      discordBotToken: 'test-token',
      discordGuildId: 'guild-1',
      discordFetchFn: async (url, request = {}) => {
        firstDiscordRequests.push({ url, method: request.method || 'GET' });
        return { ok: true, json: async () => ({ threads: [] }), text: async () => '' };
      },
      fetchFn: async () => { throw new Error('Hermes webhook should not receive direct GJC final'); },
    });
    assert.equal(first.sent, 0);
  });
  assert.deepEqual(firstDiscordRequests, []);

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    markDeliverySent(index.db, `${sessionId}:start`, 'discord-fast');
    markDeliverySent(index.db, `${sessionId}:gjc-user-1`, 'discord-fast');
  } finally {
    closeEventIndex(index);
  }

  const discordRequests = [];
  await withEnv({ GJC_SESSIONS_ROOT: sessionsRoot }, async () => {
    const second = await pollHermesWebhookNotifications({
      projectRoot: root,
      discoverTmuxProjectRoots: false,
      statePath,
      eventIndexPath,
      projectChannelMapPath: mapPath,
      webhookUrl: 'http://hermes.test/webhook',
      eventTypes: new Set(['FinalAnswer']),
      replay: true,
      autoCreateDiscordThreads: true,
      notificationMode: 'direct',
      discordBotToken: 'test-token',
      discordGuildId: 'guild-1',
      discordFetchFn: async (url, request = {}) => {
        const method = request.method || 'GET';
        const body = request.body ? JSON.parse(request.body) : null;
        discordRequests.push({ url, method, body });
        if (method === 'GET' && url.endsWith('/guilds/guild-1/threads/active')) {
          return { ok: true, json: async () => ({ threads: [] }), text: async () => '' };
        }
        if (method === 'POST' && url.endsWith('/channels/project-channel/threads')) {
          assert.equal(body.name, expectedThreadName);
          return { ok: true, status: 201, json: async () => ({ id: 'gjc-ordered-thread', name: body.name, parent_id: 'project-channel', type: 11 }), text: async () => '' };
        }
        if (method === 'POST' && url.endsWith('/channels/gjc-ordered-thread/messages')) {
          return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
        }
        throw new Error(`unexpected Discord request: ${method} ${url}`);
      },
      fetchFn: async () => { throw new Error('Hermes webhook should not receive direct GJC final'); },
    });
    assert.equal(second.sent, 1);
  });

  assert.equal(discordRequests.filter((request) => request.url.endsWith('/channels/project-channel/threads')).length, 1);
  const posts = discordRequests.filter((request) => request.url.endsWith('/channels/gjc-ordered-thread/messages'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /^# Session Idle/);
  assert.match(posts[0].body.content, /안녕 테스트 한줄 출력/);
});


test('pollHermesWebhookNotifications rechecks session thread map before creating a GJC direct thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-hermes-stale-map-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  const project = root.split('/').pop();
  const sessionId = '019e9000-8080-7000-aaaa-ffffffffffff';
  const startedAt = '2026-06-04T10:00:00.000Z';
  await writeFile(mapPath, JSON.stringify({ projects: { [project]: 'project-channel' } }));
  await writeFile(hermesConfigPath, 'discord:\n  free_response_channels: other-channel\n  allowed_channels: other-channel\n');

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [{
      session: {
        backend: 'gjc',
        lifecycleOwner: 'gjc',
        hasOmxLifecycle: false,
        gjcSessionId: sessionId,
        bridgeSessionId: sessionId,
        threadId: sessionId,
        project,
        startedAt,
      },
      event: {
        eventId: `${sessionId}:final`,
        type: 'FinalAnswer',
        source: 'gjc-log',
        timestamp: '2026-06-04T10:00:02.000Z',
        text: 'GJC direct 완료 답변',
        phase: 'final_answer',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const discordRequests = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    updateHermesConfig: true,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    hermesGatewayRestarter: async () => {
      await writeFile(mapPath, JSON.stringify({
        projects: { [project]: 'project-channel' },
        sessionThreads: {
          [sessionId]: {
            project,
            parentChannelId: 'project-channel',
            threadId: 'existing-gjc-thread',
            threadName: 'gjc-existing-thread',
            createdAt: '2026-06-04T10:00:01.000Z',
          },
        },
      }));
      return { ok: true, restarted: true };
    },
    fetchFn: async () => { throw new Error('Hermes webhook should not receive direct GJC final'); },
    discordFetchFn: async (url, request = {}) => {
      const method = request.method || 'GET';
      const body = request.body ? JSON.parse(request.body) : null;
      discordRequests.push({ url, method, body });
      if (method === 'POST' && url.endsWith('/channels/existing-gjc-thread/messages')) {
        return { ok: true, json: async () => ({ id: 'message-1' }), text: async () => '' };
      }
      throw new Error(`unexpected Discord request: ${method} ${url}`);
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(discordRequests.filter((request) => request.url.endsWith('/channels/project-channel/threads')).length, 0);
  const posts = discordRequests.filter((request) => request.url.endsWith('/channels/existing-gjc-thread/messages'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /^# Session Idle/);
});

test('pollHermesWebhookNotifications retargets stale resumed FinalAnswer to the current OMX session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-resume-current-thread-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  const project = root.split('/').pop();
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-current-thread',
    native_session_id: 'codex-resumed-thread',
    started_at: '2026-05-29T03:06:10.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(mapPath, JSON.stringify({
    projects: { [project]: 'project-channel' },
    sessionThreads: {
      'omx-old-thread': {
        project,
        parentChannelId: 'project-channel',
        threadId: 'old-session-thread',
        threadName: 'omx-old-thread',
      },
      'omx-current-thread': {
        project,
        parentChannelId: 'project-channel',
        threadId: 'current-session-thread',
        threadName: 'omx-current-thread',
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
        omxSessionId: 'omx-old-thread',
        runtimeOmxSessionId: 'omx-old-thread',
        project,
        status: 'ended',
        hasOmxLifecycle: true,
      },
      event: {
        eventId: 'codex-resumed-thread:message-10',
        type: 'FinalAnswer',
        source: 'codex-log',
        timestamp: '2026-05-29T03:09:00.000Z',
        text: '현재 세션으로 와야 하는 FinalAnswer',
        phase: 'final_answer',
      },
    }]);
  } finally {
    closeEventIndex(index);
  }

  const hermesPosts = [];
  const discordPosts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    fetchFn: async (_url, request) => {
      hermesPosts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      discordPosts.push({ url, body: JSON.parse(request.body) });
      assert.ok(url.endsWith('/channels/current-session-thread/messages'));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(hermesPosts, []);
  assert.equal(discordPosts.length, 1);
  assert.match(discordPosts[0].body.content, /현재 세션으로 와야 하는 FinalAnswer/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT json_extract(session_json, '$.omxSessionId') AS omx_session_id,
             target_thread_id
      FROM events
      JOIN deliveries USING (event_id)
      WHERE event_id = 'codex-resumed-thread:message-10' AND sink = 'hermes'
    `).get();
    assert.equal(row.omx_session_id, 'omx-current-thread');
    assert.equal(row.target_thread_id, 'current-session-thread');
  } finally {
    closeEventIndex(deliveryIndex);
  }
});

test('pollHermesWebhookNotifications posts short direct FinalAnswer directly to the session thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-direct-short-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '22');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({
    projects: { [root.split('/').pop()]: 'project-channel' },
    sessionThreads: {
      'omx-short-direct': {
        project: root.split('/').pop(),
        parentChannelId: 'project-channel',
        threadId: 'session-thread',
        threadName: 'omx-short-direct',
      },
    },
  }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-short-direct',
    native_session_id: 'codex-short-direct',
    started_at: '2026-05-22T03:00:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-22T03-00-00-codex-short-direct.jsonl'), [
    { timestamp: '2026-05-22T03:00:00.000Z', type: 'session_meta', payload: { id: 'codex-short-direct', timestamp: '2026-05-22T03:00:00.000Z', cwd: root } },
    { timestamp: '2026-05-22T03:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '짧은 FinalAnswer 원문' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  const hermesPosts = [];
  const discordPosts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    fetchFn: async (_url, request) => {
      hermesPosts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      discordPosts.push({ url, body: JSON.parse(request.body) });
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(hermesPosts, []);
  assert.equal(discordPosts.length, 1);
  assert.equal(discordPosts[0].url.endsWith('/channels/session-thread/messages'), true);
  assert.match(discordPosts[0].body.content, /짧은 FinalAnswer 원문/);
});

test('pollHermesWebhookNotifications keeps retryable Hermes gateway failures queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-gateway-retry-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '22');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-gateway-retry',
    native_session_id: 'codex-gateway-retry',
    started_at: '2026-05-22T03:10:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-22T03-10-00-codex-gateway-retry.jsonl'), [
    { timestamp: '2026-05-22T03:10:00.000Z', type: 'session_meta', payload: { id: 'codex-gateway-retry', timestamp: '2026-05-22T03:10:00.000Z', cwd: root } },
    { timestamp: '2026-05-22T03:10:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '재시도되어야 하는 FinalAnswer' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  await assert.rejects(
    pollHermesWebhookNotifications({
      projectRoot: root,
      discoverTmuxProjectRoots: false,
      codexHome,
      statePath,
      eventIndexPath,
      projectChannelMapPath: mapPath,
      webhookUrl: 'http://hermes.test/webhook',
      eventTypes: new Set(['FinalAnswer']),
      replay: true,
      notificationMode: 'direct',
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
      fetchFn: async () => ({ ok: false, status: 503, text: async () => 'gateway restarting' }),
    }),
    /Hermes webhook failed: 503 gateway restarting/,
  );

  let index = await openEventIndex(root, { eventIndexPath });
  try {
    const row = index.db.prepare(`
      SELECT status, retry_count, next_attempt_at, last_error
      FROM deliveries
      WHERE event_id = 'codex-gateway-retry:message-2' AND sink = 'hermes'
    `).get();
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 1);
    assert.equal(row.next_attempt_at, '1970-01-01T00:00:00.000Z');
    assert.match(row.last_error, /gateway-disconnected-retryable/);
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome,
    statePath,
    eventIndexPath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['FinalAnswer']),
    replay: true,
    notificationMode: 'direct',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].event_id, 'codex-gateway-retry:message-2');
  index = await openEventIndex(root, { eventIndexPath });
  try {
    const row = index.db.prepare(`
      SELECT status, retry_count, next_attempt_at, last_error
      FROM deliveries
      WHERE event_id = 'codex-gateway-retry:message-2' AND sink = 'hermes'
    `).get();
    assert.equal(row.status, 'sent');
    assert.equal(row.retry_count, 1);
    assert.equal(row.next_attempt_at, null);
    assert.equal(row.last_error, null);
  } finally {
    closeEventIndex(index);
  }
});

test('pollHermesWebhookNotifications marks permanent Hermes HTTP failures dead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-gateway-permanent-'));
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '22');
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ projects: { [root.split('/').pop()]: 'project-channel' } }));
  await writeFile(join(root, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-gateway-permanent',
    native_session_id: 'codex-gateway-permanent',
    started_at: '2026-05-22T03:20:00.000Z',
    cwd: root,
    pid: 123,
  }) + '\n');
  await writeFile(join(sessionsDir, 'rollout-2026-05-22T03-20-00-codex-gateway-permanent.jsonl'), [
    { timestamp: '2026-05-22T03:20:00.000Z', type: 'session_meta', payload: { id: 'codex-gateway-permanent', timestamp: '2026-05-22T03:20:00.000Z', cwd: root } },
    { timestamp: '2026-05-22T03:20:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '죽은 처리되어야 하는 FinalAnswer' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));

  await assert.rejects(
    pollHermesWebhookNotifications({
      projectRoot: root,
      discoverTmuxProjectRoots: false,
      codexHome,
      statePath,
      eventIndexPath,
      projectChannelMapPath: mapPath,
      webhookUrl: 'http://hermes.test/webhook',
      eventTypes: new Set(['FinalAnswer']),
      replay: true,
      notificationMode: 'direct',
      fetchFn: async () => ({ ok: false, status: 404, text: async () => 'not found' }),
    }),
    /Hermes webhook failed: 404 not found/,
  );

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    const row = index.db.prepare(`
      SELECT status, retry_count, next_attempt_at, last_error
      FROM deliveries
      WHERE event_id = 'codex-gateway-permanent:message-2' AND sink = 'hermes'
    `).get();
    assert.equal(row.status, 'dead');
    assert.equal(row.retry_count, 1);
    assert.equal(row.next_attempt_at, null);
    assert.match(row.last_error, /permanent-http/);
  } finally {
    closeEventIndex(index);
  }
});

test('pollHermesWebhookNotifications does not fall back to project channel for unmapped SessionEnd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-end-project-channel-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await writeFile(mapPath, JSON.stringify({ projects: { docs: 'project-channel' } }));
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: project-channel',
    '  allowed_channels: project-channel',
    '',
  ].join('\n'));
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

  const posts = [];
  const discordRequests = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    statePath,
    eventIndexPath,
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionEnd']),
    replay: true,
    autoCreateDiscordThreads: true,
    notificationMode: 'direct',
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    updateHermesConfig: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      discordRequests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      return { ok: true, json: async () => ({ id: 'alert-message-1' }), text: async () => '' };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skippedNoChannel, 1);
  assert.equal(posts.length, 0);
  assert.equal(discordRequests.length, 1);
  assert.ok(discordRequests[0].url.endsWith('/channels/project-channel/messages'));
  assert.match(discordRequests[0].body.content, /# Bridge Notification Delivery Failed/);
  assert.match(discordRequests[0].body.content, /SessionEnd/);
  assert.doesNotMatch(discordRequests[0].body.content, /세션이 종료됐어/);

  const deliveryIndex = await openEventIndex(root, { eventIndexPath });
  try {
    const row = deliveryIndex.db.prepare(`
      SELECT status, retry_count, last_error
      FROM deliveries
      WHERE event_id = 'codex-ended-only:end' AND sink = 'hermes'
    `).get();
    assert.equal(row.status, 'dead');
    assert.equal(row.retry_count, 1);
    assert.match(row.last_error, /refusing project-channel fallback/);
  } finally {
    closeEventIndex(deliveryIndex);
  }
  const savedMap = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(savedMap.sessionThreads, undefined);
});

test('pollHermesWebhookNotifications auto creates and maps a missing Discord project channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-createchannel-'));
  const docsRoot = join(root, 'docs');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await mkdir(join(docsRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: {} }));
  await writeFile(hermesConfigPath, [
    'other: true',
    'discord:',
    '  require_mention: true',
    '  free_response_channels: old-free',
    '  allowed_channels: fallback-channel,old-allowed',
    '  auto_thread: true',
    'telegram: {}',
    '',
  ].join('\n'));
  await writeFile(join(docsRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-docs-092941',
    native_session_id: 'codex-docs-3',
    started_at: '2026-05-04T09:29:41.000Z',
    cwd: docsRoot,
    pid: 123,
  }) + '\n');

  const posts = [];
  const discordRequests = [];
  const gatewayRestarts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [docsRoot],
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    updateHermesConfig: true,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    replay: true,
    discordBotToken: 'test-token',
    discordGuildId: 'guild-1',
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url, request = {}) => {
      discordRequests.push({ url, method: request.method || 'GET', body: request.body ? JSON.parse(request.body) : null });
      if ((request.method || 'GET') === 'POST') {
        assert.equal(JSON.parse(request.body).name, 'docs');
        assert.equal(JSON.parse(request.body).type, 0);
        assert.equal(JSON.parse(request.body).parent_id, 'category-1');
        return { ok: true, status: 201, json: async () => ({ id: 'created-channel', name: 'docs', type: 0, parent_id: 'category-1' }) };
      }
      return {
        ok: true,
        json: async () => [
          { id: 'fallback-channel', name: 'ops', type: 0, parent_id: 'category-1' },
          { id: 'other-channel', name: 'other', type: 0 },
        ],
      };
    },
    hermesGatewayRestarter: async () => {
      gatewayRestarts.push('restart');
      return { ok: true, restarted: true, command: 'test-restart' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(discordRequests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(posts[0].project, 'docs');
  assert.equal(posts[0].channel_id, 'created-channel');
  assert.equal(posts[0].channel_mapping_status, 'project');
  assert.equal(posts[0].channel_missing, false);
  assert.equal(gatewayRestarts.length, 1);

  const saved = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(saved.projects.docs, 'created-channel');
  assert.equal(saved.channelNames.docs, 'docs');
  const hermesConfig = await readFile(hermesConfigPath, 'utf8');
  assert.match(hermesConfig, /free_response_channels: old-free,created-channel/);
  assert.match(hermesConfig, /allowed_channels: fallback-channel,old-allowed,created-channel/);
});

test('pollHermesWebhookNotifications repairs Hermes allowlist for an already mapped project channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-repairallow-'));
  const docsRoot = join(root, 'docs');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  const hermesConfigPath = join(root, 'hermes-config.yaml');
  await mkdir(join(docsRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: { docs: 'mapped-channel' } }));
  await writeFile(hermesConfigPath, [
    'discord:',
    '  free_response_channels: fallback-channel',
    '  allowed_channels: fallback-channel',
    '',
  ].join('\n'));
  await writeFile(join(docsRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-docs-102941',
    native_session_id: 'codex-docs-4',
    started_at: '2026-05-04T10:29:41.000Z',
    cwd: docsRoot,
    pid: 123,
  }) + '\n');

  const posts = [];
  const gatewayRestarts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [docsRoot],
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    projectChannelMapPath: mapPath,
    hermesConfigPath,
    updateHermesConfig: true,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    hermesGatewayRestarter: async () => {
      gatewayRestarts.push('restart');
      return { ok: true, restarted: true, command: 'test-restart' };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(posts[0].channel_id, 'mapped-channel');
  assert.equal(posts[0].channel_mapping_status, 'project');
  assert.equal(gatewayRestarts.length, 1);
  const hermesConfig = await readFile(hermesConfigPath, 'utf8');
  assert.match(hermesConfig, /free_response_channels: fallback-channel,mapped-channel/);
  assert.match(hermesConfig, /allowed_channels: fallback-channel,mapped-channel/);
});

test('pollHermesWebhookNotifications suppresses OMX team worker session notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-teamworker-'));
  const projectRoot = join(root, 'chiz-crab');
  const workerRoot = join(projectRoot, '.omx', 'team', 'extractor-safety', 'worktrees', 'worker-1');
  const statePath = join(root, 'state.json');
  const mapPath = join(root, 'project-channels.json');
  await mkdir(join(workerRoot, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ default: 'fallback-channel', projects: { 'chiz-crab': 'chiz-channel' } }));
  await writeFile(join(workerRoot, '.omx', 'logs', 'session-history.jsonl'), JSON.stringify({
    session_id: 'omx-team-worker-1',
    native_session_id: 'codex-team-worker-1',
    started_at: '2026-05-06T07:12:28.000Z',
    cwd: workerRoot,
    pid: 1234,
  }) + '\n');

  const posts = [];
  const discordLookups = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    projectRoots: [workerRoot],
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    projectChannelMapPath: mapPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart']),
    replay: true,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
    discordFetchFn: async (url) => {
      discordLookups.push(url);
      return { ok: false, status: 500, json: async () => [] };
    },
  });

  assert.equal(result.sent, 0);
  assert.equal(discordLookups.length, 0);
  assert.equal(posts.length, 0);
});

test('pollHermesWebhookNotifications drops stale native-only lifecycle pollution before sending valid pending events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-bridge-hermes-stale-native-'));
  const statePath = join(root, 'state.json');
  const eventIndexPath = join(root, 'events.sqlite');
  await mkdir(join(root, '.omx', 'logs'), { recursive: true });
  await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });

  const index = await openEventIndex(root, { eventIndexPath });
  try {
    upsertEvents(index.db, [
      {
        session: {
          bridgeSessionId: 'native-batch',
          omxSessionId: 'native-batch',
          codexSessionId: 'native-batch',
          project: 'chiz-crab',
          hasOmxLifecycle: true,
        },
        event: {
          eventId: 'native-batch:start',
          type: 'SessionStart',
          source: 'notification',
          timestamp: '2026-05-06T12:03:39.590Z',
        },
      },
      {
        session: {
          bridgeSessionId: 'codex-visible',
          omxSessionId: 'owned-visible',
          codexSessionId: 'codex-visible',
          project: 'omx-bridge',
          hasOmxLifecycle: true,
          lifecycleOwner: 'omx',
        },
        event: {
          eventId: 'codex-visible:message-1',
          type: 'FinalAnswer',
          source: 'codex-log',
          phase: 'final_answer',
          timestamp: '2026-05-06T12:04:00.000Z',
          text: '완료',
        },
      },
    ]);
    markDeliveryFailed(index.db, 'native-batch:start', 'hermes', new Error('fetch failed'));
  } finally {
    closeEventIndex(index);
  }

  const posts = [];
  const result = await pollHermesWebhookNotifications({
    projectRoot: root,
    discoverTmuxProjectRoots: false,
    codexHome: join(root, 'codex-home'),
    statePath,
    eventIndexPath,
    webhookUrl: 'http://hermes.test/webhook',
    eventTypes: new Set(['SessionStart', 'FinalAnswer']),
    requireChannel: false,
    replay: true,
    maxEventsPerPoll: 1,
    fetchFn: async (_url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    },
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(posts.map((post) => post.event_id), ['codex-visible:message-1']);
});
