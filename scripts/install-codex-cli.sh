#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install hermes-codex-bridge helper CLIs onto PATH.

Usage:
  scripts/install-codex-cli.sh [options]

Installs:
  codex-new   Start a visible Codex tmux session
  codex-send  Send follow-up commands through the bridge API
  codex-kill  Stop the tmux session referenced by a bridge session

Options:
  --dir PATH          Target bin directory (default: $CODEX_CLI_INSTALL_DIR or ~/.local/bin)
  --repo-root PATH    Bridge repository root (default: parent of scripts/)
  --copy              Copy files instead of creating symlinks
  --force             Replace existing files/links at the target path
  --uninstall         Remove symlinks/copies installed from this repository
  --dry-run           Print actions without writing
  -h, --help          Show help

Notes:
  - This installer only manages codex-new, codex-send, and codex-kill.
  - It does not install or modify Codex global hooks.
  - Keep the target directory on PATH for Hermes/Gateway workers.
USAGE
}

script_name="$(basename "$0")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
target_dir="${CODEX_CLI_INSTALL_DIR:-$HOME/.local/bin}"
copy_mode=0
force=0
uninstall=0
dry_run=0
tools=(codex-new codex-send codex-kill)

log() { printf '%s\n' "$*"; }
die() { echo "$script_name: $*" >&2; exit 1; }

trim_trailing_slash() {
  local value="$1"
  while [[ "$value" != "/" && "$value" == */ ]]; do value="${value%/}"; done
  printf '%s' "$value"
}

path_contains_dir() {
  local dir="$1"
  case ":$PATH:" in *":$dir:"*) return 0 ;; *) return 1 ;; esac
}

install_tool() {
  local tool="$1" src="$repo_root/bin/$tool" dst="$target_dir/$tool" current_target=""
  [[ -x "$src" ]] || die "missing executable source: $src"

  if [[ "$dry_run" == "1" ]]; then
    if [[ "$copy_mode" == "1" ]]; then
      log "DRY-RUN: install -m 0755 '$src' '$dst'"
    else
      log "DRY-RUN: ln -s '$src' '$dst'"
    fi
    return 0
  fi

  mkdir -p "$target_dir"
  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst" || true)"
    if [[ "$current_target" == "$src" && "$copy_mode" == "0" ]]; then
      log "Already installed: $dst -> $src"
      return 0
    fi
  fi

  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ "$force" == "1" ]]; then
      rm -f "$dst"
    else
      die "target exists: $dst (use --force to replace it)"
    fi
  fi

  if [[ "$copy_mode" == "1" ]]; then
    install -m 0755 "$src" "$dst"
    log "Installed copy: $dst"
  else
    ln -s "$src" "$dst"
    log "Installed symlink: $dst -> $src"
  fi
}

uninstall_tool() {
  local tool="$1" src="$repo_root/bin/$tool" dst="$target_dir/$tool" current_target=""
  if [[ "$dry_run" == "1" ]]; then
    log "DRY-RUN: remove repository-managed '$dst' if present"
    return 0
  fi

  if [[ ! -e "$dst" && ! -L "$dst" ]]; then
    log "Already absent: $dst"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst" || true)"
    if [[ "$current_target" == "$src" ]]; then
      rm -f "$dst"
      log "Removed symlink: $dst"
      return 0
    fi
    die "refusing to remove symlink not managed by this repository: $dst -> $current_target"
  fi

  if cmp -s "$src" "$dst"; then
    rm -f "$dst"
    log "Removed copied helper: $dst"
    return 0
  fi

  die "refusing to remove file not matching repository helper: $dst"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) target_dir="${2:?missing --dir value}"; shift 2 ;;
    --repo-root) repo_root="${2:?missing --repo-root value}"; shift 2 ;;
    --copy) copy_mode=1; shift ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

repo_root="$(cd "$repo_root" && pwd)"
target_dir="$(trim_trailing_slash "$target_dir")"

if [[ "$dry_run" != "1" ]]; then
  mkdir -p "$target_dir"
fi

for tool in "${tools[@]}"; do
  if [[ "$uninstall" == "1" ]]; then
    uninstall_tool "$tool"
  else
    install_tool "$tool"
  fi
done

log ""
log "Target dir: $target_dir"
if path_contains_dir "$target_dir"; then
  log "PATH check: ok"
else
  log "PATH check: $target_dir is not currently on PATH"
  log "  export PATH=\"$target_dir:\$PATH\""
fi
