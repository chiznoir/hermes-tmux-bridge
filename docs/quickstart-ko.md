# Quick Start — Hermes Codex Bridge

영어 기본 문서는 [`docs/quickstart.md`](quickstart.md)입니다.

이 문서는 이미 Hermes Gateway와 Discord bot이 있는 self-host 환경에서 `hermes-codex-bridge`를 빠르게 붙이는 절차입니다. Hermes/에이전트용 단일 runbook은 repository root의 `INSTALL.md`입니다.

Bridge와 Hermes/Discord 알림만 설치하는 agent용 runbook은 `docs/bridge-hermes-only-install-ko.md`입니다.

## 0. 권장 구조

```text
codex / Codex / tmux
  -> hermes-codex-bridge
     -> Hermes Gateway webhook sink
  -> Hermes subscription `codex-bridge` + hermes-codex-bridge skill
  -> Discord project channel
```

## 1. 의존성 확인

기준:

- Node.js **20+** / npm: bridge server와 test/package script 실행.
- `tmux`: visible session 생성·종료와 tmux-backed dispatch.
- `curl`: health check와 bridge HTTP 호출.
- `jq`: `codex-send` / `codex-kill` 등 helper CLI가 bridge JSON을 읽고 JSON payload를 만들 때 사용하므로 helper CLI 설치 모드에서는 필수.
- Hermes Gateway: webhook/Discord push delivery를 쓰는 self-host quick start에서 필요.

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service
```

## 2. 권장 원커맨드 설치

```bash
git clone https://github.com/chiznoir/hermes-codex-bridge.git
cd hermes-codex-bridge
npm test
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --channel <fallback-discord-channel-id> \
  --project hermes-codex-bridge=<project-discord-channel-id> \
  --restart
```

channel ID는 실제 Discord 환경에 맞게 바꿉니다. 이 명령은 repo의 `bin/codex-new`, `bin/codex-send`, `bin/codex-kill`도 `PATH`에 설치합니다. `--webhook` 없는 agent bridge-only 모드는 자동 push 알림 없이 Hermes가 bridge API를 직접 조회하는 최소 설치 모드입니다.

수동으로 나눠 설치해야 하면 `docs/install-ko.md` 또는 아래 3~4장을 참고하세요.

확인:

```bash
systemctl --user status hermes-codex-bridge.service
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v codex-new codex-send codex-kill
```

## 3. 수동 helper CLI와 Hermes skill 설치

```bash
scripts/install-codex-cli.sh --force
scripts/install-hermes-skill.sh
systemctl --user restart hermes-gateway.service
```

설치 위치:

```text
~/.hermes/skills/autonomous-ai-agents/hermes-codex-bridge/SKILL.md
```

## 4. 수동 Hermes webhook sink 연결

원커맨드 installer를 쓰지 않고 나눠 설치할 때만 이 단계를 직접 수행합니다. Secret과 project channel map을 준비합니다.

```bash
mkdir -p ~/.config/hermes-codex-bridge
openssl rand -hex 32 > ~/.config/hermes-codex-bridge/hermes-webhook.secret
chmod 600 ~/.config/hermes-codex-bridge/hermes-webhook.secret
```

채널 매핑 예시:

```bash
cat > ~/.config/hermes-codex-bridge/project-channels.json <<'JSON'
{
  "default": "<fallback-discord-channel-id>",
  "projects": {
    "project-a": "<project-discord-channel-id>"
  }
}
JSON
chmod 600 ~/.config/hermes-codex-bridge/project-channels.json
```

bridge env에 Hermes sink를 켭니다.

```env
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/codex-bridge
BRIDGE_HERMES_WEBHOOK_SECRET=<same secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-discord-channel-id>
BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-codex-bridge/project-channels.json
BRIDGE_HERMES_CONFIG=~/.hermes/config.yaml
BRIDGE_HERMES_ALLOWLIST=true
BRIDGE_HERMES_RESTART=true
BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service
```

`BRIDGE_HERMES_ALLOWLIST=true`는 bridge가 새 project channel을 Hermes Gateway Discord allowlist에 추가하게 합니다. Session thread는 parent/project channel allowlist를 사용하며 thread ID를 별도 추가하지 않습니다. 이미 allowlist에 있는 채널은 continuation line까지 검사해 no-op 처리하며, 이 경우 `BRIDGE_HERMES_RESTART_CMD`를 실행하지 않아야 합니다.

Hermes Gateway webhook platform을 켭니다.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same secret>
```

