# Operations — hermes-codex-bridge

## 서비스

`hermes-codex-bridge`는 기본 설치에서 **systemd user service**로 동작합니다.
system-wide 목록인 `systemctl list-units`에는 안 보일 수 있으므로 `--user`를 붙입니다.

```bash
systemctl --user list-units --type=service --all | grep -E 'hermes-codex-bridge|hermes-gateway'
systemctl --user status hermes-codex-bridge.service
systemctl --user status hermes-gateway.service
systemctl --user cat hermes-codex-bridge.service
journalctl --user -u hermes-codex-bridge.service -f
journalctl --user -u hermes-gateway.service -f
```

실행 모델:

```text
systemd --user hermes-codex-bridge.service
  -> ExecStart=<npm 경로> start
  -> package.json scripts.start = node src/server.js
  -> listen http://127.0.0.1:3037
```

따라서 프로세스 목록에는 보통 `npm start`, `sh -c node src/server.js`,
`node src/server.js`가 함께 보입니다. 현재 PID/cgroup까지 확인하려면:

```bash
pid="$(systemctl --user show -p MainPID --value hermes-codex-bridge.service)"
ps -fp "$pid" --forest
systemctl --user status hermes-codex-bridge.service --no-pager
```

Health:

```bash
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:8644/health
```

## 기본 운영값

런타임 env에는 기본값을 반복하지 않습니다. 아래는 “켜는 기능/비밀/ID”만 남긴 권장 예시입니다. 실제 sample은 `.env.example`에도 같은 기준으로 정리되어 있습니다.

```env
# Hermes webhook sink
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/codex-bridge
BRIDGE_HERMES_WEBHOOK_SECRET=<shared secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback channel id>

# Discord fast-path/session thread
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<Hermes/Discord bot token>
BRIDGE_DISCORD_GUILD_ID=<Discord guild/server id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
DISCORD_ALERT_CHANNEL_ID=123456789012345678
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true

# Hermes Gateway allowlist 자동 갱신
BRIDGE_HERMES_ALLOWLIST=true

# 선택: 최초 SessionStart mention
BRIDGE_DISCORD_MENTION_USERS=<Discord user id>[,<Discord user id>...]
```

보통 생략하는 기본값: `HOST=127.0.0.1`, `PORT=3037`, `BRIDGE_PUBLIC_URL=http://127.0.0.1:3037`, user service 기준 `BRIDGE_STATE_ROOT=~/.local/state/hermes-codex-bridge`, `BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer`, `BRIDGE_HERMES_NOTIFICATION_MODE=direct`, `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-codex-bridge/project-channels.json`, `BRIDGE_NOTIFY_EVENT_TYPES=SessionStart,SessionLinked,SessionEnd,CommandSubmitted`, `BRIDGE_NOTIFY_DELIVERY_SINK=discord-fast`, `BRIDGE_FINAL_BLOCK=true`, `BRIDGE_FINAL_WAIT_MS=10000`, `BRIDGE_FINAL_SINK=hermes`.

기본값은 `BRIDGE_HERMES_WEBHOOK_INTERVAL_MS=250`, `BRIDGE_NOTIFY_INTERVAL_MS=100`, 각 poll 최대 3개입니다. 운영에서 CPU/Discord 호출을 줄이고 싶으면 3000ms처럼 늘릴 수 있습니다. 초과 이벤트를 버린다는 뜻이 아니라 한 poll에서 3개만 보내고 나머지는 다음 poll에서 보냅니다.

`BRIDGE_DISCORD_MENTION_USERS`를 쉼표 구분 Discord user id 목록으로 설정하면 최초 `SessionStart` 메시지에만 `<@user>` 멘션을 포함하고, `@here`/`@everyone`은 사용하지 않습니다.

