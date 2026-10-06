# Install helper

Read this when `install.sh` stops, when a client does not show the tools afterwards, when you set a
client up by hand, or to uninstall. Agents repairing an install: every stop prints its cause; find
it in the table, apply the fix, and re-run the same command. Never use sudo, and never ask for or
handle API keys; hand those prompts to the user.

## If the installer stops

Every stop prints its cause; apply the fix and re-run the same command.

| Message | Fix |
| --- | --- |
| `Node.js >= 20 is required` | Install or upgrade Node (e.g. `brew install node`) so `node` on `PATH` is 20 or newer. |
| `npm is required to install or update Pi` | Install Node.js with npm included, then re-run. |
| `npm's global directory … is not writable by <user>` | `npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"`, and put the `PATH` line in your shell profile. Do not sudo. |
| `ACTION REQUIRED: add <dir> to PATH` (not a stop) | Pi went into npm's global `bin`, which is not on your normal `PATH`; MCP clients use the recorded absolute path, but add the directory to your shell profile for terminal use. |
| `git is required` | Install git (`xcode-select --install` or `brew install git`). |
| `cannot reach <repo>` | Network, DNS, or URL problem: check connectivity, or set `CYBERDECK_REPO_URL` to a reachable clone URL. |
| `<dir> exists and is not a Cyberdeck home` | `CYBERDECK_HOME` points at an unrelated directory. Point it at a new or empty one, or unset it to use `~/.cyberdeck`. |
| `no terminal available for the API key prompt` | Run in an interactive terminal (the prompt reads `/dev/tty`), or set `OPENROUTER_API_KEY` for the installer. Agents: hand this step to the user; never ask for or handle the key. |
| `unknown provider` | Re-run with `--provider openrouter` or `--provider venice`. |
| `no terminal available for the Venice key prompt` / `empty Venice key` | Set `VENICE_API_KEY` or run interactively and enter an inference key with Private Only selected in Venice API settings. |
| `Venice setup failed` | Fix the reported API, model, or JSON error. Use a valid inference key with Private Only selected in Venice API settings. The installer requires an explicit service refusal of a synthetic anonymous text request and private, available, tool-capable catalog models that accept every listed thinking level. Remove conflicting Venice auth/endpoint overrides from `models.json`. |
| `OpenRouter setup failed` | Make `~/.pi/agent/models.json` valid JSON (Pi accepts comments there; this installer does not) and writable, then re-run. |
| `empty API key` / `Pi does not report OpenRouter credentials as ready` | Nothing was stored, or Pi rejected the key. Check `pi auth check --provider openrouter`; re-run to be prompted again. |
| `pi was installed or detected but cannot now be found on PATH` | Add npm's global `bin` directory to the current shell's `PATH` and re-run. |
| `configured Pi command … is not executable` | Restore the detected Pi at the path printed in the error, then re-run. |
| `cannot update ~/.claude.json` | Make the file valid JSON and writable. Unrelated settings are preserved. |
| `cannot update ~/.claude/settings.json` | Make the file valid JSON and writable. Unrelated settings are preserved. |
| `cannot update ~/.codex/config.toml` | Make the file writable. Unrelated content is preserved. |
| `cannot update ~/.pi/agent/models.json` | Make it valid JSON (strip comments) and writable, then re-run. Unrelated content is preserved. |
| `cannot update ~/.pi/agent/auth.json` | Make it valid JSON and writable, then re-run. Other providers' credentials are preserved. |
| `cannot update ~/.cyberdeck/cyberdeck.config.json` | Make the published `cyberdeck.config.json` valid JSON and the installed policy writable, then re-run. |
| `cyberdeck.config.json is missing from <dir>` | The checkout is incomplete. Restore it (the piped installer clones a complete one), then re-run. |
| `the bundled deck skill is missing` | Restore or update the Cyberdeck checkout (piped installs update `~/.cyberdeck/app` automatically). |
| `Herdr is required for --herdr` | Install Herdr from herdr.dev, then re-run with `--herdr`. |
| `cannot install the coordinator at <path> because it is not managed by Cyberdeck` | Move that extension directory aside, then re-run with `--herdr`. |
| `cannot install the deck skill at <path> because that path already exists` | A non-Cyberdeck skill owns the name `deck`. Move or remove it; the installer never overwrites it. |
| `unexpected failure at install.sh line <n>` | The named command failed; fix the error printed above it and re-run. |
| `'<command>' failed` | That command printed its error just above; fix it and re-run. |
| `cannot update the app at <dir>` | The existing checkout stays in place. Fix the reported git or network error and re-run. |
| `verification failed: the resolved configuration does not load` | `node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect` prints the error; fix `~/.cyberdeck/cyberdeck.config.json` and re-run. |
| `set pi from <old> to <new>` (not a stop) | Pi moved to the latest npm release, up or down. Open a new shell if `pi --version` still shows the old one. |
| `version could not be read` (not a stop) | `pi --version` did not print a version. Fix that command, then re-run. |
| `pi <found> is current` (not a stop) | npm already has the latest Pi. Re-running still checks. |
| `ACTION REQUIRED: put <dir> first on PATH` (not a stop) | Another Pi is earlier on PATH. Put npm's global bin first so the shell `pi` matches the updated binary. |
| `ACTION REQUIRED: remove the Cyberdeck extension in Claude Desktop` (not a stop) | Cyberdeck no longer installs a Claude Desktop extension; Claude Code in the app uses the `cyberdeck` registration. Remove the extension under Settings > Extensions. |
| OpenRouter says no endpoints match your data policy (not a stop) | Pick a model with a ZDR endpoint; keep `zdr` and `data_collection` enforced. |

