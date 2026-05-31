#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Apply the checked-out hermes-codex-bridge repo to the local runtime service.

This is the repeatable "after code update" step: reload systemd units, restart
the bridge service, and wait for /health to return ok.

Usage:
  scripts/apply-runtime.sh [options]

Options:
  --user                  Restart the per-user systemd service (default)
  --system                Restart the system service
  --name NAME             Service name (default: hermes-codex-bridge)
  --host HOST             Health check host (default: 127.0.0.1)
  --port PORT             Health check port (default: PORT env or 3037)
  --health-url URL        Full health URL (default: http://HOST:PORT/health)
  --timeout SECONDS       Health wait timeout (default: 20)
  --no-reload             Skip systemd daemon-reload
  --no-restart            Skip service restart and only run health check
  --skip-health           Do not wait for /health
  --dry-run               Print actions without executing them
  -h, --help              Show this help

Examples:
  scripts/apply-runtime.sh
  npm run apply:runtime
  scripts/apply-runtime.sh --system --name hermes-codex-bridge --port 3037
USAGE
}

scope="user"
name="${BRIDGE_SERVICE_NAME:-hermes-codex-bridge}"
host="${HOST:-127.0.0.1}"
port="${PORT:-3037}"
health_url=""
timeout="${BRIDGE_RUNTIME_APPLY_TIMEOUT:-20}"
reload_systemd=1
restart_service=1
skip_health=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) scope="user"; shift ;;
    --system) scope="system"; shift ;;
    --name) name="${2:?missing --name value}"; shift 2 ;;
    --host) host="${2:?missing --host value}"; shift 2 ;;
    --port) port="${2:?missing --port value}"; shift 2 ;;
    --health-url) health_url="${2:?missing --health-url value}"; shift 2 ;;
    --timeout) timeout="${2:?missing --timeout value}"; shift 2 ;;
    --no-reload) reload_systemd=0; shift ;;
    --no-restart) restart_service=0; shift ;;
    --skip-health) skip_health=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$timeout" =~ ^[0-9]+$ ]] || [[ "$timeout" -lt 1 ]]; then
  echo "--timeout must be a positive integer" >&2
  exit 2
fi

if [[ -z "$health_url" ]]; then
  health_url="http://${host}:${port}/health"
fi

if [[ "$scope" == "user" ]]; then
  systemctl_cmd=(systemctl --user)
else
  systemctl_cmd=(systemctl)
fi

print_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [[ "$dry_run" -eq 0 ]]; then
    "$@"
  fi
}

health_ok() {
  local body
  body="$(curl -fsS "$health_url" 2>/dev/null || true)"
  [[ "$body" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]
}

if [[ "$dry_run" -eq 1 ]]; then
  echo "Runtime apply plan:"
  echo "  scope: $scope"
  echo "  service: ${name}.service"
  echo "  health: $([[ "$skip_health" -eq 1 ]] && echo skipped || echo "$health_url")"
fi

if [[ "$reload_systemd" -eq 1 ]]; then
  run_cmd "${systemctl_cmd[@]}" daemon-reload
fi

if [[ "$restart_service" -eq 1 ]]; then
  run_cmd "${systemctl_cmd[@]}" restart "${name}.service"
fi

if [[ "$skip_health" -eq 1 ]]; then
  echo "runtime apply complete: health check skipped"
  exit 0
fi

if [[ "$dry_run" -eq 1 ]]; then
  print_cmd curl -fsS "$health_url"
  echo "runtime apply dry-run complete"
  exit 0
fi

deadline=$((SECONDS + timeout))
until health_ok; do
  if (( SECONDS >= deadline )); then
    echo "health check failed after ${timeout}s: $health_url" >&2
    "${systemctl_cmd[@]}" status "${name}.service" --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

echo "runtime apply complete: ${name}.service is healthy at $health_url"
