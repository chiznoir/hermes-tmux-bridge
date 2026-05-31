# hermes-codex-bridge

**Localhost-first bridge core for Hermes, Codex, and tmux-backed agent sessions.**

[한국어](README-ko.md)

> Built for Hermes ↔ Codex integration over tmux-backed local sessions. The notification idea, flow, and style were inspired by [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex).

![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![raw HTTP](https://img.shields.io/badge/http-raw%20node:http-111827)
![localhost first](https://img.shields.io/badge/security-localhost--first-blue)
![tests](https://img.shields.io/badge/tests-node%20--test-brightgreen)

`hermes-codex-bridge` is the **bridge core**: a small, auditable HTTP service and helper CLI set that lets Hermes work with local Codex sessions. It discovers sessions from local logs and tmux, reads full Codex answers, dispatches follow-up commands into visible tmux panes, and forwards selected events to Discord through Hermes Gateway.

```text
Hermes / Discord
  -> hermes-codex-bridge on 127.0.0.1
     -> session registry / event router / command dispatch / audit log
  -> local Codex JSONL logs + tmux panes
```


## Table of contents

- [Why this exists](#why-this-exists)
- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Installation modes](#installation-modes)
- [Configuration](#configuration)
- [Security model](#security-model)
- [HTTP API](#http-api)
- [State model](#state-model)
- [Development](#development)
- [Documentation](#documentation)

## Why this exists

Hermes can orchestrate work better when it can see the same local evidence that a developer sees: Codex lifecycle logs, Codex JSONL transcripts, tmux panes, and command/audit history. This bridge keeps that integration local by default and exposes only the narrow API Hermes needs.

Use it when you want to:

- start, steer, and stop local Codex sessions from Hermes;
- read the latest full assistant output instead of short notification previews;
- route session events into Discord project channels; fast lifecycle/user-command events can bypass Hermes summarization and post directly;
- keep command dispatch and routing decisions inspectable through JSONL audit logs.

## Highlights

- **Session discovery** — merges bridge-owned lifecycle records, Codex JSONL sessions, and tmux panes into one bridge session view.
- **Full output access** — reads Codex session logs for latest assistant/final-answer text.
- **Command dispatch** — sends follow-up instructions to the visible tmux pane. The retired Codex App Server command backend is not used in production.
- **Bundled helper CLIs** — ships bridge lifecycle tools (`codex-new`, `codex-send`, `codex-kill`) in `bin/`.
- **Event delivery** — sends `AskPermission` and `FinalAnswer` through the Hermes webhook path, while `SessionStart`, `SessionLinked`, `SessionEnd`, and `CommandSubmitted` use the direct Discord fast path. Standalone `SessionIdle` skeleton notifications are suppressed.
- **Project channel routing** — resolves or creates per-project Discord text channel mappings for Hermes delivery.
- **Auditability** — records bridge commands and routing decisions in local append-only JSONL logs.

## Quick start

For a complete agent-friendly runbook, start with [INSTALL.md](INSTALL.md). For an already prepared Hermes Gateway + Discord host, the shortest path is:

```bash
git clone https://github.com/chiznoir/hermes-codex-bridge.git
cd hermes-codex-bridge
npm install
npm test

scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --channel <fallback-discord-channel-id> \
  --project hermes-codex-bridge=<project-discord-channel-id>
```

Validate the install:

```bash
systemctl --user status hermes-codex-bridge.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v codex-new codex-send codex-kill
```

Expected health response:

```json
{ "ok": true }
```

## Installation modes

| Mode | Command | Use when |
| --- | --- | --- |
| Agent bridge only | `scripts/install-hermes-stack.sh --non-interactive` | Hermes will query the bridge API directly; no automatic webhook push is needed. |
| Hermes webhook sink | `scripts/install-hermes-stack.sh --webhook --non-interactive` | Bridge events should be pushed to Hermes Gateway; default delivery is direct fullText into auto-created project channels/session threads when Discord bot settings are available. |
| Helper CLIs only | `bin/install.sh --force` | You only need `codex-new`, `codex-send`, and `codex-kill` on `PATH`; this wraps `scripts/install-codex-cli.sh`. |
| Systemd user service only | `scripts/install-systemd-service.sh --host 127.0.0.1 --port 3037` | You want to manage the bridge server separately. |

The service is installed as a **systemd user service**. Use `systemctl --user ...`, not system-wide `systemctl ...`.

## Configuration

Start from the example file:

```bash
cp .env.example .env
```

Node does not load `.env` automatically, so local shell runs should export it first:

```bash
set -a
. ./.env
set +a
npm start
```

Minimal localhost configuration can be empty. `.env.example` is safe to source because defaults and recommended values are commented; uncomment only the lines you need.

Defaults usually omitted:

```env
# HOST=127.0.0.1
# PORT=3037
# BRIDGE_STATE_ROOT=~/.local/state/hermes-codex-bridge
# BRIDGE_PUBLIC_URL=http://127.0.0.1:3037
```

Set `BRIDGE_STATE_ROOT` only when a system service has an ambiguous HOME or when you need a fixed state location. It is only the SQLite/queue/audit-log storage root, not the project root.

Optional Codex reasoning effort for sessions started by `codex-new`:

```env
# CODEX_EFFORT=high
```

Valid values follow Codex config values such as `medium`, `high`, or `xhigh`. `codex-new` does not set a model by default.

Optional token for non-localhost exposure:

```env
BRIDGE_TOKEN=<random-long-token>
```

Recommended Hermes Gateway webhook + Discord thread setup:

```env
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/codex-bridge
BRIDGE_HERMES_WEBHOOK_SECRET=<same-as-Hermes-WEBHOOK_SECRET>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-discord-channel-id>
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<discord-bot-token>
BRIDGE_DISCORD_GUILD_ID=<discord-guild-id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true
BRIDGE_HERMES_ALLOWLIST=true
```

`BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer`, `BRIDGE_HERMES_NOTIFICATION_MODE=direct`, `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-codex-bridge/project-channels.json`, `BRIDGE_NOTIFY_EVENT_TYPES=SessionStart,SessionLinked,SessionEnd,CommandSubmitted`, `BRIDGE_NOTIFY_DELIVERY_SINK=discord-fast`, and `BRIDGE_HERMES_RESTART=true` are defaults or have default paths, so they are usually omitted.

`BRIDGE_HERMES_ALLOWLIST=true` lets the bridge add newly mapped project channels to Hermes Gateway's Discord allowlists. Session threads are routed under the already-allowed parent/project channel and are not added as separate allowlist entries. Existing entries are checked across YAML continuation lines, so an already allowed channel is a no-op and must not restart Gateway.

Hermes Gateway must use the same webhook secret:

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same-as-bridge-secret>
```

## Security model

The bridge is designed to run on **`127.0.0.1` only** by default.

This matters because it can read local agent logs and inject commands into live sessions. Treat it as a local control socket, not as a public API.

Recommended rules:

- Keep `HOST=127.0.0.1` for normal installs.
- Set `BRIDGE_TOKEN` before exposing the bridge to Docker, a LAN, a reverse proxy, or the public internet.
- Never commit `.env`, webhook URLs, Discord bot tokens, generated secret files, or local state directories.
- Prefer `--token-file` and `--secret-file` installer options instead of putting secrets in shell history.
- Keep `BRIDGE_HERMES_WEBHOOK_SECRET` equal to Hermes Gateway `WEBHOOK_SECRET` when webhook delivery is enabled.

When `BRIDGE_TOKEN` is set, every endpoint except `GET /health` requires:

```http
Authorization: Bearer <token>
```

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness check. Public even when token auth is enabled. |
| `GET /sessions` | List discovered bridge sessions. |
| `GET /sessions/:id` | Read one session's public metadata and activity state. |
| `GET /sessions/:id/state` | Read compact current activity state. |
| `GET /sessions/:id/events` | Read the merged session event timeline. |
| `GET /sessions/:id/idle/latest` | Read the latest full assistant output from Codex logs. |
| `GET /sessions/:id/interactions` | Read bridge command/response history. |
| `POST /sessions/:id/commands` | Dispatch a command to tmux or Codex backend. With `approvalGate:"discord-hermes-codex-send"`, return a bridge-owned approval question instead of dispatching immediately. |
| `POST /sessions/:id/questions` | Queue a bridge-visible question request. |
| `POST /sessions/:id/question-answers` | Queue an answer to a bridge question. |
| `GET /audit` | Read local append-only audit records. |
| `GET /projects/:project/channel` | Resolve project Discord channel mapping. |
| `POST /projects/:project/channel` | Persist project Discord channel mapping. |

Dry-run dispatch:

```bash
curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/commands" \
  -H 'content-type: application/json' \
  -d '{"commandText":"bridge binding smoke check","dryRun":true}'
```

Visible tmux dispatch:

```bash
curl -sS -X POST "http://127.0.0.1:3037/sessions/$SESSION_ID/commands" \
  -H 'content-type: application/json' \
  -d '{"commandText":"Summarize the current state.","mode":"tmux","submit":true}'
```

Backend modes:

- `auto` — use the tmux backend. This is the production default.
- `tmux` — send text to the visible tmux target; best for user-visible Codex/team sessions.
- `codex` — unsupported for command dispatch; the experimental Codex App Server write path was removed from the production contract.
- `dryRun: true` — validate routing and write local records without injecting input.

The bridge no longer performs App Server-to-tmux fallback for command dispatch. `auto` selects tmux directly, while `mode: "codex"` fails explicitly with `mode-codex-unsupported`.

## State model

The bridge treats bridge-owned lifecycle records plus local Codex logs as canonical runtime evidence. Derived indexes, caches, and delivery cursors are rebuildable state; they must not become a second source of truth.

Local logs can contain prompts, assistant output, project paths, and command text. Keep state directories and generated secret files outside git and with local-user permissions.

## Development

Requirements:

- Node.js **20+** for the bridge server and test runtime
- npm for package install and scripts
- tmux for visible tmux-backed sessions and `codex-new` / `codex-kill`
- curl for health checks, install validation, and helper CLI HTTP calls
- jq for bundled helper CLIs that parse bridge JSON or build JSON payloads, especially `codex-send` and `codex-kill`
- Codex local session logs
- Optional: Hermes Gateway and Discord credentials for webhook-based Discord delivery

Local workflow:

```bash
node --version
npm install
npm test

set -a; . ./.env; set +a
npm start
```

Useful source entry points:

- `src/server.js` — raw HTTP server and route handling.
- `src/control-plane/registry.js` — session discovery and enrichment.
- `src/control-plane/event-router.js` — merged event timeline construction.
- `src/hermes-webhook-sink.js` — Hermes Gateway webhook payload and polling loop.
- `src/discord-channels.js` / `src/project-channels.js` — project channel lookup, create, and mapping.
- `src/tmux.js` — tmux pane/session lookup and command injection.

## Documentation

- [Install runbook](INSTALL.md) — canonical agent-facing install flow.
- [Quick start](docs/quickstart.md) — fastest Hermes Gateway + Discord setup path.
- [Install guide](docs/install.md) — detailed install and environment notes.
- [Operations guide](docs/operations.md) — runtime routing and troubleshooting notes.
- [Hermes Gateway integration](docs/hermes-gateway-integration.md) — webhook subscription and Discord delivery behavior.
- [Bridge + Hermes install](docs/bridge-hermes-only-install.md) — agent runbook for bridge/Hermes/Discord notifications.
- [Helper CLI docs](bin/README.md) — `codex-new`/`codex-send`/`codex-kill` operating contract.

The `codex-new`, `codex-send`, and `codex-kill` helper contract is owned by `bin/` and installed by `bin/install.sh`, `scripts/install-codex-cli.sh`, or `scripts/install-hermes-stack.sh`; avoid duplicating those scripts in prose.
