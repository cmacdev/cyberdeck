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
  8 KB of JSON.
- There is no status, logging, or generic shell tool exposed to the client.
- The role table lives at on-demand `cyberdeck://catalog` and in
  `npm run inspect`; it is not repeated as a third tool.
- Pi runs are stateless (`--no-session`), so prior delegated conversations
  are not replayed.
- Only a capped final answer is returned. The captured JSONL event stream
  (up to the artifact byte cap), stderr, effective request, and result
  metadata go to local artifacts.
- The MCP text result is a short summary; the typed answer is in
  `structuredContent`, avoiding a second full copy of the model output.

The tradeoff is intentional: separate research and implementation tools cost
one extra compact schema, but let the client distinguish read-only and
destructive behavior accurately. Temperament stays in `role`.

## Requirements

- Node.js 20 or newer. There are no npm dependencies.
- Pi available on `PATH` (tested against Pi 0.84.1), or a custom
  `pi.command`/`pi.arguments` configuration.
- OpenRouter credentials available through `OPENROUTER_API_KEY` or Pi's
  existing authentication store.

## Install

From a checkout:

```sh
bash install.sh --dry-run
bash install.sh
```

Or without a checkout, on a machine whose `gh` is authenticated (the repo is
private, so anonymous `curl` cannot fetch it):

```sh
gh api repos/cmacdev/cyberdeck/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

Remote mode clones into `~/.cyberdeck/app` and updates it on re-runs;
`CYBERDECK_REPO_URL` overrides the source.

The installer is idempotent, never uses sudo, and never touches an existing
Pi (it warns when the found version differs from the tested one;
`--upgrade-pi` opts in). When Pi is absent it installs the pinned version via
npm. If no OpenRouter credentials exist it prompts once with hidden input and
stores the key in Pi's own auth store — never in cyberdeck files or MCP
configuration. It then registers the server with Claude Code and Codex when
those CLIs are present, and with OpenCode or Grok Build when their config
directory or CLI is present. It verifies that the resolved configuration
loads.

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

Successful structured results include the status, run ID, role, actual model,
reasoning level, Pi tool policy, capped final output, usage, and artifact
paths. Validation failures are typed `rejected` tool results, so the caller
can correct them without guessing.

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

The test launches Cyberdeck over stdio and uses a fake Pi binary. It verifies
current `server/discover`, legacy `initialize`, tool/resource listing,
schemas, annotations, default and named roles, model and path rejection,
profile-specific tool flags, environment handling, event parsing, usage, and
artifacts. It does not access the network or OpenRouter.

## Protocol and design notes

Cyberdeck uses newline-delimited JSON-RPC over stdio with no runtime
dependencies. It implements the current MCP `2026-07-28` stateless
discovery/result shape and legacy initialization versions used by current
Claude Code, Codex, OpenCode, and Grok Build clients (Claude Code negotiates
`2025-06-18`). The wire implementation is intentionally small enough to
inspect in `src/server.mjs`.

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