`DISCORD_ALERT_CHANNEL_ID`는 delivery가 `dead`로 끝난 이유를 운영자가 바로 볼 수 있는 Discord 채널입니다. 기존 `BRIDGE_DISCORD_BOT_TOKEN`을 그대로 사용하며 별도 토큰은 요구하지 않습니다. 설정하지 않으면 가능한 경우 해당 프로젝트 채널에 실패 알림을 남기고, 채널이 없으면 bridge log에만 남습니다.

Discord fast-path delivery는 sink 안에서 event timestamp/event id 순서의 FIFO를 유지합니다. 또한 같은 세션의 이전 `FinalAnswer`/`AskPermission`이 `BRIDGE_FINAL_SINK`에서 아직 `sent`/`dead`가 아니면 뒤 `User Command`를 보류합니다. `BRIDGE_FINAL_WAIT_MS`는 delivery row가 아직 안 생긴 경우의 짧은 대기 시간입니다. 전송 실패 시 head event를 즉시 재시도하고, 성공하거나 명시적으로 `dead` 처리된 뒤에 다음 event로 넘어갑니다. 기본 post timeout은 `DISCORD_POST_TIMEOUT_MS=3000`이고 기본 최대 시도 횟수는 `BRIDGE_NOTIFY_DELIVERY_MAX_ATTEMPTS`/`BRIDGE_DELIVERY_MAX_ATTEMPTS` 미설정 시 3회입니다. 따라서 일반 network hang 또는 5xx가 계속되면 기본 최악 지연은 약 9초입니다. `5xx`, `408`, network error, timeout은 retry 대상이고, `401`/`403`/`404` 및 기타 `4xx`는 permanent failure로 빠르게 `dead` 처리합니다. `429`는 `Retry-After`가 `DISCORD_429_MAX_WAIT_MS=1000` 이하이면 잠깐 기다렸다 retry하고, 더 길면 FIFO를 깨지 않도록 해당 delivery를 `failed`/hold 상태로 남긴 뒤 다음 poll에서 재시도합니다.

프로젝트 채널/세션 thread 자동 검색·생성·매핑에는 `BRIDGE_DISCORD_BOT_TOKEN`과 `BRIDGE_DISCORD_GUILD_ID`가 기본 필수값입니다. `scripts/install-hermes-stack.sh`는 명시 플래그가 없으면 `~/.hermes/.env`의 `DISCORD_BOT_TOKEN`/`BRIDGE_DISCORD_BOT_TOKEN`을 읽고, `DISCORD_HOME_CHANNEL` 또는 fallback channel id에서 Discord API로 guild id를 유도해 systemd env에 `BRIDGE_DISCORD_GUILD_ID`를 기록합니다. 토큰이나 guild id가 없으면 auto-create thread는 결정적으로 동작하지 않으므로, project-channel delivery만 원할 때는 `--no-threads`를 명시합니다.

## Hermes 알림 mode

기본값은 `direct`입니다. `summary`는 명시적으로 선택하는 축약 모드입니다.

```env
BRIDGE_HERMES_NOTIFICATION_MODE=direct
```

동작 차이:

- `summary`: bridge는 Discord 완성문을 길게 만들지 않고 `event_name`, `event_context_line`, `bridge_session_id`, `text_preview`, `read_endpoints`를 포함한 구조화 payload를 Hermes에 전달합니다. Hermes가 원문보다 짧게 압축하되, FinalAnswer는 원문 길이와 운영 밀도에 따라 짧은 원문 8~12줄, 보통 원문 12~20줄, 긴 원문 20~36줄 범위에서 핵심 결론/원인/수정/검증/주의를 남깁니다.
- `direct`: bridge가 Codex JSONL의 마지막 FinalAnswer fullText를 알림 본문으로 직접 만들고, 1800자를 넘으면 여러 조각으로 나눕니다. Discord bot token과 session thread target이 있으면 bridge가 각 조각을 Discord channel message로 순차 전송해 Hermes agent 병렬 처리/순서 역전을 거치지 않습니다. Hermes로 전달되는 direct payload가 있는 경우에도 Hermes는 summary 없이 그대로 전달해야 합니다. 최신 assistant fullText가 없으면 FinalAnswer event text를 원문 소스로 쓰며, 둘 다 없을 때만 실패를 명시합니다.

