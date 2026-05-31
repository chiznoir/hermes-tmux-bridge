# hermes-codex-notify

**Hermes, Codex, tmux 기반 에이전트 세션을 위한 localhost 우선 notification bridge.**

[English](README.md)

> tmux 기반 로컬 세션에서 Hermes ↔ Codex를 연동하기 위해 만들었습니다. Notification 아이디어, 흐름, 스타일은 [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)를 참고했습니다.

![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![raw HTTP](https://img.shields.io/badge/http-raw%20node:http-111827)
![localhost first](https://img.shields.io/badge/security-localhost--first-blue)
![tests](https://img.shields.io/badge/tests-node%20--test-brightgreen)

`hermes-codex-notify`는 **notification bridge**입니다. Hermes가 로컬 Codex 세션 이벤트를 받고 필요한 후속 동작을 할 수 있도록 작은 HTTP service와 helper CLI를 제공합니다. 로컬 log와 tmux에서 세션을 찾고, Codex 답변 원문을 읽고, visible tmux pane에 후속 명령을 전달하며, 선택된 이벤트를 Hermes Gateway를 통해 Discord로 보냅니다.

```text
Hermes / Discord
  -> 127.0.0.1에서 실행되는 hermes-codex-notify
     -> session registry / event router / command dispatch / audit log
  -> local Codex JSONL logs + tmux panes
```


## 목차

- [왜 필요한가](#왜-필요한가)
- [주요 기능](#주요-기능)
- [빠른 시작](#빠른-시작)
- [설치 모드](#설치-모드)
- [설정](#설정)
- [보안 모델](#보안-모델)
- [HTTP API](#http-api)
- [상태 모델](#상태-모델)
- [개발](#개발)
- [문서](#문서)

## 왜 필요한가

Hermes가 개발자와 같은 로컬 신호를 받을 수 있으면 작업을 더 안정적으로 오케스트레이션할 수 있습니다. 이 프로젝트는 Codex lifecycle log, Codex JSONL transcript, tmux pane, command/audit history를 localhost 안에서 읽고 Hermes에 필요한 좁은 API만 제공합니다.

다음 상황에서 사용합니다.

- Hermes에서 로컬 Codex 세션을 시작, 조향, 종료하고 싶을 때
- 짧은 notification preview가 아니라 최신 assistant output 원문을 읽어야 할 때
- 세션 이벤트를 Discord 프로젝트 채널로 라우팅해야 할 때
- 명령 전달과 routing 결정을 JSONL audit log로 확인 가능하게 남기고 싶을 때

## 주요 기능

- **세션 발견** — bridge-owned lifecycle record, Codex JSONL session, tmux pane을 하나의 bridge session view로 병합합니다.
- **전체 출력 조회** — Codex session log에서 최신 assistant/final-answer text를 읽습니다.
- **명령 전달** — 후속 지시를 visible tmux pane으로 전달합니다. 은퇴한 Codex App Server command backend는 production에서 사용하지 않습니다.
- **내장 helper CLI** — `bin/`에 bridge lifecycle 도구(`codex-new`, `codex-send`, `codex-kill`)를 포함합니다.
- **이벤트 전달** — `AskPermission`, `FinalAnswer`는 Hermes webhook path로, `SessionStart`, `SessionLinked`, `SessionEnd`, `CommandSubmitted`는 직접 Discord fast path로 보냅니다. standalone `SessionIdle` 골격 알림은 억제합니다.
- **프로젝트 채널 라우팅** — 프로젝트별 Discord text channel mapping을 찾거나 생성합니다.
- **감사 가능성** — bridge 명령과 routing 결정을 로컬 append-only JSONL log에 기록합니다.

## 빠른 시작

에이전트가 그대로 따라 할 수 있는 전체 runbook은 [INSTALL.md](INSTALL.md)를 먼저 보세요. Hermes Gateway와 Discord host가 이미 준비되어 있다면 가장 짧은 경로는 아래입니다.

```bash
git clone https://github.com/chiznoir/hermes-codex-notify.git
cd hermes-codex-notify
npm install
npm test

scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --channel <fallback-discord-channel-id> \
  --project hermes-codex-notify=<project-discord-channel-id>
```

설치 확인:

```bash
systemctl --user status hermes-codex-notify.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v codex-new codex-send codex-kill
```

정상 health 응답:

```json
{ "ok": true }
```

## 설치 모드

| Mode | Command | 언제 쓰나 |
| --- | --- | --- |
| Agent bridge only | `scripts/install-hermes-stack.sh --non-interactive` | Hermes가 bridge API를 직접 조회하고 자동 webhook push가 필요 없을 때 |
| Hermes webhook sink | `scripts/install-hermes-stack.sh --webhook --non-interactive` | bridge 이벤트를 Hermes Gateway로 push해 Discord에 요약하고 싶을 때 |
| Helper CLI only | `bin/install.sh --force` | `codex-new`, `codex-send`, `codex-kill`만 `PATH`에 올리면 될 때. 내부적으로 `scripts/install-codex-cli.sh`를 감쌉니다. |
| Systemd user service only | `scripts/install-systemd-service.sh --host 127.0.0.1 --port 3037` | bridge server를 별도로 관리하고 싶을 때 |

서비스는 **systemd user service**로 설치됩니다. system-wide `systemctl ...`이 아니라 `systemctl --user ...`를 사용하세요.

## 설정

예시 env 파일에서 시작합니다.

```bash
cp .env.example .env
```

Node가 `.env`를 자동으로 읽지는 않으므로 로컬 shell 실행 시 먼저 export합니다.

```bash
set -a
. ./.env
set +a
npm start
```

최소 localhost 설정은 비워도 됩니다. `.env.example`은 안전하게 source할 수 있도록 기본값과 권장값을 주석으로 제공합니다. 필요한 줄만 주석을 풀어 쓰세요.

보통 생략하는 기본값:

```env
# HOST=127.0.0.1
# PORT=3037
# BRIDGE_STATE_ROOT=~/.local/state/hermes-codex-notify
# BRIDGE_PUBLIC_URL=http://127.0.0.1:3037
```

`BRIDGE_STATE_ROOT`는 system service처럼 HOME이 불분명하거나 state 위치를 고정해야 할 때만 명시하세요. 이 값은 SQLite/큐/감사 로그 저장 위치일 뿐, 프로젝트 루트가 아닙니다.

`codex-new`로 시작하는 Codex reasoning effort를 바꿀 때만 아래 env를 설정합니다.

```env
# CODEX_EFFORT=high
```

값은 Codex config가 받는 `medium`, `high`, `xhigh` 같은 값입니다. `codex-new`는 모델을 기본 지정하지 않습니다.

localhost 밖으로 노출하는 경우 token을 설정합니다.

```env
BRIDGE_TOKEN=<random-long-token>
```

권장 Hermes Gateway webhook + Discord thread 설정:

```env
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/codex-notify
BRIDGE_HERMES_WEBHOOK_SECRET=<same-as-Hermes-WEBHOOK_SECRET>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-discord-channel-id>
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<discord-bot-token>
BRIDGE_DISCORD_GUILD_ID=<discord-guild-id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true
BRIDGE_HERMES_ALLOWLIST=true
```

`BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer`, `BRIDGE_HERMES_NOTIFICATION_MODE=direct`, `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-codex-notify/project-channels.json`, `BRIDGE_NOTIFY_EVENT_TYPES=SessionStart,SessionLinked,SessionEnd,CommandSubmitted`, `BRIDGE_NOTIFY_DELIVERY_SINK=discord-fast`, `BRIDGE_HERMES_RESTART=true`는 기본값과 같거나 기본 경로가 있으므로 보통 생략합니다.

`BRIDGE_HERMES_ALLOWLIST=true`이면 bridge가 새로 매핑한 project channel을 Hermes Gateway Discord allowlist에 추가합니다. Session thread는 이미 허용된 parent/project channel 아래로 라우팅하며 별도 allowlist 항목으로 추가하지 않습니다. 이미 등록된 채널은 YAML continuation line까지 검사해 no-op으로 처리하므로 Gateway를 재시작하지 않아야 합니다.

Hermes Gateway 쪽 webhook secret도 같아야 합니다.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same-as-bridge-secret>
```

## 보안 모델

bridge는 기본적으로 **`127.0.0.1` 전용**으로 실행되도록 설계되어 있습니다.

로컬 에이전트 로그를 읽고 live session에 명령을 주입할 수 있으므로 공개 API가 아니라 로컬 control socket처럼 다뤄야 합니다.

권장 규칙:

- 일반 설치에서는 `HOST=127.0.0.1`을 유지합니다.
- Docker, LAN, reverse proxy, public internet에서 접근 가능해지면 `BRIDGE_TOKEN`을 설정합니다.
- `.env`, webhook URL, Discord bot token, 생성된 secret file, local state directory를 커밋하지 않습니다.
- secret이 shell history에 남지 않도록 installer의 `--token-file`, `--secret-file` 옵션을 선호합니다.
- webhook delivery를 켜면 `BRIDGE_HERMES_WEBHOOK_SECRET`을 Hermes Gateway `WEBHOOK_SECRET`과 같게 유지합니다.

`BRIDGE_TOKEN`이 설정되어 있으면 `GET /health`를 제외한 모든 endpoint에 아래 header가 필요합니다.

```http
Authorization: Bearer <token>
```

## HTTP API

| Endpoint | 용도 |
| --- | --- |
| `GET /health` | liveness check. token auth가 켜져도 공개됩니다. |
| `GET /sessions` | 발견된 bridge session 목록. |
| `GET /sessions/:id` | 단일 session metadata와 activity state. |
| `GET /sessions/:id/state` | compact current activity state. |
| `GET /sessions/:id/events` | 병합된 session event timeline. |
| `GET /sessions/:id/idle/latest` | Codex log의 최신 assistant output 원문. |
| `GET /sessions/:id/interactions` | bridge command/response 이력. |
| `POST /sessions/:id/commands` | tmux 또는 Codex backend로 명령 전달. |
| `POST /sessions/:id/questions` | bridge-visible question request queue. |
| `POST /sessions/:id/question-answers` | bridge question에 대한 answer queue. |
| `GET /audit` | 로컬 append-only audit record 조회. |
| `GET /projects/:project/channel` | 프로젝트 Discord channel mapping 조회. |
| `POST /projects/:project/channel` | 프로젝트 Discord channel mapping 저장. |

Dry-run 전달:

```bash
curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/commands" \
  -H 'content-type: application/json' \
  -d '{"commandText":"bridge binding smoke check","dryRun":true}'
```

Visible tmux 전달:

```bash
curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/commands" \
  -H 'content-type: application/json' \
  -d '{"commandText":"Summarize the current state.","mode":"tmux","submit":true}'
```

Backend mode:

- `auto` — tmux backend를 사용합니다. production 기본값입니다.
- `tmux` — visible tmux target에 text를 보냅니다. Codex/team session에 적합합니다.
- `codex` — command dispatch에서 지원하지 않습니다. 실험적 Codex App Server write path는 production 계약에서 제거되었습니다.
- `dryRun: true` — input 주입 없이 routing과 로컬 기록만 검증합니다.

bridge는 command dispatch에서 더 이상 App Server-to-tmux fallback을 수행하지 않습니다. `auto`는 tmux를 직접 선택하고, `mode: "codex"`는 `mode-codex-unsupported`로 명시 실패합니다.

## 상태 모델

bridge는 bridge-owned lifecycle record와 로컬 Codex log를 canonical runtime evidence로 취급합니다. derived index, cache, delivery cursor는 다시 만들 수 있는 상태이며 두 번째 source of truth가 되면 안 됩니다.

로컬 log에는 prompt, assistant output, project path, command text가 포함될 수 있습니다. state directory와 생성된 secret file은 git 밖에 두고 local-user permission으로 보호하세요.

## 개발

요구사항:

- Node.js **20+**
- npm
- visible tmux-backed session을 쓰는 경우 tmux
- 내장 helper CLI용 curl과 jq
- Codex 로컬 session log
- 선택사항: webhook 기반 Discord delivery용 Hermes Gateway와 Discord credential

로컬 workflow:

```bash
node --version
npm install
npm test

set -a; . ./.env; set +a
npm start
```

주요 source entry point:

- `src/server.js` — raw HTTP server와 route 처리.
- `src/control-plane/registry.js` — session discovery/enrichment.
- `src/control-plane/event-router.js` — merged event timeline 생성.
- `src/hermes-webhook-sink.js` — Hermes Gateway webhook payload와 polling loop.
- `src/discord-channels.js` / `src/project-channels.js` — project channel lookup/create/mapping.
- `src/tmux.js` — tmux pane/session lookup과 command injection.

## 문서

- [Install runbook](INSTALL.md) — 에이전트용 canonical 설치 흐름.
- [Quick start](docs/quickstart-ko.md) — Hermes Gateway + Discord 빠른 설치 경로.
- [Install guide](docs/install-ko.md) — 상세 설치와 env 설명.
- [Operations guide](docs/operations.md) — 짧은 day-2 service/routing/troubleshooting runbook.
- [Internals and risk notes](docs/internals.md) — delivery ordering, session reconciliation, refactor risk 상세 점검.
- [Hermes Gateway integration](docs/hermes-gateway-integration.md) — webhook subscription과 Discord delivery 동작.
- [Notify + Hermes install](docs/bridge-hermes-only-install-ko.md) — Hermes/Discord 알림 설치 runbook.
- [Helper CLI docs](bin/README.md) — `codex-new`/`codex-send`/`codex-kill` 운영 기준.

`codex-new`, `codex-send`, `codex-kill` helper 계약의 SSoT는 `bin/`이고 bridge lifecycle 설치는 `bin/install.sh`, `scripts/install-codex-cli.sh`, 또는 `scripts/install-hermes-stack.sh`가 담당합니다. 스크립트 내용을 문서에 중복 복사하지 않습니다.
