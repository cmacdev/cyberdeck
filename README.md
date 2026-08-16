# Cyberdeck

Cyberdeck is a small local MCP server that turns Pi + OpenRouter into a typed
delegation boundary for whatever coding agent you already use. It is not a
harness, a skill, or a hidden router.

Use your most familiar agent as the operator. Register Cyberdeck as a normal
stdio MCP server; that agent then decides when to delegate and which preset
role fits the task. Cyberdeck only enforces the visible policy: read-only
`research` versus write-capable `implement`, bound models, workspace roots,
limits, and artifacts.

Any MCP client that can launch a local stdio server can use it: Claude Code,
Codex, OpenCode, Grok Build, Cursor, and the same class of tools. The
installer wires Claude Code and Codex when those CLIs are present, and
OpenCode or Grok Build when their config is present. Other clients need the
stdio command below.

Pi is the inner execution engine Cyberdeck spawns. It is not the primary
client. Pi's core has no MCP client; people who drive Pi as their outer agent
cannot attach this server without a third-party Pi extension.

## Why delegate

Stay in the harness you already know. The primary agent keeps integration
authority, conversation context, and the decision of *whether* to delegate.
Cyberdeck gives it two compact tools plus a short role catalog so it can send
the work to a model that is actually good at that job.

The server does not hide a workflow engine. The calling agent sequences or
parallelizes typed calls; `limits.maxConcurrentRuns` only caps fan-out. That
keeps workflow decisions in the visible outer transcript and keeps the MCP
catalog small.

## Tools and roles

Two tools, split on permission — not one tool per temperament:

- `research`: a read-only Pi tool policy. Cyberdeck refuses to start if this
  profile includes Pi's built-in `bash`, `edit`, or `write` tools.
- `implement`: a write-capable Pi policy with honest destructive/open-world
  MCP annotations.

Each tool has a `role` enum. Omit it to use the profile default. Omit `model`
to use the role's bound OpenRouter ID. Override `model` only when you need a
listed ID from the same profile.

Shipped roles:

| Tool | Role | Model | Use when |
| --- | --- | --- | --- |
| `research` | `mechanical` (default) | `deepseek/deepseek-v4-flash-0731` | Cheap survey, inventory, grep, citation |
| `research` | `verify` | `z-ai/glm-5.2` | Independent check of someone else's work |
| `research` | `adversarial` | `x-ai/grok-4.6` | Attack a plan, find holes, hostile review |
| `implement` | `intellectual` (default) | `x-ai/grok-4.6` | Bounded, spec-exact, reviewable diffs |
| `implement` | `gritty` | `moonshotai/kimi-k3` | Ambiguous or cross-cutting; thorough |

The calling agent sees those descriptions on the tools themselves. The longer
table lives at the on-demand `cyberdeck://catalog` resource; resolved policy
is at `cyberdeck://profiles`.

Both tools still require an explicit task and an absolute working directory.
The configuration — not a calling skill — sets roles, models, Pi tool
allowlists, reasoning ceilings, workspace roots, prompt preambles, timeouts,
and output limits.

The default `pi.stateDirectory` is `null`, so Pi reuses its normal user-level
auth, models, extensions, and settings. If your research capability is a Pi
extension tool, add its registered name to `profiles.research.tools`.
Project-local Pi extensions stay disabled by default; set
`pi.trustProjectFiles` to `true` only for projects you intentionally trust.

Cyberdeck is compatible with tool-capable OpenRouter models as long as Pi
supports the model and the model reliably follows Pi's tool-calling protocol.
The calling harness sees one outer MCP call and its result; Pi owns the inner
model/tool loop.

## Context footprint

This package avoids the usual sources of MCP context growth:

- Only two action schemas are exposed. Roles are an enum plus a short
  description, not extra tools. The current serialized tool catalog is about
  8 KB of JSON (the test suite fails above 10 KB).
- There is no status, logging, or generic shell tool exposed to the client.
- The role table lives at on-demand `cyberdeck://catalog` and in
  `npm run inspect`; it is not repeated as a third tool.
- Pi runs are stateless (`--no-session`), so prior delegated conversations
  are not replayed.
- Only a capped final answer is returned. The captured JSONL event stream and
  stderr (together capped at `limits.maxArtifactBytes`), effective request,
  and result metadata go to local artifacts.
- The MCP text result is a short summary; the typed answer is in
  `structuredContent`. This deliberately skips the spec's SHOULD of repeating
  the serialized JSON in the text block, avoiding a second full copy of the
  model output.

