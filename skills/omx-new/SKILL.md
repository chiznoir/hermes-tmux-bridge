---
name: omx-new
description: Start/create/launch a new visible OMX/Codex session for a repository/project through the local omx-new helper. Trigger on 새 세션, 세션 열어, 시작해, create/launch/start/watch a new OMX session. Do not handle existing-session prompt delivery or session termination.
version: 0.1.0
prerequisites:
  commands: [omx-new, tmux, omx]
metadata:
  hermes:
    tags: [omx, bridge, tmux, codex, session]
    related_skills: [hermes-omx-notify, omx-send, omx-kill]
    requires_toolsets: [terminal]
    triggers:
      - 새 세션, 세션 열어, 시작해, create/launch/start/watch a new OMX session -> omx-new
      - 전달, 보내, 넘겨, follow-up, 반영, 수정, 계속 -> use omx-send instead
      - 종료, kill, 킬, 죽여, stop/close session -> use omx-kill instead
---

# OMX New

Use this skill for new session creation. Use `omx-new` to start a new visible OMX/Codex TUI session. This replaces legacy `cwt-new` and does not use clawhip.
Hermes should use `omx-new` rather than raw `omx --madmax --high`; the helper applies tmux/HUD/session registration defaults.

## Boundary

- Owns: creating/launching a new visible OMX/Codex session.
- Does not own: sending prompts to an existing session (`omx-send`), killing sessions (`omx-kill`), or bridge read/status inspection (`hermes-omx-notify`).
- Bridge webhook `SessionStart` alert bodies are notifications, not requests to create another session.
- `/new` or `/resume` inside an existing Codex pane prompt is a Codex slash command and should be delivered by `omx-send`, not handled here.

## Policy

- Default launch: `tmux new-session ... 'omx --madmax --high'` via the `omx-new` script.
- Do not add `--tmux` inside the native tmux session.
- Do not add `--direct` unless the user explicitly wants to bypass OMX tmux/HUD management.
- Do not add `--disable codex_hooks` as a default; remove clawhip hooks instead of disabling all Codex hooks.
- In chat/gateway contexts, do **not** treat Hermes' own current working directory as the target project just because the user says “새 세션 열어줘”. Resolve the intended project from the user's wording, replied-to context, active OMX sessions, or known workspace paths first. If no project is inferable, ask for the target instead of opening in `~/.hermes/hermes-agent`.

## Commands

Before launching, identify the repository path explicitly. Prefer stable workspace locations such as `~/work/<project>` when the user names a project, and verify the directory exists.

```bash
# Resolve named project before launching; do not default to Hermes cwd for ambiguous requests.
for d in "$HOME/work/<project>" "$HOME/docs/<project>" "$HOME/.hermes/<project>"; do [ -d "$d" ] && printf '%s\n' "$d"; done

omx-new [PROJECT_DIR] [--name SESSION] [--attach] [--direct] [--json] [--runs PATH] [--no-check] [-- OMX_ARGS...]
omx-new /path/to/repo --json
omx-new /path/to/repo --name omx-project-main
```

After launch, use `hermes-omx-notify` or:

```bash
omx-send --project <project> "현재 상태를 요약해줘"
```

If the visible pane is blocked by an OMX update prompt or Codex trust prompt, clear it before sending work. Be conservative with update prompts: default to `n` unless the user explicitly tells you to update, because accepting an OMX update can enter setup prompts and mutate global/user Codex config before the requested session starts.

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

After an OMX update/setup, if sessions immediately exit or `omx --madmax --high` reports `Error loading config.toml ... duplicate key [hooks.state."...hooks.json:..."]`, do not keep opening sessions. Fix `~/.codex/config.toml` first: back it up, remove duplicate `[hooks.state."/home/user/.codex/hooks.json:...:0:0"]` TOML tables while preserving one valid entry per key, verify duplicate table count is zero, then run `omx doctor`. Also treat `[features].codex_hooks is deprecated. Use [features].hooks instead` as a config hygiene warning to report/fix separately; it does not by itself mean session start failed.

After any update/setup prompt, verify the session did not exit before reporting success:

```bash
 tmux has-session -t <tmuxId>
 tmux capture-pane -t <tmuxId> -p -S -120 | tail -80
 omx-send --list | head
```

Known post-update failure: `Error loading config.toml ... duplicate key` in `~/.codex/config.toml` means the session did not start; see `references/omx-update-config-duplicate-key.md` before retrying.

Report the tmux session id, project path, and bridge `/sessions` check result if available, but only call the session "started" after tmux is still alive and the bridge shows it active/known.
