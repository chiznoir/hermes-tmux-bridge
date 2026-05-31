# INSTALL — Hermes Codex Bridge

This file is written as a direct runbook for Hermes or another automation agent. Follow it from top to bottom and do not print secrets, tokens, or webhook URLs in the final report.

## Goal

Install a same-host `hermes-codex-bridge` stack that provides:

1. `codex-new`, `codex-send`, and `codex-kill` helper CLIs on `PATH`.
2. The `hermes-codex-bridge` Hermes skill.
3. The localhost bridge server as a systemd user service.
4. Optional Hermes Gateway webhook subscription for Discord delivery.

The default security posture is localhost-only. `HOST=127.0.0.1` and `PORT=3037` are built-in defaults, so the runtime env file should not repeat them unless they are intentionally changed.

If the bridge is reachable from Docker, LAN, a reverse proxy, or the public internet, require `BRIDGE_TOKEN` and pass it with `--token-file`.

Runtime env rule: write only enabled features, secrets/ids, and non-default overrides. Use `.env.example` for the required/recommended variable surface; do not copy default-only keys into systemd env.

## Prerequisites

Dependency criteria:

- Node.js **20+** and npm are required for the bridge server, tests, and package install.
- `tmux` is required for visible Codex sessions and for `codex-new` / `codex-kill`.
- `curl` is required for health checks, install validation, and helper CLI HTTP calls.
- `jq` is required for the bundled helper CLIs that parse bridge JSON or build JSON payloads, especially `codex-send` and `codex-kill`. Treat it as required when installing `codex-new`, `codex-send`, and `codex-kill` onto `PATH`.
- Hermes Gateway is required only for webhook/Discord push delivery. Agent bridge-only installs can run without it.

```bash
node --version   # must be >= 20
npm --version
curl --version
jq --version
tmux -V
```

Webhook mode also expects a local Hermes Gateway:

```bash
systemctl --user status hermes-gateway.service --no-pager || true
curl -sS http://127.0.0.1:8644/health || true
```

## Environment-specific inputs

Do not copy Discord or Hermes values from another machine. On each PC, the installing agent must discover or ask for the real local values before enabling webhook delivery:

- fallback Discord channel id (`--channel`)
- project Discord channel mapping (`--project <project>=<channel-id>`)
- Discord bot token and guild id, usually from the local Hermes/Gateway environment
- Hermes Gateway env file location, if it is not `~/.hermes/.env`
- bridge token and webhook secret file paths

If a value is missing, stop and ask the operator instead of inventing one. Report secret/token paths only; never print raw secret, token, webhook URL, or full env file contents.

## Clone and verify

```bash
git clone https://github.com/chiznoir/hermes-codex-bridge.git
cd hermes-codex-bridge
npm install
npm test
```

Read project instructions before changing anything. The core branch does not require a tracked `AGENTS.md`; if a local one exists, read it before editing:

```bash
if [ -f AGENTS.md ]; then sed -n '1,220p' AGENTS.md; fi
```


## Automatic install: agent bridge only

Use this when Hermes will query the bridge API directly and no automatic webhook push is required.

```bash
scripts/install-hermes-stack.sh \
  --non-interactive
```

This installs helper CLIs, the Hermes skill, and the bridge server. It does not create a Hermes Gateway webhook subscription.

## Automatic install: Hermes Gateway webhook sink

Use this when bridge events should be pushed to Hermes Gateway and delivered to Discord.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id>
```

Before or immediately after this step, ensure Hermes Gateway has matching webhook env:

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same value as the bridge webhook secret file>
```

The installer creates the bridge secret file when webhook mode is enabled. Do not print the secret value. Report only the path.

When a Hermes config path is available, the service env uses the short allowlist keys:

```env
BRIDGE_HERMES_CONFIG=~/.hermes/config.yaml
BRIDGE_HERMES_ALLOWLIST=true
BRIDGE_HERMES_RESTART=true
BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service
```

The bridge treats YAML continuation-line allowlist entries as existing channels. Re-sending an already allowed channel is a no-op and must not rewrite `config.yaml` or restart Gateway.

## Manual install

If the stack installer cannot be used, run the pieces explicitly.

### 1. Install helper CLIs

```bash
scripts/install-codex-cli.sh --force
```

Optional target directory:

```bash
scripts/install-codex-cli.sh --force --dir "$HOME/.local/bin"
```

Confirm the target directory is on `PATH` for Hermes/Gateway workers:

```bash
command -v codex-new
command -v codex-send
command -v codex-kill
```

### 2. Install Hermes skill

```bash
scripts/install-hermes-skill.sh
systemctl --user restart hermes-gateway.service || true
```

### 3. Install bridge server

```bash
scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037
```

For non-localhost exposure, generate a token and pass the token file:

```bash
mkdir -p ~/.config/hermes-codex-bridge
openssl rand -hex 32 > ~/.config/hermes-codex-bridge/bridge.token
chmod 600 ~/.config/hermes-codex-bridge/bridge.token

scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037 \
  --token-file ~/.config/hermes-codex-bridge/bridge.token
```

### 4. Optional webhook sink

```bash
mkdir -p ~/.config/hermes-codex-bridge
openssl rand -hex 32 > ~/.config/hermes-codex-bridge/hermes-webhook.secret
chmod 600 ~/.config/hermes-codex-bridge/hermes-webhook.secret

scripts/install-systemd-service.sh \
  --host 127.0.0.1 \
  --port 3037 \
  --sink \
  --sink-url http://127.0.0.1:8644/webhooks/codex-bridge \
  --secret-file ~/.config/hermes-codex-bridge/hermes-webhook.secret \
  --channel <fallback-discord-channel-id> \
  --config ~/.hermes/config.yaml
```

Prefer `scripts/install-hermes-stack.sh --webhook` when possible because it also manages the Hermes subscription prompt.

## Validation

```bash
systemctl --user status hermes-codex-bridge.service --no-pager
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v codex-new
command -v codex-send
command -v codex-kill
npm test
```

Webhook mode validation:

```bash
curl -sS http://127.0.0.1:8644/health
hermes webhook list | grep codex-bridge
journalctl --user -u hermes-codex-bridge.service --no-pager -n 100 | grep 'bridge Hermes webhook sink enabled'
```

## Final report format

Report:

- `npm test` result.
- Bridge service status.
- `curl http://127.0.0.1:3037/health` result.
- Installed helper CLI paths from `command -v`.
- Hermes skill target path.
- Webhook status only if webhook mode was requested.

Do not report raw secrets, tokens, Discord webhook URLs, or full `.env` contents.