Codex log에서 나온 standalone idle 중복 이벤트는 보내지 않습니다. 최종 답변 알림은 이벤트 타입은 `FinalAnswer`로 유지하되 사용자 제목은 `Session Idle`로 렌더링합니다. 이미 발행된 `FinalAnswer`/`AgentResponse`는 바로 뒤에 더 늦은 `User Command`가 관측되더라도 stale terminal로 버리지 않고, event queue에 남긴 순서대로 delivery 대상에 포함합니다.

FinalAnswer의 `summary` 알림은 너무 짧게 뭉개지지 않도록 운영합니다. `payload.message_markdown`은 제목/컨텍스트 골격일 수 있으므로 그대로 끝내지 않고, 원문을 결론/원인/수정/검증/주의로 재배열합니다. 기본 구조는 `핵심 결론`, `원인/수정 내용`, `검증 결과`, `남은 주의/운영 조치`입니다. 고정 상한으로 자르지 않고 원문 길이에 맞춰 짧은 원문은 8~12줄, 보통 원문은 12~20줄, 긴 원문이나 운영 판단 근거가 많은 원문은 20~36줄까지 허용합니다. 원문 전체를 그대로 보내지는 않지만, 긴 원문일수록 원인·수정·검증 bullet을 더 남기고 서비스명/PID/포트/env key/commit hash/테스트 결과처럼 운영 판단에 필요한 세부 정보는 보존합니다. 파일/설정/커밋/테스트는 대표 묶음으로 압축하되 판단에 필요한 식별자는 보존하고, 긴 명령·긴 로그·전체 `git status`는 붙이지 않습니다. `text_truncated=true`이거나 `text_length`가 큰 경우 Hermes는 `/sessions/:id/idle/latest`로 전체 원문을 확인한 뒤 요약해야 합니다.
설명 문장은 한국어 중심으로 작성합니다. 명령어·경로·API endpoint·env key·schema field·event type·서비스명·UI 라벨·commit hash처럼 정확히 보존해야 하는 기술 토큰은 원문 그대로 남기되, `Document graph`(문서 그래프), `keyword_fallback`(키워드 fallback 경로), `resultCount`(결과 개수 필드)처럼 의미가 필요한 고유 명칭에는 첫 언급에서 한국어 설명을 덧붙입니다.

