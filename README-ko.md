# hermes-omx-notify

**Hermes, OMX, Codex, tmux 기반 에이전트 세션을 위한 localhost 우선 notification/control bridge.**

[English](README.md)

> tmux 기반 로컬 세션으로 OMX와 Hermes를 연결하기 위해 만들었습니다. Notification 흐름과 스타일은 [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)를 참고했습니다.

![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![raw HTTP](https://img.shields.io/badge/http-raw%20node:http-111827)
![localhost first](https://img.shields.io/badge/security-localhost--first-blue)
![tests](https://img.shields.io/badge/tests-node%20--test-brightgreen)

`hermes-omx-notify`는 Hermes가 로컬 OMX/Codex 세션을 관측하고 제어할 수 있게 해주는 작은 bridge입니다. 기본적으로 `127.0.0.1`에서만 동작하며, OMX lifecycle evidence, Codex JSONL log, tmux pane을 읽어 선택된 이벤트를 Hermes Gateway / Discord로 전달합니다.

```text
Hermes / Discord
  -> 127.0.0.1에서 실행되는 hermes-omx-notify
     -> session registry / event router / command dispatch / audit log
  -> local OMX + Codex JSONL logs + tmux panes
```

## 하는 일

- **세션 발견** — OMX lifecycle log, Codex JSONL session, tmux pane을 하나의 bridge session view로 병합합니다.
- **전체 출력 조회** — 짧은 notification preview가 아니라 최신 assistant/final-answer 원문을 읽습니다.
- **명령 전달** — bridge audit path를 통해 visible tmux pane에 후속 지시를 전달합니다.
- **GJC lifecycle 제어** — target checkout에서 `gjc --tmux` / `gjc --tmux --worktree <path>`를 실행하고, 검증된 managed GJC tmux session만 종료합니다.
- **Helper CLI** — Hermes가 쓰기 쉬운 `omx-new`, `omx-send`, `omx-kill` lifecycle 도구를 설치합니다.
- **Discord delivery** — `AskPermission`, `FinalAnswer`, lifecycle, command event를 Hermes webhook 또는 direct Discord fast path로 전달합니다.
- **프로젝트 채널 라우팅** — 프로젝트별 Discord channel mapping을 찾거나 만들고 기록합니다.

## 빠른 시작

에이전트가 그대로 따라 할 수 있는 전체 설치 절차는 [INSTALL.md](INSTALL.md)를 사용하세요. Hermes Gateway와 Discord가 이미 준비되어 있다면 가장 짧은 경로는 아래입니다.

```bash
git clone https://github.com/chiznoir/hermes-omx-notify.git
cd hermes-omx-notify
npm install
npm test

scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --channel <fallback-discord-channel-id> \
  --project hermes-omx-notify=<project-discord-channel-id>
```

설치 확인:

```bash
systemctl --user status hermes-omx-notify.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v omx-new omx-send omx-kill
```

정상 health 응답:

```json
{ "ok": true }
```

## GJC 제어 모델

Hermes의 GJC 제어는 GJC HTTPS bridge session-control endpoint가 아니라, 공식 문서의 external-runner 경로를 사용합니다. repo/worktree별 GJC tmux runner를 만들거나 붙고, 로컬 tmux dispatch route로 명령을 보내고, 결과는 GJC JSONL log에서 읽습니다.

```bash
curl -sS -X POST http://127.0.0.1:3037/gjc/sessions \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/repo","worktree":"/path/to/worktree"}'

curl -sS -X POST http://127.0.0.1:3037/sessions/<gjc-session-id>/commands \
  -H 'content-type: application/json' \
  -d '{"mode":"tmux","commandText":"/skill:ralplan ..."}'

curl -sS http://127.0.0.1:3037/sessions/<gjc-session-id>/events
curl -sS -X POST http://127.0.0.1:3037/sessions/<gjc-session-id>/stop
```

GJC `--mode bridge`는 GJC가 `/commands`, `/events`, `/control`을 공식 enable하기 전까지 이 프로젝트에서 probe/diagnostic 전용입니다. disabled bridge endpoint는 disabled로 보고하며, tmux로 조용히 재시도하지 않습니다.

## 보안 모델

bridge는 same-host 사용을 전제로 하며 기본 bind는 `127.0.0.1`입니다. 로컬 에이전트 log를 읽고 live tmux session에 명령을 주입할 수 있으므로 공개 API가 아니라 로컬 control socket처럼 다뤄야 합니다.

- 일반 설치에서는 `HOST=127.0.0.1`을 유지합니다.
- Docker, LAN, reverse proxy, public internet으로 노출하면 먼저 `OMX_BRIDGE_TOKEN`을 설정합니다.
- `.env`, webhook URL, Discord bot token, 생성된 secret file, local state directory를 커밋하지 않습니다.
- secret이 shell history에 남지 않도록 installer의 `--token-file`, `--secret-file` 옵션을 선호합니다.

## 문서

설치, 운영, 구현 세부 내용은 아래 문서를 참고하세요.

| 필요한 내용 | 문서 |
| --- | --- |
| 전체 설치 흐름 | [INSTALL.md](INSTALL.md) |
| Hermes Gateway + Discord 빠른 설치 | [docs/quickstart-ko.md](docs/quickstart-ko.md) |
| 상세 설치와 env 설명 | [docs/install-ko.md](docs/install-ko.md) |
| 운영과 troubleshooting | [docs/operations.md](docs/operations.md) |
| 내부 상태, delivery ordering, edge case | [docs/internals.md](docs/internals.md) |
| Hermes Gateway webhook과 Discord 동작 | [docs/hermes-gateway-integration.md](docs/hermes-gateway-integration.md) |
| Bridge/Hermes 전용 agent 설치 runbook | [docs/bridge-hermes-only-install-ko.md](docs/bridge-hermes-only-install-ko.md) |
| Helper CLI 사용법 | [bin/README.md](bin/README.md) |

Helper CLI 세부 사용법은 `bin/README.md`와 각 helper script에 정리되어 있습니다.
