#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install hermes-codex-bridge as a systemd service.

Default installs a per-user service so it can access the same user's ~/.codex,
tmux socket, and local bridge state. Project Codex logs are discovered from live
tmux panes by the bridge sink; pass --project-root only for an extra fixed scan
root.

Usage:
  scripts/install-systemd-service.sh [options]

Options:
  --user                  Install systemd user service (default)
  --system                Install system service under /etc/systemd/system
  --name NAME             Service name (default: hermes-codex-bridge)
  --host HOST             Bind host (default: 127.0.0.1)
  --port PORT             HTTP port (default: 3037)
  --project-root PATH     Optional fixed Codex project root to scan
  --repo-root PATH        Bridge repository root (default: parent of scripts/)
  --state-root PATH       Bridge-owned state/log/cache root
  --token TOKEN           Bearer token for bridge API (optional for 127.0.0.1)
  --token-file PATH       Read Bearer token from first line of file
  --notify                Enable bridge Discord notifier (default: disabled)
  --webhook URL           Discord webhook URL for bridge notifier
  --webhook-file PATH     Read Discord webhook URL from first line of file
  --no-notify             Disable bridge Discord notifier
  --sink                  Enable Hermes Gateway webhook sink
  --sink-url URL
                           Hermes webhook endpoint (default: http://127.0.0.1:8644/webhooks/codex-bridge)
  --secret SECRET
                           HMAC secret for Hermes webhook subscription
  --secret-file PATH
                           Read Hermes webhook secret from first line of file
  --channel ID
                           Fallback Discord channel id for Hermes sink payloads (does not enable sink)
  --mode summary|direct
                           Hermes FinalAnswer notification mode (default: direct)
  --direct                 Shortcut for --mode direct
  --summary                Shortcut for --mode summary
  --map PATH
                           Project->Discord channel JSON map for Hermes sink (does not enable sink)
  --bot-token TOKEN
                           Discord bot token for deterministic project channel lookup/create
  --bot-token-file PATH
                           Read Discord bot token from first line of file
  --guild ID              Discord guild/server id for project channel lookup/create
  --alert-channel ID      Discord channel id for delivery-dead operator alerts
  --mention-users IDS      Comma-separated Discord user ids to mention on initial SessionStart
  --threads
                           Create/reuse one Discord thread per session under the project channel (default)
  --no-threads             Send to the project channel instead of per-session threads
  --config PATH            Hermes config.yaml to update with new Discord channels
  --restart-cmd CMD
                           Command run after Hermes channel allowlist updates
  --env-file PATH         Env file path to write/use
  --npm PATH              npm executable (default: command -v npm)
  --no-enable             Do not enable service
  --no-start              Do not start/restart service
  --dry-run               Print generated files and commands without writing
  -h, --help              Show this help

Examples:
  scripts/install-systemd-service.sh --token-file ~/.config/hermes/codex-bridge.token
  scripts/install-systemd-service.sh --system --state-root /var/lib/hermes-codex-bridge --token 'change-me'
USAGE
}