The tradeoff is intentional: separate research and implementation tools cost
one extra compact schema, but let the client distinguish read-only and
destructive behavior accurately. Temperament stays in `role`.

## Requirements

- Node.js 20 or newer. There are no npm dependencies.
- Pi available on `PATH` (tested against Pi 0.84.2), or a custom
  `pi.command`/`pi.arguments` configuration.
- OpenRouter credentials available through `OPENROUTER_API_KEY` or Pi's
  existing authentication store.
- Only when Pi is absent: npm's global directory must be writable by the
  user running the installer (`npm install -g`, never sudo). It usually is
  not when Node was installed from another user account — for example a
  work profile and a personal profile on one Mac. The installer stops and
  prints the fix; see below.

## Install

One command, no checkout:

```sh
curl -fsSL https://raw.githubusercontent.com/cmacdev/cyberdeck/master/install.sh | bash
```

While the repo is private that returns 404; use an authenticated `gh`
instead:

```sh
gh api repos/cmacdev/cyberdeck/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

Either form clones into `~/.cyberdeck/app`, updates it on re-runs, and
registers that fixed path; `CYBERDECK_REPO_URL` overrides the source. Append
`-s -- --dry-run` to `bash` to print the plan without changing anything.
Agents installing on someone's behalf should use this form rather than a
checkout, and hand the API-key prompt to the user (see the table below).

For development, from a checkout (registers the checkout itself):

```sh
bash install.sh --dry-run
bash install.sh
```

The installer is idempotent, never uses sudo, and never touches an existing
Pi (it warns when the found version differs from the tested one; `--pin-pi`
installs the tested version, up or down). When Pi is absent it installs the
pinned version via npm. If no OpenRouter credentials exist it prompts once with hidden input and
stores the key in Pi's own auth store — never in cyberdeck files or MCP
configuration. It then registers the server with Claude Code and Codex when
those CLIs are present, and with OpenCode or Grok Build when their config
directory or CLI is present. It verifies that the resolved configuration
loads.

### If the installer stops

Every stop prints its cause; this table gives the fix. Apply it and re-run
the same command — the installer is idempotent, and it never uses sudo.

| Message | Fix |
| --- | --- |
| `curl: (22) The requested URL returned error: 404` | The repo is private (or the URL is wrong): use the `gh api` form above with an authenticated `gh`. |
| `Node.js >= 20 is required` | Install or upgrade Node (e.g. `brew install node`) so `node` on `PATH` is 20 or newer. |
| `npm's global directory … is not writable by <user>` | `npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"`, and put the `PATH` line in your shell profile (`~/.zshrc`, `~/.bashrc`) so the MCP clients find `pi`. Do not sudo. |
| `ACTION REQUIRED: add <dir> to PATH` (not a stop) | Pi was installed into npm's global `bin`, which is not on your `PATH`. Add it to your shell profile; the MCP clients start `pi` from that `PATH`. |
| `git is required` | Install git (`xcode-select --install` or `brew install git`). |
| `cannot read <repo> without a password prompt` | The repo is private. `gh auth login`, then `gh auth setup-git` (or store a GitHub credential in your keychain), and re-run. |
| `no terminal available for the API key prompt` | Run the same command in an interactive terminal (the prompt reads `/dev/tty`), or export `OPENROUTER_API_KEY` in the environment the MCP clients start with — the installer then leaves credentials to that variable. Agents: hand this step to the user; do not ask for or handle the key. |
| `empty API key` / `Pi does not report OpenRouter credentials as ready` | Nothing was stored, or the key was rejected. Check with `pi auth check --provider openrouter`; re-run to be prompted again. |
| `verification failed: the resolved configuration does not load` | `node <app>/bin/cyberdeck-mcp.mjs --config <app>/cyberdeck.config.json --inspect` prints the configuration error (`<app>` is the checkout or `~/.cyberdeck/app`). Fix `cyberdeck.config.json` and re-run. |
| `pi <found> found; left untouched (tested with <pinned>…)` (not a stop) | A different Pi version stays as it is. `--pin-pi` installs the tested version, up or down. |

After a successful run, restart the client. If the tools do not appear:
`claude mcp get cyberdeck` (Claude Code) or `~/.codex/config.toml` (Codex)
shows the registration. If a `research` call returns `status: "failed"` with
`error` containing `spawn pi ENOENT`, `pi` is not on the `PATH` the client
starts with — add npm's global `bin` to your shell profile and restart the
client.

