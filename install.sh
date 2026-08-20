#!/usr/bin/env bash
set -Eeuo pipefail

main() {
PINNED_PI="0.84.2"
PI_PACKAGE="@earendil-works/pi-coding-agent"
CYBERDECK_HOME="${CYBERDECK_HOME:-$HOME/.cyberdeck}"
if [ -d "$CYBERDECK_HOME" ]; then CYBERDECK_HOME="$(cd "$CYBERDECK_HOME" && pwd -P)"; fi
CYBERDECK_REPO_URL="${CYBERDECK_REPO_URL:-https://github.com/cmacdev/cyberdeck.git}"

usage() {
  cat <<EOF
Usage: bash install.sh [--dry-run] [--pin-pi] [--uninstall]

Idempotent and sudo-free. Registers Cyberdeck with Claude Code and Codex (plus Claude
Desktop and ChatGPT Desktop on macOS), installs Pi $PINNED_PI only when pi is absent
(--pin-pi forces that version), and stores an OpenRouter key in Pi's auth store only
when Pi has none. Piped runs clone CYBERDECK_REPO_URL into CYBERDECK_HOME/app.
--dry-run prints the plan; --uninstall reverses every write except Pi and its auth store.
EOF
}

DRY_RUN=0
PIN_PI=0
UNINSTALL=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --pin-pi) PIN_PI=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

LOG_PREFIX="cyberdeck-install"
if [ "$UNINSTALL" -eq 1 ]; then LOG_PREFIX="cyberdeck-uninstall"; fi
SUMMARY=()
note() { SUMMARY+=("$1"); echo "$LOG_PREFIX: $1"; }
die() {
  echo "$LOG_PREFIX: $1" >&2
  echo "$LOG_PREFIX: see install-helper.md, section 'If the installer stops'." >&2
  exit 1
}
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$LOG_PREFIX: would run: $*"
  else
    "$@" || die "'$*' failed. Fix the error it printed above, then re-run."
  fi
}
trap 'die "unexpected failure at install.sh line $LINENO running: $BASH_COMMAND. Fix the error printed above, then re-run."' ERR
tty_usable() {
  ( : </dev/tty ) 2>/dev/null
}
is_cyberdeck_home() {
  [ -f "$CYBERDECK_HOME/pi-command" ] || [ -f "$CYBERDECK_HOME/cyberdeck.config.json" ] \
    || [ -f "$CYBERDECK_HOME/app/bin/cyberdeck-mcp.mjs" ]
}
CLAUDE_CONFIG="$HOME/.claude.json"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_CONFIG="$HOME/.codex/config.toml"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_MODELS="$PI_AGENT_DIR/models.json"
PI_SETTINGS="$PI_AGENT_DIR/settings.json"
ATOMIC_WRITE='
  const { existsSync, realpathSync, renameSync, statSync, writeFileSync } = require("node:fs");
  const atomicWrite = (file, text, mode) => {
    const target = existsSync(file) ? realpathSync(file) : file;
    const temporary = target + ".cyberdeck.tmp";
    writeFileSync(temporary, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : mode });
    renameSync(temporary, target);
  };
'
claude_registered_in_file() {
  [ -f "$CLAUDE_CONFIG" ] && node -e '
    const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.exit(settings?.mcpServers?.cyberdeck ? 0 : 1);
  ' "$CLAUDE_CONFIG" 2>/dev/null
}
codex_registered() {
  [ -f "$CODEX_CONFIG" ] && grep -qE '^[[:space:]]*\[mcp_servers\.cyberdeck\]' "$CODEX_CONFIG"
}
pi_default_set() {
  [ -f "$PI_SETTINGS" ] && node -e '
    const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.exit(settings.defaultModel || settings.defaultProvider || settings.defaultThinkingLevel ? 0 : 1);
  ' "$PI_SETTINGS" 2>/dev/null
}
zdr_pinned() {
  [ -f "$PI_MODELS" ] && node -e '
    const routing = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))?.providers?.openrouter?.compat?.openRouterRouting;
    process.exit(routing?.zdr === true && routing?.data_collection === "deny" ? 0 : 1);
  ' "$PI_MODELS" 2>/dev/null
}