scope="user"
name="hermes-codex-bridge"
host="127.0.0.1"
port="3037"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
project_root=""
state_root=""
token="${BRIDGE_TOKEN:-}"
token_file=""
webhook=""
webhook_file=""
notify_enabled="false"
hermes_webhook_enabled="false"
hermes_webhook_url="${BRIDGE_HERMES_WEBHOOK_URL:-http://127.0.0.1:8644/webhooks/codex-bridge}"
hermes_webhook_secret="${BRIDGE_HERMES_WEBHOOK_SECRET:-}"
hermes_webhook_secret_file=""
hermes_default_channel_id="${BRIDGE_HERMES_DEFAULT_CHANNEL_ID:-}"
hermes_notification_mode="${BRIDGE_HERMES_NOTIFICATION_MODE:-direct}"
project_channel_map="${BRIDGE_HERMES_PROJECT_CHANNEL_MAP:-}"
discord_bot_token="${BRIDGE_DISCORD_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
discord_bot_token_file=""
discord_guild_id="${BRIDGE_DISCORD_GUILD_ID:-${DISCORD_GUILD_ID:-${DISCORD_SERVER_ID:-}}}"
discord_alert_channel_id="${DISCORD_ALERT_CHANNEL_ID:-}"
discord_mention_users="${BRIDGE_DISCORD_MENTION_USERS:-${BRIDGE_DISCORD_MENTION_USER:-${BRIDGE_DISCORD_SESSION_START_MENTION_USER_IDS:-${BRIDGE_DISCORD_SESSION_START_MENTION_USER_ID:-}}}}"
discord_auto_create_threads="${BRIDGE_DISCORD_AUTO_CREATE_THREADS:-true}"
hermes_config_path="${BRIDGE_HERMES_CONFIG:-}"
hermes_gateway_restart_command="${BRIDGE_HERMES_RESTART_CMD:-systemctl --user restart --no-block hermes-gateway.service}"
env_file=""
npm_bin="$(command -v npm || true)"
enable_service=1
start_service=1
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) scope="user"; shift ;;
    --system) scope="system"; shift ;;
    --name) name="${2:?missing --name value}"; shift 2 ;;
    --host) host="${2:?missing --host value}"; shift 2 ;;
    --port) port="${2:?missing --port value}"; shift 2 ;;
    --project-root) project_root="${2:?missing --project-root value}"; shift 2 ;;
    --repo-root) repo_root="${2:?missing --repo-root value}"; shift 2 ;;
    --state-root) state_root="${2:?missing --state-root value}"; shift 2 ;;
    --token) token="${2:?missing --token value}"; shift 2 ;;
    --token-file) token_file="${2:?missing --token-file value}"; shift 2 ;;
    --notify) notify_enabled="true"; shift ;;
    --webhook) webhook="${2:?missing --webhook value}"; notify_enabled="true"; shift 2 ;;
    --webhook-file) webhook_file="${2:?missing --webhook-file value}"; notify_enabled="true"; shift 2 ;;
    --no-notify) notify_enabled="false"; shift ;;
    --sink) hermes_webhook_enabled="true"; shift ;;
    --sink-url) hermes_webhook_url="${2:?missing --sink-url value}"; hermes_webhook_enabled="true"; shift 2 ;;
    --secret) hermes_webhook_secret="${2:?missing --secret value}"; hermes_webhook_enabled="true"; shift 2 ;;
    --secret-file) hermes_webhook_secret_file="${2:?missing --secret-file value}"; hermes_webhook_enabled="true"; shift 2 ;;
    --channel) hermes_default_channel_id="${2:?missing --channel value}"; shift 2 ;;
    --mode) hermes_notification_mode="${2:?missing --mode value}"; shift 2 ;;
    --direct) hermes_notification_mode="direct"; shift ;;
    --summary) hermes_notification_mode="summary"; shift ;;
    --map) project_channel_map="${2:?missing --map value}"; shift 2 ;;
    --bot-token) discord_bot_token="${2:?missing --bot-token value}"; shift 2 ;;
    --bot-token-file) discord_bot_token_file="${2:?missing --bot-token-file value}"; shift 2 ;;
    --guild) discord_guild_id="${2:?missing --guild value}"; shift 2 ;;
    --alert-channel) discord_alert_channel_id="${2:?missing --alert-channel value}"; shift 2 ;;
    --mention-users) discord_mention_users="${2:?missing --mention-users value}"; shift 2 ;;
    --threads) discord_auto_create_threads="true"; shift ;;
    --no-threads) discord_auto_create_threads="false"; shift ;;
    --config) hermes_config_path="${2:?missing --config value}"; shift 2 ;;
    --restart-cmd) hermes_gateway_restart_command="${2:?missing --restart-cmd value}"; shift 2 ;;
    --env-file) env_file="${2:?missing --env-file value}"; shift 2 ;;
    --npm) npm_bin="${2:?missing --npm value}"; shift 2 ;;
    --no-enable) enable_service=0; shift ;;
    --no-start) start_service=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$token_file" ]]; then
  token="$(head -n 1 "$token_file" | tr -d '\r\n')"
fi
if [[ -n "$webhook_file" ]]; then
  webhook="$(head -n 1 "$webhook_file" | tr -d '\r\n')"
fi
if [[ -n "$hermes_webhook_secret_file" ]]; then
  hermes_webhook_secret="$(head -n 1 "$hermes_webhook_secret_file" | tr -d '\r\n')"
fi
if [[ -n "$discord_bot_token_file" ]]; then
  discord_bot_token="$(head -n 1 "$discord_bot_token_file" | tr -d '\r\n')"
fi

read_env_key() {
  local key="$1" file="$2" line value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#export }"
    [[ "$line" == "$key="* ]] || continue
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%'}"; value="${value#'}"
    printf '%s' "$value"
    return 0
  done < "$file"
}

