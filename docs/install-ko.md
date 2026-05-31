# Install — 다른 PC / 다른 Hermes Agent에 붙이기

영어 기본 문서는 [`docs/install.md`](install.md)입니다.

권장 설치는 `install-hermes-stack.sh --webhook`로 helper CLI, bridge service, Hermes skill, Hermes Gateway webhook subscription을 함께 맞추는 것입니다. `--webhook` 없는 agent bridge-only 모드는 자동 push 알림 없이 Hermes가 bridge API를 직접 조회하는 최소 설치 모드입니다.

> AgentMemory/CodeGraph 없이 bridge와 Hermes/Discord 알림만 설치하려면 `docs/bridge-hermes-only-install-ko.md`를 사용하세요.

## 1. 사전 조건

의존성 기준:

- Node.js **20+** / npm: bridge server 실행, package 설치, test에 필요합니다.
- `tmux`: visible OMX/Codex session과 `omx-new` / `omx-kill`에 필요합니다.
- `curl`: health check, 설치 검증, helper CLI의 bridge HTTP 호출에 필요합니다.
- `jq`: bridge JSON을 읽거나 JSON payload를 만드는 helper CLI에 필요합니다. 특히 `omx-send`와 `omx-kill`은 `jq`가 없으면 실행을 중단하므로, helper CLI를 `PATH`에 설치하는 모드에서는 필수로 봅니다.
- Hermes Gateway: webhook/Discord push delivery를 켤 때만 필요합니다. agent bridge-only 모드는 Gateway 없이도 설치할 수 있습니다.

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service
curl -sS http://127.0.0.1:8644/health
```

권장 webhook sink 모드에서는 Hermes Gateway webhook platform이 필요합니다. Gateway에 아래 env가 있어야 하며, `WEBHOOK_SECRET`은 bridge secret과 같아야 합니다.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<scripts/install-hermes-stack.sh가 만든 secret 파일 값과 동일>
```

> 스크립트는 `--webhook` 모드에서 Hermes subscription을 만들지만, Hermes Gateway service env는 자동 수정하지 않습니다. Gateway env 위치가 설치마다 다르기 때문입니다.

## 2. 원커맨드 설치

```bash
git clone https://github.com/chiznoir/hermes-omx-notify.git
cd hermes-omx-notify
npm test
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --channel <fallback-discord-channel-id> \
  --project hermes-omx-notify=<project-discord-channel-id> \
  --restart
```

위 명령의 channel ID는 실제 Discord 환경에 맞게 바꿉니다. agent bridge-only 최소 설치가 필요하면 `--webhook` 없이 실행할 수 있지만, 그 경우 Hermes 자동 push 알림은 오지 않습니다.

Hermes config를 찾을 수 있으면 installer는 아래 짧은 env를 bridge service에 씁니다.

```env
BRIDGE_HERMES_CONFIG=~/.hermes/config.yaml
BRIDGE_HERMES_ALLOWLIST=true
BRIDGE_HERMES_RESTART=true
BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service
```

`BRIDGE_HERMES_ALLOWLIST=true`는 새로 매핑된 project channel을 Hermes Gateway Discord allowlist에 추가합니다. Session thread는 parent/project channel allowlist를 사용하며 thread ID를 별도 추가하지 않습니다. 이미 등록된 채널은 YAML continuation line까지 포함해 검사하므로 no-op이어야 하며, 이 경우 Gateway restart가 발생하면 안 됩니다.

생성/사용 파일:

```text
~/.local/bin/omx-new
~/.local/bin/omx-send
~/.local/bin/omx-kill
~/.config/hermes-omx-notify/hermes-omx-notify.env
~/.hermes/skills/autonomous-ai-agents/hermes-omx-notify/SKILL.md
~/.config/systemd/user/hermes-omx-notify.service

# --webhook 사용 시에만 추가
~/.config/hermes-omx-notify/hermes-webhook.secret
~/.config/hermes-omx-notify/project-channels.json
~/.hermes/webhook_subscriptions.json
```