if [ "$UNINSTALL" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required. Install it first (e.g. 'brew install node')."

  if command -v claude >/dev/null 2>&1 && claude mcp get cyberdeck >/dev/null 2>&1; then
    run claude mcp remove --scope user cyberdeck
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Code: would remove the cyberdeck registration"
    else
      note "Claude Code: removed the cyberdeck registration"
    fi
  elif claude_registered_in_file; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Code: would remove cyberdeck from $CLAUDE_CONFIG"
    else
      CLAUDE_CONFIG="$CLAUDE_CONFIG" node -e "$ATOMIC_WRITE"'
        const { readFileSync } = require("node:fs");
        const file = process.env.CLAUDE_CONFIG;
        const settings = JSON.parse(readFileSync(file, "utf8"));
        delete settings.mcpServers.cyberdeck;
        atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o600);
      ' || die "cannot update $CLAUDE_CONFIG. Ensure it contains valid JSON and is writable, then re-run."
      note "Claude Code: removed cyberdeck from $CLAUDE_CONFIG"
    fi
  else
    note "Claude Code: cyberdeck is not registered; nothing to remove"
  fi

  if [ -f "$CLAUDE_SETTINGS" ] && grep -q 'mcp__cyberdeck__' "$CLAUDE_SETTINGS"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Claude Code: would remove the mcp__cyberdeck__* permission rules from $CLAUDE_SETTINGS"
    else
      CLAUDE_SETTINGS="$CLAUDE_SETTINGS" node -e "$ATOMIC_WRITE"'
        const { readFileSync } = require("node:fs");
        const file = process.env.CLAUDE_SETTINGS;
        const settings = JSON.parse(readFileSync(file, "utf8"));
        for (const list of Object.values(settings.permissions ?? {})) {
          if (!Array.isArray(list)) continue;
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (typeof list[i] === "string" && list[i].startsWith("mcp__cyberdeck__")) list.splice(i, 1);
          }
        }
        atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o644);
      ' || die "cannot update $CLAUDE_SETTINGS. Ensure it contains valid JSON and is writable, then re-run."
      note "Claude Code: removed the mcp__cyberdeck__* permission rules"
    fi
  else
    note "Claude Code: no cyberdeck permission rules; nothing to remove"
  fi

  if codex_registered; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Codex: would remove the [mcp_servers.cyberdeck] block from $CODEX_CONFIG"
    else
      CODEX_CONFIG="$CODEX_CONFIG" node -e "$ATOMIC_WRITE"'
        const { readFileSync } = require("node:fs");
        const file = process.env.CODEX_CONFIG;
        const kept = [];
        let skipping = false;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers\.cyberdeck[\].]/.test(line);
          if (!skipping) kept.push(line);
        }
        while (kept.length > 1 && kept[kept.length - 1] === "" && kept[kept.length - 2] === "") kept.pop();
        atomicWrite(file, kept.join("\n"), 0o644);
      ' || die "cannot update $CODEX_CONFIG. Ensure the file is writable, then re-run."
      note "Codex: removed the cyberdeck block from $CODEX_CONFIG (other content preserved)"
    fi
  else
    note "Codex: cyberdeck is not registered; nothing to remove"
  fi

  remove_deck_skill() {
    local client="$1"
    local target="$2"
    if [ -f "$target/.cyberdeck-managed" ]; then
      run rm -rf "$target"
      if [ "$DRY_RUN" -eq 1 ]; then
        note "$client: would remove the managed deck skill at $target"
      else
        note "$client: removed the managed deck skill at $target"
      fi
    elif [ -e "$target" ]; then
      note "$client: $target is not managed by Cyberdeck; left untouched"
    else
      note "$client: no deck skill installed; nothing to remove"
    fi
  }
  remove_deck_skill "Claude Code" "$HOME/.claude/skills/deck"
  remove_deck_skill "Codex and ChatGPT Desktop" "$HOME/.codex/skills/deck"

  if [ -f "$PI_SETTINGS" ] && grep -q '"cyberdeckDefaults": true' "$PI_SETTINGS"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Pi: would remove the installer-set default model from $PI_SETTINGS"
    else
      PI_SETTINGS="$PI_SETTINGS" node -e "$ATOMIC_WRITE"'
        const { readFileSync, unlinkSync } = require("node:fs");
        const file = process.env.PI_SETTINGS;
        const settings = JSON.parse(readFileSync(file, "utf8"));
        delete settings.defaultProvider;
        delete settings.defaultModel;
        delete settings.defaultThinkingLevel;
        if (settings.enableInstallTelemetry === false) delete settings.enableInstallTelemetry;
        delete settings.cyberdeckDefaults;
        if (Object.keys(settings).length) atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o600);
        else unlinkSync(file);
      ' || die "cannot update $PI_SETTINGS. Make it valid JSON and writable, then re-run."
      note "Pi: removed the installer-set default model from $PI_SETTINGS (other settings preserved)"
    fi
  else
    note "Pi: no installer-set default model; nothing to remove"
  fi

  if zdr_pinned; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "Pi: would remove the zero-data-retention routing pin from $PI_MODELS"
    else
      PI_MODELS="$PI_MODELS" node -e "$ATOMIC_WRITE"'
        const { readFileSync, unlinkSync } = require("node:fs");
        const file = process.env.PI_MODELS;
        const models = JSON.parse(readFileSync(file, "utf8"));
        const routing = models.providers.openrouter.compat.openRouterRouting;
        delete routing.zdr;
        delete routing.data_collection;
        const prune = (parent, key) => { if (!Object.keys(parent[key]).length) delete parent[key]; };
        prune(models.providers.openrouter.compat, "openRouterRouting");
        prune(models.providers.openrouter, "compat");
        prune(models.providers, "openrouter");
        prune(models, "providers");
        if (Object.keys(models).length) atomicWrite(file, JSON.stringify(models, null, 2) + "\n", 0o600);
        else unlinkSync(file);
      ' || die "cannot update $PI_MODELS. Make it valid JSON and writable, then re-run."
      note "Pi: removed the zero-data-retention routing pin from $PI_MODELS (other content preserved)"
    fi
  else
    note "Pi: no zero-data-retention routing pin; nothing to remove"
  fi

  if [ "$(uname -s)" = "Darwin" ] && [ -e "$CYBERDECK_HOME/cyberdeck.mcpb" ]; then
    note "ACTION REQUIRED: remove the Cyberdeck extension in Claude Desktop under Settings > Extensions (this script never edits Claude Desktop's app state)"
  fi

  if is_cyberdeck_home; then
    run rm -rf "$CYBERDECK_HOME"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would remove $CYBERDECK_HOME (app, installed policy, run artifacts)"
    else
      note "removed $CYBERDECK_HOME (app, installed policy, run artifacts)"
    fi
  elif [ -d "$CYBERDECK_HOME" ]; then
    note "$CYBERDECK_HOME is not a Cyberdeck home; left untouched"
  else
    note "$CYBERDECK_HOME is already absent"
  fi

  echo
  echo "$LOG_PREFIX: done. Summary:"
  for line in "${SUMMARY[@]}"; do echo "  - $line"; done
  echo "Pi and its auth store were left untouched; see install-helper.md 'Uninstall' to remove them too."
  exit 0