if [[ -z "$npm_bin" ]]; then
  echo "npm executable not found; pass --npm /path/to/npm" >&2
  exit 1
fi

repo_root="$(cd "$repo_root" && pwd)"
if [[ "$scope" == "user" ]]; then
  service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  default_env_dir="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-codex-bridge"
  default_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/hermes-codex-bridge"
  systemctl_cmd=(systemctl --user)
  service_path="$service_dir/$name.service"
else
  service_dir="/etc/systemd/system"
  default_env_dir="/etc/hermes-codex-bridge"
  default_state_root="/var/lib/hermes-codex-bridge"
  systemctl_cmd=(systemctl)
  service_path="$service_dir/$name.service"
fi

state_root="${state_root:-$default_state_root}"
state_root="$(realpath -m "$state_root")"
if [[ -n "$project_root" ]]; then
  project_root="$(realpath -m "$project_root")"
fi

env_file="${env_file:-$default_env_dir/$name.env}"
path_value="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

escaped_path_value="${path_value//\\/\\\\}"
escaped_path_value="${escaped_path_value//\"/\\\"}"

service_content="[Unit]
Description=Hermes Codex Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=$repo_root
EnvironmentFile=$env_file
Environment=\"PATH=$escaped_path_value\"
ExecStart=$npm_bin start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"

if [[ "$scope" == "system" ]]; then
  service_content="${service_content/WantedBy=default.target/WantedBy=multi-user.target}"
fi

env_content="NODE_ENV=production
"

append_env() {
  local key="$1" value="$2"
  [[ -n "$value" ]] || return 0
  env_content+="$key=$value
"
}

# Do not write code defaults into the runtime env file. The env file should show
# only operator intent: enabled features, secrets/ids, non-default routing, and
# non-default bind/state choices.
if [[ "$host" != "127.0.0.1" ]]; then
  append_env HOST "$host"
fi
if [[ "$port" != "3037" ]]; then
  append_env PORT "$port"
fi
if [[ "$scope" == "system" || "$state_root" != "$default_state_root" ]]; then
  append_env BRIDGE_STATE_ROOT "$state_root"
fi
if [[ -n "$project_root" ]]; then
  append_env PROJECT_ROOT "$project_root"
fi
if [[ "$notify_enabled" == "true" ]]; then
  append_env BRIDGE_NOTIFY_ENABLED true
fi
if [[ "$hermes_webhook_enabled" == "true" ]]; then
  append_env BRIDGE_HERMES_WEBHOOK_ENABLED true
fi
if [[ "$notify_enabled" == "true" && -n "$webhook" ]]; then
  append_env BRIDGE_DISCORD_WEBHOOK_URL "$webhook"
fi
if [[ "$hermes_webhook_enabled" == "true" && -n "$hermes_webhook_url" ]]; then
  append_env BRIDGE_HERMES_WEBHOOK_URL "$hermes_webhook_url"
fi
if [[ "$hermes_webhook_enabled" == "true" && -n "$hermes_webhook_secret" ]]; then
  append_env BRIDGE_HERMES_WEBHOOK_SECRET "$hermes_webhook_secret"
fi
if [[ "$hermes_webhook_enabled" == "true" && -n "$hermes_default_channel_id" ]]; then
  append_env BRIDGE_HERMES_DEFAULT_CHANNEL_ID "$hermes_default_channel_id"
fi
if [[ "$hermes_webhook_enabled" == "true" && "$hermes_notification_mode" != "direct" ]]; then
  append_env BRIDGE_HERMES_NOTIFICATION_MODE "$hermes_notification_mode"
fi
user_default_channel_map="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-codex-bridge/project-channels.json"
if [[ "$hermes_webhook_enabled" == "true" && -n "$project_channel_map" ]]; then
  if [[ "$scope" == "system" || "$project_channel_map" != "$user_default_channel_map" ]]; then
    append_env BRIDGE_HERMES_PROJECT_CHANNEL_MAP "$project_channel_map"
  fi
fi
if [[ -n "$discord_bot_token" ]]; then
  append_env BRIDGE_DISCORD_BOT_TOKEN "$discord_bot_token"
fi
if [[ -n "$discord_guild_id" ]]; then
  append_env BRIDGE_DISCORD_GUILD_ID "$discord_guild_id"