## After a successful run

Restart the client after a first install so it spawns the server. Clients bound to
`~/.cyberdeck/cyberdeck.config.json` pick up a reinstall without a restart. `claude mcp get cyberdeck` (Claude Code) or `~/.codex/config.toml` (Codex
CLI, ChatGPT Desktop) shows the registration.
`node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect`
prints the resolved contract (checkout installs: use the checkout path from the installer summary). To check the real Pi path once, call `research` with model
`deepseek-flash`, `thinking: "low"`, and task `Reply with exactly the word READY and nothing else.`,
and expect `final_output` containing `READY`.

## Manual client setup

Run the installer for the selected provider's privacy controls before setting up a client manually.
Use `--provider venice` for a restricted inference key and Pi model registration, or
`--provider openrouter` for the ZDR routing pin.

Any MCP client: `node /abs/cyberdeck/bin/cyberdeck-mcp.mjs --config /abs/cyberdeck.config.json`,
started inside a project so `@cwd` resolves there.

Claude Code:
`claude mcp add --scope user cyberdeck -- node /abs/bin/cyberdeck-mcp.mjs --config /abs/cyberdeck.config.json`,
plus `"permissions": {"allow": ["mcp__cyberdeck__research"], "ask": ["mcp__cyberdeck__implement"]}`
in `~/.claude/settings.json`.

Codex CLI and ChatGPT Desktop, in `~/.codex/config.toml`:

```toml
[mcp_servers.cyberdeck]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs", "--config", "/absolute/path/to/cyberdeck.config.json"]
enabled_tools = ["research", "implement"]
startup_timeout_sec = 10
tool_timeout_sec = 1900

[mcp_servers.cyberdeck.tools.research]
approval_mode = "auto"

[mcp_servers.cyberdeck.tools.implement]
approval_mode = "prompt"
```

## Update

Re-run the same install command. It resets `~/.cyberdeck/app` to the published version
(local changes there are discarded — develop in a checkout instead) and replaces
`~/.cyberdeck/cyberdeck.config.json` with that version's policy for the selected provider.
Machine paths are rewritten: the Pi executable, Pi state directory, artifact directory, and
schema path. Models, kinds, limits, workspace roots, and Pi arguments are not preserved.
Unrelated Pi settings are. The selected provider's privacy controls are reapplied before that
replacement; a failed Venice check leaves the previous policy in place. Venice reuses its saved
inference key, checks privacy enforcement against the published policy, and refreshes model
metadata. Every install runs `npm install -g @earendil-works/pi-coding-agent@latest`, including
when Pi is already present. `--dry-run` does not install, but still requires npm and a writable
global directory. There is no pin and no flag to keep an older Pi. A prerelease can move back to
the latest stable tag. Pi's auth store and other settings are not. `--uninstall` still leaves Pi.
Delegated runs suppress Pi's update notices by design; interactive `pi` shows them itself.
Servers bound to the installed policy pick up the replacement without a restart.

Edit the installed policy only for changes you are willing to reapply after the next install.
A model change edits its `models` entry: per-provider `id` and accepted `thinking`. Validate with
`node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect`,
using the checkout path when applicable. A server bound to that file picks up the change. Read
`cyberdeck://catalog` and `cyberdeck://profiles` to confirm.

## Uninstall

`install.sh --uninstall` removes the Claude Code registration and its permission rules, the
`[mcp_servers.cyberdeck]` block, both managed `deck` skills, the managed Pi coordinator,
and `~/.cyberdeck` (only when it is a Cyberdeck home); everything else in those files is preserved. On a Mac it reminds you to remove
the extension in Claude Desktop. Pi, its auth store, and provider settings stay. Revoke unused
Venice keys in Venice API settings separately.
Stop any coordinator worker servers with `herdr session stop <name>` before uninstalling.
Herdr and its official Pi state integration are left installed.
`npm uninstall -g @earendil-works/pi-coding-agent` and `rm -rf ~/.pi` remove them.

Pi's `settings.json` is left unchanged, including defaults written by older Cyberdeck
installers. To remove those defaults, edit that file yourself; remove `cyberdeckDefaults`
and only the `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, or
`enableInstallTelemetry` values you no longer want.