기본값은 `--scope user`입니다. 즉 `/etc/systemd/system` 아래 system service가 아니라
`~/.config/systemd/user/hermes-omx-notify.service`에 설치됩니다. 확인/재시작도
항상 `systemctl --user ...`를 사용하세요. 서비스 파일의 실행 명령은
`ExecStart=<npm 경로> start`이고, `package.json`의 `start` script가
`node src/server.js`를 실행합니다.

## 3. Helper CLI만 수동 설치

전체 stack이 아니라 CLI만 설치해야 하면 repository의 `bin/`에서 설치합니다.

```bash
bin/install.sh --force
# 또는
scripts/install-omx-cli.sh --force
command -v omx-new omx-send omx-kill
```

이 installer는 Codex global hook을 수정하지 않습니다.


## 4. LAN/Docker/Reverse proxy에 노출하는 경우

로컬 `127.0.0.1` 전용이면 token 없이도 괜찮습니다. 다른 host/container에서 접근하면 token을 켜세요.

```bash
mkdir -p ~/.config/hermes-omx-notify
openssl rand -hex 32 > ~/.config/hermes-omx-notify/bridge.token
chmod 600 ~/.config/hermes-omx-notify/bridge.token

scripts/install-hermes-stack.sh \
  --token-file ~/.config/hermes-omx-notify/bridge.token
```

Hermes Gateway 쪽에도 같은 token을 설정합니다.

```env
OMX_BRIDGE_URL=http://127.0.0.1:3037
OMX_BRIDGE_TOKEN=<bridge.token 값>
```

## 5. 확인

```bash
systemctl --user list-units --type=service --all | grep hermes-omx-notify
systemctl --user status hermes-omx-notify.service
systemctl --user cat hermes-omx-notify.service
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v omx-new omx-send omx-kill
curl -sS http://127.0.0.1:8644/health
```

Discord/Hermes에서:

```text
hermes-omx-notify로 bridge health와 sessions를 확인해줘.
```

## 6. env 복잡도 기준

런타임 env file은 기본값을 반복하지 않고 “운영자가 켠 기능과 비밀/ID”만 남겨야 합니다. `scripts/install-systemd-service.sh`와 `scripts/install-hermes-stack.sh`도 이 기준으로 systemd env를 생성합니다. 사람이 직접 편집할 때는 `.env.example`을 샘플로 보되, 주석 처리된 값 중 필요한 것만 풀어 쓰세요.

### 필수/권장 env

```env
# bridge를 LAN/Docker/reverse proxy/public으로 노출할 때만 필요
# OMX_BRIDGE_TOKEN=<random-long-token>

# Hermes webhook sink를 켤 때 필수
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/omx-notify
BRIDGE_HERMES_WEBHOOK_SECRET=<secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-channel-id>

# Discord fast-path/session thread를 쓸 때 필수/권장
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<Discord bot token>
BRIDGE_DISCORD_GUILD_ID=<Discord guild id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true

# Hermes Gateway allowlist 자동 갱신을 쓸 때 권장
BRIDGE_HERMES_ALLOWLIST=true
```

`BRIDGE_STATE_ROOT`는 기본값이 있지만, system service처럼 HOME이 불분명하거나 state 위치를 고정해야 하는 운영에서는 명시해도 됩니다. 이 값은 SQLite/큐/감사 로그 저장 위치일 뿐 프로젝트 루트가 아닙니다.

### 보통 생략하는 기본값