fi
if [[ -n "$discord_alert_channel_id" ]]; then
  append_env DISCORD_ALERT_CHANNEL_ID "$discord_alert_channel_id"
fi
if [[ -n "$discord_mention_users" ]]; then
  append_env BRIDGE_DISCORD_MENTION_USERS "$discord_mention_users"
fi
if [[ "$hermes_webhook_enabled" == "true" && -n "$discord_bot_token" ]]; then
  append_env BRIDGE_DISCORD_FAST_EVENTS_ENABLED true
  append_env BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS true
fi
if [[ "$hermes_webhook_enabled" == "true" && "${discord_auto_create_threads,,}" == "true" ]]; then
  append_env BRIDGE_DISCORD_AUTO_CREATE_THREADS true
fi
if [[ -n "$hermes_config_path" ]]; then
  default_hermes_config_path="$HOME/.hermes/config.yaml"
  if [[ "$scope" == "system" || "$hermes_config_path" != "$default_hermes_config_path" ]]; then
    append_env BRIDGE_HERMES_CONFIG "$hermes_config_path"
  fi
  append_env BRIDGE_HERMES_ALLOWLIST true
  if [[ -n "$hermes_gateway_restart_command" && "$hermes_gateway_restart_command" != "systemctl --user restart --no-block hermes-gateway.service" ]]; then
    append_env BRIDGE_HERMES_RESTART_CMD "$hermes_gateway_restart_command"
  fi
fi
if [[ -n "$token" ]]; then
  env_content+="BRIDGE_TOKEN=$token
"
else
  cat >&2 <<'WARN'
NOTE: BRIDGE_TOKEN is empty. This is acceptable for same-host
HOST=127.0.0.1 deployments. Set --token or --token-file before exposing the
bridge through Docker, LAN, reverse proxy, or public interfaces.
WARN
fi

write_file() {
  local path="$1"
  local content="$2"
  local mode="${3:-0644}"
  if [[ "$dry_run" == "1" ]]; then
    local printable="$content"
    printable="$(printf '%s' "$printable" | sed -E 's#(BRIDGE_TOKEN=).*#\1<redacted>#; s#(BRIDGE_DISCORD_WEBHOOK_URL=).*#\1<redacted>#; s#(BRIDGE_HERMES_WEBHOOK_SECRET=).*#\1<redacted>#; s#(BRIDGE_DISCORD_BOT_TOKEN=).*#\1<redacted>#')"
    printf '\n--- %s ---\n%s\n' "$path" "$printable"
    return
  fi
  if [[ "$scope" == "system" ]]; then
    sudo install -d -m 0755 "$(dirname "$path")"
    printf '%s' "$content" | sudo tee "$path" >/dev/null
    sudo chmod "$mode" "$path"
  else
    install -d -m 0755 "$(dirname "$path")"
    printf '%s' "$content" > "$path"
    chmod "$mode" "$path"
  fi
}

run_systemctl() {
  if [[ "$dry_run" == "1" ]]; then
    printf 'DRY-RUN:'
    for part in "${systemctl_cmd[@]}" "$@"; do
      printf ' %q' "$part"
    done
    printf '\n'
    return
  fi
  "${systemctl_cmd[@]}" "$@"
}

write_file "$env_file" "$env_content" 0600
write_file "$service_path" "$service_content" 0644

if [[ "$dry_run" == "1" ]]; then
  printf 'DRY-RUN: install -d -m 0755 %q\n' "$state_root"
elif [[ "$scope" == "system" ]]; then
  sudo install -d -m 0755 "$state_root"
else
  install -d -m 0755 "$state_root"
fi

run_systemctl daemon-reload
if [[ "$enable_service" == "1" ]]; then
  run_systemctl enable "$name.service"
fi
if [[ "$start_service" == "1" ]]; then
  run_systemctl restart "$name.service"
fi

cat <<EOF2
Installed $name.service ($scope)
Service file: $service_path
Env file:     $env_file
State root:   $state_root
Project root: ${project_root:-tmux-discovered}
Host:         $host
Port:         $port
Notifier:     $notify_enabled
Hermes sink:  $hermes_webhook_enabled

Check:
  ${systemctl_cmd[*]} status $name.service
  curl -sS http://$host:$port/health
EOF2

if [[ "$scope" == "user" ]]; then
  cat <<EOF2

If the service must survive logout, run once:
  loginctl enable-linger $(id -un)
EOF2
fi