Hermes webhook subscription은 `scripts/install-hermes-stack.sh`가 만드는 `subscription_prompt`를 SSoT로 사용해 설치합니다. 공개 문서에 prompt 전문을 복사하지 않습니다. prompt가 바뀌면 스크립트와 Hermes skill을 갱신한 뒤 아래처럼 재설치합니다.

```bash
scripts/install-hermes-stack.sh --webhook --restart --non-interactive
```

수동 `hermes webhook subscribe`가 필요하면 `scripts/install-hermes-stack.sh`의 `subscription_prompt` 내용을 그대로 사용하고, 문서에 오래된 prompt 사본을 새로 만들지 마세요. 현재 subscription은 `hermes-codex-bridge,codex-new,codex-send,codex-kill` 네 skill을 함께 로드하며, prompt에는 `CommandSubmitted`/`User Command` 원문 알림, 기본 `direct` FinalAnswer fullText, 선택 `summary`, 긴 `FinalAnswer` 분할 시 첫 조각만 제목을 표시하고 모든 조각 끝에 `(i/N)`을 붙이는 규칙, bridge-owned direct chunk 전송, `원문 그대로` 예외, Discord-originated dispatch의 `codex-send --discord-approval` + Hermes `clarify` 승인 카드 gate, 그리고 생성/전달/종료 intent를 각각 `codex-new`, `codex-send`, `codex-kill`로 넘기는 경계 규칙이 포함됩니다. `--discord-approval`은 bridge pending state만 만들므로 Hermes가 `clarify`/AskUserQuestion을 호출해야 실제 Discord 전송/거절/추가수정 버튼이 보입니다. `codex-send` 전달 프롬프트의 routing metadata/payload instruction 분리와 의미 보존형 실행 지시 정제 규칙은 `skills/codex-send/SKILL.md`가 소유합니다. `/new`/`/resume`은 Hermes/Gateway 라우팅 명령으로 `codex-new`에 매핑하지 않고, 기존 Codex pane에 보내는 Codex slash command라면 원문 그대로 전달합니다.

서비스 재시작:

```bash
systemctl --user restart hermes-gateway.service
systemctl --user restart hermes-codex-bridge.service
```

확인:

```bash
curl -sS http://127.0.0.1:8644/health
curl -sS http://127.0.0.1:3037/health
```

## 5. Discord에서 사용하는 법

### 프로젝트 채널을 미리 만든 뒤 새 세션 시작

Discord bot token/guild id가 bridge에 `BRIDGE_DISCORD_BOT_TOKEN`/`BRIDGE_DISCORD_GUILD_ID`로 설정되어 있어야 프로젝트 text channel 자동 검색/생성/매핑이 결정적으로 동작합니다. `scripts/install-hermes-stack.sh`는 Hermes의 `~/.hermes/.env`에 있는 `DISCORD_BOT_TOKEN`과 `DISCORD_HOME_CHANNEL`/fallback channel에서 이 값을 자동 매핑합니다. 권한이 없는 환경에서는 Discord에서 프로젝트명 텍스트 채널을 먼저 만드는 운영이 가장 안정적입니다.

예:

```text
#project-a
#project-b
```

그 다음 Hermes에게 이렇게 지시합니다.

```text
project-a 프로젝트를 codex-new로 새 세션 시작해서 감시해줘.
프로젝트명 텍스트 채널을 미리 만들어뒀으니 #project-a를 찾아 bridge에 매핑 등록하고, 이후 알림은 그 채널로 보내줘.
```