fi

if [ -d "$CYBERDECK_HOME" ] && [ -n "$(ls -A "$CYBERDECK_HOME" 2>/dev/null)" ] && ! is_cyberdeck_home; then
  die "$CYBERDECK_HOME exists and is not a Cyberdeck home. Set CYBERDECK_HOME to a new or empty directory (or remove that directory if it is a stale Cyberdeck home), then re-run."
fi

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/cyberdeck-mcp.mjs" ]; then
  APP_DIR="$SCRIPT_DIR"
  note "using checkout at $APP_DIR"
else
  APP_DIR="$CYBERDECK_HOME/app"
  command -v git >/dev/null 2>&1 || die "git is required to fetch cyberdeck (e.g. 'xcode-select --install' or 'brew install git')."
  export GIT_TERMINAL_PROMPT=0
  git ls-remote --exit-code "$CYBERDECK_REPO_URL" HEAD >/dev/null 2>&1 \
    || die "cannot reach $CYBERDECK_REPO_URL (git ls-remote failed). Check network access, or set CYBERDECK_REPO_URL to a reachable clone URL, then re-run."
  if [ -d "$APP_DIR/.git" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would update $APP_DIR to the published version (local changes there are discarded)"
    elif git -C "$APP_DIR" fetch --quiet --depth 1 origin HEAD \
      && git -C "$APP_DIR" reset --hard --quiet FETCH_HEAD; then
      note "updated $APP_DIR to the published version (local changes there are discarded)"
    else
      rm -rf "$APP_DIR"
      git clone --depth 1 --quiet "$CYBERDECK_REPO_URL" "$APP_DIR" \
        || die "cannot update or reclone $APP_DIR from $CYBERDECK_REPO_URL. Remove that directory and re-run."
      note "recloned $APP_DIR (the previous copy could not be updated)"
    fi
  else
    run mkdir -p "$CYBERDECK_HOME"
    run chmod 700 "$CYBERDECK_HOME"
    run git clone --depth 1 --quiet "$CYBERDECK_REPO_URL" "$APP_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then
      note "would clone $CYBERDECK_REPO_URL to $APP_DIR"
    else
      note "cloned $CYBERDECK_REPO_URL to $APP_DIR"
    fi
  fi
fi

command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required. Install it first (e.g. 'brew install node')."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "Node.js >= 20 is required; found $(node --version). Upgrade it first (e.g. 'brew install node')."
note "node $(node --version) ok"

npm_global_writable() {
  local target
  for target in "$(npm root -g)" "$(npm prefix -g)/bin"; do
    while [ ! -e "$target" ]; do target="$(dirname "$target")"; done
    [ -w "$target" ] || return 1
  done
}
install_pi() {
  command -v npm >/dev/null 2>&1 || die "npm is required to install Pi; it ships with Node. Install Node.js with npm included, then re-run."
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

auth_ready() {
  local report
  report="$( (unset OPENROUTER_API_KEY; pi auth check --provider openrouter 2>/dev/null) || true)"
  grep -q '^ready' <<<"$report"
}
store_openrouter_key() {
  OR_KEY="$1" PI_AGENT_DIR="$PI_AGENT_DIR" node -e "$ATOMIC_WRITE"'
    const { chmodSync, mkdirSync, readFileSync } = require("node:fs");
    const path = require("node:path");
    const file = path.join(process.env.PI_AGENT_DIR, "auth.json");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    store.openrouter = { type: "api_key", key: process.env.OR_KEY };
    atomicWrite(file, JSON.stringify(store, null, 2) + "\n", 0o600);
    chmodSync(file, 0o600);
  ' || die "cannot update $PI_AGENT_DIR/auth.json. Make it valid JSON and writable, then re-run."
}
AUTH_FIX="Run 'pi auth check --provider openrouter', fix what it reports, then re-run."
if command -v pi >/dev/null 2>&1 && auth_ready; then
  note "Pi already has OpenRouter credentials; left untouched"
elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would store OPENROUTER_API_KEY in Pi's auth store for CLI and desktop clients"
  else
    store_openrouter_key "$OPENROUTER_API_KEY"
    auth_ready || die "Pi does not report OpenRouter credentials as ready after storing the key. $AUTH_FIX"
    note "stored OPENROUTER_API_KEY in Pi's auth store (~/.pi/agent/auth.json, mode 600)"
  fi
elif [ "$DRY_RUN" -eq 1 ]; then
  note "would prompt for an OpenRouter API key (hidden input) and store it in Pi's auth store"
else
  tty_usable || die "no terminal available for the API key prompt; set OPENROUTER_API_KEY and re-run."
  printf "OpenRouter API key (input hidden): " >/dev/tty
  IFS= read -rs OPENROUTER_KEY_INPUT </dev/tty || OPENROUTER_KEY_INPUT=""
  echo >/dev/tty
  [ -n "$OPENROUTER_KEY_INPUT" ] || die "empty API key. Re-run and paste the key at the prompt, or set OPENROUTER_API_KEY."
  store_openrouter_key "$OPENROUTER_KEY_INPUT"
  unset OPENROUTER_KEY_INPUT
  auth_ready || die "Pi does not report OpenRouter credentials as ready after storing the key. $AUTH_FIX"
  note "stored OpenRouter key in Pi's auth store (~/.pi/agent/auth.json, mode 600)"
fi

if zdr_pinned; then
  note "Pi: OpenRouter routing already pinned to zero-data-retention endpoints in $PI_MODELS; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Pi: would pin OpenRouter routing to zero-data-retention endpoints (zdr true, data_collection deny) in $PI_MODELS"
else
  PI_MODELS="$PI_MODELS" node -e "$ATOMIC_WRITE"'
    const { mkdirSync, readFileSync } = require("node:fs");
    const path = require("node:path");
    const file = process.env.PI_MODELS;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const models = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const compat = ((models.providers ??= {}).openrouter ??= {}).compat ??= {};
    compat.openRouterRouting = { ...compat.openRouterRouting, zdr: true, data_collection: "deny" };
    atomicWrite(file, JSON.stringify(models, null, 2) + "\n", 0o600);
  ' || die "cannot update $PI_MODELS. Make it valid JSON (Pi accepts comments there; this installer does not) and writable, then re-run."
  note "Pi: pinned OpenRouter routing to zero-data-retention endpoints (zdr true, data_collection deny) in $PI_MODELS"
fi

if [ -f "$APP_DIR/cyberdeck.config.json" ]; then
  PI_DEFAULT_MODEL="$(node -p '
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).profiles.implementation;
    p.roles[p.defaultRole].model' "$APP_DIR/cyberdeck.config.json")"
  PI_DEFAULT_THINKING="$(node -p '
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).profiles.implementation;
    p.roles[p.defaultRole].defaultThinking ?? p.defaultThinking' "$APP_DIR/cyberdeck.config.json")"
