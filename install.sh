#!/usr/bin/env bash
# Cyberdeck installer. Idempotent, no sudo, never touches an existing Pi unless --pin-pi.
# Usage: bash install.sh [--dry-run] [--pin-pi]
# Remote mode (piped): clones CYBERDECK_REPO_URL (default: the private cmacdev/cyberdeck
# repo, so the machine needs authenticated git/gh for github.com).
set -euo pipefail

PINNED_PI="0.84.2"
PI_PACKAGE="@earendil-works/pi-coding-agent"
CYBERDECK_HOME="${CYBERDECK_HOME:-$HOME/.cyberdeck}"
CYBERDECK_REPO_URL="${CYBERDECK_REPO_URL:-https://github.com/cmacdev/cyberdeck.git}"

DRY_RUN=0
PIN_PI=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --pin-pi) PIN_PI=1 ;;
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
  echo "cyberdeck-install: see README.md, section 'If the installer stops'." >&2
  exit 1
}

# --- Locate or fetch cyberdeck -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/cyberdeck-mcp.mjs" ]; then
  APP_DIR="$SCRIPT_DIR"
  note "using checkout at $APP_DIR"
else
  APP_DIR="$CYBERDECK_HOME/app"
  command -v git >/dev/null 2>&1 || die "git is required to fetch cyberdeck (e.g. 'xcode-select --install' or 'brew install git')."
  # Piped installs cannot answer a credential prompt; fail fast with the fix instead.
  export GIT_TERMINAL_PROMPT=0
  git ls-remote --exit-code "$CYBERDECK_REPO_URL" HEAD >/dev/null 2>&1 \
    || die "cannot read $CYBERDECK_REPO_URL without a password prompt. The repo is private: run 'gh auth login' then 'gh auth setup-git' (or store a GitHub credential in your keychain) and re-run."
  if [ -d "$APP_DIR/.git" ]; then
    run git -C "$APP_DIR" pull --ff-only --quiet
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would update $APP_DIR from $CYBERDECK_REPO_URL"
    else
      note "updated $APP_DIR from $CYBERDECK_REPO_URL"
    fi
  else
    run mkdir -p "$CYBERDECK_HOME"
    run git clone --depth 1 --quiet "$CYBERDECK_REPO_URL" "$APP_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would clone $CYBERDECK_REPO_URL to $APP_DIR"
    else
      note "cloned $CYBERDECK_REPO_URL to $APP_DIR"
    fi
  fi
fi
SOURCE_CONFIG_PATH="$APP_DIR/cyberdeck.config.json"

# --- Node ----------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required. Install it first (e.g. 'brew install node')."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "Node.js >= 20 is required; found $(node --version). Upgrade it first (e.g. 'brew install node')."
note "node $(node --version) ok"

# --- Pi: never touch an existing installation -----------------------------------
npm_global_writable() {
  # npm -g writes the global node_modules and bin. A fresh prefix may not exist
  # yet, so test the nearest existing ancestor of each.
  local target
  for target in "$(npm root -g)" "$(npm prefix -g)/bin"; do
    while [ ! -e "$target" ]; do target="$(dirname "$target")"; done
    [ -w "$target" ] || return 1
  done
}
install_pi() {
  command -v npm >/dev/null 2>&1 || die "npm is required to install Pi; it ships with Node."
  npm_global_writable || die "npm's global directory ($(npm prefix -g)) is not writable by $(id -un), and this installer never uses sudo (typical when Node was installed from another user account). Give npm a user-level prefix, then re-run:
  npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"
Put that PATH line in your shell profile too, so future shells can find pi."
  run npm install -g "$PI_PACKAGE@$PINNED_PI"
  NPM_BIN="$(npm prefix -g)/bin"
  case ":$PATH:" in
    *":$NPM_BIN:"*) ;;
    *)
      export PATH="$NPM_BIN:$PATH"
      note "ACTION REQUIRED: add $NPM_BIN to PATH in your shell profile so future shells can find pi"
      ;;
  esac
}
if command -v pi >/dev/null 2>&1; then
  FOUND_PI="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  FOUND_PI="${FOUND_PI:-unknown}"
  if [ "$FOUND_PI" = "$PINNED_PI" ]; then
    note "pi $FOUND_PI found (tested version); left untouched"
  elif [ "$PIN_PI" -eq 1 ]; then
    install_pi
    if [ "$DRY_RUN" -eq 1 ]; then
      note "pi would be set to $PINNED_PI (explicit --pin-pi)"
    else
      note "pi set to $PINNED_PI (explicit --pin-pi)"
    fi
  else
    note "pi $FOUND_PI found; left untouched (tested with $PINNED_PI; pass --pin-pi to install that version)"
  fi
else
  install_pi
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would install pi $PINNED_PI"
  else
    note "installed pi $PINNED_PI"
  fi
fi

