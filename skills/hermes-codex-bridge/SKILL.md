---
name: hermes-codex-bridge
description: Use the local hermes-codex-bridge read API to inspect bridge health, session lists, session state, latest idle/final answer text, events, interactions, and bridge-owned Discord notification payloads. Do not own session creation, prompt dispatch, or termination; hand those intents to codex-new, codex-send, or codex-kill.
version: 0.2.0
author: Hermes Agent
license: MIT
prerequisites:
  commands: [curl, jq]
metadata:
  hermes:
    tags: [hermes, codex, codex, bridge, discord, status, read-api]
    related_skills: [codex-new, codex-send, codex-kill]
    requires_toolsets: [terminal]
    triggers:
      - 브리지 상태, bridge health, gateway health -> GET /health
      - 세션 목록, 열린 세션, 세션 열려있어, 세션 살아있어, 현재 세션 확인 -> GET /sessions and GET /sessions/:id/state
      - 원문 알려줘, 마지막 답변 원문, raw, full text, latest idle 원문 -> GET /sessions/:id/idle/latest fullText
      - 최근 로그, 이벤트, timeline -> GET /sessions/:id/events
      - 내가 보낸 이력, 방금 보낸 지시, 명령 이력 -> GET /sessions/:id/interactions
      - bridge webhook FinalAnswer, Session Idle, AskPermission, CommandSubmitted 알림 렌더링 -> bridge payload/rendering rules
      - 새 세션, 세션 열어, 시작해 -> delegate to codex-new
      - 전달, 보내, 넘겨, 세션에 전달, follow-up, 반영, 수정, 계속 -> delegate to codex-send
      - 종료, kill, 킬, 죽여, stop session -> delegate to codex-kill
---

# Hermes Codex Bridge

This is the bridge operations and read-API skill. It teaches Hermes how to read the `hermes-codex-bridge` control plane, interpret bridge-owned event payloads, and render bridge notifications. It is not the owner of session lifecycle mutations.

## Responsibility Boundary

- `hermes-codex-bridge`: bridge server health, session list, session state, latest idle/final answer fullText, session events, command/interactions history, Discord notification rendering, channel/thread payload interpretation.
- `codex-new`: create/start a new visible Codex session.
- `codex-send`: send/refine a follow-up instruction or approval/denial into an existing session.
- `codex-kill`: stop/kill/close an existing Codex session.

When a user intent is lifecycle or dispatch, load and follow the dedicated skill. Do not duplicate its command rules here. This avoids two canonical prompt-refinement or lifecycle policies.

## Intent Handoff

Use bridge read endpoints for explanation/status requests only:

- “세션 열려있어?”, “세션 살아있어?”, “현재 세션 확인”, “열린 세션 목록” -> inspect `GET /sessions`, then `GET /sessions/:id/state` for the selected session.
- “원문 알려줘”, “마지막 답변 원문”, “raw”, “full text”, “latest idle 원문” -> `GET /sessions/:id/idle/latest` and relay `fullText` without summarizing.
- “최근 로그”, “이벤트 보여줘”, “timeline” -> `GET /sessions/:id/events`.
- “내가 보낸 이력”, “방금 보낸 지시”, “명령 이력” -> `GET /sessions/:id/interactions`.
- “이건 뭐냐”, “무슨 뜻이야?”, “궁금한데”, “왜 그래?” -> explain from bridge read endpoints only when the reply has no dispatch/stop/start verbs.

Delegate mutation intents:

- “새 세션”, “세션 열어”, “시작해”, “launch/create/watch a new Codex session” -> use `codex-new` skill.
- “전달”, “전달해”, “보내”, “넘겨”, “세션에 전달”, “follow-up”, “이거 반영”, “수정”, “고쳐”, “계속”, “진행” -> use `codex-send` skill. In notification replies, route by the replied alert's `bridge_session_id`; never switch to a latest same-project session.
- “종료”, “이 세션 종료해”, “kill”, “킬”, “죽여”, “stop/close session” -> use `codex-kill` skill. In notification replies, the target is the replied alert's `bridge_session_id` or exact `tmux` metadata.
- AskPermission approval/denial (`/approve`, `/deny`, `/approve session`, `/approve always`) -> use `codex-send` skill with the exact reply option for the same `bridge_session_id`.

Bridge webhook `SessionStart` payload text is an alert body, not a new-session trigger. Literal `/new` or `/resume` inside a prompt for an existing Codex pane is a Codex slash command and belongs to `codex-send`, not `codex-new`.

## Bridge Read API

Default local endpoint:

```bash
BRIDGE_URL=${BRIDGE_URL:-http://127.0.0.1:3037}
```

Read-only inspection examples:

```bash
curl -fsS "$BRIDGE_URL/health"
curl -fsS "$BRIDGE_URL/sessions?activity=false&limit=50"
curl -fsS "$BRIDGE_URL/sessions/$SESSION_ID/state"
curl -fsS "$BRIDGE_URL/sessions/$SESSION_ID/idle/latest"
curl -fsS "$BRIDGE_URL/sessions/$SESSION_ID/events"
curl -fsS "$BRIDGE_URL/sessions/$SESSION_ID/interactions"
```

Prefer the bridge read API over raw tmux capture for canonical status/history. Use raw tmux capture only as explicitly reported diagnostic evidence when the bridge endpoint is unavailable.