elif [ "$DRY_RUN" -eq 1 ]; then
  PI_DEFAULT_MODEL="the implementation default role's model"
  PI_DEFAULT_THINKING="its default"
else
  die "cyberdeck.config.json is missing from $APP_DIR. Restore the checkout (the piped installer clones a complete one), then re-run."
fi
if pi_default_set; then
  note "Pi: a default model is already configured in $PI_SETTINGS; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Pi: would set the interactive default to $PI_DEFAULT_MODEL (thinking $PI_DEFAULT_THINKING) and disable install telemetry in $PI_SETTINGS"
else
  PI_SETTINGS="$PI_SETTINGS" PI_DEFAULT_MODEL="$PI_DEFAULT_MODEL" PI_DEFAULT_THINKING="$PI_DEFAULT_THINKING" node -e "$ATOMIC_WRITE"'
    const { mkdirSync, readFileSync } = require("node:fs");
    const path = require("node:path");
    const file = process.env.PI_SETTINGS;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    settings.defaultProvider = "openrouter";
    settings.defaultModel = process.env.PI_DEFAULT_MODEL;
    settings.defaultThinkingLevel = process.env.PI_DEFAULT_THINKING;
    settings.enableInstallTelemetry ??= false;
    settings.cyberdeckDefaults = true;
    atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o600);
  ' || die "cannot update $PI_SETTINGS. Make it valid JSON and writable, then re-run."
  note "Pi: set the interactive default to $PI_DEFAULT_MODEL (thinking $PI_DEFAULT_THINKING) and disabled install telemetry in $PI_SETTINGS"
