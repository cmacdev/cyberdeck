#!/usr/bin/env bash
# Cyberdeck installer. Idempotent, no sudo, never touches an existing Pi.
# Usage: bash install.sh [--dry-run] [--upgrade-pi]
# Remote mode (piped): clones CYBERDECK_REPO_URL (default: the private cmacdev/cyberdeck
# repo, so the machine needs authenticated git/gh for github.com).
set -euo pipefail

PINNED_PI="0.84.1"
PI_PACKAGE="@earendil-works/pi-coding-agent"
CYBERDECK_HOME="${CYBERDECK_HOME:-$HOME/.cyberdeck}"
CYBERDECK_REPO_URL="${CYBERDECK_REPO_URL:-https://github.com/cmacdev/cyberdeck.git}"

DRY_RUN=0
UPGRADE_PI=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --upgrade-pi) UPGRADE_PI=1 ;;
    --help|-h)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

SUMMARY=()
note() { SUMMARY+=("$1"); echo "cyberdeck-install: $1"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "cyberdeck-install: would run: $*"
  else
    "$@"
  fi
}
die() {
  echo "cyberdeck-install: $1" >&2
  exit 1
}

# --- Locate or fetch cyberdeck -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/cyberdeck-mcp.mjs" ]; then
  APP_DIR="$SCRIPT_DIR"
  note "using checkout at $APP_DIR"
else
  APP_DIR="$CYBERDECK_HOME/app"
  if [ -d "$APP_DIR/.git" ]; then
    run git -C "$APP_DIR" pull --ff-only --quiet
    note "updated $APP_DIR from $CYBERDECK_REPO_URL"
  else
    run mkdir -p "$CYBERDECK_HOME"
    run git clone --depth 1 --quiet "$CYBERDECK_REPO_URL" "$APP_DIR"
    note "cloned $CYBERDECK_REPO_URL to $APP_DIR"
  fi
fi
CONFIG_PATH="$APP_DIR/cyberdeck.config.json"

# --- Node ----------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required. Install it first (e.g. 'brew install node')."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "Node.js >= 20 is required; found $(node --version). Upgrade it first (e.g. 'brew install node')."
note "node $(node --version) ok"

# --- Pi: never touch an existing installation -----------------------------------
if command -v pi >/dev/null 2>&1; then
  FOUND_PI="$(pi --version 2>/dev/null | head -1 || echo unknown)"
  if [ "$FOUND_PI" = "$PINNED_PI" ]; then
    note "pi $FOUND_PI found (tested version); left untouched"
  elif [ "$UPGRADE_PI" -eq 1 ]; then
    run npm install -g "$PI_PACKAGE@$PINNED_PI"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "pi would be upgraded to $PINNED_PI (explicit --upgrade-pi)"
    else
      note "pi upgraded to $PINNED_PI (explicit --upgrade-pi)"
    fi
  else
    note "pi $FOUND_PI found; left untouched (tested with $PINNED_PI; pass --upgrade-pi to change)"
  fi
else
  command -v npm >/dev/null 2>&1 || die "npm is required to install Pi."
  run npm install -g "$PI_PACKAGE@$PINNED_PI"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would install pi $PINNED_PI"
  else
    note "installed pi $PINNED_PI"
  fi
fi

# --- OpenRouter credentials ------------------------------------------------------
auth_ready() {
  pi auth check --provider openrouter 2>/dev/null | grep -q '^ready'
}
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  note "OPENROUTER_API_KEY is set in the environment; Pi will use it"
elif command -v pi >/dev/null 2>&1 && auth_ready; then
  note "Pi already has OpenRouter credentials; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "would prompt for an OpenRouter API key (hidden input) and store it in Pi's auth store"
