# hermes-omx-notify

**Localhost-first notification and control bridge for Hermes, OMX, Codex, and tmux-backed agent sessions.**

[한국어](README-ko.md)

> Built to connect OMX and Hermes through tmux-backed local sessions. The notification flow and style were inspired by [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex).

![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![raw HTTP](https://img.shields.io/badge/http-raw%20node:http-111827)
![localhost first](https://img.shields.io/badge/security-localhost--first-blue)
![tests](https://img.shields.io/badge/tests-node%20--test-brightgreen)

`hermes-omx-notify` lets Hermes observe and control local OMX/Codex sessions without exposing a public control plane. It runs on `127.0.0.1`, discovers sessions from OMX lifecycle evidence, Codex JSONL logs, and tmux panes, then forwards selected events to Hermes Gateway / Discord.

```text
Hermes / Discord
  -> hermes-omx-notify on 127.0.0.1
     -> session registry / event router / command dispatch / audit log
  -> local OMX + Codex JSONL logs + tmux panes
```

## What it does

- **Session discovery** — merges OMX lifecycle logs, Codex JSONL sessions, and tmux panes into one bridge session view.
- **Full output access** — reads the latest assistant/final-answer text instead of only short notification previews.
- **Command dispatch** — sends follow-up instructions into the visible tmux pane through bridge-owned audit paths.
- **Helper CLIs** — installs `omx-new`, `omx-send`, and `omx-kill` for Hermes-friendly session lifecycle operations.
- **Discord delivery** — routes `AskPermission`, `FinalAnswer`, lifecycle, and command events through Hermes webhook or direct Discord fast-path delivery.
- **Project channel routing** — resolves, creates, and records project-specific Discord channel mappings.

## Quick start

For a complete agent-facing runbook, use [INSTALL.md](INSTALL.md). If Hermes Gateway and Discord are already prepared, the shortest path is:

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

Validate the install:

```bash
systemctl --user status hermes-omx-notify.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v omx-new omx-send omx-kill
```

Expected health response:

```json
{ "ok": true }
```

## Security model

The bridge is designed for same-host use and binds to `127.0.0.1` by default. It can read local agent logs and inject commands into live tmux sessions, so treat it as a local control socket, not as a public API.

- Keep `HOST=127.0.0.1` for normal installs.
- Set `OMX_BRIDGE_TOKEN` before exposing the bridge through Docker, LAN, reverse proxy, or the public internet.
- Never commit `.env`, webhook URLs, Discord bot tokens, generated secret files, or local state directories.
- Prefer installer `--token-file` and `--secret-file` options so secrets do not land in shell history.

## Documentation

README is intentionally only a landing page. The detailed contracts live in the linked documents below.

| Need | Document |
| --- | --- |
| Full install flow | [INSTALL.md](INSTALL.md) |
| Fast Hermes Gateway + Discord setup | [docs/quickstart.md](docs/quickstart.md) |
| Detailed install and environment notes | [docs/install.md](docs/install.md) |
| Day-to-day operations and troubleshooting | [docs/operations.md](docs/operations.md) |
| Internal state, delivery ordering, and edge cases | [docs/internals.md](docs/internals.md) |
| Hermes Gateway webhook and Discord behavior | [docs/hermes-gateway-integration.md](docs/hermes-gateway-integration.md) |
| Bridge/Hermes-only agent install runbook | [docs/bridge-hermes-only-install.md](docs/bridge-hermes-only-install.md) |
| Helper CLI contract | [bin/README.md](bin/README.md) |

The helper lifecycle contract is owned by `bin/` and the install scripts. Avoid copying those details into README; update the owning document or script instead.