### Uninstall

```sh
claude mcp remove --scope user cyberdeck
rm -rf ~/.cyberdeck
```

Then delete the `[mcp_servers.cyberdeck]` block from `~/.codex/config.toml`
(likewise `mcp.cyberdeck` in `~/.config/opencode/opencode.json` or the block
in `~/.grok/config.toml` if present) and the two `mcp__cyberdeck__*` rules
from `~/.claude/settings.json`. Pi and its auth store are left as they were;
`npm uninstall -g @earendil-works/pi-coding-agent` and `rm -rf ~/.pi` remove
them if you want that too. Run artifacts live in `.cyberdeck/runs` next to
the config file, so the one-command install's artifacts go with
`~/.cyberdeck`; a checkout install keeps them in the checkout (gitignored).

## Configure

Edit `cyberdeck.config.json`:

1. Edit each profile's `roles` to change the bound model or the one-line
   `when` text the calling agent sees. `defaultRole` is used when the caller
   omits `role`.
2. Keep `modelPatterns` as the allowlist for both role defaults and optional
   `model` overrides.
3. Set `profiles.research.tools` and `profiles.implementation.tools` to the
   exact Pi built-in or extension tool names those profiles may use.
4. Set `workspaceRoots`. The special value `@cwd` resolves to the MCP server
   process's working directory.
5. Adjust concurrency and other limits plus the short `promptPreamble`
   values. Role-level preambles override the profile default. These are
   visible policy, not skill prose.
6. Leave `pi.stateDirectory` as `null` to reuse the existing Pi
   installation, or point it at an isolated directory.

Inspect the authoritative, resolved contract:

```sh
npm run inspect
```

The output includes both MCP input/output schemas, safety annotations,
resolved paths, the role catalog, tool allowlists, and limits. It never
includes API keys.

## Connect any MCP client

Cyberdeck is a local stdio server. Point the client at:

```text
node /absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs --config /absolute/path/to/cyberdeck/cyberdeck.config.json
```

Start the client inside a project. The default `@cwd` workspace root is the
server process working directory, which should be that project — not `/` or
`$HOME`.

### OpenCode

Add a local server to `~/.config/opencode/opencode.json` (or the project
`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cyberdeck": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs",
        "--config",
        "/absolute/path/to/cyberdeck/cyberdeck.config.json"
      ],
      "enabled": true
    }
  }
}
```

See the official [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/) guide.

### Grok Build

```sh
grok mcp add cyberdeck -- node /absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs --config /absolute/path/to/cyberdeck/cyberdeck.config.json
```

Or declare it in `~/.grok/config.toml`:

```toml
[mcp_servers.cyberdeck]
command = "node"
args = [
  "/absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs",
  "--config",
  "/absolute/path/to/cyberdeck/cyberdeck.config.json",
]
startup_timeout_sec = 10
tool_timeout_sec = 1900
```

See the official [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers) page.

### Codex

Copy `codex-config.example.toml` into your user-level `~/.codex/config.toml`,
replacing the two Cyberdeck paths and the common workspace path. The
important portion is:

```toml
[mcp_servers.cyberdeck]
command = "node"
args = [
  "/absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs",
  "--config",
  "/absolute/path/to/cyberdeck/cyberdeck.config.json",
]
cwd = "/absolute/path/to/your-workspace-parent"
enabled_tools = ["research", "implement"]
env_vars = ["OPENROUTER_API_KEY"]
tool_timeout_sec = 1900

[mcp_servers.cyberdeck.tools.research]
approval_mode = "auto"

[mcp_servers.cyberdeck.tools.implement]
approval_mode = "prompt"
```

Restart Codex after changing MCP configuration. If Pi authenticates from its
own auth store rather than an environment variable, `env_vars` can be
omitted.

Codex currently supports stdio MCP configuration with per-server commands,
working directories, environment-variable forwarding, enabled-tool
allowlists, timeouts, and per-tool approval modes. See the official
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp).

### Claude Code

Register once at user scope, replacing the two absolute paths:

```sh
claude mcp add --scope user cyberdeck -- node /absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs --config /absolute/path/to/cyberdeck/cyberdeck.config.json
```

