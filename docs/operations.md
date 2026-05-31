# Operations — hermes-codex-notify

이 문서는 설치 후 운영자가 자주 확인하는 항목만 남긴 runbook입니다. 설치 절차는 `INSTALL.md`, 상세 설계/edge case는 `docs/internals.md`를 봅니다.

## 1. 서비스 확인

`hermes-codex-notify`는 기본적으로 **systemd user service**입니다. system-wide `systemctl`이 아니라 `--user`를 붙입니다.

```bash
systemctl --user status hermes-codex-notify.service --no-pager
systemctl --user status hermes-gateway.service --no-pager
journalctl --user -u hermes-codex-notify.service -f
journalctl --user -u hermes-gateway.service -f
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:8644/health
```

실행 경로는 단순합니다.

```text
hermes-codex-notify.service
  -> npm start
  -> node src/server.js
  -> http://127.0.0.1:3037
```

## 2. 핵심 운영 파일

| 대상 | 위치/명령 |
| --- | --- |
| service env | `systemctl --user cat hermes-codex-notify.service` |
| bridge state | `~/.local/state/hermes-codex-notify/` |
| project channel map | `~/.config/hermes-codex-notify/project-channels.json` |
| Hermes webhook subscription | `~/.hermes/webhook_subscriptions.json` |
| Hermes notify skill | `skills/hermes-codex-notify/SKILL.md` |
| helper CLI source | repository's `bin/` |

## 3. 권장 env 표면

런타임 env에는 “켜는 기능/비밀/ID”만 둡니다. 나머지 기본값은 코드와 installer가 소유합니다.

```env
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/codex-notify
BRIDGE_HERMES_WEBHOOK_SECRET=<shared secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback channel id>

BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<Hermes/Discord bot token>
BRIDGE_DISCORD_GUILD_ID=<Discord guild/server id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
DISCORD_ALERT_CHANNEL_ID=<operator alert channel id>

BRIDGE_HERMES_ALLOWLIST=true
CODEX_EFFORT=high
```

선택값:

- `BRIDGE_DISCORD_MENTION_USERS=<Discord user id>[,<Discord user id>...]`: 최초 `SessionStart`에만 user mention을 붙입니다.
- `BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true`: mapping 전 diagnostic 알림까지 보고 싶을 때만 켭니다.
- `BRIDGE_HERMES_WEBHOOK_INTERVAL_MS=3000`: 호출 빈도를 낮추고 싶을 때 조정합니다.

## 4. Helper CLI 경계

`codex-new`, `codex-send`, `codex-kill`의 source of truth는 repository's `bin/`입니다. 설치/갱신은 아래 명령만 사용합니다.

```bash
scripts/install-codex-cli.sh --force
scripts/install-hermes-stack.sh --non-interactive
scripts/install-hermes-stack.sh --skip-cli
```

자주 쓰는 예시는 아래입니다. 정식 계약은 `bin/README.md`와 각 CLI의 `--help`가 소유하며, 이 문서는 helper SSoT가 아닙니다.

```text
codex-new [PROJECT_DIR] [--name SESSION] [--attach] [--json] [--no-check] [-- CODEX_ARGS...]
codex-send --session SESSION_ID [--dry|--dry-run] [--hold|--no-submit] '<prompt>'
codex-send --session <bridgeSessionId> --discord-approval '<prompt>'
codex-kill --session SESSION_ID
```

Hermes가 visible session을 만들 때는 raw `codex` 직접 실행 대신 `codex-new`를 사용합니다. `codex-new`가 bridge-owned tmux session과 순정 `codex --dangerously-bypass-approvals-and-sandbox` 실행을 구성합니다. reasoning effort는 모델 인자가 아니라 `CODEX_EFFORT=high|xhigh|medium` env로 설정합니다. 운영 규칙에서 `--tmux`, `--direct`, hook disable 옵션을 기본값처럼 추가하지 않습니다.

## 5. Hermes 규칙 주입 위치

런타임 규칙은 아래 파일들이 나눠 가집니다.

- `scripts/install-hermes-stack.sh`: `subscription_prompt` 원본입니다. 설치 후 `~/.hermes/webhook_subscriptions.json`에 저장됩니다.
- `skills/hermes-codex-notify/SKILL.md`: bridge read/status/notification rendering 규칙입니다.
- `skills/codex-new/SKILL.md`: 새 Codex-owned lifecycle session 생성 규칙입니다.
- `skills/codex-send/SKILL.md`: 기존 session 전달 규칙입니다. prompt refinement SSoT이므로 의미 보존, routing metadata 제거, Discord approval flow를 여기에서만 바꿉니다.
- `skills/codex-kill/SKILL.md`: session 종료 규칙입니다.
- `src/hermes-webhook-sink.js`: `AskPermission`/`FinalAnswer` payload와 native-only 필터 경계입니다.
- `src/server.js`: `POST /sessions/:id/commands`, approval question, `CommandSubmitted` / `User Command` event 경계입니다.

