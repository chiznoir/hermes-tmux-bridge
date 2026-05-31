#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the recommended self-hosted Hermes Codex Bridge stack.

This wraps the lower-level installers so a second PC / second Hermes agent can be
set up with a short command:

  scripts/install-hermes-stack.sh --restart

Interactive mode asks for the fallback Discord channel and optional project
channel mappings. Pass flags only for automation/non-interactive installs.

What it does:
  1. installs codex-new/codex-send/codex-kill helper CLIs from this repository
  2. installs the Hermes skill
  3. installs/restarts the bridge systemd service for Hermes agent bridge access
  4. optionally enables the Hermes Gateway webhook sink when --webhook is passed

Options:
  --channel ID                   Fallback Discord channel id for project alerts
  --project PROJECT=ID           Add/update a project channel mapping; repeatable
  --project-root PATH            Optional fixed Codex project root to scan
  --repo-root PATH               Bridge repository root (default: parent of scripts/)
  --state-root PATH              Bridge-owned state/log/cache root
  --hermes-home PATH             Hermes home (default: $HERMES_HOME or ~/.hermes)
  --cli-dir PATH                 Install helper CLIs here (default: ~/.local/bin)
  --copy-cli                     Copy helper CLIs instead of symlinking them
  --no-force-cli                 Do not replace existing helper CLI targets
  --skip-cli                     Do not install codex-new/codex-send/codex-kill
  --bridge-host HOST             Bridge bind host (default: 127.0.0.1)
  --bridge-port PORT             Bridge port (default: 3037)
  --webhook                      Enable Hermes Gateway webhook sink and subscription (default: off)
  --no-webhook                   Disable webhook sink and remove codex-bridge subscription (default)
  --url URL                      Hermes webhook URL used only with --webhook
  --mode summary|direct
                                  FinalAnswer mode (default: direct)
  --direct                       Shortcut for --mode direct
  --summary                      Shortcut for --mode summary
  --secret-file PATH             HMAC secret file used only with --webhook
  --map PATH                     Project channel map used only with --webhook
  --bot-token TOKEN              Discord bot token for deterministic project channel lookup/create
  --bot-token-file PATH          Read Discord bot token from first line of file
  --guild ID                     Discord guild/server id for project channel lookup/create
  --alert-channel ID             Discord channel id for delivery-dead operator alerts
  --threads                      Create/reuse one Discord thread per session under the project channel (default)
  --no-threads
                                 Send to the project channel instead of per-session threads
  --mention-users IDS            Comma-separated Discord user ids for initial SessionStart
  --config PATH                  Hermes config.yaml to update with new Discord channels
  --token-file PATH              Optional bridge bearer token file
  --token TOKEN                  Optional bridge bearer token
  --scope user|system            systemd scope (default: user)
  --restart                      Restart hermes-gateway.service after skill/subscription update
  --no-start                     Install service/subscription but do not start bridge
  --non-interactive              Do not prompt; use only provided flags/env
  --dry-run                      Print actions without writing secrets or services
  -h, --help                     Show help

Notes:
  - For same-host localhost deployments, BRIDGE_TOKEN may be empty.
  - If bridge is exposed to Docker/LAN/reverse proxy/public, pass --token-file.
  - Default install mode is Hermes agent bridge: no webhook sink, no webhook subscription.
  - When --webhook is enabled, default notification mode is direct and
    Discord project channels / per-session threads are auto-created when the
    Discord bot token and guild id are available.
  - Helper CLIs are installed from repo bin/ and do not modify Codex global hooks.
  - If --webhook is enabled, Hermes Gateway must have WEBHOOK_ENABLED=true
    and WEBHOOK_SECRET matching the generated secret.