# --- OpenRouter credentials ------------------------------------------------------
auth_ready() {
  (unset OPENROUTER_API_KEY; pi auth check --provider openrouter 2>/dev/null) | grep -q '^ready'
}
store_openrouter_key() {
  OR_KEY="$1" node -e '
    const { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");
    const path = require("node:path");
    const file = path.join(process.env.HOME, ".pi", "agent", "auth.json");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    store.openrouter = { type: "api_key", key: process.env.OR_KEY };
    writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  '
}
if command -v pi >/dev/null 2>&1 && auth_ready; then
  note "Pi already has OpenRouter credentials; left untouched"
elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would store OPENROUTER_API_KEY in Pi's auth store for CLI and desktop clients"
  else
    store_openrouter_key "$OPENROUTER_API_KEY"
    auth_ready || die "Pi does not report OpenRouter credentials as ready after storing the key."
    note "stored OPENROUTER_API_KEY in Pi's auth store (~/.pi/agent/auth.json, mode 600)"
  fi
elif [ "$DRY_RUN" -eq 1 ]; then
  note "would prompt for an OpenRouter API key (hidden input) and store it in Pi's auth store"
else
  [ -r /dev/tty ] || die "no terminal available for the API key prompt; set OPENROUTER_API_KEY and re-run."
  printf "OpenRouter API key (input hidden): " >/dev/tty
  IFS= read -rs OPENROUTER_KEY_INPUT </dev/tty
  echo >/dev/tty
  [ -n "$OPENROUTER_KEY_INPUT" ] || die "empty API key."
  store_openrouter_key "$OPENROUTER_KEY_INPUT"
  unset OPENROUTER_KEY_INPUT
  auth_ready || die "Pi does not report OpenRouter credentials as ready after storing the key."
  note "stored OpenRouter key in Pi's auth store (~/.pi/agent/auth.json, mode 600)"
fi

# Resolve executable paths once so GUI clients do not depend on a login-shell PATH.
NODE_COMMAND="$(node -p 'process.execPath')"
if command -v pi >/dev/null 2>&1; then
  PI_COMMAND="$(command -v pi)"
elif [ "$DRY_RUN" -eq 1 ]; then
  PI_COMMAND="<absolute-path-to-pi>"
else
  die "pi was installed or detected but cannot now be found on PATH. Add npm's global bin directory to PATH and re-run."
fi

# Keep machine-specific paths and run artifacts outside the git checkout. Preserve
# this file on re-runs so installer updates never overwrite user policy changes.
CONFIG_PATH="$CYBERDECK_HOME/cyberdeck.config.json"
PI_POINTER="$CYBERDECK_HOME/pi-command"
if [ "$DRY_RUN" -eq 1 ]; then
  if [ -f "$CONFIG_PATH" ]; then
    note "installed policy at $CONFIG_PATH already exists; would leave it untouched"
  else
    note "would create installed policy at $CONFIG_PATH with machine-specific executable paths"
  fi
  note "would record the Pi executable path for Claude Desktop at $PI_POINTER"
else
  mkdir -p "$CYBERDECK_HOME"
  printf '%s\n' "$PI_COMMAND" >"$PI_POINTER"
  chmod 600 "$PI_POINTER"
  if [ -f "$CONFIG_PATH" ]; then
    note "installed policy at $CONFIG_PATH already exists; left untouched"
  else
    SOURCE_CONFIG_PATH="$SOURCE_CONFIG_PATH" CONFIG_PATH="$CONFIG_PATH" \
      PI_COMMAND="$PI_COMMAND" CYBERDECK_HOME="$CYBERDECK_HOME" node -e '
        const { readFileSync, writeFileSync, chmodSync } = require("node:fs");
        const path = require("node:path");
        const source = process.env.SOURCE_CONFIG_PATH;
        const target = process.env.CONFIG_PATH;
        const config = JSON.parse(readFileSync(source, "utf8"));
        config.$schema = path.join(path.dirname(source), "cyberdeck.config.schema.json");
        config.artifactDirectory = path.join(process.env.CYBERDECK_HOME, "runs");
        config.pi.command = process.env.PI_COMMAND;
        writeFileSync(target, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
        chmodSync(target, 0o600);
      '
    note "created installed policy at $CONFIG_PATH (absolute Pi path; artifacts in $CYBERDECK_HOME/runs)"
  fi
fi

# --- Register with Claude Code ----------------------------------------------------
# User-scoped MCP servers live in ~/.claude.json. Prefer Claude's CLI when it
# is present; otherwise merge the same documented stdio shape directly so the
# default location is ready when Claude Code is installed.
CLAUDE_CONFIG="$HOME/.claude.json"
if command -v claude >/dev/null 2>&1; then
  if claude mcp get cyberdeck >/dev/null 2>&1; then
    note "Claude Code: cyberdeck already registered; left untouched"
  else
    run claude mcp add --scope user cyberdeck -- "$NODE_COMMAND" "$APP_DIR/bin/cyberdeck-mcp.mjs" --config "$CONFIG_PATH"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Code: would register cyberdeck at user scope"
    else
      note "Claude Code: registered cyberdeck at user scope"
    fi
  fi
elif [ -f "$CLAUDE_CONFIG" ] && node -e '
  const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.exit(settings?.mcpServers?.cyberdeck ? 0 : 1);
' "$CLAUDE_CONFIG" 2>/dev/null; then
  note "Claude Code: cyberdeck already registered in $CLAUDE_CONFIG; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Claude Code CLI not found; would register cyberdeck directly in $CLAUDE_CONFIG"
else
  CLAUDE_CONFIG="$CLAUDE_CONFIG" NODE_COMMAND="$NODE_COMMAND" APP_DIR="$APP_DIR" \
    CONFIG_PATH="$CONFIG_PATH" node -e '
      const { existsSync, readFileSync, writeFileSync } = require("node:fs");
      const file = process.env.CLAUDE_CONFIG;
      const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      settings.mcpServers = settings.mcpServers ?? {};
      settings.mcpServers.cyberdeck = {
        type: "stdio",
        command: process.env.NODE_COMMAND,
        args: [
          `${process.env.APP_DIR}/bin/cyberdeck-mcp.mjs`,
          "--config",
          process.env.CONFIG_PATH,
        ],
        env: {},
      };
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    ' || die "cannot update $CLAUDE_CONFIG. Ensure it contains valid JSON and is writable, then re-run."
  note "Claude Code CLI not found; registered cyberdeck directly in $CLAUDE_CONFIG"
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
  ' || die "cannot update $HOME/.claude/settings.json. Ensure it contains valid JSON and is writable, then re-run."
  note "Claude Code: permission rules ensured (allow research, ask implement)"
fi

# --- Register with Codex and ChatGPT Desktop --------------------------------------
# ~/.codex/config.toml is the documented default and is shared by Codex CLI and
# ChatGPT Desktop on the same Mac host. Register it even if the CLI is not on PATH.
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
command = "$NODE_COMMAND"
args = ["$APP_DIR/bin/cyberdeck-mcp.mjs", "--config", "$CONFIG_PATH"]
enabled_tools = ["research", "implement"]
startup_timeout_sec = 10
tool_timeout_sec = 1900

[mcp_servers.cyberdeck.tools.research]
approval_mode = "auto"

[mcp_servers.cyberdeck.tools.implement]
approval_mode = "prompt"
EOF
  note "Codex: appended cyberdeck block to $CODEX_CONFIG"
fi

# --- macOS desktop clients --------------------------------------------------------
PLATFORM="$(uname -s)"
if [ "$PLATFORM" = "Darwin" ]; then
  if command -v open >/dev/null 2>&1 && open -Ra "ChatGPT" >/dev/null 2>&1; then
    note "ChatGPT Desktop: uses the Codex registration in $CODEX_CONFIG; restart the app"
  else
    note "ChatGPT Desktop not found; Codex config is ready if the app is installed later"
  fi

  if command -v open >/dev/null 2>&1 && open -Ra "Claude" >/dev/null 2>&1; then
    command -v zip >/dev/null 2>&1 || die "zip is required to build the Claude Desktop MCP bundle on macOS. Install the Xcode command-line tools and re-run."
    MCPB_STAGE="$CYBERDECK_HOME/.mcpb-stage"
    MCPB_PATH="$CYBERDECK_HOME/cyberdeck.mcpb"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Desktop: would build $MCPB_PATH and open its installation dialog"
    else
      rm -rf "$MCPB_STAGE"
      mkdir -p "$MCPB_STAGE"
      cp "$APP_DIR/desktop/claude-manifest.json" "$MCPB_STAGE/manifest.json"
      cp -R "$APP_DIR/bin" "$APP_DIR/src" "$APP_DIR/desktop" "$MCPB_STAGE/"
      cp "$APP_DIR/cyberdeck.config.json" "$APP_DIR/cyberdeck.config.schema.json" \
        "$APP_DIR/package.json" "$APP_DIR/LICENSE" "$MCPB_STAGE/"
      rm -f "$MCPB_PATH"
      (cd "$MCPB_STAGE" && zip -qr "$MCPB_PATH" .)
      rm -rf "$MCPB_STAGE"
      if open "$MCPB_PATH"; then
        note "Claude Desktop: opened $MCPB_PATH; select a workspace root and approve installation in Claude"
        if [ -r /dev/tty ]; then
          printf "Complete the Cyberdeck install in Claude Desktop, then press Return here: " >/dev/tty
          IFS= read -r _ </dev/tty || true
        else
          note "ACTION REQUIRED: complete the open Claude Desktop installation dialog before using Cyberdeck"
        fi
      else
        note "ACTION REQUIRED: Claude Desktop could not open $MCPB_PATH; install it from Settings > Extensions > Advanced settings > Install Extension"
      fi
    fi
  else
    note "Claude Desktop not found; skipped its MCP bundle (the installer never installs desktop apps)"
  fi
else
  note "macOS desktop integrations skipped on $PLATFORM; no desktop app detection or installation was attempted"
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
echo "Restart the calling MCP client to pick up the server."