- `HOST=127.0.0.1`, `PORT=3037`, `BRIDGE_PUBLIC_URL=http://127.0.0.1:3037`
- `BRIDGE_STATE_ROOT=~/.local/state/hermes-omx-notify` user service 기준
- `BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer`
- `BRIDGE_HERMES_NOTIFICATION_MODE=direct`
- `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-omx-notify/project-channels.json`
- `BRIDGE_NOTIFY_EVENT_TYPES=SessionStart,SessionLinked,SessionEnd,CommandSubmitted`
- `BRIDGE_NOTIFY_DELIVERY_SINK=discord-fast`
- `BRIDGE_FINAL_BLOCK=true`, `BRIDGE_FINAL_WAIT_MS=10000`, `BRIDGE_FINAL_SINK=hermes`
- `BRIDGE_HERMES_RESTART=true`, `BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service`
- `BRIDGE_DISCOVERED_PROJECT_ROOT_MAX=8`, `BRIDGE_MADMAX_RUN_MAX=8`, `BRIDGE_MADMAX_RUN_LOOKBACK_HOURS=12`, `BRIDGE_CODEX_CWD_ATTACH_SCAN_LIMIT=30`

poll 기본값은 빠른 알림 기준입니다: `BRIDGE_HERMES_WEBHOOK_INTERVAL_MS=250`, `BRIDGE_NOTIFY_INTERVAL_MS=100`, 각 poll 최대 3개. CPU/Discord 호출을 줄이고 싶을 때만 3000ms처럼 늘리세요. 초과 이벤트를 버리는 값이 아니라 poll 주기입니다.

알림 정책:
- Discord fast-path는 같은 세션의 이전 `FinalAnswer`/`AskPermission`이 `BRIDGE_FINAL_SINK`에서 아직 끝나지 않았으면 뒤 `User Command`를 보류합니다. `BRIDGE_FINAL_WAIT_MS`는 delivery row가 아직 안 생긴 경우의 짧은 대기 시간입니다.

- standalone `SessionIdle` 골격 알림은 기본 사용자 알림으로 보내지 않습니다.
- `FinalAnswer`는 이벤트 타입은 유지하고 사용자 제목은 `Session Idle`로 보냅니다. standalone `SessionIdle` 골격 이벤트와 구분하기 위해 전송 판단은 계속 `FinalAnswer` 타입을 사용합니다.
- 이미 발행된 `FinalAnswer`/`AgentResponse`는 같은 세션에서 더 늦은 `User Command`가 관측되더라도 stale로 버리지 않고, 큐에 들어온 순서대로 delivery 대상에 남깁니다.
- 긴 `FinalAnswer` 알림이 Discord 제한 때문에 여러 메시지로 나뉘면 모든 조각 끝에 `(i/N)` 순번을 붙이고, 제목과 세션 컨텍스트는 첫 조각에만 표시합니다.
- Discord fast-path post는 기본 3초 timeout과 3회 retry로 bounded 처리합니다. `5xx`/network/timeout은 retry, `401`/`403`/`404`와 기타 `4xx`는 빠르게 `dead`, 짧은 `429 Retry-After`는 잠깐 기다렸다 retry, 긴 `Retry-After`는 FIFO 보존을 위해 hold합니다. `dead`는 조용한 누락이 아니라 event index에 `last_error`/`retry_count`를 남기는 명시적 실패입니다.
- `DISCORD_ALERT_CHANNEL_ID`를 설정하면 post 실패로 `dead`가 된 이벤트의 이유를 기존 `BRIDGE_DISCORD_BOT_TOKEN`으로 운영 채널에 알립니다.
- Discord는 일반 Markdown table을 표로 렌더링하지 않으므로 fast-path 알림은 table을 정렬된 plain text로 변환합니다. multi-chunk 알림은 모든 chunk가 성공하기 전까지 `sent`가 아니며, 실패 시 chunk manifest와 실패 chunk 번호를 기록합니다.

사용자가 “원문 알려줘”, “마지막 답변 원문”, “원문 그대로”, “raw”, “full text”, “latest idle 원문”을 명시한 경우에는
`summary` 알림 규칙보다 원문 relay 규칙이 우선합니다. Hermes는
`/sessions/:id/idle/latest`의 `fullText`를 그대로 보내야 하며, 원문 전체를
삼중 백틱 markdown 코드블럭으로 다시 감싸면 안 됩니다.
