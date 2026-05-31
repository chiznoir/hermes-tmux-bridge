# Install — attach another PC or Hermes Agent

The recommended install path is `scripts/install-hermes-stack.sh --webhook`. It aligns the helper CLIs, bridge service, Hermes skill, and Hermes Gateway webhook subscription. Without `--webhook`, the install is an agent bridge-only mode: Hermes can query the bridge API, but there is no automatic push notification delivery.

For the Korean version, see [`docs/install-ko.md`](install-ko.md).

For a bridge + Hermes/Discord install without AgentMemory or CodeGraph, use [`docs/bridge-hermes-only-install.md`](bridge-hermes-only-install.md).

## 1. Prerequisites

Dependency criteria:

- Node.js **20+** / npm: required for the bridge server, package install, and tests.
- `tmux`: required for visible OMX/Codex sessions and `omx-new` / `omx-kill`.
- `curl`: required for health checks, install validation, and bridge HTTP calls.
- `jq`: required by helper CLIs that read bridge JSON or build JSON payloads. Treat it as required when installing `omx-send` and `omx-kill` onto `PATH`.
- Hermes Gateway: required only when webhook/Discord push delivery is enabled. Agent bridge-only mode can be installed without Gateway.

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service
curl -sS http://127.0.0.1:8644/health
```

Webhook mode expects Hermes Gateway's webhook platform to be enabled. Gateway must use the same `WEBHOOK_SECRET` value as the bridge webhook secret file.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same value as the secret file created by scripts/install-hermes-stack.sh>
```

> The stack installer creates/updates the Hermes webhook subscription, but it does not edit the Hermes Gateway service env. Gateway env location can vary by host.

## 2. One-command install

```bash
git clone https://github.com/chiznoir/hermes-omx-notify.git
cd hermes-omx-notify
npm test
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --channel <fallback-discord-channel-id> \
  --project hermes-omx-notify=<project-discord-channel-id> \
  --restart
```

Replace the channel IDs with real Discord IDs for the target environment. If you need a minimal agent bridge-only install, omit `--webhook`; Hermes automatic push notifications will not be delivered in that mode.

When a Hermes config path is available, the installer writes these short env keys for the bridge service:

```env
BRIDGE_HERMES_CONFIG=~/.hermes/config.yaml
BRIDGE_HERMES_ALLOWLIST=true
BRIDGE_HERMES_RESTART=true
BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service
```

`BRIDGE_HERMES_ALLOWLIST=true` lets the bridge add newly mapped project channels to Hermes Gateway's Discord allowlist. Session threads use the parent/project channel allowlist and are not added as separate allowlist entries. Existing entries are detected across YAML continuation lines; a no-op must not restart Gateway.

Created/used files:

```text
~/.local/bin/omx-new
~/.local/bin/omx-send
~/.local/bin/omx-kill
~/.config/hermes-omx-notify/hermes-omx-notify.env
~/.hermes/skills/autonomous-ai-agents/hermes-omx-notify/SKILL.md
~/.config/systemd/user/hermes-omx-notify.service

# Only when --webhook is used
~/.config/hermes-omx-notify/hermes-webhook.secret
~/.config/hermes-omx-notify/project-channels.json
~/.hermes/webhook_subscriptions.json
```

The default scope is `--scope user`. The service is installed under `~/.config/systemd/user/hermes-omx-notify.service`, not `/etc/systemd/system`. Use `systemctl --user ...` for checks and restarts. The service runs `npm start`, and `package.json` maps that to `node src/server.js`.

## 3. Manual helper CLI install only

If you only need the CLIs, install them from the repository `bin/` directory.

```bash
bin/install.sh --force
# or
scripts/install-omx-cli.sh --force
command -v omx-new omx-send omx-kill
```

This installer does not modify Codex global hooks.

## 4. Exposing the bridge to LAN, Docker, or reverse proxies

For localhost-only `127.0.0.1`, a token can be omitted. If another host/container can reach the bridge, enable a token.

