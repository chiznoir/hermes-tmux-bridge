# Bridge + Hermes only install — agent runbook

**English** | [한국어](bridge-hermes-only-install-ko.md)

Use this runbook when a new PC or Hermes Agent should install only `hermes-codex-bridge` plus Hermes/Discord notification integration.

## Goal

The install is complete when only the following are working:

1. The `hermes-codex-bridge` server runs on `127.0.0.1:3037` as a systemd user service.
2. Hermes has the `hermes-codex-bridge`, `codex-new`, `codex-send`, and `codex-kill` skills installed.
3. The Hermes Gateway webhook subscription `codex-bridge` receives `AskPermission,FinalAnswer` events.
4. Notifications reach a Discord project channel or session thread.
5. The `codex-new`, `codex-send`, and `codex-kill` helper CLIs are on `PATH`.

The required helper CLIs are installed by `scripts/install-hermes-stack.sh`, which installs only `codex-new`, `codex-send`, and `codex-kill` for this path. To install only the CLIs, use `bin/install.sh --force` or `scripts/install-codex-cli.sh --force`.

## What this runbook does not install

These tools are outside this runbook:

- `codex-bootstrap`, `codex-status`, `codex-sync`, `codex-cleanup`
- Codex memory/search MCP, RTK, Cognee, CLIProxy, caveman helper, or other agent-extension tooling setup
- Codex global hook or MCP config changes

## Values the agent must get from the operator

Do not print secret values back to the screen. Report only file paths or whether a value was configured.

Required:

- Discord fallback channel ID: default notification channel ID.
- Discord bot token: bot token used by Hermes Gateway/bridge to send Discord messages.
- Discord guild/server ID.
- Hermes Gateway `WEBHOOK_SECRET` location or permission to configure it.

Recommended:

- Per-project Discord channel mapping, for example `hermes-codex-bridge=345678901234567890`.
- Discord user IDs to mention on `SessionStart`, for example `456789012345678901`.

Optional:

- Bridge bearer token: needed only when exposing the bridge through Docker, LAN, reverse proxy, or public access.
- Existing Hermes home path. The default is `~/.hermes`.

## Check prerequisites

```bash
node --version   # >= 20
npm --version
curl --version
jq --version
tmux -V
systemctl --user status hermes-gateway.service --no-pager || true
curl -sS http://127.0.0.1:8644/health || true
```

The Hermes Gateway webhook platform must be enabled. Gateway env must include the values below, and `WEBHOOK_SECRET` must match the secret file used by the bridge installer.

```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=<same value as the bridge secret file>
```

Gateway env locations vary by install. The agent should ask the operator for the location instead of guessing.

## Clone and verify

```bash
git clone https://github.com/chiznoir/hermes-codex-bridge.git
cd hermes-codex-bridge
npm install
npm test
```

## Recommended install: include Hermes webhook notifications

This command installs the bridge service, Hermes skills, webhook subscription, and helper CLIs together.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id>
```

You can pass `--project` more than once.

```bash
scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project hermes-codex-bridge=<project-channel-id> \
  --project other-project=<other-project-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id>
```

If the bridge stays on the same host at `127.0.0.1`, the bridge bearer token can be empty. If it is exposed through Docker, LAN, a reverse proxy, or public access, create a token file and add `--token-file`.

```bash
mkdir -p ~/.config/hermes-codex-bridge
openssl rand -hex 32 > ~/.config/hermes-codex-bridge/bridge.token
chmod 600 ~/.config/hermes-codex-bridge/bridge.token

scripts/install-hermes-stack.sh \
  --webhook \
  --non-interactive \
  --restart \
  --direct \
  --threads \
  --channel <fallback-discord-channel-id> \
  --project <project-name>=<project-discord-channel-id> \
  --bot-token '<discord-bot-token>' \
  --guild <discord-guild-or-server-id> \
  --mention-users <discord-user-id> \
  --token-file ~/.config/hermes-codex-bridge/bridge.token
```

## Bridge-only mode where Hermes queries the API directly

If you do not need automatic Discord push notifications and Hermes only needs to query the bridge API, install without `--webhook`. This mode does not create a Hermes Gateway webhook subscription.

```bash
scripts/install-hermes-stack.sh --non-interactive --restart
```

In this mode, `FinalAnswer` / `AskPermission` automatic notifications will not be sent.

## Installed artifacts

```text
~/.local/bin/codex-new
~/.local/bin/codex-send
~/.local/bin/codex-kill
~/.hermes/skills/autonomous-ai-agents/hermes-codex-bridge/SKILL.md
~/.hermes/skills/autonomous-ai-agents/codex-new/SKILL.md
~/.hermes/skills/autonomous-ai-agents/codex-send/SKILL.md
~/.hermes/skills/autonomous-ai-agents/codex-kill/SKILL.md
~/.config/systemd/user/hermes-codex-bridge.service
~/.config/hermes-codex-bridge/hermes-codex-bridge.env
~/.config/hermes-codex-bridge/hermes-webhook.secret
~/.config/hermes-codex-bridge/project-channels.json
~/.hermes/webhook_subscriptions.json
```

## Verify

```bash
systemctl --user is-active hermes-codex-bridge.service
systemctl --user status hermes-codex-bridge.service --no-pager
curl -fsS http://127.0.0.1:3037/health | jq .

systemctl --user is-active hermes-gateway.service
curl -fsS http://127.0.0.1:8644/health | jq .

command -v codex-new codex-send codex-kill
hermes skills list | grep 'hermes-codex-bridge'
```

Also verify that the webhook subscription prompt is current. `FinalAnswer` remains the internal event type, but the user-facing title should be `Session Idle`.

```bash
python - <<'PY'
import json, os
p = os.path.expanduser('~/.hermes/webhook_subscriptions.json')
data = json.load(open(p))
sub = data.get('codex-bridge') or data.get('subscriptions', {}).get('codex-bridge')
prompt = sub.get('prompt', '') if sub else ''
assert sub and sub.get('events') == ['AskPermission', 'FinalAnswer']
assert '제목 `Final Answer`' not in prompt
assert 'Session Idle' in prompt
print('ok: codex-bridge subscription prompt is current')
PY
```

## Notification smoke test

1. Create a new visible session from Hermes or a local shell.

```bash
codex-new . --name codex-smoke --attach
```

2. In another shell, check dry-run command dispatch.

```bash
codex-send --list
codex-send --session <bridge-session-id-or-tmux-id> --dry-run 'bridge binding smoke check'
```

3. If real delivery is needed, send without dry-run.

```bash
codex-send --session <bridge-session-id-or-tmux-id> 'Briefly answer only the current cwd and whether you can work.'
```

Expected results:

- A `User Command` notification appears in the project channel or session thread.
- The completion notification uses the user-facing title `Session Idle`, even if the internal payload is `event_type=FinalAnswer`.
- Standalone `SessionIdle` skeleton notifications do not appear separately.
