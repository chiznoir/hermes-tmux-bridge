#!/usr/bin/env bash
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

usage() {
  cat <<USAGE
Usage:
  bin/install.sh [install-codex-cli options]

Description:
  Install only the core hermes-codex-bridge helper CLIs onto PATH:
    codex-new
    codex-send
    codex-kill

This core installer is a thin wrapper around scripts/install-codex-cli.sh.
It does not install global Codex hooks, codex-bootstrap, codex-status,
codex-sync, or other agent-extension tooling.

Common options:
  --dir PATH      Target bin directory (default: ~/.local/bin)
  --force         Replace existing files or symlinks
  --copy          Install copies instead of symlinks
  --uninstall     Remove helper links/copies installed from this repository
  --dry-run       Print actions without changing files
  -h, --help      Show this help
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --hooks|--no-global)
      printf 'error: %s belonged to the old extension installer and is not supported by bridge core\n' "$arg" >&2
      printf 'hint: use scripts/install-codex-cli.sh or bin/install.sh for codex-new/codex-send/codex-kill only\n' >&2
      exit 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

exec "$repo_root/scripts/install-codex-cli.sh" --repo-root "$repo_root" "$@"