USAGE
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
project_root=""
state_root=""
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
cli_dir="${CODEX_CLI_INSTALL_DIR:-$HOME/.local/bin}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-codex-bridge"
secret_file="$config_dir/hermes-webhook.secret"
channel_map="$config_dir/project-channels.json"
default_channel_id="${BRIDGE_HERMES_DEFAULT_CHANNEL_ID:-}"
hermes_notification_mode="${BRIDGE_HERMES_NOTIFICATION_MODE:-direct}"
bridge_host="127.0.0.1"
bridge_port="3037"
gateway_url="${BRIDGE_HERMES_WEBHOOK_URL:-http://127.0.0.1:8644/webhooks/codex-bridge}"
token="${BRIDGE_TOKEN:-}"
token_file=""
discord_bot_token="${BRIDGE_DISCORD_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
discord_bot_token_file=""
discord_guild_id="${BRIDGE_DISCORD_GUILD_ID:-${DISCORD_GUILD_ID:-${DISCORD_SERVER_ID:-}}}"
discord_alert_channel_id="${DISCORD_ALERT_CHANNEL_ID:-}"
discord_mention_users="${BRIDGE_DISCORD_MENTION_USERS:-${BRIDGE_DISCORD_MENTION_USER:-${BRIDGE_DISCORD_SESSION_START_MENTION_USER_IDS:-${BRIDGE_DISCORD_SESSION_START_MENTION_USER_ID:-}}}}"
discord_auto_create_threads="${BRIDGE_DISCORD_AUTO_CREATE_THREADS:-true}"
hermes_config_path="${BRIDGE_HERMES_CONFIG:-$hermes_home/config.yaml}"
scope="user"
restart_gateway=0
webhook_sink_enabled=0
start_service=1
dry_run=0
non_interactive=0
skip_cli=0
copy_cli=0
force_cli=1
project_channels=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) default_channel_id="${2:?missing --channel value}"; shift 2 ;;
    --project) project_channels+=("${2:?missing --project value}"); shift 2 ;;
    --project-root) project_root="${2:?missing --project-root value}"; shift 2 ;;
    --repo-root) repo_root="${2:?missing --repo-root value}"; shift 2 ;;
    --state-root) state_root="${2:?missing --state-root value}"; shift 2 ;;
    --hermes-home) hermes_home="${2:?missing --hermes-home value}"; shift 2 ;;
    --cli-dir) cli_dir="${2:?missing --cli-dir value}"; shift 2 ;;
    --copy-cli) copy_cli=1; shift ;;
    --no-force-cli) force_cli=0; shift ;;
    --skip-cli) skip_cli=1; shift ;;
    --bridge-host) bridge_host="${2:?missing --bridge-host value}"; shift 2 ;;
    --bridge-port) bridge_port="${2:?missing --bridge-port value}"; shift 2 ;;
    --webhook) webhook_sink_enabled=1; shift ;;
    --no-webhook) webhook_sink_enabled=0; shift ;;
    --url) gateway_url="${2:?missing --url value}"; shift 2 ;;
    --mode) hermes_notification_mode="${2:?missing --mode value}"; shift 2 ;;
    --direct) hermes_notification_mode="direct"; shift ;;
    --summary) hermes_notification_mode="summary"; shift ;;
    --secret-file) secret_file="${2:?missing --secret-file value}"; shift 2 ;;
    --map) channel_map="${2:?missing --map value}"; shift 2 ;;
    --bot-token) discord_bot_token="${2:?missing --bot-token value}"; shift 2 ;;
    --bot-token-file) discord_bot_token_file="${2:?missing --bot-token-file value}"; shift 2 ;;
    --guild) discord_guild_id="${2:?missing --guild value}"; shift 2 ;;
    --alert-channel) discord_alert_channel_id="${2:?missing --alert-channel value}"; shift 2 ;;
    --mention-users) discord_mention_users="${2:?missing --mention-users value}"; shift 2 ;;
    --threads) discord_auto_create_threads="true"; shift ;;
    --no-threads) discord_auto_create_threads="false"; shift ;;
    --config) hermes_config_path="${2:?missing --config value}"; shift 2 ;;
    --token-file) token_file="${2:?missing --token-file value}"; shift 2 ;;
    --token) token="${2:?missing --token value}"; shift 2 ;;
    --scope) scope="${2:?missing --scope value}"; shift 2 ;;
    --restart) restart_gateway=1; shift ;;
    --no-start) start_service=0; shift ;;
    --non-interactive) non_interactive=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$scope" in
  user|system) ;;
  *) echo "--scope must be user or system" >&2; exit 2 ;;
esac

