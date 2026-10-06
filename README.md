```
┌────────────────────────── [ C Y B E R D E C K ] ───────────────────────────┐
│                                                                            │
│  TYPE..............................................local stdio MCP server  │
│  TOOLS...........................research (read-only) · implement (write)  │
│  ENGINE........................................Pi on OpenRouter or Venice  │
│  CLIENTS........................Claude Code · Codex CLI · ChatGPT Desktop  │
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

Run install, **choose [OpenRouter](https://openrouter.ai/) or [Venice](https://venice.ai/)**, and tell Claude or ChatGPT to use `/deck` for subagents. Both require an API key. It should work with any harness including Pi (which is what the deck installs and uses itself).

```sh
curl -fsSL https://raw.githubusercontent.com/cmacdev/cyberdeck/master/install.sh | bash
```

If you have any issues just tell your primary agent to look at cyberdeck and fix it. Same for customising.

**It is always a good idea to get your primary agent to look at the repo first and do a quick compatibility and security scan.**
Cyberdeck installs enforce ZDR and are otherwise conscious of security and privacy, but this remains your responsibility.

> PRs with minimal lines and human written descriptions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

# Agents

Cyberdeck is a local stdio MCP server with no npm dependencies. The caller decides when to delegate; Cyberdeck enforces read-only `research` versus write-capable `implement`, catalog models and their thinking levels, workspace roots, limits, and artifacts. MCP calls spawn a stateless Pi process; that Pi is the engine, not a client. Herdr coordinators are persistent Pi sessions that manage workers. The installer registers Claude Code and Codex CLI; on macOS it also prepares ChatGPT Desktop. Any MCP client that can launch a local stdio server can use it.

## Tools and models

`research` refuses Pi's `bash`, `edit`, and `write` tools. `implement` is annotated destructive and open-world. Any model works with either tool. Omit `model` for the `kind` preset's model, else `defaultModel`. `model` is the catalog key (`grok-4-7`), not the provider ID (`x-ai/grok-4.7`). Omit `thinking` for the model's default (bold); a level the model does not list is rejected, and every install pins Pi to exactly the listed levels, so Pi never substitutes another. The Thinking column lists OpenRouter levels (– for Venice-only models); the Venice column notes levels that differ there. "no thinking control" means Venice sets it and a `thinking` argument is rejected. Policy is `cyberdeck.config.json`. `npm run inspect` prints the resolved contract; `cyberdeck://catalog` and `cyberdeck://profiles` expose it.