사용자가 “원문 그대로”, “full text”, “latest idle 원문”을 명시하면 summary mode 예외입니다. Hermes는 bridge의 `/sessions/:id/idle/latest`를 조회해 `fullText`를 본문으로 그대로 보내고, 원문 전체를 ```markdown 코드블럭으로 다시 감싸지 않습니다. 길이 때문에 나눌 때는 markdown fence가 깨지지 않게 자릅니다. bridge 원문 조회 실패 시 truncated 알림이나 tmux capture를 원문처럼 조용히 대체하지 말고 실패를 명시해야 합니다.

세션 상태 확인은 tmux 화면을 캡처하지 말고 bridge가 Codex JSONL에서 계산한 상태를 먼저 봅니다.

```bash
codex-send --list
curl -sS http://127.0.0.1:3037/sessions/<session-id>/state
```

`GET /sessions`는 운영 응답성을 위해 기본적으로 최근/활성 중심 50개만 스캔하고, `hasBridgeLifecycle:false`인 Codex-only/native-only 세션은 일반 감시/전달 대상이 아니므로 기본 목록에서 숨깁니다. 전체 과거 세션까지 확인해야 할 때만 `GET /sessions?limit=all`을 사용하고, Codex CLI extract 같은 diagnostic-only 로그까지 확인해야 할 때만 `GET /sessions?includeNativeOnly=true`를 명시합니다. 빠른 CLI 조회/프로젝트 해석에는 `GET /sessions?activity=false&limit=50`처럼 activity 재계산을 끕니다. 기본 제한은 `BRIDGE_CONTROL_SESSION_SCAN_LIMIT` 또는 공통 `BRIDGE_SESSION_SCAN_LIMIT`로 조정할 수 있습니다.

응답의 `activityState`/`activity.state`는 `working`, `idle`, `ask`, `final`, `ended`, `unknown` 중 하나입니다. `summary` mode에서도 이 상태 조회는 알림 전송과 별개로 사용할 수 있습니다.

Hermes skill 경계는 역할별로 분리합니다. `hermes-codex-bridge`는 bridge read/status/notification rendering 전용이고, 생성·전달·종료 mutation은 전용 helper skill이 소유합니다. 알림 reply에서 “이 세션/이거/방금 알림”은 항상 해당 알림의 `bridge_session_id`를 뜻하며 project 최신 세션으로 추정하지 않습니다. “이건 뭐냐”, “무슨 뜻이야?”, “궁금한데”, “왜 그래?” 같은 단순 설명 요청은 dispatch/stop/start 단어가 없을 때만 `hermes-codex-bridge`가 bridge read endpoint로 확인해 설명합니다.

전용 mutation skill mapping은 다음과 같습니다.

- `codex-new`: “새 세션”, “세션 열어”, “시작해”, create/launch/start/watch a new Codex session. Bridge webhook `SessionStart` 알림 본문은 새 세션 트리거가 아닙니다.
- `codex-send`: “전달”, “보내”, “넘겨”, “세션에 전달”, “follow-up”, “이거 반영”, “수정”, “고쳐”, “계속”, AskPermission의 `/approve`/`/deny` 같은 승인/거절. Discord-originated Hermes reply dispatch는 정제 후 `codex-send --discord-approval`로 bridge pending approval을 만들고, Hermes가 이어서 native `clarify`/AskUserQuestion으로 operator 전송/거절/추가수정 카드를 실제 Discord에 렌더링해야 합니다. `codex-send --discord-approval`의 JSON `component_actions`만으로는 Gateway 버튼이 자동 생성되지 않습니다. `/new`/`/resume`이 기존 Codex tmux pane에 전달되는 프롬프트 안에 있으면 Codex slash command이므로 `codex-send`가 원문 의미를 보존해 전달합니다. prompt refinement SSoT도 `skills/codex-send/SKILL.md`입니다.
- `codex-kill`: “종료”, “이 세션 종료해”, “kill”, “킬”, “죽여”, stop/close session. reply 대상 `bridge_session_id`나 정확한 `tmux` metadata를 우선합니다.
- `hermes-codex-bridge`: “원문 알려줘”, “마지막 답변 원문”, “raw”, “full text”는 `/sessions/:id/idle/latest`의 `fullText`; “세션 열려있어?”, “세션 살아있어?”, “현재 세션 확인”은 `/sessions` 또는 `/sessions/:id/state`; “최근 로그/이벤트”는 `/sessions/:id/events`; “내가 보낸 이력/명령 이력”은 `/sessions/:id/interactions`.

## Hermes 규칙 주입 위치

실제 런타임 규칙은 아래 네 곳으로 나뉩니다.

- `scripts/install-hermes-stack.sh`의 `subscription_prompt`: Hermes webhook subscription의 `prompt` 원본입니다. 설치/갱신 후 `~/.hermes/webhook_subscriptions.json`에 저장됩니다.
- `skills/hermes-codex-bridge/SKILL.md`: 브리지 운영/조회/상태확인/알림 렌더링 skill입니다. Hermes가 `codex-bridge` subscription에서 함께 로드하며 `scripts/install-hermes-skill.sh`가 `~/.hermes/skills/autonomous-ai-agents/hermes-codex-bridge/`로 복사합니다.
- `skills/codex-new/SKILL.md`, `skills/codex-send/SKILL.md`, `skills/codex-kill/SKILL.md`: 세션 생성, 프롬프트 전달, 세션 종료를 각각 소유하는 전용 helper skills입니다. `codex-send`에는 prompt refinement, 과정제/의미왜곡 금지선, temp-file/write_file 금지선, Discord-originated `--discord-approval` + Hermes `clarify` card 렌더링 규칙이 들어 있습니다. `scripts/install-hermes-stack.sh`의 webhook subscription은 `hermes-codex-bridge,codex-new,codex-send,codex-kill`을 함께 로드합니다.
- `src/hermes-webhook-sink.js`: 알림 대상 이벤트와 payload를 만드는 코드 경계입니다. `shouldPollSession`/`shouldForwardToHermes`가 Codex-owned lifecycle 및 native-only 오염 필터를 적용합니다.
- `src/server.js`: `codex-send`/`POST /sessions/:id/commands` dispatch 응답을 만들고, 입력 원문은 `bridge-interactions` 기반 `CommandSubmitted` / `User Command` 이벤트로 노출되게 합니다.

`docs/quickstart-ko.md`, `docs/hermes-gateway-integration.md`, 이 문서는 운영 예시와 설명입니다. 실제 subscription prompt를 바꾼 뒤에는 Hermes skill 재설치, `~/.hermes/webhook_subscriptions.json` 갱신, `hermes-gateway.service` 재시작까지 확인해야 새 webhook run에 반영됩니다.

## Helper CLI 설치 경계

`codex-new`/`codex-send`/`codex-kill` helper CLI의 SSoT는 이제 이 repository의 `bin/` 디렉터리입니다. `scripts/install-codex-cli.sh`는 세 CLI만 `PATH`에 설치하며 Codex global hook은 수정하지 않습니다. `scripts/install-hermes-stack.sh`는 기본으로 이 CLI installer를 먼저 실행한 뒤 Hermes skill과 bridge service를 설치합니다.

- CLI만 설치/갱신: `scripts/install-codex-cli.sh --force`
- 전체 stack 설치: `scripts/install-hermes-stack.sh --non-interactive`
- CLI 설치를 건너뛰어야 하는 특수 환경: `scripts/install-hermes-stack.sh --skip-cli`

현재 `codex-new`는 `codex-new [PROJECT_DIR] [--name SESSION] [--attach] [--json] [--no-check] [-- CODEX_ARGS...]`입니다. Hermes가 새 visible session을 시작할 때는 raw `codex` 직접 실행 대신 `codex-new`를 사용합니다. `codex-new`가 bridge-owned tmux session과 순정 `codex --dangerously-bypass-approvals-and-sandbox`를 구성하고 lifecycle을 `BRIDGE_STATE_ROOT/session-history.jsonl`에 기록합니다. reasoning effort는 `CODEX_EFFORT=high|xhigh|medium` env로만 설정합니다. Hermes 규칙에서 `--tmux`, `--direct`, hook disable 옵션을 기본값처럼 추가하면 안 됩니다.

## 이벤트 타입 조절

평소에는 설정하지 않아도 됩니다. 기본값은 아래와 같습니다.

기본:

```env
BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer
```

`Commentary`는 기본 사용자 알림에서 제외합니다. 중간 진행이 꼭 필요할 때만 일시적으로 event types에 추가하세요.

가장 보수적인 운영:

```env
BRIDGE_HERMES_WEBHOOK_MAX_EVENTS_PER_POLL=1
BRIDGE_HERMES_WEBHOOK_INTERVAL_MS=250
```

## 채널 정책

- 채널명은 프로젝트명 기준입니다.
- 브랜치는 채널명에 넣지 않고 메시지 메타로 표시합니다.
- 매핑 파일에 프로젝트가 있으면 해당 채널 사용.
- 매핑이 없으면 bridge가 `BRIDGE_DISCORD_BOT_TOKEN`/`BRIDGE_DISCORD_GUILD_ID`로 `desired_channel_name` 기존 채널을 먼저 찾고, 없으면 권한이 허용될 때 생성/매핑합니다. 이 값이 없거나 Discord API가 실패하면 관측 가능한 fallback 전송만 수행하고 project map을 조용히 오염시키지 않습니다.
- `BRIDGE_DISCORD_AUTO_CREATE_THREADS=true` 또는 installer의 `--threads`를 켜면, 세션별 공개 thread를 프로젝트 채널 아래에 만들고 이후 같은 세션 이벤트를 그 thread로 보냅니다. 직접 Discord fast-path(`SessionStart`/`SessionLinked`/`SessionEnd`/`CommandSubmitted`)와 Hermes webhook path(`AskPermission`/`FinalAnswer`)가 같은 `sessionThreads` map을 공유합니다. thread id는 같은 project channel map의 `sessionThreads`에 기록됩니다. thread 생성/매핑 실패 시 프로젝트 채널로 조용히 fallback하지 않고 delivery 실패로 남깁니다. thread 표시 이름은 프로젝트명을 다시 붙이지 않고 사람이 보기 쉬운 `tmuxId`만 우선 사용합니다. `tmuxId`가 없으면 bridge/Codex session id를 사용하고, canonical map key는 visible Codex 세션이면 `lifecycleSessionId`를 우선 사용합니다.
- `BRIDGE_HERMES_CONFIG`, `BRIDGE_HERMES_ALLOWLIST`, `BRIDGE_HERMES_RESTART`, `BRIDGE_HERMES_RESTART_CMD`가 설정되어 있으면 bridge가 Discord fast-path와 Hermes webhook path 모두에서 새 project channel을 Hermes Gateway Discord allowlist에 추가하고 필요할 때만 Gateway restart command를 실행합니다. Session thread는 parent/project channel allowlist를 사용하므로 새 thread ID를 `config.yaml`에 추가하지 않습니다. 이미 등록된 channel은 YAML continuation line까지 검사해 no-op이어야 하며, no-op에서는 `config.yaml` write와 Gateway restart가 없어야 합니다. 긴 env 이름은 더 이상 읽지 않습니다.

예:

```json
{
  "default": "<fallback-channel-id>",
  "projects": {
    "project-name": "<channel-id>"
  },
  "sessionThreads": {
    "<session-id>": {
      "project": "project-name",
      "parentChannelId": "<channel-id>",
      "threadId": "<thread-id>",
      "threadName": "<tmux-id-or-session-id>"
    }
  }
}
```

fallback 채널만 바꾸려면 스크립트를 사용합니다. 이 스크립트는 channel map의 `default`와 systemd env의 fallback 키를 같이 갱신합니다.

```bash
scripts/set-hermes-fallback-channel.sh <fallback-channel-id> --restart
```

## 채널 매핑 등록

Hermes가 기존 프로젝트 채널을 찾으면 아래 API로 bridge map에 등록합니다. 이후 같은 프로젝트 이벤트는 `channel_mapping_status=project`로 전달됩니다.

```bash
PROJECT=project-name
curl -sS -X POST "http://127.0.0.1:3037/projects/$PROJECT/channel" \
  -H 'content-type: application/json' \
  -d '{"channelId":"<project-channel-id>","channelName":"project-name"}'