else
  [ -r /dev/tty ] || die "no terminal available for the API key prompt; set OPENROUTER_API_KEY and re-run."
  printf "OpenRouter API key (input hidden): " >/dev/tty
  IFS= read -rs OPENROUTER_KEY_INPUT </dev/tty
  echo >/dev/tty
  [ -n "$OPENROUTER_KEY_INPUT" ] || die "empty API key."
  OR_KEY="$OPENROUTER_KEY_INPUT" node -e '
    const { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");
    const path = require("node:path");
    const file = path.join(process.env.HOME, ".pi", "agent", "auth.json");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    store.openrouter = { type: "api_key", key: process.env.OR_KEY };
    writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  '
  unset OPENROUTER_KEY_INPUT OR_KEY
  auth_ready || die "Pi does not report OpenRouter credentials as ready after storing the key."
  note "stored OpenRouter key in Pi's auth store (~/.pi/agent/auth.json, mode 600)"
fi

# --- Register with Claude Code ----------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  if claude mcp get cyberdeck >/dev/null 2>&1; then
    note "Claude Code: cyberdeck already registered; left untouched"
  else
    run claude mcp add --scope user cyberdeck -- node "$APP_DIR/bin/cyberdeck-mcp.mjs" --config "$CONFIG_PATH"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Code: would register cyberdeck at user scope"
    else
      note "Claude Code: registered cyberdeck at user scope"
    fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    note "Claude Code: would add permission rules (allow research, ask implement) to ~/.claude/settings.json"
  else
    node -e '
      const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
      const path = require("node:path");
      const file = path.join(process.env.HOME, ".claude", "settings.json");
      mkdirSync(path.dirname(file), { recursive: true });
      const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      settings.permissions = settings.permissions ?? {};
      for (const [list, rule] of [["allow", "mcp__cyberdeck__research"], ["ask", "mcp__cyberdeck__implement"]]) {
        const rules = settings.permissions[list] ?? [];
        if (!rules.includes(rule)) rules.push(rule);
        settings.permissions[list] = rules;
      }
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    '
    note "Claude Code: permission rules ensured (allow research, ask implement)"
  fi
else
  note "Claude Code CLI not found; skipped (re-run after installing it)"
fi

# --- Register with Codex -----------------------------------------------------------
if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then
  CODEX_CONFIG="$HOME/.codex/config.toml"
  if [ -f "$CODEX_CONFIG" ] && grep -q '^\[mcp_servers\.cyberdeck\]' "$CODEX_CONFIG"; then
    note "Codex: cyberdeck already registered; left untouched"
  elif [ "$DRY_RUN" -eq 1 ]; then
    note "Codex: would append [mcp_servers.cyberdeck] block to $CODEX_CONFIG"
  else
    mkdir -p "$HOME/.codex"
    cat >>"$CODEX_CONFIG" <<EOF

# Added by cyberdeck install.sh. No cwd: the server inherits the session directory,
# so cyberdeck's @cwd workspace root is the current project (root/home are refused).
[mcp_servers.cyberdeck]
command = "node"
args = ["$APP_DIR/bin/cyberdeck-mcp.mjs", "--config", "$CONFIG_PATH"]
enabled_tools = ["research", "implement"]
env_vars = ["OPENROUTER_API_KEY"]
startup_timeout_sec = 10
tool_timeout_sec = 1900

[mcp_servers.cyberdeck.tools.research]
approval_mode = "auto"

[mcp_servers.cyberdeck.tools.implement]
approval_mode = "prompt"
EOF
    note "Codex: appended cyberdeck block to $CODEX_CONFIG"
  fi
else
  note "Codex not found; skipped (re-run after installing it)"
fi

# --- Verify -------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  note "would verify: resolved config loads and schemas build (bin/cyberdeck-mcp.mjs --inspect)"
else
  (cd "$APP_DIR" && node bin/cyberdeck-mcp.mjs --config "$CONFIG_PATH" --inspect >/dev/null) \
    || die "verification failed: the resolved configuration does not load."
  note "verified: resolved config loads and schemas build"
fi

echo
echo "cyberdeck-install: done. Summary:"
for line in "${SUMMARY[@]}"; do echo "  - $line"; done
echo "Restart Claude Code / Codex sessions to pick up the server."