| Model | Tier | Family | Thinking | OpenRouter | Venice | Strengths |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-flash` | cheap | deepseek | low, high, **max** | `deepseek/deepseek-v4-flash-0731` | `deepseek-v4-flash-0731` | Bulk reading, long-context recall, tests, docs |
| `deepseek-flash-4-1` | cheap | deepseek | off, low, high, **max** | `deepseek/deepseek-v4.1-flash` | `deepseek-v4-1-flash` | Planning, debugging, security review; fast |
| `glm-flash` | cheap | glm | low, high, **max** | `z-ai/glm-5.3-flash` | `z-ai-glm-5-3-flash` (no thinking control) | Implementation and tool loops; cheapest strong coder |
| `mimo-flash` | cheap | mimo | off, minimal, low, medium, **high** | `xiaomi/mimo-v2.6-flash` | – | Tool calling; cross-family reviewer; weak on security |
| `deepseek-pro` | smart | deepseek | low, **high**, max | `deepseek/deepseek-v4-pro-0813` | `deepseek-v4-pro-0813` | Smart reader for very large context |
| `grok-4-7` | smart | grok | low, medium, **high**, xhigh | `x-ai/grok-4.7` | `grok-4-7` | Default smart worker; price doubles over 200K context |
| `kimi-k3` | smart | kimi | low, **high**, max | `moonshotai/kimi-k3` | `kimi-k3` | Long-horizon autonomy and hard reviews; very verbose, priciest |
| `abliterated-large-v2` | smart | abliterated | – | – | `abliteration-abliterated-model-large-v2` (no thinking control) | Cybersecurity and adversarial work; abliterated, Venice only |

Only private models: Venice installs register only private models (– means not offered on that provider), and OpenRouter requests are pinned to zero data retention. For an independent review, pass `implemented_by` with the implementer's family; a reviewer of that family is rejected.

MCP runs are stateless (`--no-session`). Herdr workers are persistent Pi sessions. Shipped `pi.arguments` are `--no-extensions --no-skills`; a reinstall replaces them with the published policy. With `pi.stateDirectory` null, Pi reuses user-level auth and settings. With `pi.loadContextFiles` true, it loads `AGENTS.md` and `CLAUDE.md` from the working directory.

### Kinds

An optional `kind` sets the default model and appends its preamble. Kinds are presets, not a limit: omit `kind` for any other task.

| Kind | Model | Preamble |
| --- | --- | --- |
| `survey` | `deepseek-flash` | Report findings with file:line citations, separating facts, inferences, and unknowns. |
| `plan` | `deepseek-flash-4-1` | Return a plan: ordered steps, files touched, acceptance checks, and risks. |
| `implement` | `glm-flash` | Report changed files, checks run with results, and open issues. |
| `test` | `deepseek-flash` | Report tests added, what each covers, and their results. |
| `review` | `grok-4-7` | Return findings ranked by severity, each with location, defect, evidence, and fix. |
| `debug` | `deepseek-flash-4-1` | Report the root cause, evidence, fix, and how it was verified. |
| `docs` | `deepseek-flash` | Return only the requested text. |

## What leaves your machine

The task, constraints, attached `context_files`, and whatever enabled Pi tools read go to the selected provider. Cyberdeck makes no network calls. Each MCP run sets `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`. Pi's own tools still reach the network when the task does, including `bash` under `implement`.

The installer contacts github.com (clone), the npm registry (Pi, on every install), and Venice's API when configuring Venice: authentication, model metadata, and a one-token privacy probe containing only `1`. An unrestricted key may incur a minimal charge. Inference keys live in Pi's auth store. Provider ZDR does not cover local artifacts or external tools.

Enforced and unenforced boundaries: [SECURITY.md](SECURITY.md). Read it before unattended `implement`.

## Requirements

macOS or Linux, Node.js 20 or newer, git for a piped install, and a provider API key. No Windows support; open an issue if you want it. Every install runs `npm install -g` for the latest Pi, including when `pi` is already present. There is no pin. npm must be installed and its global directory writable, including for `--dry-run`. `--uninstall` leaves Pi. Everything else is zero-dependency Node.

## Install

Run the command at the top. From a checkout: `bash install.sh [--provider openrouter|venice] [--codex-only] [--herdr] [--dry-run] [--uninstall]`. Piped dry run: append `-s -- --dry-run` to the command at the top. It prints the plan and does not perform the writes below; the `pi` and `claude` probes may still create those tools' own state files. Re-running is the update. `--uninstall` removes Cyberdeck and leaves Pi, its credentials, and provider settings. The installer is idempotent and never uses sudo.

Interactive installs ask for a provider, defaulting to the installed choice or OpenRouter. `--provider` skips the prompt. `--codex-only` installs and uninstalls without invoking Claude's CLI.

OpenRouter uses `OPENROUTER_API_KEY` or a hidden prompt, and keeps an existing Pi credential. Venice uses the saved Pi key, `VENICE_API_KEY`, or a hidden prompt. Set that key to **Private Only** in [Venice API settings](https://venice.ai/settings/api) before installing. Each install checks that an anonymous text request is rejected. No admin key is required. A privacy failure stops the install; there is no weaker fallback. OpenRouter pins `zdr: true` and `data_collection: "deny"`, including on model-specific routing overrides. Mechanism and the `PRIVATE_ONLY` / `PRIVATE_TEXT` distinction: [SECURITY.md](SECURITY.md).

The installer writes exactly these locations:

| Path | Content |
| --- | --- |
| `~/.cyberdeck/app` | Clone of this repo, reset to the published version on re-runs (piped install only) |
| `~/.cyberdeck/cyberdeck.config.json` | Published policy for the selected provider, with absolute Pi executable/state paths and run directory (mode 600; replaced on re-run) |
| `~/.cyberdeck/cyberdeck.config.schema.json` | Schema copy for editors |
| `~/.claude.json` | User-scope `cyberdeck` stdio server (`claude mcp add` when the CLI is present) |
| `~/.claude/settings.json` | `permissions.allow: mcp__cyberdeck__research`, `permissions.ask: mcp__cyberdeck__implement` |
| `~/.codex/config.toml` | `[mcp_servers.cyberdeck]` block (research `auto`, implement `prompt`); shared by Codex CLI and ChatGPT Desktop |
| `~/.claude/skills/deck`, `~/.codex/skills/deck` | The `deck` skill with a `.cyberdeck-managed` marker; an unmanaged skill of that name is never overwritten |
| `~/.pi/agent/auth.json` | Selected provider's inference key; unrelated credentials preserved |
| `~/.pi/agent/models.json` | OpenRouter ZDR routing and catalog thinking levels on every install; Venice's endpoint and configured model metadata when selected; other providers preserved |
| `~/.pi/agent/extensions/cyberdeck-coordinator`, `~/.pi/agent/extensions/herdr-agent-state.ts` | With `--herdr`: managed coordinator loader and Herdr's official Pi state extension |
| npm's global directory (`npm prefix -g`) | Latest Pi, installed or updated on every install; `--uninstall` leaves it |

Stops, manual setup, update, and uninstall: [install-helper.md](install-helper.md). Install and uninstall do not change Pi's interactive settings; each run supplies its own model, thinking, and telemetry settings. Restart the client after a first install so it spawns the server. Clients bound to `~/.cyberdeck/cyberdeck.config.json` pick up a reinstall's replaced policy without a restart. Invoke `/deck …` (Claude Code), `$deck …` (Codex CLI), or `@deck …` (ChatGPT Desktop). The skill chooses `research` or `implement` and a model, and calls Cyberdeck with the absolute project directory.

## Configure

### Pi coordinators in Herdr

`bash install.sh --herdr` (add `--codex-only` to skip Claude) requires Herdr already installed. It adds Herdr's official Pi state extension and Cyberdeck's managed coordinator, and updates that coordinator on reinstall without touching Pi settings. Open Herdr in a project and start Pi inside it, for example `pi --provider venice --model grok-4-7`, or any model from the configured provider. Started outside Herdr, the coordinator stays inactive. Use `/reload` after installation.

Each interactive session gets a `workers` tool. Orchestration instructions and the installed model catalog are supplied every turn, without relying on skill discovery. No `/deck` invocation. Workers are persistent Pi sessions on a separate named Herdr server per coordinator, hidden from the visible Agents list. Another primary session gets its own server. One-shot delegation remains the Deck MCP tools. Models and thinking come from `~/.cyberdeck/cyberdeck.config.json`, not from the primary's model. The coordinator is the router: it chooses the model and thinking for each task and replaces a failing model itself, accounting for partial work before retrying. Cyberdeck enforces the configured permissions, allowed models, and limits; it does not escalate models automatically.

Actions are `start`, `send`, `read`, `list`, `interrupt`, and `close`. `send` waits. A timeout does not mean the work stopped or the prompt was lost; the run still holds a concurrency slot, so read before retrying. A failed or unconfirmed start is `unregistered`: read its terminal, and `close` it to abandon the start and end its processes. Reload and resume reconnect by Pi session identity; a fork gets separate workers. Do not start another worker with the same task to replace an unconfirmed one.

Worker sessions are local state, outside inference ZDR, and not an OS sandbox. Sockets live in Herdr's named-session directory. Transcripts live under `artifactDirectory/workers`. Guardrails only catch common direct pane and agent commands. `/deck-guardrails off` is for intentional manual terminal setup; `on` restores the checks. Do not disable them to bypass an error.

If Pi was started with `--no-extensions`, also pass `--extension` for both `~/.pi/agent/extensions/herdr-agent-state.ts` and `~/.pi/agent/extensions/cyberdeck-coordinator/index.js`. The footer names the worker server: `herdr --session <name>`, `herdr session stop <name>`. Detaching the primary terminal does not stop workers. Close finished workers with the tool. If that server stops, `/reload` before starting or reconnecting. Uninstall removes only the managed coordinator; stop worker servers first. Herdr and its Pi state extension stay. See [install-helper.md](install-helper.md#uninstall).

### Policy

Edit `~/.cyberdeck/cyberdeck.config.json`, or `cyberdeck.config.json` in a checkout. A reinstall replaces the installed policy with the published one and rewrites machine paths, so reapply local edits afterwards. `models` (`family`, `tier`, one-line `strengths`, `defaultThinking`, and per-provider `id` and accepted `thinking`), `kinds` (`model`, `preamble`), `defaultModel`, and per profile `tools` (exact Pi built-in or extension names) and `promptPreamble`. Also top-level: `workspaceRoots` (`@cwd` is the server's working directory; `/` and `$HOME` are refused) and `limits`. `npm run inspect` prints schemas, annotations, paths, catalog, and limits. It never prints a key.

To load a trusted extension, add `"--extension", "/absolute/path/to/extension.ts"` to `pi.arguments` and its tool names to the profile that should have them. Explicit paths still load under `--no-extensions`. `pi.trustProjectFiles` chooses `--approve` or `--no-approve` and does not enable discovery. An extension runs with your OS permissions and can have side effects even when its tools are not selected.

## Calls, results, artifacts

Both tools take `task` and an absolute `working_directory` inside a configured root, plus optional `kind`, `model`, `thinking`, `implemented_by`, `context_files`, `constraints`, `timeout_seconds`, and `return_characters`. Ceilings are in the MCP schema. Unknown fields are rejected.

`status` is `succeeded`, `failed`, `timed_out`, `output_limit`, or `rejected`. The result also has run id, kind, actual model, Pi tool policy, capped `final_output`, usage, `error`, and artifact paths. A client cancel (`notifications/cancelled`) terminates Pi and returns no response; that run's `result.json` records `cancelled`. A model output-token cut is `failed` with `output_truncated: true` and any partial text. An answer shortened only by `return_characters` stays `succeeded` and also sets `output_truncated: true`.

While a call runs, the server emits MCP progress notifications when the client supplies a progress token. Clients that reset their idle timer on progress keep waiting through a silent run: Claude Code kills a stdio call after 30 minutes without a response or progress notification, so heartbeats keep a long run alive there. Nothing here changes the run's own cap: `timeout_seconds` (default `limits.defaultTimeoutSeconds`, ceiling `limits.maxTimeoutSeconds`). Codex waits `tool_timeout_sec` (the installer writes 1900).

Each accepted call writes `<artifactDirectory>/<run-id>/` (`0700`) containing `request.json`, `events.jsonl`, `stderr.log`, and `result.json` (`0600`). `events.jsonl` and stderr together stop at `limits.maxArtifactBytes`.

The server speaks MCP `2026-07-28` and accepts legacy `initialize` for `2025-11-25` through `2024-11-05`. An unsupported `_meta` protocol version gets `-32022` and the supported list. On stdin EOF or `SIGTERM` / `SIGINT` / `SIGHUP` it terminates every running Pi before exiting.

## Test

`npm test` is offline. It pins the wire contract, enforcement, result semantics, shutdown, the installer, and these documentation tables.
