#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/set-hermes-fallback-channel.sh CHANNEL_ID [options]

Update the Hermes Codex Bridge fallback Discord channel in both:
  - project channel map default
  - bridge service env fallback keys

Options:
  --map PATH           Channel map path
                       (default: $BRIDGE_HERMES_PROJECT_CHANNEL_MAP or
                        ~/.config/hermes-codex-bridge/project-channels.json)
  --env-file PATH      Bridge service env file
                       (default: ~/.config/hermes-codex-bridge/hermes-codex-bridge.env)
  --restart            Restart the user systemd bridge service after updating
  --no-restart         Do not restart the service (default)
  --service NAME       systemd --user service name
                       (default: hermes-codex-bridge.service)
  --dry-run            Print intended changes without writing files
  -h, --help           Show this help

Example:
  scripts/set-hermes-fallback-channel.sh <fallback-channel-id> --restart
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

channel_id=""
channel_map="${BRIDGE_HERMES_PROJECT_CHANNEL_MAP:-$HOME/.config/hermes-codex-bridge/project-channels.json}"
env_file="$HOME/.config/hermes-codex-bridge/hermes-codex-bridge.env"
service_name="hermes-codex-bridge.service"
restart=false
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --map) channel_map="${2:?missing --map value}"; shift 2 ;;
    --env-file) env_file="${2:?missing --env-file value}"; shift 2 ;;
    --service) service_name="${2:?missing --service value}"; shift 2 ;;
    --restart) restart=true; shift ;;
    --no-restart) restart=false; shift ;;
    --dry-run) dry_run=true; shift ;;
    --*) die "unknown option: $1" ;;
    *)
      if [[ -n "$channel_id" ]]; then
        die "unexpected extra argument: $1"
      fi
      channel_id="$1"
      shift
      ;;
  esac
done

[[ -n "$channel_id" ]] || die "CHANNEL_ID is required"
[[ "$channel_id" =~ ^[0-9]{15,25}$ ]] || die "CHANNEL_ID must look like a Discord snowflake"

if [[ "$dry_run" == "true" ]]; then
  printf 'DRY-RUN: would set fallback channel to %s\n' "$channel_id"
  printf 'DRY-RUN: channel map: %s\n' "$channel_map"
  printf 'DRY-RUN: env file: %s\n' "$env_file"
  printf 'DRY-RUN: would update env keys: BRIDGE_HERMES_DEFAULT_CHANNEL_ID, BRIDGE_DISCORD_CHANNEL_ID, TARGET_ID\n'
  [[ "$restart" == "true" ]] && printf 'DRY-RUN: would restart %s\n' "$service_name"
  exit 0
fi

CHANNEL_ID="$channel_id" CHANNEL_MAP="$channel_map" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const channelId = process.env.CHANNEL_ID;
const channelMap = process.env.CHANNEL_MAP;
fs.mkdirSync(path.dirname(channelMap), { recursive: true });

let map = { projects: {} };
try {
  if (fs.existsSync(channelMap)) {
    const parsed = JSON.parse(fs.readFileSync(channelMap, 'utf8'));
    if (parsed && typeof parsed === 'object') map = { projects: {}, ...parsed };
  }
} catch {
  map = { projects: {} };
}

if (!map.projects || typeof map.projects !== 'object') map.projects = {};
map.default = channelId;
delete map.default_channel_id;
fs.writeFileSync(channelMap, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
NODE

ENV_FILE="$env_file" CHANNEL_ID="$channel_id" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const envFile = process.env.ENV_FILE;
const channelId = process.env.CHANNEL_ID;
const keys = ['BRIDGE_HERMES_DEFAULT_CHANNEL_ID', 'BRIDGE_DISCORD_CHANNEL_ID', 'TARGET_ID'];

fs.mkdirSync(path.dirname(envFile), { recursive: true });
const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
const seen = new Set();
const output = [];

for (const line of existing) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  if (match && keys.includes(match[1])) {
    if (!seen.has(match[1])) {
      output.push(`${match[1]}=${channelId}`);
      seen.add(match[1]);
    }
    continue;
  }
  if (line.length > 0) output.push(line);
}

for (const key of keys) {
  if (!seen.has(key)) output.push(`${key}=${channelId}`);
}

fs.writeFileSync(envFile, `${output.join('\n')}\n`, { mode: 0o600 });
NODE

printf 'Updated Hermes fallback channel to %s\n' "$channel_id"
printf 'Updated channel map: %s\n' "$channel_map"
printf 'Updated env file: %s\n' "$env_file"

if [[ "$restart" == "true" ]]; then
  systemctl --user restart "$service_name"
  printf 'Restarted %s\n' "$service_name"
fi

if command -v curl >/dev/null 2>&1; then
  bridge_url="${BRIDGE_URL:-http://127.0.0.1:3037}"
  printf 'Current bridge fallback probe:\n'
  curl -fsS "$bridge_url/projects/__missing_probe__/channel" || true
  printf '\n'
fi