Claude Code launches stdio servers from the directory the session was started
in, so the default `@cwd` workspace root resolves to the current project —
the Claude Code equivalent of Codex's explicit `cwd` line. Mirror the Codex
approval modes with permission rules in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__cyberdeck__research"],
    "ask": ["mcp__cyberdeck__implement"]
  }
}
```

`claude mcp list` shows connection health. Restart the session after changing
MCP or permission configuration.

## Typed calls

The calling agent supplies these fields to either tool:

```json
{
  "task": "A self-contained delegated objective and expected deliverable",
  "working_directory": "/absolute/path/inside/an/allowed/root",
  "role": "mechanical",
  "model": "provider-model-id-known-to-pi",
  "thinking": "high",
  "context_files": ["/absolute/path/to/relevant-file"],
  "constraints": ["Do not contact external systems"],
  "timeout_seconds": 600,
  "return_characters": 3000
}
```

Only `task` and `working_directory` are required. `role` defaults to the
profile's `defaultRole`; `model` defaults to that role's bound ID. Unknown
fields are rejected. Every optional value has a server-side ceiling reflected
in the MCP JSON Schema.

Structured results include `status` (`succeeded`, `failed`, `timed_out`,
`output_limit`, `rejected`; `cancelled` appears only in the artifact, see
below), run ID, role, actual model, reasoning level, Pi tool policy,
`final_output`, usage, and artifact paths. `final_output` is
always the assistant's final text, capped at `return_characters`, or empty
when there was none; on failure the diagnostic is in `error` and the full
stderr is an artifact. Validation failures are typed `rejected` tool results,
so the caller can correct them without guessing.

A request cancelled by the client (`notifications/cancelled`) terminates Pi
and, per the MCP cancellation rules, receives no response; its
`result.json` artifact records `status: "cancelled"` and the client's reason.

## Artifacts

Each accepted call creates:

```text
<artifactDirectory>/<run-id>/
├── request.json   # effective, secret-free request and policy
├── events.jsonl   # complete Pi JSON event stream, subject to the byte cap
├── stderr.log
└── result.json    # typed result and usage
```

Artifacts make the delegation auditable without placing the entire
inner-agent trace in the calling harness's context. They can contain
sensitive source excerpts, prompts, and model output; apply an appropriate
retention policy.

Concurrency and wall-clock limits reduce accidental fan-out, but Cyberdeck
does not impose a token or dollar budget inside a Pi run. Configure
OpenRouter account/key spending limits as the hard cost boundary.

## Test

```sh
npm test
```

The tests launch Cyberdeck over stdio against the fake Pi in `fixtures/` and
never touch the network. `test/server.test.mjs` pins the wire contract
(discovery, legacy initialize, schemas, annotations, resources, error codes),
the enforcement paths (roles, models, roots, limits, timeout, cancellation,
output cap, spawn failure, concurrency), result semantics, and shutdown.
`test/config.test.mjs` pins startup refusals, the CLI, and the catalog size
tripwire.

To check the real Pi path once (costs one cheap OpenRouter call): start the
server from this directory, call `research` with role `mechanical`,
`thinking: "off"`, and task `Reply with exactly the word READY and nothing
else.`; expect `ok: true`, `final_output` containing `READY`, and non-zero
`usage`.

## Protocol and design notes

Cyberdeck uses newline-delimited JSON-RPC over stdio with no runtime
dependencies. It implements the current MCP `2026-07-28` stateless
discovery/result shape and legacy initialization versions used by current
Claude Code, Codex, OpenCode, and Grok Build clients (Claude Code negotiates
`2025-06-18`). A request that carries a modern
`_meta["io.modelcontextprotocol/protocolVersion"]` is checked against the
supported version (unsupported → `-32022` with the supported list, so the
client can retry); a request without one is served under legacy semantics.
Client capabilities are not consumed and so not required. Lines over 16
million characters are refused. On stdin EOF or
`SIGTERM`/`SIGINT`/`SIGHUP` the server stops reading and terminates every
running Pi (SIGTERM, then SIGKILL after 2 s) before exiting, so a killed
client cannot leave delegated runs writing or spending. The wire
implementation is intentionally small enough to inspect in `src/server.mjs`.

OpenAI's current MCP guidance calls for explicit input/output schemas,
accurate safety annotations, concise structured results, and server-side
enforcement; those requirements shaped the split tool surface. See
[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
and [Define tools](https://developers.openai.com/plugins/plan/tools). The
protocol details follow the current
[MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Read `SECURITY.md` before enabling unattended implementation. Pi has no
built-in OS sandbox, and nested Pi tool calls are not separately approved by
the calling harness.