fi

NODE_COMMAND="$(node -p 'process.execPath')"
if command -v pi >/dev/null 2>&1; then
  PI_COMMAND="$(command -v pi)"
elif [ "$DRY_RUN" -eq 1 ]; then
  PI_COMMAND="<absolute-path-to-pi>"
else
  die "pi was installed or detected but cannot now be found on PATH. Add npm's global bin directory to PATH and re-run."
fi

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
  chmod 700 "$CYBERDECK_HOME"
  printf '%s\n' "$PI_COMMAND" >"$PI_POINTER"
  chmod 600 "$PI_POINTER"
  cp "$APP_DIR/cyberdeck.config.schema.json" "$CYBERDECK_HOME/cyberdeck.config.schema.json"
  if [ -f "$CONFIG_PATH" ]; then
    note "installed policy at $CONFIG_PATH already exists; left untouched"
  else
    SOURCE_CONFIG_PATH="$APP_DIR/cyberdeck.config.json" CONFIG_PATH="$CONFIG_PATH" \
      PI_COMMAND="$PI_COMMAND" CYBERDECK_HOME="$CYBERDECK_HOME" node -e '
        const { readFileSync, writeFileSync } = require("node:fs");
        const path = require("node:path");
        const config = JSON.parse(readFileSync(process.env.SOURCE_CONFIG_PATH, "utf8"));
        config.artifactDirectory = path.join(process.env.CYBERDECK_HOME, "runs");
        config.pi.command = process.env.PI_COMMAND;
        writeFileSync(process.env.CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      '
    note "created installed policy at $CONFIG_PATH (absolute Pi path; artifacts in $CYBERDECK_HOME/runs)"
  fi
fi

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
elif claude_registered_in_file; then
  note "Claude Code: cyberdeck already registered in $CLAUDE_CONFIG; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Claude Code CLI not found; would register cyberdeck directly in $CLAUDE_CONFIG"
else
  CLAUDE_CONFIG="$CLAUDE_CONFIG" NODE_COMMAND="$NODE_COMMAND" APP_DIR="$APP_DIR" \
    CONFIG_PATH="$CONFIG_PATH" node -e "$ATOMIC_WRITE"'
      const { readFileSync } = require("node:fs");
      const path = require("node:path");
      const file = process.env.CLAUDE_CONFIG;
      const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      settings.mcpServers = settings.mcpServers ?? {};
      settings.mcpServers.cyberdeck = {
        type: "stdio",
        command: process.env.NODE_COMMAND,
        args: [path.join(process.env.APP_DIR, "bin", "cyberdeck-mcp.mjs"), "--config", process.env.CONFIG_PATH],
        env: {},
      };
      atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o600);
    ' || die "cannot update $CLAUDE_CONFIG. Ensure it contains valid JSON and is writable, then re-run."
  note "Claude Code CLI not found; registered cyberdeck directly in $CLAUDE_CONFIG"