## Hermes Webhook Sink Mode

If a message arrives from the `codex-bridge` webhook subscription, treat the payload as a bridge event envelope. Important fields include `event_type`, `event_context_line`, `notification_title`, `notification_summary`, `message_markdown`, `project`, `channel_id`, `discord_delivery_target_id`, `chunk_delivery_channel_id`, `channel_mapping_status`, `bridge_session_id`, `thread_id`, `discord_thread_id`, `tmux_id`, `text_preview`, `reply_options`, `approval_actions`, `notification_chunked`, `notification_chunk_index`, `notification_chunk_total`, and `read_endpoints`.

Notification rendering rules:

1. Use `payload.message_markdown` as the ready-made body / skeleton for lifecycle and permission alerts.
2. Every user-facing `SessionStart`, `SessionEnd`, `AskPermission`, and `FinalAnswer` alert must include the context line. Prefer `event_context_line`; if only `session_context_line` exists, use that.
3. The rendered event alert is the user-facing output. do not send a second transport confirmation. Do not send a second transport confirmation such as `완료`, `discord에 보냈어`, `direct 모드라 보냈어`, `알림 렌더링 완료`, `요약을 보냈고`, or `message_id`.
4. For `CommandSubmitted`, send the `User Command` body from `payload.message_markdown`. It is post-dispatch truth and must not be summarized or rewritten here.
5. For `FinalAnswer` with `notification_mode: "direct"`, do not summarize. Send `payload.message_markdown` exactly as prepared. If `direct_full_text_unavailable` is true, report that fullText was unavailable; do not silently fall back to preview/summary.
6. For `FinalAnswer` in `summary` mode, keep the title/context and summarize with these sections when useful: `핵심 결론`, `원인/수정 내용`, `검증 결과`, `남은 주의/운영 조치`. Preserve concrete fixes, validation evidence, important files/config/commit hashes, and remaining caveats; do not collapse evidence into vague praise.
7. Use length-adaptive detail for summaries: about 8–12 lines for short answers, 12–20 for normal answers, and 20–36 for long operational answers. If `text_truncated=true`, call `read_endpoints.idle_latest` before summarizing.
8. Write explanatory prose primarily in Korean. Preserve exact technical identifiers, and explain UI/domain terms on first mention when needed, e.g. `Document graph`(문서 그래프), `keyword_fallback`(키워드 fallback 경로). Group file/config/commit/test lists instead of dumping every item.
9. Do not send standalone `SessionIdle` skeleton alerts. The answer-complete notification is the `FinalAnswer` payload rendered with the user-facing title `Session Idle`.
10. Ignore `Commentary` for user-facing alerts unless the user explicitly enabled progress chatter.

When a long `FinalAnswer` / `Session Idle` alert is split as a continued notification, the bridge may deliver direct-mode chunks to Discord itself when a bot token and session thread target are available. If a chunked payload reaches Hermes, it is already capped at 1800 characters and each prepared chunk should end every chunk with an `(i/N)` marker. Send each `payload.message_markdown` exactly as prepared and in arrival order: only the first chunk contains title/context, continuation chunks contain only continued body plus `(2/N)`, `(3/N)`, etc. Do not repeat `Session Idle` on continuation chunks. Send all chunks to the same `channel_id` / `discord_delivery_target_id` / `chunk_delivery_channel_id`; if `channel_mapping_status=session-thread` and `discord_thread_id` exists, that is already the Discord session thread. Do not reinterpret `thread_id` as a Discord channel; `thread_id` is a Codex thread/session identifier.

## Raw Markdown Relay Rule

For “원문 그대로”, “raw”, “full text”, or “latest idle 원문”:

- Fetch canonical text from `GET /sessions/:id/idle/latest` and use `fullText`.
- Do not reconstruct from `payload.message_markdown`, `payload.text_preview`, notification snippets, Discord history, or tmux capture.
- Do not summarize, paraphrase, reorder, or wrap the full markdown in an extra triple-backtick block.
- If splitting is required outside bridge-prepared payloads, preserve markdown fences and send every split message to the same Discord target with `(i/N)` markers and a 1800-character ceiling.
- If the endpoint fails or returns empty `fullText`, report that explicit bridge read failure.

## Discord Components for Structured Questions

For bridge-registered structured questions, prefer native Discord components over tmux key movement:

- `single-answerable`: buttons or a String Select menu.
- `multi-answerable`: multi-select menu.
- `allow_other: true`: `직접 입력` / `Other` modal with `other_text`.

Submit answers only to the canonical bridge question endpoint returned by the payload. Do not invent option values from rendered markdown. If structured answer submission returns `delivery.status: "queued"`, report it as queued for the question renderer, not final completion.

## Safety

- Do not mutate bridge state with hand-written terminal `curl` unless no supported helper/API surface exists and the user explicitly accepts that fallback.
- Do not use raw tmux capture as canonical truth when bridge endpoints are available.
- Do not choose a different same-project session when a reply contains `bridge_session_id`, `session:`, `tmux:`, or `discord_thread_id` metadata.
- Do not keep a second copy of `codex-send` prompt refinement rules here; `skills/codex-send/SKILL.md` owns dispatch prompt refinement.