repo_root="$(cd "$repo_root" && pwd)"
cli_dir="$(realpath -m "$cli_dir")"
if [[ -n "$project_root" ]]; then
  project_root="$(realpath -m "$project_root")"
fi
if [[ -n "$state_root" ]]; then
  state_root="$(realpath -m "$state_root")"
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

first_hermes_env() {
  local value key
  for key in "$@"; do
    value="$(read_env_key "$key" "$hermes_home/.env")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
}

if [[ -n "$token_file" ]]; then
  token="$(head -n 1 "$token_file" | tr -d '\r\n')"
fi
if [[ -n "$discord_bot_token_file" ]]; then
  discord_bot_token="$(head -n 1 "$discord_bot_token_file" | tr -d '\r\n')"
fi
if [[ -z "$discord_bot_token" ]]; then
  discord_bot_token="$(first_hermes_env BRIDGE_DISCORD_BOT_TOKEN DISCORD_BOT_TOKEN)"
fi
if [[ -z "$discord_guild_id" ]]; then
  discord_guild_id="$(first_hermes_env BRIDGE_DISCORD_GUILD_ID DISCORD_GUILD_ID DISCORD_SERVER_ID)"
fi
if [[ -z "$discord_alert_channel_id" ]]; then
  discord_alert_channel_id="$(first_hermes_env DISCORD_ALERT_CHANNEL_ID)"
fi
if [[ -z "$discord_mention_users" ]]; then
  discord_mention_users="$(first_hermes_env BRIDGE_DISCORD_MENTION_USERS BRIDGE_DISCORD_MENTION_USER BRIDGE_DISCORD_SESSION_START_MENTION_USER_IDS BRIDGE_DISCORD_SESSION_START_MENTION_USER_ID)"
fi
if [[ -z "$default_channel_id" ]]; then
  default_channel_id="$(first_hermes_env BRIDGE_HERMES_DEFAULT_CHANNEL_ID DISCORD_HOME_CHANNEL DISCORD_CHANNEL_ID BRIDGE_DISCORD_CHANNEL_ID TARGET_ID)"
fi

