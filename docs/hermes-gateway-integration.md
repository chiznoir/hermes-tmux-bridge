# Hermes Gateway ↔ hermes-omx-notify 연결 가이드

이 문서는 Hermes Gateway와 `hermes-omx-notify`를 연결하는 운영 가이드입니다. 빠른 설치는 [`docs/quickstart-ko.md`](quickstart-ko.md)를 먼저 보세요.

## 결론

새 Discord bot은 필요 없습니다. 기존 Hermes Gateway/Discord bot을 사용합니다.

```text
Discord user
  -> Hermes Gateway / Discord bot
  -> hermes-omx-notify skill
  -> hermes-omx-notify HTTP API
  -> Codex/OMX/tmux session
```

자동 알림/요약은 아래 흐름을 권장합니다.

```text
hermes-omx-notify event router
  -> Hermes webhook sink
  -> POST /webhooks/omx-notify
  -> Hermes agent summary/judgement
  -> Discord project channel
```

## 권장 설정

### Bridge service

기본값은 runtime env에 쓰지 않습니다. 아래는 webhook/Discord thread 운영에 필요한 값만 남긴 예시입니다.

```env
# Hermes webhook sink
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/omx-notify
BRIDGE_HERMES_WEBHOOK_SECRET=<shared secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback Discord channel id>

# Discord fast-path/session thread
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<Discord bot token>
BRIDGE_DISCORD_GUILD_ID=<Discord guild id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true

# Hermes Gateway allowlist 자동 갱신
BRIDGE_HERMES_ALLOWLIST=true

# 선택: 고정 scan root가 필요한 non-tmux 환경에서만 지정.
# 일반 설치는 live tmux OMX project root를 자동 발견한다.
# PROJECT_ROOT=/path/to/fixed-omx-project

# 로컬-only면 unset. LAN/Docker/public이면 필수.
# OMX_BRIDGE_TOKEN=<random-long-token>
```

생략하는 기본값: `HOST=127.0.0.1`, `PORT=3037`, `BRIDGE_PUBLIC_URL=http://127.0.0.1:3037`, `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-omx-notify/project-channels.json`, `BRIDGE_HERMES_NOTIFICATION_MODE=direct`.

### Hermes Gateway

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same shared secret>

OMX_BRIDGE_URL=http://127.0.0.1:3037
# bridge token을 쓰는 경우에만 설정
# OMX_BRIDGE_TOKEN=<bridge token>
```

Hermes webhook subscription은 `scripts/install-hermes-stack.sh`의 `subscription_prompt`로 설치합니다.

```bash
scripts/install-hermes-stack.sh --webhook --restart --non-interactive
```

수동 `hermes webhook subscribe`가 필요하면 `scripts/install-hermes-stack.sh`의 현재 `subscription_prompt` 내용을 사용하세요. 현재 subscription은 `hermes-omx-notify,omx-new,omx-send,omx-kill` 네 skill을 함께 로드하며, prompt에는 `CommandSubmitted`/`User Command` 원문 알림, `FinalAnswer` 요약/direct 전달, 긴 `FinalAnswer` 분할 시 첫 조각만 제목을 표시하고 모든 조각 끝에 `(i/N)`을 붙이는 규칙, `원문 그대로` 예외, Discord-originated dispatch의 `omx-send --discord-approval` + Hermes `clarify` 승인 카드 gate, 그리고 생성/전달/종료 intent를 각각 `omx-new`, `omx-send`, `omx-kill`로 넘기는 경계 규칙이 포함됩니다. `omx-send` 전달 프롬프트의 routing metadata/payload instruction 분리와 의미 보존형 실행 지시 정제 규칙은 `skills/omx-send/SKILL.md`에 정리되어 있습니다.

## Project channel map

```json
{
  "default": "<fallback-channel-id>",
  "projects": {
    "hermes-omx-notify": "<channel-id>"
  }
}
```

- 매핑이 있으면 해당 채널 사용.
- 매핑이 없으면 bridge가 `BRIDGE_DISCORD_BOT_TOKEN`/`BRIDGE_DISCORD_GUILD_ID`로 `desired_channel_name` 기존 채널을 찾고, 없으면 권한이 허용될 때 생성/매핑한다.
- 프로젝트 채널 자동 생성/자동 매핑은 bridge 기본 동작이다. `scripts/install-hermes-stack.sh`는 Hermes `~/.hermes/.env`의 `DISCORD_BOT_TOKEN`과 `DISCORD_HOME_CHANNEL`/fallback channel에서 이 값을 자동 매핑한다. 끄려면 `BRIDGE_HERMES_AUTO_CREATE_CHANNELS=false`.
- Hermes Gateway Discord allowlist 자동 반영은 `BRIDGE_HERMES_CONFIG`, `BRIDGE_HERMES_ALLOWLIST`, `BRIDGE_HERMES_RESTART`, `BRIDGE_HERMES_RESTART_CMD` 설정을 사용한다. bridge는 `config.yaml`의 긴 scalar allowlist가 YAML continuation line으로 접혀도 전체 값을 검사한다. 이미 등록된 project channel은 no-op이어야 하며 Gateway restart를 실행하지 않는다. Session thread는 parent/project channel allowlist를 사용하므로 thread ID를 별도 allowlist 항목으로 추가하지 않는다.
- 브랜치는 채널명에 넣지 않고 메시지 메타로 표시하는 것을 권장.

## 설치 명령 요약

Webhook sink 원커맨드:

```bash
scripts/install-hermes-stack.sh --webhook --restart
```

수동 bridge service:

```bash
scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --sink \
  --sink-url http://127.0.0.1:8644/webhooks/omx-notify \
  --sink-secret-file ~/.config/hermes-omx-notify/hermes-webhook.secret \
  --channel <fallback-channel-id> \
  --map ~/.config/hermes-omx-notify/project-channels.json