`subscription_prompt`를 바꾼 뒤에는 Hermes skill 재설치, `~/.hermes/webhook_subscriptions.json` 갱신, `hermes-gateway.service` 재시작까지 확인해야 새 webhook run에 반영됩니다.

## 6. 알림/라우팅 요약

- `SessionStart`, `SessionLinked`, `SessionEnd`, `CommandSubmitted`: direct Discord fast-path.
- `AskPermission`, `FinalAnswer`: Hermes webhook path. 사용자 제목은 `FinalAnswer`라도 `Session Idle`로 보일 수 있습니다.
- `BRIDGE_HERMES_NOTIFICATION_MODE=direct`: Codex fullText를 bridge가 직접 조각내 전송합니다. 기본값입니다.
- `BRIDGE_HERMES_NOTIFICATION_MODE=summary`: Hermes가 구조화 payload를 요약합니다.
- session thread가 켜져 있으면 fast-path와 webhook path 모두 같은 `sessionThreads` map을 사용합니다.
- reply의 “이 세션/이거/방금 알림”은 알림 payload의 `bridge_session_id`를 뜻합니다. project 최신 세션으로 추정하지 않습니다.
- `/new`와 `/resume`은 Codex slash command입니다. 기존 pane에 전달하는 경우 `codex-send`가 원문 의미를 보존해 그대로 보냅니다.

## 7. 채널 매핑

프로젝트 채널은 프로젝트명 기준입니다. 매핑이 없으면 bridge가 Discord API로 기존 채널을 찾고, 권한이 있으면 생성/매핑합니다. 실패하면 project map을 조용히 오염시키지 않고 관측 가능한 실패로 남깁니다.

```bash
PROJECT=project-name
curl -sS -X POST "http://127.0.0.1:3037/projects/$PROJECT/channel" \
  -H 'content-type: application/json' \
  -d '{"channelId":"<project-channel-id>","channelName":"project-name"}'
```

fallback 채널만 바꿀 때:

```bash
scripts/set-hermes-fallback-channel.sh <fallback-channel-id> --restart
```

`BRIDGE_HERMES_CONFIG`, `BRIDGE_HERMES_ALLOWLIST`, `BRIDGE_HERMES_RESTART`, `BRIDGE_HERMES_RESTART_CMD`가 있으면 새 project channel을 Hermes Gateway Discord allowlist에 추가합니다. allowlist write/restart의 no-op 세부 규칙은 `docs/internals.md`가 설명합니다.

## 8. 자주 보는 문제

### webhook route 404

```text
Hermes webhook failed: 404 {"error":"Unknown route: codex-notify"}
```

```bash
hermes webhook list
ls -l ~/.hermes/webhook_subscriptions.json
curl -sS http://127.0.0.1:8644/health
scripts/install-hermes-stack.sh --webhook --non-interactive --restart
```

### Discord로 너무 많이 보냄

```env
BRIDGE_NOTIFY_ENABLED=false
BRIDGE_HERMES_WEBHOOK_MAX_EVENTS_PER_POLL=1
BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer
```

`Commentary`는 기본 사용자 알림에서 제외되어야 합니다. 중간 진행 알림이 꼭 필요할 때만 일시적으로 event types에 추가합니다.

### session은 있는데 답변 알림이 없음

```bash
SESSION=codex-...
curl -fsS "http://127.0.0.1:3037/sessions/$SESSION/state"
curl -fsS "http://127.0.0.1:3037/sessions/$SESSION/events" | jq '.events[].type'
tmux display-message -pt <tmux-session>:0 '#{session_name}|#{pane_current_path}|#{pane_current_command}|#{pane_pid}'
```

`sessionLogPath`가 없거나 Codex log의 `cwd`가 프로젝트 root와 다르면 bridge는 다른 native thread의 답변을 이 session에 억지로 붙이지 않습니다. 이 경우는 `docs/internals.md`의 session reconciliation section을 확인합니다.

### tmux 주입 실패

- `/sessions`에서 `tmuxId` 또는 `tmuxPaneId`가 있는지 확인합니다.
- production 기본 dispatch mode는 `auto`이고 현재는 tmux backend를 직접 선택합니다.
- `mode: "codex"`는 지원하지 않으며 `mode-codex-unsupported`로 명시 실패해야 합니다.

### Discord 버튼/선택 UX 실패

- `AskPermission` payload에 `approval_actions`, `component_actions`, `discord_components`가 있는지 확인합니다.
- `codex-send --session <id> --answer-approval send|reject --question-id <questionId>`로 answer가 들어가는지 확인합니다.
- 만료/중복 interaction은 명시 실패 또는 idempotent duplicate로 처리해야 합니다. raw tmux 방향키 fallback으로 조용히 전환하지 않습니다.

## 9. 보안

- 기본 bind는 `HOST=127.0.0.1`을 유지합니다.
- Docker/LAN/reverse proxy/public 노출이면 `BRIDGE_TOKEN`을 필수로 둡니다.
- webhook secret, bot token, channel/user ID가 들어간 운영 env 파일은 commit하지 않습니다.
- `.env`, `~/.config/hermes-codex-notify/*.env`, secret files는 로컬 운영 파일입니다.