derive_discord_guild_id() {
  [[ -n "$discord_bot_token" && -z "$discord_guild_id" && -n "$default_channel_id" ]] || return 0
  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: derive Discord guild id from configured Discord channel" >&2
    return 0
  fi
  discord_guild_id="$(
    DISCORD_BOT_TOKEN_VALUE="$discord_bot_token" DISCORD_CHANNEL_ID_VALUE="$default_channel_id" node <<'NODE'
(async () => {
  const token = process.env.DISCORD_BOT_TOKEN_VALUE;
  const channelId = process.env.DISCORD_CHANNEL_ID_VALUE;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
      method: 'GET',
      headers: { authorization: `Bot ${token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      process.stderr.write(`WARN: Discord guild id lookup failed: HTTP ${res.status}\n`);
      return;
    }
    const body = await res.json();
    if (body && body.guild_id) process.stdout.write(String(body.guild_id));
    else process.stderr.write('WARN: Discord channel lookup returned no guild_id\n');
  } catch (err) {
    process.stderr.write(`WARN: Discord guild id lookup failed: ${err.message}\n`);
  }
})();
NODE
  )"
}
derive_discord_guild_id

is_tty() {
  [[ -t 0 && -t 1 ]]
}

prompt_line() {
  local prompt="$1" default_value="${2:-}" answer
  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " answer
    printf '%s' "${answer:-$default_value}"
  else
    read -r -p "$prompt: " answer
    printf '%s' "$answer"
  fi
}

prompt_yes_no() {
  local prompt="$1" default_value="${2:-N}" answer normalized
  read -r -p "$prompt [$default_value]: " answer
  answer="${answer:-$default_value}"
  normalized="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized" == "y" || "$normalized" == "yes" ]]
}

prompt_missing_inputs() {
  if [[ "$webhook_sink_enabled" != "1" ]]; then
    return
  fi
  if [[ "$non_interactive" == "1" ]]; then
    return
  fi
  if ! is_tty; then
    return
  fi

  echo "Hermes Codex Bridge interactive setup"
  echo "Press Enter to skip optional values."
  echo

  if [[ -z "$default_channel_id" ]]; then
    default_channel_id="$(prompt_line 'Fallback Discord channel ID')"
  fi

  if prompt_yes_no 'Add project-specific Discord channel mappings now?' 'N'; then
    while true; do
      local project channel
      project="$(prompt_line 'Project name, e.g. project-a')"
      [[ -n "$project" ]] || break
      channel="$(prompt_line "Discord channel ID for $project")"
      if [[ -n "$channel" ]]; then
        project_channels+=("$project=$channel")
      fi
      prompt_yes_no 'Add another project mapping?' 'N' || break
    done
  fi
}

prompt_missing_inputs

if [[ "$webhook_sink_enabled" == "1" && -z "$default_channel_id" ]]; then
  cat >&2 <<'WARN'
WARN: fallback channel id is empty. The bridge can be installed, but Hermes
      sink events without a mapped project channel may be skipped until a
      fallback or project channel mapping is added.
WARN
fi

if [[ "$webhook_sink_enabled" == "1" && "${discord_auto_create_threads,,}" == "true" && ( -z "$discord_bot_token" || -z "$discord_guild_id" ) ]]; then
  cat >&2 <<'WARN'
WARN: Discord session thread auto-create is enabled by default, but bot token
      or guild id is missing. Add Discord bot settings or pass --no-threads
      for project-channel delivery.
WARN
fi

run() {
  if [[ "$dry_run" == "1" ]]; then
    local redact_next=0 arg
    printf 'DRY-RUN:'
    for arg in "$@"; do
      if [[ "$redact_next" == "1" ]]; then
        printf ' %q' '<redacted>'
        redact_next=0
        continue
      fi
      printf ' %q' "$arg"
      case "$arg" in
        --token|--bot-token|--secret) redact_next=1 ;;
      esac
    done
    printf '\n'
  else
    "$@"
  fi
}

ensure_secret() {
  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: ensure secret file $secret_file"
    return
  fi
  install -d -m 0700 "$(dirname "$secret_file")"
  if [[ ! -s "$secret_file" ]]; then
    openssl rand -hex 32 > "$secret_file"
    chmod 600 "$secret_file"
  fi
}

update_channel_map() {
  local entries_json
  entries_json="$(printf '%s\n' "${project_channels[@]}" | node -e '
const fs = require("fs");
const lines = fs.readFileSync(0, "utf8").split(/\n/).filter(Boolean);
const entries = {};
for (const line of lines) {
  const idx = line.includes("=") ? line.indexOf("=") : line.indexOf(":");
  if (idx <= 0) throw new Error(`Invalid --project: ${line}`);
  const project = line.slice(0, idx).trim();
  const channel = line.slice(idx + 1).trim();
  if (!project || !channel) throw new Error(`Invalid --project: ${line}`);
  entries[project] = channel;
}
process.stdout.write(JSON.stringify(entries));
')"

  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: update channel map $channel_map"
    [[ -n "$default_channel_id" ]] && echo "DRY-RUN: set default channel id <redacted>"
    [[ "${#project_channels[@]}" -gt 0 ]] && printf 'DRY-RUN: project mappings: %s\n' "${project_channels[*]}"
    return 0
  fi

  install -d -m 0700 "$(dirname "$channel_map")"
  DEFAULT_CHANNEL_ID="$default_channel_id" CHANNEL_MAP="$channel_map" ENTRIES_JSON="$entries_json" node <<'NODE'
const fs = require('fs');
const path = process.env.CHANNEL_MAP;
let map = { projects: {} };
if (fs.existsSync(path)) {
  try { map = { projects: {}, ...JSON.parse(fs.readFileSync(path, 'utf8')) }; }
  catch { map = { projects: {} }; }
}
if (!map.projects || typeof map.projects !== 'object') map.projects = {};
if (process.env.DEFAULT_CHANNEL_ID) map.default = process.env.DEFAULT_CHANNEL_ID;
const entries = JSON.parse(process.env.ENTRIES_JSON || '{}');
for (const [project, channel] of Object.entries(entries)) map.projects[project] = channel;
fs.writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(path, 0o600);
NODE
}

subscription_prompt() {
  cat <<'PROMPT'
Codex Discord 알림·제어 라우터.
라우팅: reply의 “이 세션/이거/방금 알림”은 payload `bridge_session_id`. 최우선 dispatch: Discord reply에서 `전달`/`보내`/`넘겨`/`세션에 넣어`면 설명/조회하지 말고 정제 후 `codex-send --session <bridge_session_id> --discord-approval`; 반영/수정/재시도/진행/계속/위 내용/답장/고쳐는 “전달해” 없어도 정제 후 `codex-send --discord-approval`. 이 gate는 bridge pending approval만 만들며 Discord 버튼을 자동 렌더링하지 않는다. `delivery.status=approval-pending`이면 반드시 Hermes native `clarify`/AskUserQuestion으로 정제 prompt와 선택지 `전송`, `거절`, `추가수정`을 표시한 뒤, 선택 결과를 `codex-send --session <bridge_session_id> --answer-approval send|reject --question-id <questionId>`로 제출하고, 추가수정은 편집 문구를 받은 뒤 `--answer-approval modify --question-id <questionId> --edit <text>`로 기존 pending을 닫고 재정제한다. `clarify` 성공 전에는 “승인 요청 올려뒀다/버튼에서 전송 누르면 된다”고 말하지 말고, 실패 시 approval UI 실패를 명시한다. 추가수정은 재정제 후 새 approval을 만든다. Discord-origin이 아닌 명시적 local/manual helper dispatch만 plain `codex-send --session <bridge_session_id>` 가능. “이건 뭐냐/궁금한데/왜 그래?”는 dispatch 단어가 없을 때만 읽고 설명. 종료/kill은 `codex-kill` skill; 새 세션은 `codex-new` skill; dispatch는 `codex-send` skill; `SessionStart` 트리거 아님. `/new`/`/resume`은 Codex slash command라 `codex-send`로 그대로 보내되 Discord reply라면 `--discord-approval` gate를 먼저 거친다. 원문/raw/full text는 `/sessions/:id/idle/latest` `fullText`; 세션 확인은 `/sessions` 또는 `/sessions/:id/state`; 최근 로그 `/sessions/:id/events`; 명령 이력은 `/sessions/:id/interactions`. AskPermission: `/approve`/`/deny`를 `codex-send --mode tmux`.

대상/금지: Codex lifecycle만. `channel_mapping_status=session-thread`: `channel_id`/`discord_delivery_target_id`/`chunk_delivery_channel_id`는 이미 Discord thread다. 긴 direct FinalAnswer는 bot token과 thread target이 있으면 브리지가 Discord에 직접 순차 전송한다. Hermes에 chunked payload가 도착한 경우에는 브리지가 1800자 안전 한도로 미리 나눈 각 payload를 순서대로 같은 thread에 보내고 재탐색/fallback 금지. 알림=응답; 확인 금지. `알림 렌더링 완료`/`요약을 보냈고` 금지.

이벤트: standalone `SessionIdle` 골격 알림은 보내지 않고 `FinalAnswer`를 `Session Idle` 제목으로 보낸다. `SessionEnd`: `duration`/`reason`. `CommandSubmitted`는 `User Command`; `payload.message_markdown` 그대로, 요약/재작성 금지; pre-dispatch 미적용. `FinalAnswer`: 제목 `Session Idle`; 브리지가 긴 본문을 1800자 이하 조각으로 미리 나누며 분할 시 모든 조각 끝에 `(i/N)`, 제목/컨텍스트는 첫 조각만, 후속 조각도 같은 `channel_id`/`discord_delivery_target_id`로만 전송. 긴 direct 조각은 bridge-owned Discord 전송이 우선이며 Hermes가 받은 조각만 그대로 처리한다. `payload.message_markdown`은 골격일 수 있어 `핵심 결론`, `원인/수정 내용`, `검증 결과`, `남은 주의/운영 조치`로 재배열. 짧은 원문 8~12줄, 보통 12~20줄, 긴 원문 20~36줄. `text_truncated=true`면 `read_endpoints.idle_latest`; 긴 원문은 판단 근거·수정 포인트를 남긴다. `notification_mode=direct`는 summary를 만들지 않는다; fullText 그대로, `direct_full_text_unavailable=true`면 실패를 명시.

FinalAnswer 스타일: 설명 문장은 한국어 중심. `Document graph`(문서 그래프), `keyword_fallback`(키워드 fallback 경로)처럼 첫 뜻 병기. 영어 명사구를 한국어 문장 안에 길게 이어 붙이지 않는다. 명령어/경로/env/hash/PID는 backtick. 파일/설정/커밋/테스트는 대표 묶음, 판단에 필요한 식별자 보존.

전용 skill 경계: `hermes-codex-bridge`는 bridge read/status/notification rendering만 맡는다. 세션 생성은 `codex-new`, 전달/승인/거절은 `codex-send`, 종료는 `codex-kill` skill을 따른다. `codex-send` prompt refinement SSoT는 `skills/codex-send/SKILL.md`이며, temp file/write_file을 쓰더라도 원문 Discord reply가 아니라 정제된 prompt만 기록해야 한다. Discord-originated Hermes dispatch는 정제된 prompt를 바로 보내지 말고 `codex-send --discord-approval`로 bridge-owned `codex-send-approval` question을 만든 다음 `clarify`/AskUserQuestion으로 실제 Discord 승인 카드를 렌더링해야 한다.

원문 그대로 요청: summary 없이 `fullText` 그대로. `payload.message_markdown`, `payload.text_preview`, 알림 조각/tmux capture로 재구성하지 않는다. 전체 원문을 새 ```markdown 코드블럭으로 감싸지 않고, 브리지가 이미 나눈 조각을 순서대로 보내며 markdown fence 보존, 모든 조각 끝 `(i/N)`, 제목 반복 금지. `fullText` 조회 실패/빈 값은 실패 명시.

Payload:
```json
{__raw__}
```

PROMPT
}

install_subscription() {
  local secret prompt_file subscribe_output
  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: install/update Hermes webhook subscription codex-bridge in $hermes_home"
    return
  fi
  secret="$(head -n 1 "$secret_file" | tr -d '\r\n')"
  prompt_file="$(mktemp)"
  subscription_prompt > "$prompt_file"

  if command -v hermes >/dev/null 2>&1; then
    if subscribe_output="$(HERMES_HOME="$hermes_home" hermes webhook subscribe codex-bridge \
      --events AskPermission,FinalAnswer \
      --skills hermes-codex-bridge,codex-new,codex-send,codex-kill \
      --deliver discord \
      --deliver-chat-id '{channel_id}' \
      --secret "$secret" \
      --prompt "$(cat "$prompt_file")" 2>&1)"; then
      printf '%s\n' "$subscribe_output" | sed -E 's/(Secret:)[[:space:]]+[^[:space:]]+/\1 <redacted>/g'
      rm -f "$prompt_file"
      return
    fi
    printf '%s\n' "$subscribe_output" | sed -E 's/(Secret:)[[:space:]]+[^[:space:]]+/\1 <redacted>/g' >&2
    echo "WARN: hermes webhook subscribe failed; falling back to JSON subscription file" >&2
  fi

  HERMES_HOME="$hermes_home" SECRET="$secret" PROMPT_FILE="$prompt_file" node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const file = path.join(home, 'webhook_subscriptions.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
let data = {};
if (fs.existsSync(file)) {
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { data = {}; }
}
data['codex-bridge'] = {
  description: 'Bridge events from hermes-codex-bridge for project-channel summarization',
  events: ['AskPermission', 'FinalAnswer'],
  secret: process.env.SECRET,
  prompt: fs.readFileSync(process.env.PROMPT_FILE, 'utf8'),
  skills: ['hermes-codex-bridge', 'codex-new', 'codex-send', 'codex-kill'],
  deliver: 'discord',
  deliver_extra: { chat_id: '{channel_id}' },
  created_at: new Date().toISOString(),
};
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE
  rm -f "$prompt_file"
}

remove_subscription() {
  if [[ "$dry_run" == "1" ]]; then
    echo "DRY-RUN: remove Hermes webhook subscription codex-bridge from $hermes_home if present"
    return
  fi

  HERMES_HOME="$hermes_home" node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const file = path.join(home, 'webhook_subscriptions.json');
if (!fs.existsSync(file)) process.exit(0);
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { process.exit(0); }
if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'codex-bridge')) process.exit(0);
delete data['codex-bridge'];
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE
}

if [[ "$webhook_sink_enabled" == "1" ]]; then
  ensure_secret
  update_channel_map
fi

if [[ "$skip_cli" != "1" ]]; then
  cli_args=("$repo_root/scripts/install-codex-cli.sh" --repo-root "$repo_root" --dir "$cli_dir")
  if [[ "$copy_cli" == "1" ]]; then
    cli_args+=(--copy)
  fi
  if [[ "$force_cli" == "1" ]]; then
    cli_args+=(--force)
  fi
  run "${cli_args[@]}"
fi

run "$repo_root/scripts/install-hermes-skill.sh" --hermes-home "$hermes_home"

service_args=(
  "$repo_root/scripts/install-systemd-service.sh"
  "--$scope"
  --host "$bridge_host"
  --port "$bridge_port"
  --repo-root "$repo_root"
  --no-notify
)
if [[ -n "$project_root" ]]; then
  service_args+=(--project-root "$project_root")
fi
if [[ -n "$state_root" ]]; then
  service_args+=(--state-root "$state_root")
fi
if [[ "$webhook_sink_enabled" == "1" ]]; then
  service_args+=(
    --sink
    --sink-url "$gateway_url"
    --secret-file "$secret_file"
    --map "$channel_map"
  )
  if [[ -n "$default_channel_id" ]]; then
    service_args+=(--channel "$default_channel_id")
  fi
  service_args+=(--mode "$hermes_notification_mode")
fi
if [[ -n "$token" ]]; then
  service_args+=(--token "$token")
fi
if [[ "$webhook_sink_enabled" == "1" ]]; then
  if [[ -n "$discord_bot_token" ]]; then
    service_args+=(--bot-token "$discord_bot_token")
  fi
  if [[ -n "$discord_guild_id" ]]; then
    service_args+=(--guild "$discord_guild_id")
  fi
  if [[ -n "$discord_alert_channel_id" ]]; then
    service_args+=(--alert-channel "$discord_alert_channel_id")
  fi
  if [[ -n "$discord_mention_users" ]]; then
    service_args+=(--mention-users "$discord_mention_users")
  fi
  if [[ "${discord_auto_create_threads,,}" == "true" ]]; then
    service_args+=(--threads)
  else
    service_args+=(--no-threads)
  fi
  if [[ -n "$hermes_config_path" ]]; then
    service_args+=(--config "$hermes_config_path")
  fi
fi
if [[ "$start_service" == "0" ]]; then
  service_args+=(--no-start)
fi
run "${service_args[@]}"

if [[ "$webhook_sink_enabled" == "1" ]]; then
  install_subscription
else
  remove_subscription
fi

if [[ "$restart_gateway" == "1" ]]; then
  if [[ "$scope" == "system" ]]; then
    run systemctl restart hermes-gateway.service
  else
    run systemctl --user restart hermes-gateway.service
  fi
fi

scope_systemctl_arg="--user"
if [[ "$scope" == "system" ]]; then scope_systemctl_arg=""; fi

cat <<EOF2

Hermes Codex Bridge stack install complete.

Mode: $(if [[ "$webhook_sink_enabled" == "1" ]]; then echo "Hermes webhook sink"; else echo "Hermes agent bridge"; fi)
Helper CLIs: $(if [[ "$skip_cli" == "1" ]]; then echo "skipped"; else echo "$cli_dir"; fi)

Check:
  curl -sS http://$bridge_host:$bridge_port/health
  systemctl ${scope_systemctl_arg} status hermes-codex-bridge.service

Files:
  Hermes home: $hermes_home
EOF2

if [[ "$webhook_sink_enabled" == "1" ]]; then
  cat <<EOF2

Important Hermes Gateway env must match:
  WEBHOOK_ENABLED=true
  WEBHOOK_PORT=8644
  WEBHOOK_SECRET=<secret-file-value>

Webhook files:
  Secret:      $secret_file
  Channel map: $channel_map

Webhook check:
  curl -sS http://127.0.0.1:8644/health
EOF2
fi