fi

if [ -f "$CLAUDE_SETTINGS" ] && grep -q 'mcp__cyberdeck__' "$CLAUDE_SETTINGS"; then
  note "Claude Code: permission rules for cyberdeck already present in $CLAUDE_SETTINGS; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Claude Code: would add permission rules (allow research, ask implement) to $CLAUDE_SETTINGS"
else
  CLAUDE_SETTINGS="$CLAUDE_SETTINGS" node -e "$ATOMIC_WRITE"'
    const { mkdirSync, readFileSync } = require("node:fs");
    const path = require("node:path");
    const file = process.env.CLAUDE_SETTINGS;
    mkdirSync(path.dirname(file), { recursive: true });
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    settings.permissions = settings.permissions ?? {};
    for (const [list, rule] of [["allow", "mcp__cyberdeck__research"], ["ask", "mcp__cyberdeck__implement"]]) {
      const rules = settings.permissions[list] ?? [];
      if (!rules.includes(rule)) rules.push(rule);
      settings.permissions[list] = rules;
    }
    atomicWrite(file, JSON.stringify(settings, null, 2) + "\n", 0o644);
  ' || die "cannot update $CLAUDE_SETTINGS. Ensure it contains valid JSON and is writable, then re-run."
  note "Claude Code: permission rules added (allow research, ask implement)"
