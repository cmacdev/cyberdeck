```
┌────────────────────────── [ C Y B E R D E C K ] ───────────────────────────┐
│                                                                            │
│  TYPE..............................................local stdio MCP server  │
│  TOOLS...........................research (read-only) · implement (write)  │
│  ENGINE...........................................Pi on OpenRouter models  │
│  CLIENTS.......Claude Code · Codex CLI · ChatGPT Desktop · Claude Desktop  │
│  DEPENDENCIES...........................................................0  │
│  INVOKE............................................................./deck  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

[![CI](https://github.com/cmacdev/cyberdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/cmacdev/cyberdeck/actions/workflows/ci.yml)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-6fa47b)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-6fa47b)](LICENSE)

# Human

This is a cyberdeck that jacks your daily driver into the agent matrix. The initial goal is for the deck to help you spend less on tokens by using the right models for each job. It packages an opinionated protocol that makes it easy for your primary agent to make the right decisions (so you do not have to think about them).

Run install, **add an [openrouter](https://openrouter.ai/) API key**, and tell Claude or ChatGPT to use `/deck` for subagents. It should work with any harness including Pi (which is what the deck installs and uses itself).

```sh
curl -fsSL https://raw.githubusercontent.com/cmacdev/cyberdeck/master/install.sh | bash
```

If you have any issues just tell your primary agent to look at cyberdeck and fix it. Same for customising.

**It is always a good idea to get your primary agent to look at the repo first and do a quick compatibility and security scan.**
Cyberdeck installs enforce ZDR and are otherwise conscious of security and privacy, but this remains your responsibility.

For Claude Desktop, a dialog will open that asks for a **workspace root**. Don't get a fright, choose the folder that contains your projects. That will cover every project inside it. Change it any time: Settings > Extensions > Cyberdeck > Configure. Also, approve the tools in Configure for Cyberdeck.

> PRs with minimal lines and human written descriptions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

# Agents

Cyberdeck is a small local MCP server (stdio, no npm dependencies) that turns Pi + OpenRouter
into a typed delegation boundary for the coding agent you already use. The calling agent decides
when to delegate; Cyberdeck enforces the visible policy: read-only `research` versus
write-capable `implement`, bound models, workspace roots, limits, and artifacts. Pi is the inner
engine Cyberdeck spawns, not a client.

The installer supports Claude Code and Codex CLI; on macOS it also prepares ChatGPT Desktop and a
Claude Desktop extension. Any MCP client that can launch a local stdio server can use it.

## Tools and roles

- `research`: read-only Pi tool policy. Cyberdeck refuses to start if this profile includes Pi's
  `bash`, `edit`, or `write` tools.
- `implement`: write/shell-capable policy with honest destructive/open-world MCP annotations.

Each tool takes a `role` (omit for the profile default) and an optional `model` override that
must match the profile's `modelPatterns`. Policy lives in `cyberdeck.config.json`;
`npm run inspect` prints the resolved contract, and `cyberdeck://catalog` and
`cyberdeck://profiles` expose it to the client.

| Tool | Role | Model | Use when |
| --- | --- | --- | --- |
| `research` | `mechanical` (default) | `deepseek/deepseek-v4-flash-0731` | Cheap survey, inventory, grep, citation |
| `research` | `verify` | `moonshotai/kimi-k3` | Judgment-bearing independent check |
| `research` | `adversarial` | `x-ai/grok-4.6` | Attack a plan, find holes, hostile review |
| `implement` | `intellectual` (default) | `x-ai/grok-4.6` | Bounded, spec-exact, reviewable diffs |
| `implement` | `gritty` | `moonshotai/kimi-k3` | Ambiguous or cross-cutting; thorough |

Pi runs stateless (`--no-session`), ignores project-local Pi extensions unless
`pi.trustProjectFiles` is `true`, reuses your user-level Pi auth and settings while
`pi.stateDirectory` is `null`, and loads `AGENTS.md`/`CLAUDE.md` from the working directory while
`pi.loadContextFiles` is `true`.

## What leaves your machine

- The task, constraints, attached `context_files`, and whatever Pi's enabled tools read go to
  OpenRouter and from there to the model bound to the chosen role, restricted to
  zero-data-retention endpoints that do not train on your data (the routing pin below).
- Cyberdeck itself makes no network calls and disables Pi's update check and install telemetry
  for every run (`PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`); the installer also turns Pi's
  install telemetry off for interactive use. Pi's tools reach whatever the task uses, such as a
  `web_search` extension or `bash` under `implement`.
- The installer contacts github.com (clone) and the npm registry (Pi, only when absent).
- The OpenRouter key lives only in Pi's auth store, never in Cyberdeck files or run artifacts.

Read [SECURITY.md](SECURITY.md) for the enforced and unenforced boundaries before unattended `implement`.

## Requirements

macOS or Linux, Node.js 20 or newer, git (piped install), and an OpenRouter key. No Windows
support; open an issue if you want it. Pi 0.84.2 is installed with
`npm install -g` only when `pi` is absent (`--pin-pi` forces that version); an existing Pi is
never touched. Everything else is zero-dependency Node.

## Install

