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
| `npm is required to install Pi` | Install Node.js with npm included, then re-run. |
| `npm's global directory … is not writable by <user>` | `npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"`, and put the `PATH` line in your shell profile. Do not sudo. |
| `ACTION REQUIRED: add <dir> to PATH` (not a stop) | Pi went into npm's global `bin`, which is not on your normal `PATH`; MCP clients use the recorded absolute path, but add the directory to your shell profile for terminal use. |
| `git is required` | Install git (`xcode-select --install` or `brew install git`). |
| `cannot reach <repo>` | Network, DNS, or URL problem: check connectivity, or set `CYBERDECK_REPO_URL` to a reachable clone URL. |
| `<dir> exists and is not a Cyberdeck home` | `CYBERDECK_HOME` points at an unrelated directory. Point it at a new or empty one, or unset it to use `~/.cyberdeck`. |
| `no terminal available for the API key prompt` | Run in an interactive terminal (the prompt reads `/dev/tty`), or set `OPENROUTER_API_KEY` for the installer. Agents: hand this step to the user; never ask for or handle the key. |
| `unknown provider` | Re-run with `--provider openrouter` or `--provider venice`. |
| `no terminal available for the Venice key prompt` / `empty Venice key` | Set `VENICE_API_KEY` or run interactively and enter an inference key with Private Only selected in Venice API settings. |
| `Venice setup failed` | Fix the reported API, model, or JSON error. Use a valid inference key with Private Only selected in Venice API settings. The installer requires an explicit service refusal of a synthetic anonymous text request and private, available, tool-capable role models. Remove conflicting Venice auth/endpoint overrides from `models.json`. |
| `empty API key` / `Pi does not report OpenRouter credentials as ready` | Nothing was stored, or Pi rejected the key. Check `pi auth check --provider openrouter`; re-run to be prompted again. |
| `pi was installed or detected but cannot now be found on PATH` | Add npm's global `bin` directory to the current shell's `PATH` and re-run. |
| `configured Pi command … is not executable` | Set `pi.command` in the named configuration file to the detected executable path printed in the error, then re-run. |
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
| `zip is required to build the Claude Desktop MCP bundle on macOS` | `xcode-select --install`, then re-run. Never checked on Linux. |
| `unexpected failure at install.sh line <n>` | The named command failed; fix the error printed above it and re-run. |
| `'<command>' failed` | That command printed its error just above; fix it and re-run. |
| `cannot update the app at <dir>` | The existing checkout stays in place. Fix the reported git or network error and re-run. |
| `verification failed: the resolved configuration does not load` | `node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect` prints the error; fix `~/.cyberdeck/cyberdeck.config.json` and re-run. |
| `pi <found> found; left untouched (tested with <pinned>…)` (not a stop) | A different Pi version stays. `--pin-pi` installs the tested version, up or down. |
| Claude Desktop says `ENOENT … package.mcpb` (not a stop) | The bundle was moved before approval. `open ~/.cyberdeck/cyberdeck.mcpb` and approve again. |
| OpenRouter says no endpoints match your data policy (not a stop) | Pick a model with a ZDR endpoint; keep `zdr` and `data_collection` enforced. |

## After a successful run

Restart the client. `claude mcp get cyberdeck` (Claude Code) or `~/.codex/config.toml` (Codex
CLI, ChatGPT Desktop) shows the registration; Claude Desktop lists the extension under Settings >
Extensions and its configured workspace must still exist.
`node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect`
prints the resolved contract (checkout installs: use the checkout path from the installer summary). To check the real Pi path once, call `research` with role
`mechanical`, `thinking: "off"`, and task `Reply with exactly the word READY and nothing else.`,
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

Claude Desktop does not read Claude Code's registration; it needs the `.mcpb` bundle the installer
builds (`open ~/.cyberdeck/cyberdeck.mcpb`, or Settings > Extensions > Advanced settings >
Install Extension).

## Update

Re-run the same install command. It resets `~/.cyberdeck/app` to the published version
(local changes there are discarded — develop in a checkout instead) and replaces
`~/.cyberdeck/cyberdeck.config.json` with that version's policy for the selected provider.
Machine paths are rewritten: the Pi executable, Pi state directory, artifact directory, and
schema path. Roles, model aliases, limits, workspace roots, and Pi arguments are not preserved.
Unrelated Pi settings are. The selected provider's privacy controls are reapplied before that
replacement; a failed Venice check leaves the previous policy in place. Venice reuses its saved
inference key, checks privacy enforcement against the published policy, and refreshes model
metadata. Pi is never updated implicitly: when the found version differs from the tested
one the installer says so and keeps it; add `--pin-pi` to move Pi to the tested version.
Delegated runs suppress Pi's update notices by design; interactive `pi` shows them itself.
Restart clients afterwards.

Edit the installed policy only for changes you are willing to reapply after the next install.
A model change must update both its role binding and the profile's `modelPatterns`. Validate with
`node ~/.cyberdeck/app/bin/cyberdeck-mcp.mjs --config ~/.cyberdeck/cyberdeck.config.json --inspect`,
using the checkout path when applicable, then restart the client and read `cyberdeck://catalog`
and `cyberdeck://profiles`.

## Uninstall

`install.sh --uninstall` removes the Claude Code registration and both permission rules, the
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