```

수동 helper CLI와 Hermes skill:

```bash
scripts/install-omx-cli.sh --force
scripts/install-hermes-skill.sh
systemctl --user restart hermes-gateway.service
systemctl --user restart hermes-omx-notify.service
```

## 연결 확인

```bash
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
curl -sS http://127.0.0.1:8644/health
hermes webhook list
```

Signed route smoke는 허용되지 않은 event type으로 보내 agent run 없이 route/HMAC만 확인할 수 있습니다.

## Hermes가 수행할 일

Hermes는 `hermes-omx-notify` skill을 통해 다음을 수행합니다.

- `omx-send --list`로 세션 목록 확인
- `GET /sessions/:id/events`로 timeline 확인
- `GET /sessions/:id/idle/latest`로 최신 assistant 원문 확인
- `GET /sessions/:id/interactions`로 명령/응답 이력 확인
- `omx-send --session <id>`로 후속 지시 전달
- Discord에서 정제 프롬프트 전송 전 operator 승인이 필요하면 `omx-send --session <id> --discord-approval` 사용
- `omx-new`로 새 visible OMX 세션 시작
- `omx-kill`로 OMX/tmux 세션 종료

Trigger 문구는 일반 대화가 아니라 도구 호출로 라우팅합니다. 알림 reply의 “이 세션/이거/방금 알림”은 reply payload의 `bridge_session_id`를 우선하며 project 최신 세션으로 추정하지 않습니다. reply에 `전달`/`보내`/`넘겨`/`세션에 넣어`가 들어가면 설명/조회보다 `omx-send --session <bridge_session_id>`가 최우선입니다. Discord-originated Hermes 전달에서 operator가 정제 프롬프트를 먼저 보고 전송/거절/추가수정을 선택해야 하면 `--discord-approval`을 붙인 뒤 Hermes `clarify`/AskUserQuestion으로 실제 Discord 승인 카드를 띄웁니다. 반영/수정/재시도/진행/계속/위 내용/답장 관련 reply(예: “답장하기”, “위 내용 전달”, “이거 반영”, “답장으로 보낸 거”, “방금 알림에 대한 말”)도 `전달해`가 없어도 `omx-send`; “이건 뭐냐”, “궁금한데” 같은 단순 설명 요청은 dispatch 단어가 없을 때만 Hermes가 read endpoint로 확인해 설명; reply의 “종료/kill/킬/죽여”는 `omx-kill --session <bridge_session_id>`; “원문 알려줘”, “마지막 답변 원문”, “raw”, “full text”는 `/sessions/:id/idle/latest` `fullText`; “세션 열려있어?”, “세션 살아있어?”, “현재 세션 확인”은 `omx-send --list` 또는 `/sessions/:id/state`; “최근 로그/이벤트”는 `/sessions/:id/events`; “내가 보낸 이력/명령 이력”은 `/sessions/:id/interactions`; 사용자가 새 visible 세션을 직접 요청한 “새 세션”, “세션 열어”, “시작해”만 `omx-new`를 사용합니다. bridge webhook `SessionStart` 알림 본문은 새 세션 트리거가 아닙니다. `/new`/`/resume`은 Hermes/Gateway 명령이 아니라 Codex 입력 slash command로 구분합니다. 기존 OMX/Codex tmux pane에 보내는 `/new`/`/resume`은 `omx-send --session <bridge_session_id>`로 원문 그대로 전달하고, bridge가 이후 새 Codex session id를 감지해 기존 tmux/bridge session mapping을 새 Codex mapping으로 따라가게 해야 합니다. 일반 승인/거절은 AskPermission이 실제로 있을 때만 다룹니다.

처음 바인딩한 세션에는 `omx-send --dry` 또는 `omx-send --dry-run`을 먼저 보내고, live tmux 화면에 보여야 하는 지시는 `omx-send --mode tmux`를 사용합니다. 세션 시작/전달/종료 작업은 Hermes가 터미널에서 bridge API용 `curl -X POST ...`를 직접 만들지 않고 위 helper CLI를 사용해야 합니다. `omx-send` 성공 후 사용자에게 보고할 때는 프롬프트 원문을 별도 확인 메시지로 재출력하지 않습니다. 입력 원문은 bridge의 `CommandSubmitted`/`User Command` 이벤트 알림으로 남습니다.

Helper CLI는 이 repository의 `bin/` 기준입니다. `scripts/install-hermes-stack.sh`가 기본으로 `omx-new`/`omx-send`/`omx-kill`을 `PATH`에 설치하며, CLI만 설치하려면 `scripts/install-omx-cli.sh --force`를 사용합니다. 이 CLI installer는 Codex global hook을 수정하지 않습니다. `omx-new`는 현재 `omx-new [PROJECT_DIR] [--name SESSION] [--attach] [--direct] [--json] [--runs PATH] [--no-check] [-- OMX_ARGS...]` 형태이며 기본 모드에서는 native tmux 세션 안에서 `omx --madmax --high`를 실행합니다. 명시적 `--direct`/`-d` 지정 시 tmux 세션을 만들지 않고 현재 터미널에서 `omx --direct --yolo`를 실행하며, `--attach`/`-a`, `--name`, `--json`과 함께 사용할 수 없습니다. Hermes가 raw `omx --madmax --high`를 직접 실행하거나 기본으로 `--tmux`/`--direct`/`--disable codex_hooks`를 붙이지 않도록 유지합니다.

## Discord interaction UX

`AskPermission` payload에는 `approval_actions`, `component_actions`, `discord_components`가 포함될 수 있습니다. Hermes Gateway가 Discord component interaction을 지원하면 `/approve`, `/deny`, `/approve session`, `/approve always`를 버튼으로 렌더링하고, 클릭 시 해당 action의 `endpoint`와 `body`를 그대로 bridge에 전달합니다. `/approve always`는 danger 스타일 또는 2차 확인을 권장합니다.

`omx-send --discord-approval`은 `POST /sessions/:id/commands`에 `approvalGate: "discord-hermes-omx-send"`를 붙입니다. bridge는 tmux dispatch 전에 `kind: "omx-send-approval"` structured question을 등록하고 `202 approval-pending`과 `component_actions`/`discord_components`를 반환합니다. 이 JSON은 bridge/API 응답이며 Hermes Gateway가 terminal-tool 결과에서 자동으로 버튼을 렌더링하지 않습니다. Hermes agent가 `clarify`/AskUserQuestion을 호출해야 Discord native 카드가 뜹니다. 선택 후 Hermes는 `omx-send --session <id> --answer-approval send|reject --question-id <questionId>` 또는 추가수정 재정제를 사용해 `/sessions/:id/question-answers`에 제출합니다. 전송은 bridge decision log의 `send_claimed` marker 후 exact-once로 dispatch되며, 거절/추가수정은 tmux로 보내지지 않습니다.

Deep Interview 같은 구조화 질문은 tmux 방향키 대신 bridge structured question/answer endpoints를 사용합니다. 먼저 bridge/OMX 쪽 question을 등록한 뒤 answer를 제출해야 합니다.

```http
POST /sessions/:id/questions
POST /sessions/:id/question-answers
```

`single-answerable`은 버튼/String Select, `multi-answerable`은 multi-select, `allow_other: true`는 Discord modal/text input으로 렌더링합니다. 직접 입력값은 `other_text`로 별도 보존해야 하며 predefined option value로 덮어쓰면 안 됩니다. answer 제출은 renderer/consumer 처리 전까지 `queued` 상태이며, Hermes는 이를 “완료”가 아니라 “bridge queue에 접수됨”으로 표시해야 합니다.

## clawhip 의존성

브리지는 `clawhip`을 필수 의존성으로 사용하지 않습니다.

- 세션/응답 원문: Codex JSONL + OMX logs/hooks
- 명령 주입: tmux CLI. Codex App Server command adapter는 production 전달 경로에서 제거되어 `mode: "codex"`가 unsupported로 실패한다.
- 자동 알림: Hermes webhook sink

`clawhip`은 `omxx` 런처가 tmux 세션을 만들 때 선택적으로 사용할 수 있지만 bridge control plane과 webhook sink는 clawhip 없이 동작합니다.
