---
name: omx-send
description: Send a refined follow-up instruction to an existing OMX/Codex session through hermes-omx-notify using the local omx-send helper. Trigger when the user asks to 전달/보내/넘겨/반영/수정/계속 into an OMX session or replies to an OMX notification.
version: 0.2.0
prerequisites:
  commands: [omx-send]
metadata:
  hermes:
    tags: [omx, bridge, command, codex, tmux]
    related_skills: [hermes-omx-notify, omx-new, omx-kill]
    requires_toolsets: [terminal]
    triggers:
      - 전달, 전달해, 보내, 넘겨, 세션에 전달, follow-up -> omx-send
      - 세션에 넣어, 답장하기, 위 내용 전달, 답장으로 보낸 거, 방금 알림에 대한 말 -> omx-send
      - 반영, 수정, 고쳐, 계속, 진행, 이거 반영, 알림 reply, 알림에 답장, Notification reply -> omx-send
      - Discord-originated Hermes reply dispatch -> omx-send --discord-approval
      - AskPermission 승인/거절, /approve, /deny -> omx-send --mode tmux
      - 새 세션, 세션 열어, 시작해 -> use omx-new instead
      - 종료, kill, 킬, 죽여 -> use omx-kill instead
---

# OMX Send

This dispatch-specific skill exists because Hermes may load `omx-send` directly when the user names that skill or replies to a session notification. `hermes-omx-notify` handles bridge read/status/rendering; this file describes the dispatch rules so direct `skill_view("omx-send")` does not bypass prompt refinement.

Use `omx-send` to dispatch commands through hermes-omx-notify. Do not hand-build raw bridge `curl` calls. Do not silently fall back to raw tmux paste; if bridge delivery fails, report the explicit failure unless the user explicitly asked for visible tmux/manual fallback.

For Discord-originated Hermes replies that dispatch a refined prompt into an existing session, use `omx-send --session <id> --discord-approval "<refined prompt>"`, then immediately present the returned approval question through Hermes `clarify` / AskUserQuestion. The bridge command only registers the pending `omx-send-approval`; it does **not** by itself create Discord buttons. The Discord button/card is real only after Hermes calls `clarify` with the refined prompt and choices. Non-Discord/manual helper use may keep plain `omx-send --session <id>` when the user intentionally wants immediate dispatch.

## Target selection

- In Discord replies, route by the replied notification metadata first: `bridge_session_id`, `session:`, `tmux:`, `project:`, `omxSessionId`, `codexThreadId`.
- If a concrete bridge session id is present, use `omx-send --session <id>`.
- If only `tmux:` is present, resolve the active bridge session for that exact tmux id with `omx-send --list`; do not choose another same-project session.
- Routing labels are target metadata only. Remove them from the prompt sent to Codex.
- Typical routing labels/operators include `bridge_session_id`, `tmux id`, `bridge session id`, Korean phrases like `이 세션에 전달해`, an explicit session name such as `세션명은 X`, and `X 세션에 넣어`; these are not prompt content and must be removed from the delivered work sentence.
- Remove routing metadata from the prompt sent to Codex; 프롬프트 본문에 넣지 말고 작업 문장에서는 제거한다.

## Prompt refinement before `omx-send`

The exact argument passed to `omx-send` MUST already be the refined prompt. Do not pass the raw Discord reply, raw `[Replying to: ...]` wrapper, or raw operator command and expect Codex to infer the real task.

Priority order:

1) 대상 세션/routing metadata.
2) 실제 전달할 사용자 지시.
3) 의미 보존형 작업 지시문(meaning-preserving executable instruction).
4) 확장/왜곡 차단.

Do not mix roles: target selection, payload extraction, and prompt refinement are separate steps.

Before any `write_file`, temp-file handoff, shell command, or `omx-send` invocation:

1. Extract the payload instruction only. Remove Discord/Hermes wrappers such as `[Replying to: ...]`, `[치즈] 이 메시지를 ...에 전달해`, `이 세션에 전달해`, `세션명은 X`, `bridge_session_id`, `tmux id`, and `project:` unless they are part of the user's actual task.
2. Strip operator prefixes and meta framing such as `전달`, `추가 전달:`, `치즈전달:`, `치즈 질문:`, `치즈 지시:`, `치즈가 전달하래`, `치즈가 물었어`, `사용자 요청:`, `사용자요청:`, `User says:`, `follow-up:`, `the user asked`, and `방금 네 Final Answer에 대해 이렇게 물었어:`.
3. Rewrite colloquial/note-style text into a concise executable instruction. This is not mere proofreading and not raw copy/paste; it is also not surface wording cleanup. Preserve the original meaning first: constraints, paths, commands, identifiers, question form, tone/command force, target scope, remote/local distinction, and all/some distinction.
4. Clean typos and sentence boundaries, remove filler/flourish, resolve local deictic phrases such as “이거/위 내용/방금 결과” only from available reply context, and group multiple requested checks into short bullets only when the user already supplied multiple requirements.
5. Do not add files, features, tests, fixes, conclusions, priorities, or guarantees the user did not ask for. Add modify/validate steps only when the user explicitly or strongly implies change/fix/resolution.
6. Preserve Codex slash commands such as `/new` and `/resume` verbatim when they are intended for the target Codex session.

Forbidden in the delivered prompt:

- Prefaces like `추가 확인 요청이야`, `사용자는`, `치즈 요청:`, `치즈 질문:`, `치즈 지시:`, `전달:`, `추가 전달:`, `치즈전달:`, `사용자요청:`, or `User says:`.
- Quote wrappers, “answer the quoted text below” frames, or raw `[Replying to: ...]` blocks.
- Scope expansion/narrowing, local-vs-remote substitution, unrelated requirements, or invented solutions that replace the user request.
- Politeness/formality rewrites that erase the user's direct tone.

## Prompt-refinement template and guardrails

- This is the prompt-refinement template / 정제 템플릿.
- Template: `target metadata -> payload instruction -> executable work units -> expansion/distortion check`.
- For simple requests or requirements, produce one or two cleaner direct sentences. For multiple user-supplied requirements, use short bullets only when the user already supplied multiple requirements.
- The payload instruction is the direct work / 직접 수행할 작업 문장. Keep the actual question or instruction and constraints; do not turn a one-line reply/question into a long analysis plan.
- Clean spelling, awkward sentence boundaries, filler, praise, flourish, meta/욕설/감탄, quote block / wrapper text, and operator framing while preserving 반말/직설 and the user's command force; do not convert it into a more polite or formal 문서체.
- Do not add items the user did not state: files, features, or areas the user did not ask for; also do not add tests, new priority, guarantees, or invent conclusions/solutions that replace the original prompt.
- Do not expand or narrow scope, substitute a different task, collapse remote/local distinction, or lose all/some distinction.
- Add modify/validate steps only when the user explicitly or strongly implies change/fix/resolution; otherwise answer/check exactly what was asked.
- Avoid prompts that are too long. The final delivered text should be an executable instruction, not commentary about the user or Hermes.
- When the user asks for style such as “적당히 요약”, “간결하게”, “깔끔하게”, or “장황하게 하지 말 것”, preserve that as a style constraint. Do not make the prompt “safer” by inventing concrete output examples / 구체 출력 예시, fixed section templates, sample Markdown, exact wording, or expanded acceptance criteria that the user did not request.
- Never deliver prefaces such as `추가 확인 요청이야 ... 사용자는 ...`; preserve the original meaning first and write in the user's voice.
- If the user is angry because a prior dispatch changed meaning, stop elaborating. Acknowledge internally by sending only the corrected minimal payload; do not bundle “helpful” guardrails or broadened acceptance criteria into the resend.
- When the user says a previous dispatch was wrong and asks to resend/re-deliver, preserve the correction narrowly. Do not “improve” the corrected request by adding extra files, validation steps, manifests, contact sheets, prohibitions, or operational criteria unless the user explicitly restates them. The safe resend shape is usually one direct sentence plus only the minimal target/path needed to disambiguate.

Use `omx-send --raw` only when the user explicitly requests near byte-for-byte delivery with phrases such as “원문 그대로”, “그대로 전달”, “다음 그대로 전달”, `raw`, or equivalent.