알림 이벤트는 기본적으로 fast-path Discord가 `SessionStart`, `SessionLinked`, `SessionEnd`, `CommandSubmitted`를 처리하고 Hermes webhook이 `AskPermission`, `FinalAnswer`를 처리합니다. standalone `SessionIdle` 골격 알림은 보내지 않고, 답변 완료 알림은 이벤트 타입은 `FinalAnswer`로 유지하고 사용자 제목은 `Session Idle`로 렌더링합니다. 이미 발행된 `FinalAnswer`/`AgentResponse`는 더 늦은 `User Command`가 관측되더라도 stale로 버리지 않고 큐 순서대로 delivery 대상에 남깁니다. 긴 FinalAnswer는 1800자 안전 한도로 여러 조각을 만들고 모든 조각 끝에 `(i/N)` 순번을 붙이며 제목은 첫 조각에만 표시합니다. `direct` mode의 긴 FinalAnswer는 Discord bot token과 session thread target이 있으면 bridge가 직접 Discord에 조각을 순차 전송해 Hermes 병렬 처리로 인한 순서 역전을 피합니다. Discord fast-path post는 기본 3초 timeout과 3회 retry를 사용하고, `5xx`/network/timeout은 retry, `401`/`403`/`404`와 기타 `4xx`는 `dead`, 짧은 `429 Retry-After`는 잠깐 대기, 긴 `Retry-After`는 FIFO 보존을 위해 hold합니다. `DISCORD_ALERT_CHANNEL_ID`를 설정하면 post 실패로 `dead`가 된 이유를 기존 bot token으로 운영 채널에 남깁니다. Discord Markdown table은 표로 렌더링되지 않으므로 bridge는 table을 정렬된 plain text로 바꿉니다. multi-chunk 알림은 모든 chunk가 성공하기 전까지 `sent`로 기록하지 않고, 실패 chunk 번호와 manifest를 남깁니다. Commentary/tool call/tool output은 기본 사용자 알림에서 제외됩니다.

기본 알림 mode는 `direct`입니다. bridge가 마지막 FinalAnswer fullText를 알림 본문으로 만들고 1800자를 넘으면 여러 조각으로 나눕니다. Discord bot token과 session thread target이 있으면 bridge가 조각을 직접 Discord에 순차 전송하고, Hermes로 direct payload가 전달되는 경우에는 Hermes가 summary 없이 그대로 전달합니다. `BRIDGE_HERMES_NOTIFICATION_MODE=summary`를 명시한 경우에만 bridge가 `text_preview`와 세션/채널 컨텍스트를 Hermes에 넘기고, Hermes가 Discord용 운영 요약을 작성합니다. 최신 assistant fullText가 없으면 FinalAnswer event text를 원문 소스로 쓰고, 둘 다 없을 때만 실패를 명시합니다. 단, 사용자가 “원문 그대로” 또는 “latest idle 원문”을 명시하면 Hermes는 `/sessions/:id/idle/latest`의 `fullText`를 그대로 전달하고, 원문 전체를 삼중 백틱 markdown 코드블럭으로 감싸지 않습니다.


새 프로젝트 세션 시작:

```text
현재 작업 프로젝트를 codex-new로 시작해서 감시해줘.
프로젝트명 텍스트 채널이 있으면 매핑 등록하고, 없으면 bridge 자동 생성/매핑을 시도한 뒤 이후 알림은 그 채널로 요약해줘.
```

이미 떠 있는 세션 확인:

```text
hermes-codex-bridge로 bridge health와 sessions를 확인해줘.
```

특정 세션에 후속 지시:

```text
방금 프로젝트 세션에 테스트를 실행하고 실패하면 수정하라고 지시해줘.
```

team/tmux visible session에 지시:

```text
해당 codex team 세션에는 tmux visible mode로 다음 지시를 넣어줘: worker 상태를 확인하고 다음 단계 진행.
```

## 6. Smoke check

```bash
SESSION_ID=<bridgeSessionId-or-codexSessionId>

curl -sS "http://127.0.0.1:3037/sessions/$SESSION_ID/events"
curl -sS "http://127.0.0.1:3037/sessions/$SESSION_ID/idle/latest"

curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/commands" \
  -H 'content-type: application/json' \
  -d '{"commandText":"bridge dry-run smoke","dryRun":true}'

curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/questions" \
  -H 'content-type: application/json' \
  -d '{"questionId":"smoke-question","question":"Smoke question?","type":"single-answerable","options":[{"label":"OK","value":"smoke-ok"}]}'

curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/question-answers" \
  -H 'content-type: application/json' \
  -d '{"questionId":"smoke-question","source":"discord-component","discordInteractionId":"smoke-interaction","answer":{"kind":"option","value":"smoke-ok","selected_values":["smoke-ok"]}}'
```

성공 기준:

- bridge health가 `{ "ok": true }`.
- Hermes webhook health가 `{ "status": "ok", "platform": "webhook" }`.
- `/sessions`에 Codex session이 보임.
- dry-run command가 `202`와 `delivery.dryRun: true`를 반환.
- structured question 등록이 `202`와 `answer_endpoint`를 반환.
- structured question answer가 `202`와 `delivery.status: "queued"`를 반환.
