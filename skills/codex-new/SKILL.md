---
name: codex-new
description: Start/create/launch a new visible Codex session for a repository/project through the local codex-new helper. Trigger on 새 세션, 세션 열어, 시작해, create/launch/start/watch a new Codex session. Do not handle existing-session prompt delivery or session termination.
version: 0.1.0
prerequisites:
  commands: [codex-new, tmux, codex]
metadata:
  hermes:
    tags: [codex, bridge, tmux, codex, session]
    related_skills: [hermes-codex-bridge, codex-send, codex-kill]
    requires_toolsets: [terminal]
    triggers:
      - 새 세션, 세션 열어, 시작해, create/launch/start/watch a new Codex session -> codex-new
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use codex-send instead
      - 종료, kill, 킬, 죽여, stop/close session -> use codex-kill instead
---

# Codex New

This skill owns new session creation. Use `codex-new` to start a new visible Codex TUI session.
Hermes should use `codex-new` rather than raw `codex`; the helper owns tmux session creation and bridge lifecycle registration.

## Boundary

- Owns: creating/launching a new visible Codex session.
- Does not own: sending prompts to an existing session (`codex-send`), killing sessions (`codex-kill`), or bridge read/status inspection (`hermes-codex-bridge`).
- Bridge webhook `SessionStart` alert bodies are notifications, not requests to create another session.
- `/new` or `/resume` inside an existing Codex pane prompt is a Codex slash command and should be delivered by `codex-send`, not handled here.

## Policy

- Default launch: `tmux new-session ... 'codex --dangerously-bypass-approvals-and-sandbox'` via the `codex-new` script.
- Do not add `--tmux` or `--direct` as defaults.
- Do not set a model in `codex-new`; use normal Codex defaults unless the user passes explicit extra Codex args after `--`.
- Reasoning effort is configured by env only: `CODEX_EFFORT=high|xhigh|medium`.
- In chat/gateway contexts, do **not** treat Hermes' own current working directory as the target project just because the user says “새 세션 열어줘”. Resolve the intended project from the user's wording, replied-to context, active Codex sessions, or known workspace paths first. If no project is inferable, ask for the target instead of opening in `~/.hermes/hermes-agent`.

## Commands

Before launching, identify the repository path explicitly. Prefer stable workspace locations such as `~/work/<project>` when the user names a project, and verify the directory exists.

```bash
# Resolve named project before launching; do not default to Hermes cwd for ambiguous requests.
for d in "$HOME/work/<project>" "$HOME/docs/<project>" "$HOME/.hermes/<project>"; do [ -d "$d" ] && printf '%s\n' "$d"; done

codex-new [PROJECT_DIR] [--name SESSION] [--attach] [--json] [--no-check] [-- CODEX_ARGS...]
codex-new /path/to/repo --json
codex-new /path/to/repo --name codex-project-main
CODEX_EFFORT=high codex-new /path/to/repo
```

After launch, use `hermes-codex-bridge` or:

```bash
codex-send --project <project> "현재 상태를 요약해줘"
```

If the visible pane is blocked by an Codex update prompt or Codex trust prompt, clear it before sending work. Be conservative with update prompts: default to `n` unless the user explicitly tells you to update, because accepting an Codex update can enter setup prompts and mutate global/user Codex config before the requested session starts.

```bash
# decline/update prompt if present unless the user explicitly requested update
 tmux capture-pane -t <tmuxId> -p -S -80 | tail -80
 tmux send-keys -t <tmuxId> 'n' Enter   # for "Update now? [Y/n]" by default
 tmux send-keys -t <tmuxId> Enter       # only for "Do you trust this directory?" when the directory is the requested project
```

If the user explicitly asks to accept the update:

```bash
 tmux send-keys -t <tmuxId> 'y' Enter
 # If setup asks for preferences and user wants legacy/keep, send 1.
 tmux send-keys -t <tmuxId> '1' Enter
```

After a Codex update/setup, if sessions immediately exit or `codex` reports `Error loading config.toml ... duplicate key`, do not keep opening sessions. Fix `~/.codex/config.toml` first: back it up, remove duplicate TOML tables while preserving one valid entry per key, verify duplicate table count is zero, then run `codex doctor` if available.

After any update/setup prompt, verify the session did not exit before reporting success:

```bash
 tmux has-session -t <tmuxId>
 tmux capture-pane -t <tmuxId> -p -S -120 | tail -80
 codex-send --list | head
```

Known post-update failure: `Error loading config.toml ... duplicate key` in `~/.codex/config.toml` means the session did not start; see `references/codex-update-config-duplicate-key.md` before retrying.

Report the tmux session id, project path, and bridge `/sessions` check result if available, but only call the session "started" after tmux is still alive and the bridge shows it active/known.