Raw-mode extraction still has a boundary: send the user-designated payload, not the entire Discord/operator wrapper. If the user says “다음 그대로 전달”, the raw payload begins after that marker. Do not include `[Replying to: ...]`, `[치즈]`, target metadata used only for routing, or the operator phrase itself unless the user explicitly says those wrappers are part of the payload.

When the user is correcting an earlier over-expanded/meaning-distorted dispatch, default to the narrowest safe payload. Do not add “helpful” implementation details, acceptance criteria, file paths, validation steps, or root-cause hypotheses beyond what the user wrote. If they explicitly demand “그대로”, use `--raw` and preserve their wording within the payload boundary.

If line breaks matter, a temp file is allowed, but the temp file content must be the refined or raw-bounded payload, never the full raw Discord reply. After successful dispatch, do not reprint the original prompt / raw prompt or a long paraphrase; 원문을 별도 확인 메시지로 재출력하지 말고 success/failure and the target session only.

## Discord approval gate

- Discord reply → Hermes → existing OMX/Codex session dispatch MUST prefer `omx-send --discord-approval` after prompt refinement.
- The approval gate is not a second refinement policy. It displays the already-refined prompt and waits for the operator's 전송/거절/추가수정 decision.
- Important: `omx-send --discord-approval` only creates bridge pending state and returns `answer_endpoint`, `question.questionId`, and `component_actions`. Hermes Gateway does not automatically render arbitrary terminal-tool JSON `component_actions` as Discord buttons.
- Therefore after `delivery.status == "approval-pending"`, Hermes MUST call the native user-question UI (`clarify` / AskUserQuestion) with the exact refined prompt and choices `전송`, `거절`, `추가수정`. This is the same Gateway path that renders Ouroboros-style Discord cards/buttons.
- Do not answer the user with “승인 요청을 올려뒀어”, “버튼에서 전송 누르면 돼”, or similar unless the `clarify` call actually succeeded and is waiting for the user's choice. If `clarify` is unavailable or returns an error, report that the approval UI failed; do not claim buttons exist.
- After the user chooses in `clarify`, submit the result through the helper, not a hand-built dispatch curl:
  - `전송` → `omx-send --session <id> --answer-approval send --question-id <questionId>`
  - `거절` → `omx-send --session <id> --answer-approval reject --question-id <questionId>`
  - `추가수정` or an Other/free-text answer → collect the edit text with a second open-ended `clarify` if needed, close the old pending question with `omx-send --session <id> --answer-approval modify --question-id <questionId> --edit "<edit text>"`, run prompt refinement again, and create a new approval-gated `omx-send`; do not dispatch the old prompt after a modify answer.
- 추가수정 means Hermes must use the returned edit text as a 재정제/new refinement request and create a new approval-gated `omx-send`; do not dispatch the old prompt after a modify answer.
- AskPermission approval remains separate. `/approve` and `/deny` still use `omx-send --mode tmux` for the same `bridge_session_id`, not `--discord-approval`.
- Do not make every local/manual `omx-send` approval-gated. The gate is for Discord-originated Hermes dispatch unless the user explicitly asks for another approval path.

## Examples

Raw reply wrapper:

```text
[Replying to: "프롬프트 정제가 어느 세션은 되고 어느 세션은 안되는데? 전달"]
[치즈] 이 메시지를 019e... 에 전달해.
```

Refined `omx-send` prompt:

```text
프롬프트 정제가 세션마다 다르게 적용되는 경로를 확인해. 어떤 경로가 정제 규칙을 우회하는지 근거와 수정 필요 여부를 요약해.
```

Command shape:

```bash
omx-send --session <bridgeSessionId> "<refined prompt>"
omx-send --session <bridgeSessionId> --discord-approval "<refined prompt>"
omx-send --session SESSION_ID --answer-approval send|reject --question-id QUESTION_ID
omx-send --session SESSION_ID --answer-approval modify --question-id QUESTION_ID --edit "<edit text>"
omx-send --session SESSION_ID [--mode auto|tmux|codex] [--dry|--dry-run] [--hold|--no-submit] "<refined prompt>"
```