Run the command at the top. Append `-s -- --dry-run` to print the plan without performing any
of the writes below (the pi and claude probes may still create those tools' own state files); `-s -- --uninstall`
reverses it. Re-running the same command is also the update path (`--pin-pi` moves Pi to the
tested version). From a checkout, `bash install.sh [--dry-run|--uninstall]` registers the
checkout itself.

The key is taken from `OPENROUTER_API_KEY`, else prompted for with hidden input, and stored only
when Pi has no OpenRouter credentials. The installer never uses sudo, is idempotent, and writes
exactly these locations:

| Path | Content |
| --- | --- |
| `~/.cyberdeck/app` | Clone of this repo, reset to the published version on re-runs (piped install only) |
| `~/.cyberdeck/cyberdeck.config.json` | Installed policy: the shipped config with the absolute Pi path and `~/.cyberdeck/runs` as artifact directory (mode 600, preserved on re-run) |
| `~/.cyberdeck/cyberdeck.config.schema.json`, `~/.cyberdeck/pi-command` | Schema copy for editors; Pi path for Claude Desktop |
| `~/.claude.json` | User-scope `cyberdeck` stdio server (`claude mcp add` when the CLI is present) |
| `~/.claude/settings.json` | `permissions.allow: mcp__cyberdeck__research`, `permissions.ask: mcp__cyberdeck__implement` |
| `~/.codex/config.toml` | `[mcp_servers.cyberdeck]` block (research `auto`, implement `prompt`); shared by Codex CLI and ChatGPT Desktop |
| `~/.claude/skills/deck`, `~/.codex/skills/deck` | The `deck` skill with a `.cyberdeck-managed` marker; an unmanaged skill of that name is never overwritten |
| `~/.pi/agent/auth.json` | OpenRouter key, only when Pi had none |
| `~/.pi/agent/models.json` | OpenRouter routing pin `zdr: true`, `data_collection: "deny"` for all Pi OpenRouter calls; other content preserved |
| `~/.pi/agent/settings.json` | Interactive default `x-ai/grok-4.6` at thinking `high` plus install telemetry off, only when no default model is configured; Cyberdeck calls always pass model and thinking explicitly |
| npm's global directory (`npm prefix -g`) | Pi, only when `pi` was absent; `--uninstall` leaves it |
| `~/.cyberdeck/cyberdeck.mcpb` | macOS with Claude Desktop installed: MCP bundle; the installer opens it and Claude asks for a workspace root and approval |
| `~/.cyberdeck/claude-desktop.config.json`, `~/.cyberdeck/claude-desktop-runs` | Written by the Claude Desktop launcher on each start: the installed policy scoped to the chosen workspace root, and its artifacts |

Stops and their fixes, manual client setup, and uninstall: [install-helper.md](install-helper.md).
Restart the client afterwards. Invoke the skill with `/deck …` (Claude Code), `$deck …` (Codex
CLI), or `@deck …` (ChatGPT Desktop); it picks `research` or `implement` and a role, and calls
Cyberdeck with the absolute project directory.

## Configure

Edit `~/.cyberdeck/cyberdeck.config.json` (installed) or `cyberdeck.config.json` (checkout): each
profile's `roles` (bound `model`, one-line `when`, thinking ceilings, optional `promptPreamble`),
`modelPatterns` (the allowlist for role defaults and `model` overrides), `tools` (exact Pi
built-in or extension tool names), `workspaceRoots` (`@cwd` is the server process's working
directory; `/` and `$HOME` are refused), and `limits`. `npm run inspect` prints the resolved
schemas, annotations, paths, catalog, and limits; it never prints a key.

## Calls, results, artifacts

Both tools take `task` and an absolute `working_directory` inside a configured root, plus
optional `role`, `model`, `thinking`, `context_files`, `constraints`, `timeout_seconds`, and
`return_characters`; every ceiling is in the MCP JSON Schema and unknown fields are rejected.
Results are typed: `status` (`succeeded`, `failed`, `timed_out`, `output_limit`, `rejected`), run
id, role, actual model, Pi tool policy, `final_output` (the assistant's final text, capped at
`return_characters`), usage, `error`, and artifact paths. A client-cancelled request
(`notifications/cancelled`) terminates Pi and gets no response; its `result.json` records
`status: "cancelled"`.

Each accepted call writes `<artifactDirectory>/<run-id>/` with `request.json` (effective request
and policy), `events.jsonl` (Pi's event stream, capped together with stderr at
`limits.maxArtifactBytes`), `stderr.log`, and `result.json`, as `0700`/`0600` files.

## Protocol

Newline-delimited JSON-RPC over stdio. Serves MCP `2026-07-28` discovery/result semantics and
legacy `initialize` for `2025-11-25` through `2024-11-05`; an unsupported `_meta` protocol
version gets `-32022` with the supported list. Lines over 16,777,216 characters are refused. On
stdin EOF or `SIGTERM`/`SIGINT`/`SIGHUP` the server terminates every running Pi (SIGTERM, then
SIGKILL after 2 s) before exiting.

## Test

`npm test` runs offline and pins the wire contract, enforcement, result semantics, shutdown,
the installer, and the documentation tables.