```bash
mkdir -p ~/.config/hermes-omx-notify
openssl rand -hex 32 > ~/.config/hermes-omx-notify/bridge.token
chmod 600 ~/.config/hermes-omx-notify/bridge.token

scripts/install-hermes-stack.sh \
  --token-file ~/.config/hermes-omx-notify/bridge.token
```

Set the same token in Hermes Gateway:

```env
OMX_BRIDGE_URL=http://127.0.0.1:3037
OMX_BRIDGE_TOKEN=<bridge.token value>
```

## 5. Validation

```bash
systemctl --user list-units --type=service --all | grep hermes-omx-notify
systemctl --user status hermes-omx-notify.service
systemctl --user cat hermes-omx-notify.service
curl -sS http://127.0.0.1:3037/health
curl -sS http://127.0.0.1:3037/sessions
command -v omx-new omx-send omx-kill
curl -sS http://127.0.0.1:8644/health
```

From Discord/Hermes:

```text
Use hermes-omx-notify to check bridge health and sessions.
```

## 6. Runtime env complexity rule

The runtime env file should contain only enabled features, secrets/IDs, and non-default overrides. Do not repeat built-in defaults. `scripts/install-systemd-service.sh` and `scripts/install-hermes-stack.sh` generate systemd env files using this rule. If you edit by hand, use `.env.example` as a sample and uncomment only the values you need.

### Required/recommended env

```env
# Only when exposing the bridge to LAN/Docker/reverse proxy/public access
# OMX_BRIDGE_TOKEN=<random-long-token>

# Required when enabling Hermes webhook sink
BRIDGE_HERMES_WEBHOOK_ENABLED=true
BRIDGE_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/omx-notify
BRIDGE_HERMES_WEBHOOK_SECRET=<secret>
BRIDGE_HERMES_DEFAULT_CHANNEL_ID=<fallback-channel-id>

# Required/recommended for Discord fast-path/session threads
BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true
BRIDGE_DISCORD_BOT_TOKEN=<Discord bot token>
BRIDGE_DISCORD_GUILD_ID=<Discord guild id>
BRIDGE_DISCORD_AUTO_CREATE_THREADS=true
BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true

# Recommended when auto-updating Hermes Gateway allowlists
BRIDGE_HERMES_ALLOWLIST=true
```

`BRIDGE_STATE_ROOT` has a default. Set it only when a system service has an ambiguous `HOME` or when operations require a fixed state path. It is SQLite/queue/audit-log storage, not the project root.

### Defaults usually omitted

- `HOST=127.0.0.1`, `PORT=3037`, `BRIDGE_PUBLIC_URL=http://127.0.0.1:3037`
- `BRIDGE_STATE_ROOT=~/.local/state/hermes-omx-notify` for user services
- `BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer`
- `BRIDGE_HERMES_NOTIFICATION_MODE=direct`
- `BRIDGE_HERMES_PROJECT_CHANNEL_MAP=~/.config/hermes-omx-notify/project-channels.json`
- `BRIDGE_NOTIFY_EVENT_TYPES=SessionStart,SessionLinked,SessionEnd,CommandSubmitted`
- `BRIDGE_NOTIFY_DELIVERY_SINK=discord-fast`
- `BRIDGE_FINAL_BLOCK=true`, `BRIDGE_FINAL_WAIT_MS=10000`, `BRIDGE_FINAL_SINK=hermes`
- `BRIDGE_HERMES_RESTART=true`, `BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway.service`
- `BRIDGE_DISCOVERED_PROJECT_ROOT_MAX=8`, `BRIDGE_MADMAX_RUN_MAX=8`, `BRIDGE_MADMAX_RUN_LOOKBACK_HOURS=12`, `BRIDGE_CODEX_CWD_ATTACH_SCAN_LIMIT=30`

Poll defaults favor fast notifications: `BRIDGE_HERMES_WEBHOOK_INTERVAL_MS=250`, `BRIDGE_NOTIFY_INTERVAL_MS=100`, and max 3 events per poll. Increasing them reduces CPU/Discord calls; it does not drop overflow events.
