# Internals and risk notes — hermes-omx-notify

이 문서는 `docs/operations.md`에서 뺀 상세 동작과 refactor 후 확인할 edge case를 모읍니다. 평소 운영자는 operations guide만 보면 됩니다.

## Canonical runtime evidence

`hermes-omx-notify`는 OMX lifecycle record와 로컬 Codex JSONL/log를 런타임 판단의 기준으로 사용합니다. tmux list, delivery cursor, event index, channel map은 다시 만들 수 있는 운영 상태입니다. 서로 다른 session을 억지로 하나로 합치지 않습니다.

## Session reconciliation

Codex가 남기는 `session_meta.cwd` 또는 OMX/Codex runtime `cwd`가 프로젝트 root와 다른 경우가 있습니다. 이때 bridge는 다음 원칙을 지킵니다.

- visible bridge session의 root/run root와 연결된 Codex log만 같은 session의 `CommandSubmitted`/`FinalAnswer`로 취급합니다.
- root가 다른 Codex thread를 project session으로 re-label하지 않습니다.
- session이 보이지만 답변 알림이 없다면 `/sessions/:id/state`, `/sessions/:id/events`, `sessionLogPath`, `associatedCodexLogs`를 먼저 확인합니다.
- 필요한 경우 `PROJECT_ROOT` 또는 live tmux-discovered root를 별도 scan root로 추가해 관측합니다. 이 방법은 기존 visible session으로 억지 병합하는 기능이 아닙니다.

## Delivery ordering

Discord fast-path delivery는 event timestamp/event id 순서의 FIFO를 유지합니다. 같은 session의 이전 `FinalAnswer`/`AskPermission` delivery가 아직 `sent`/`dead`가 아니면 뒤 `User Command`를 보류합니다. 전송 실패는 다음 원칙을 따릅니다.

- network error, timeout, `408`, `5xx`: retry 대상.
- `401`, `403`, `404`, 기타 일반 `4xx`: permanent failure로 `dead` 처리.
- `429`: 짧은 `Retry-After`만 기다렸다 retry하고, 너무 길면 FIFO를 깨지 않도록 다음 poll로 넘깁니다.
- 긴 `FinalAnswer` chunk 중 일부가 실패하면 전체 event를 `sent`로 표시하지 않고 실패 chunk와 manifest를 남깁니다.

## Direct vs summary notification

- `direct`: bridge가 최신 Codex assistant fullText를 메시지로 만들고 길면 `(i/N)` suffix를 붙여 조각냅니다. Discord bot token과 session thread target이 있으면 bridge가 조각을 같은 target에 순차 전송합니다.
- `summary`: Hermes가 구조화 payload를 요약합니다. `payload.message_markdown`은 제목/컨텍스트 골격일 수 있으므로 본문 판단에는 `text_preview`, `read_endpoints`, 필요 시 `/sessions/:id/idle/latest`를 함께 사용합니다.
- 원문 요청(`raw`, `full text`, “원문 그대로”)은 summary 예외입니다. `/sessions/:id/idle/latest`의 `fullText`를 확인하고, 실패하면 조용히 preview로 대체하지 않습니다.

## Prompt dispatch rules

Discord-originated reply dispatch의 prompt refinement 규칙은 `skills/omx-send/SKILL.md`에 정리되어 있습니다.

1. 대상 session/routing metadata를 분리합니다.
2. 실제 전달할 사용자 지시만 추출합니다.
3. 의미 보존형 실행 지시로 짧게 정제합니다.
4. 사용자가 말하지 않은 요구, 파일, 기능, 검증 단계를 추가하지 않습니다.

`omx-send --discord-approval`은 bridge-managed approval question을 만들 뿐입니다. Discord 버튼/선택 UI는 Hermes `clarify`/AskUserQuestion 렌더링이 별도로 필요합니다.

## Hermes allowlist repair

`BRIDGE_HERMES_CONFIG`, `BRIDGE_HERMES_ALLOWLIST`, `BRIDGE_HERMES_RESTART`, `BRIDGE_HERMES_RESTART_CMD`가 설정되면 bridge는 새 project channel을 Hermes Gateway Discord allowlist에 추가하고 필요할 때만 Gateway restart command를 실행합니다. 이미 등록된 channel은 YAML continuation line까지 검사해 no-op이어야 하며, no-op에서는 `config.yaml` write와 Gateway restart가 없어야 합니다. Session thread는 parent/project channel allowlist를 사용하므로 thread ID를 별도 allowlist 항목으로 추가하지 않습니다.

## Refactor risk checklist

OMX notify rename 이후 특히 아래를 봅니다.

- `omx-new`가 `omx --madmax --high` 기반 tmux session과 OMX lifecycle evidence를 유지하는지.
- `omx-send`/`omx-kill`이 raw tmux fallback 없이 bridge API/audit path를 사용하는지.
- `SessionStart` 알림 본문을 새 session trigger로 오해하지 않는지.
- `/new`/`/resume`이 기존 pane에 들어가는 Codex slash command로 보존되는지.
- session thread 생성 실패가 project channel silent fallback으로 숨지 않는지.
- install script, systemd service, skill path, webhook subscription이 모두 `hermes-omx-notify` 이름을 쓰는지.
- public docs/source에 local absolute path, private Discord webhook URL, 개인 Discord ID, 운영 token이 들어가지 않았는지.

## Validation commands

```bash
find src test -name '*.js' -print0 | xargs -0 -n1 node --check
bash -n bin/omx-new bin/omx-send bin/omx-kill scripts/*.sh bin/install.sh
npm test
git grep -n '<legacy-name-or-private-secret-pattern>' -- .
```

`npm test`는 현재 node test suite 검증 명령입니다. skipped tests가 있으면 test output의 skip reason을 보존하고, pass로 보고할 때 skipped 개수도 같이 적습니다.