```

## 자주 보는 문제

### tmux에는 답변이 보이는데 User Command / Session Idle 알림이 없음

증상:

- `codex-*` 세션의 `SessionStart` 또는 `SessionEnd` 알림은 옵니다.
- 같은 tmux pane에는 사용자의 prompt와 최종 답변이 실제로 보입니다.
- bridge `/sessions/:id/events`에는 `SessionStart`만 있고 `CommandSubmitted`/`FinalAnswer`가 없습니다.
- 해당 세션의 `sessionLogPath`가 `null`이거나, `.codex/state/*hud-state.json`의 `turn_count`가 0으로 남습니다.

확인 순서:

```bash
SESSION=codex-...
curl -fsS "http://127.0.0.1:3037/sessions/$SESSION" | jq '{project,tmuxId,status,sessionLogPath,associatedCodexLogs}'
curl -fsS "http://127.0.0.1:3037/sessions/$SESSION/events" | jq '.events[].type'
tmux display-message -pt <tmux-session>:0 '#{session_name}|#{pane_current_path}|#{pane_current_command}|#{pane_pid}'
rg -n '<prompt 일부>|<thread id>|<project path>' ~/.codex/sessions ~/.codex/logs ~/.codex-runs 2>/dev/null
```

원인:

Codex App/remote surface가 연결된 세션에서는 실제 tmux process cwd가 프로젝트여도 Codex rollout JSONL의 `session_meta.cwd`와 native hook payload `cwd`가 `$HOME` 같은 다른 root로 기록될 수 있습니다. 이때 native hook의 `turns-*.jsonl`도 프로젝트 `.codex/logs`가 아니라 `$HOME/.codex/logs`에 생깁니다. bridge는 visible Codex session의 canonical root/run root에 붙은 Codex log만 같은 세션의 `CommandSubmitted`/`FinalAnswer`로 취급하므로, cwd가 갈라진 native thread를 조용히 `codex-*` 세션에 붙이지 않습니다. 잘못 붙이면 다른 열린 Codex thread의 답변이 해당 프로젝트 thread에 `Session Idle`처럼 전송됩니다.

복구/운영:

- `$HOME/.codex/logs/turns-*.jsonl`에 답변이 있으면 Codex hook 자체는 돈 것입니다. 문제는 delivery가 아니라 session reconciliation입니다.
- native thread를 별도 세션으로라도 보고 싶으면 실제 hook cwd root를 `BRIDGE_PROJECT_ROOTS`에 추가할 수 있습니다. 단, 이 방법은 그 native thread를 원래 `codex-*` project session으로 re-label하지 않습니다.
- 프로젝트 thread에 `User Command`/`Session Idle`을 보내려면 Codex가 남기는 `session_meta.cwd`와 native hook `cwd`가 프로젝트 root 또는 Codex run root로 일치해야 합니다. 그렇지 않은 상태에서 bridge가 final을 만들어 보내는 것은 금지합니다.

### Hermes webhook route 404

증상:

```text
Hermes webhook failed: 404 {"error":"Unknown route: codex-bridge"}
```

확인:

```bash
hermes webhook list
ls -l ~/.hermes/webhook_subscriptions.json
curl -sS http://127.0.0.1:8644/health
```

해결: `codex-bridge` subscription을 다시 생성하고 Hermes Gateway를 재시작합니다.

### Discord로 너무 많이 보냄

확인:

```env
BRIDGE_NOTIFY_ENABLED=false
BRIDGE_HERMES_WEBHOOK_MAX_EVENTS_PER_POLL=1
BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer
```

직접 Discord fast-path notifier는 `SessionStart`/`SessionLinked`/`SessionEnd`/`CommandSubmitted`만 처리하고, 별도 `discord-fast` delivery sink로 중복 방지합니다. FinalAnswer/AskPermission은 Hermes webhook sink가 담당합니다. standalone SessionIdle 골격 알림은 보내지 않고, FinalAnswer를 사용자 제목 `Session Idle`로 보냅니다. session thread가 enabled이면 두 sink 모두 같은 session thread로 라우팅합니다.

Hermes 사용자 알림은 제목과 세션 식별 줄을 항상 포함해야 합니다. standalone `SessionIdle` 골격 알림은 보내지 않고, `FinalAnswer` 알림 제목을 `Session Idle`로 렌더링합니다. 긴 `FinalAnswer` 알림은 브리지가 1800자 안전 한도로 여러 조각으로 미리 나누고, 모든 조각 끝에 `(1/N)`, `(2/N)` 같은 순번을 붙이며, 제목/세션 식별 줄은 첫 조각에만 둡니다. 이후 조각은 이어지는 본문과 끝 순번만 보내 `Session Idle` 제목을 반복하지 않습니다. 이미 발행된 `FinalAnswer`는 뒤이은 `User Command` 때문에 stale/dead 처리하지 않고 큐 순서대로 전달합니다. `direct` mode의 긴 FinalAnswer 조각은 Discord bot token과 session thread target이 있으면 bridge가 직접 Discord에 순차 전송합니다. Hermes가 direct 조각 payload를 받은 경우에는 fullText 조각을 그대로 전달하고, `summary` mode에서는 `payload.message_markdown`이 제목/컨텍스트 골격일 수 있으므로 FinalAnswer 본문은 Hermes가 `payload.text_preview`와 필요한 경우 `payload.read_endpoints`를 근거로 작성합니다. Discord는 일반 Markdown table을 표로 렌더링하지 않으므로 bridge fast-path 알림은 table을 정렬된 plain text로 바꿔 code block 안에서 읽히게 합니다. 긴 메시지의 일부 chunk가 실패하면 event는 모든 chunk가 성공하기 전까지 `sent`로 표시하지 않고, 실패 chunk 번호와 `chunkManifest`를 delivery payload/`last_error`에 남깁니다. 단, Discord에 이미 게시된 앞 chunk를 회수할 수는 없습니다. 사용자가 원문 그대로를 요청한 경우에는 `/sessions/:id/idle/latest`의 `fullText`를 그대로 전달합니다. 이벤트 알림 자체가 사용자 출력이므로 `완료`, `discord에 보냈어`, `direct 모드라 보냈어`, `알림 렌더링 완료`, `요약을 보냈고`, `message_id` 같은 별도 전송확인 메시지를 추가로 보내지 않습니다.

```text
# Session Idle
**session:** `codex-bridge-102122`
**tmux:** `codex-bridge-102122` | **project:** `hermes-codex-bridge`
```

### 세션은 있는데 tmux 주입 실패

- `/sessions`에서 `tmuxId` 또는 `tmuxPaneId`가 있는지 확인합니다.
- team/swarm/live pane UX는 `mode: "tmux"`를 사용합니다.
- command dispatch의 production 기본값은 `auto`이며, 현재 `auto`는 tmux backend를 직접 선택합니다. `mode: "codex"`는 지원하지 않으며 `mode-codex-unsupported`로 명시 실패해야 합니다.

### Discord 버튼/선택 UX가 동작하지 않음

- `AskPermission` 알림 payload에 `approval_actions`, `component_actions`, `discord_components`가 있는지 확인합니다.
- Hermes Gateway가 Discord component interaction callback을 받고 있는지 확인합니다.
- 버튼 클릭은 일반 채팅 메시지가 아니라 `approval_actions[].endpoint`/`body`로 bridge에 전달되어야 합니다.
- Deep Interview 선택은 먼저 `/sessions/:id/questions`에 canonical question이 등록되어 있어야 하고, 이후 `/sessions/:id/question-answers`에 `questionId`, `answer.kind`, `selected_values`, 필요 시 `other_text`를 보내야 합니다.
- `/question-answers` 응답의 `queued`는 bridge queue 접수 상태입니다. 실제 질문 renderer가 소비하기 전까지 완료로 표시하지 않습니다.
- 만료되었거나 중복된 Discord interaction은 bridge가 명시 실패 또는 idempotent duplicate로 처리해야 하며, raw tmux 방향키 fallback으로 조용히 전환하면 안 됩니다.

### bridge가 죽었다 살아난 뒤 복구

bridge는 Codex JSONL/Codex logs/tmux list에서 다시 index를 만듭니다. 살아있는 tmux session과 Codex log가 있으면 재연결됩니다.

## 안전성

- 로컬-only는 `HOST=127.0.0.1` 권장.
- LAN/Docker/reverse proxy/public bind면 `BRIDGE_TOKEN` 필수.
- webhook secret과 Discord webhook URL은 repo에 커밋하지 않습니다.
- `.env`, `~/.config/hermes-codex-bridge/*.env`, secret files는 로컬 운영 파일입니다.
