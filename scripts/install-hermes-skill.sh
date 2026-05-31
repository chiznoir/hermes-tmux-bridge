#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install Hermes Codex bridge/read and helper lifecycle skills.

Usage:
  scripts/install-hermes-skill.sh [options]

Options:
  --hermes-home PATH    Hermes home (default: $HERMES_HOME or ~/.hermes)
  --category NAME       Skill category folder (default: autonomous-ai-agents)
  --name NAME           Skill folder name (default: hermes-codex-bridge)
  --source PATH         Source skill dir (default: repo skills/hermes-codex-bridge)
  --no-helper-skills    Do not install codex-new/codex-send/codex-kill helper skills
  --dry-run             Print actions without writing
  -h, --help            Show help
USAGE
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
category="autonomous-ai-agents"
name="hermes-codex-bridge"
source_dir="$repo_root/skills/hermes-codex-bridge"
dry_run=0
install_helper_skills=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home) hermes_home="${2:?missing --hermes-home value}"; shift 2 ;;
    --category) category="${2:?missing --category value}"; shift 2 ;;
    --name) name="${2:?missing --name value}"; shift 2 ;;
    --source) source_dir="${2:?missing --source value}"; shift 2 ;;
    --no-helper-skills) install_helper_skills=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -f "$source_dir/SKILL.md" ]]; then
  echo "Missing source skill: $source_dir/SKILL.md" >&2
  exit 1
fi

install_skill() {
  local skill_name="$1"
  local skill_source_dir="$2"
  local target_dir="$hermes_home/skills/$category/$skill_name"

  if [[ ! -f "$skill_source_dir/SKILL.md" ]]; then
    echo "Missing source skill: $skill_source_dir/SKILL.md" >&2
    exit 1
  fi

  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: install -d '$target_dir'"
    echo "DRY-RUN: cp -R '$skill_source_dir/.' '$target_dir/'"
  else
    install -d -m 0755 "$target_dir"
    cp -R "$skill_source_dir/." "$target_dir/"
  fi
}

sync_existing_profile_skill() {
  local skill_name="$1"
  local skill_source_dir="$2"
  local profile_root="$hermes_home/profiles"

  [[ -d "$profile_root" ]] || return 0
  local profile_target
  while IFS= read -r -d '' profile_target; do
    if [[ "$dry_run" == "1" ]]; then
      echo "DRY-RUN: cp -R '$skill_source_dir/.' '$profile_target/'"
    else
      cp -R "$skill_source_dir/." "$profile_target/"
    fi
    synced_profile_skills+=("$profile_target")
  done < <(find "$profile_root" -mindepth 4 -maxdepth 4 -type d -path "*/skills/$category/$skill_name" -print0 2>/dev/null)
}

synced_profile_skills=()
install_skill "$name" "$source_dir"

installed_helper_skills=()
if [[ "$install_helper_skills" == "1" && "$name" == "hermes-codex-bridge" && "$source_dir" == "$repo_root/skills/hermes-codex-bridge" ]]; then
  for helper_skill in codex-new codex-send codex-kill; do
    helper_source_dir="$repo_root/skills/$helper_skill"
    install_skill "$helper_skill" "$helper_source_dir"
    sync_existing_profile_skill "$helper_skill" "$helper_source_dir"
    installed_helper_skills+=("$hermes_home/skills/$category/$helper_skill")
  done
fi

cat <<EOF2
Installed Hermes skill: $name
Target: $hermes_home/skills/$category/$name
Codex helper skills: $([[ "${#installed_helper_skills[@]}" -gt 0 ]] && printf '%s ' "${installed_helper_skills[@]}" || echo "not installed")
Synced existing profile helper skills: $([[ "${#synced_profile_skills[@]}" -gt 0 ]] && printf '%s ' "${synced_profile_skills[@]}" || echo "none")

Restart or reload Hermes gateway if it is already running:
  systemctl --user restart hermes-gateway.service

Check installed skills:
  hermes skills list | grep '$name'
  hermes skills list | grep 'codex-new'
  hermes skills list | grep 'codex-send'
  hermes skills list | grep 'codex-kill'
EOF2