fi

if codex_registered; then
  note "Codex: cyberdeck already registered; left untouched"
elif [ "$DRY_RUN" -eq 1 ]; then
  note "Codex: would append [mcp_servers.cyberdeck] block to $CODEX_CONFIG"
else
  mkdir -p "$HOME/.codex"
  CODEX_CONFIG="$CODEX_CONFIG" NODE_COMMAND="$NODE_COMMAND" APP_DIR="$APP_DIR" \
    CONFIG_PATH="$CONFIG_PATH" node -e '
      const { appendFileSync } = require("node:fs");
      const path = require("node:path");
      const quote = JSON.stringify;
      const server = path.join(process.env.APP_DIR, "bin", "cyberdeck-mcp.mjs");
      appendFileSync(process.env.CODEX_CONFIG, [
        "",
        "[mcp_servers.cyberdeck]",
        "command = " + quote(process.env.NODE_COMMAND),
        "args = [" + quote(server) + ", " + quote("--config") + ", " + quote(process.env.CONFIG_PATH) + "]",
        "enabled_tools = [" + quote("research") + ", " + quote("implement") + "]",
        "startup_timeout_sec = 10",
        "tool_timeout_sec = 1900",
        "",
        "[mcp_servers.cyberdeck.tools.research]",
        "approval_mode = " + quote("auto"),
        "",
        "[mcp_servers.cyberdeck.tools.implement]",
        "approval_mode = " + quote("prompt"),
        "",
      ].join("\n"));
    ' || die "cannot update $CODEX_CONFIG. Ensure the file is writable, then re-run."
  note "Codex: appended cyberdeck block to $CODEX_CONFIG"
fi

SOURCE_SKILL="$APP_DIR/skills/deck"
install_deck_skill() {
  local client="$1"
  local target="$2"
  local temporary="${target}.tmp.$$"
  if [ -e "$target" ] && [ ! -f "$target/.cyberdeck-managed" ]; then
    die "cannot install the deck skill at $target because that path already exists and is not managed by Cyberdeck. Move or remove it, then re-run."
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    note "$client: would install the deck skill at $target"
    return
  fi
  [ -f "$SOURCE_SKILL/SKILL.md" ] || die "the bundled deck skill is missing from $SOURCE_SKILL. Re-run after restoring the Cyberdeck checkout."
  rm -rf "$temporary"
  mkdir -p "$(dirname "$target")"
  cp -R "$SOURCE_SKILL" "$temporary"
  printf 'managed by cyberdeck install.sh\n' >"$temporary/.cyberdeck-managed"
  rm -rf "$target"
  mv "$temporary" "$target"
  note "$client: installed the deck skill at $target"
}
install_deck_skill "Claude Code" "$HOME/.claude/skills/deck"
install_deck_skill "Codex and ChatGPT Desktop" "$HOME/.codex/skills/deck"

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
        if tty_usable; then
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

if [ "$DRY_RUN" -eq 1 ]; then
  note "would verify: resolved config loads and schemas build (bin/cyberdeck-mcp.mjs --inspect)"
else
  (cd "$APP_DIR" && node bin/cyberdeck-mcp.mjs --config "$CONFIG_PATH" --inspect >/dev/null) \
    || die "verification failed: the resolved configuration does not load. Run 'node $APP_DIR/bin/cyberdeck-mcp.mjs --config $CONFIG_PATH --inspect' to see the error, fix $CONFIG_PATH, then re-run."
  note "verified: resolved config loads and schemas build"
fi

echo
echo "cyberdeck-install: done. Summary:"
for line in "${SUMMARY[@]}"; do echo "  - $line"; done
echo "Restart the calling MCP client to pick up the server."
}

main "$@"
