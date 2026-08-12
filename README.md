# Cyberdeck

Cyberdeck is a small local MCP server that turns an existing Pi + OpenRouter setup into a typed, inspectable tool boundary for Codex and Claude Code. It deliberately does not contain a skill or a hidden routing prompt.

The server exposes two tools:

- `research`: a read-only Pi tool policy. Cyberdeck refuses to start if this profile includes Pi's built-in `bash`, `edit`, or `write` tools.
- `implement`: a write-capable Pi policy with honest destructive/open-world MCP annotations.

Both tools require an explicit task, absolute working directory, and exact OpenRouter model ID. The configuration—not the calling skill—sets model patterns, Pi tool allowlists, reasoning ceilings, workspace roots, prompt preambles, timeouts, and output limits.

## Why this is compatible with your existing skill

Keep the skill as the lightweight router that decides *when* to delegate and which approved model fits. Replace its direct shell invocation of Pi with one of Cyberdeck's typed calls. Pi still mediates the selected model's nested tool use, including globally installed Pi extension tools.

The default `pi.stateDirectory` is `null`, so Pi reuses its normal user-level auth, models, extensions, and settings. If your research capability is a Pi extension tool, add its registered name to `profiles.research.tools`. Project-local Pi extensions stay disabled by default; set `pi.trustProjectFiles` to `true` only for projects you intentionally trust.

Cyberdeck is compatible with tool-capable OpenRouter models as long as Pi supports the model and the model reliably follows Pi's tool-calling protocol. Codex sees one outer MCP call and its result; Pi owns the inner model/tool loop.

Cyberdeck does not hide a workflow engine inside the server. Codex or your existing skill can sequence or parallelize typed calls across different models, while `limits.maxConcurrentRuns` prevents uncontrolled fan-out. This keeps workflow decisions in the visible outer transcript and keeps the MCP catalog small.

## Context footprint

This package avoids the usual sources of MCP context growth:

- Only two action schemas are exposed. The current serialized tool catalog is about 6.4 KB of JSON (roughly 1,500–2,000 tokens before client-specific formatting).
- There is no model-catalog, status, logging, or generic shell tool exposed to Codex.
- Resolved policy lives at the on-demand `cyberdeck://profiles` resource and in `npm run inspect`; it is not repeated in server instructions.
- Pi runs are stateless (`--no-session`), so prior delegated conversations are not replayed.
- Only a capped final answer is returned. The captured JSONL event stream (up to the artifact byte cap), stderr, effective request, and result metadata go to local artifacts.
- The MCP text result is a short summary; the typed answer is in `structuredContent`, avoiding a second full copy of the model output.

The tradeoff is intentional: separate research and implementation tools cost one extra compact schema, but let Codex distinguish read-only and destructive behavior accurately.

## Requirements

- Node.js 20 or newer. There are no npm dependencies.
- Pi available on `PATH` (tested against Pi 0.84.1), or a custom `pi.command`/`pi.arguments` configuration.
- OpenRouter credentials available through `OPENROUTER_API_KEY` or Pi's existing authentication store.

## Install

From a checkout — or, once the repo is hosted, `curl -fsSL <raw-url>/install.sh | bash` (remote mode needs `CYBERDECK_REPO_URL` set until then):

```sh
bash install.sh --dry-run
bash install.sh
```

The installer is idempotent, never uses sudo, and never touches an existing Pi (it warns when the found version differs from the tested one; `--upgrade-pi` opts in). When Pi is absent it installs the pinned version via npm. If no OpenRouter credentials exist it prompts once with hidden input and stores the key in Pi's own auth store — never in cyberdeck files or MCP configuration. It then registers the server with Claude Code (user scope, plus permission rules: allow `research`, ask for `implement`) and Codex (config block with matching approval modes) when those CLIs are present, and verifies that the resolved configuration loads.

## Configure

Edit `cyberdeck.config.json`:

1. Replace each profile's wildcard `modelPatterns` with exact IDs or narrow patterns when practical. The wildcard is shipped only because your existing skill's model IDs are unknown here.
2. Set `profiles.research.tools` and `profiles.implementation.tools` to the exact Pi built-in or extension tool names those roles may use.
3. Set `workspaceRoots`. The special value `@cwd` resolves to the MCP server process's working directory.
4. Adjust concurrency and other limits plus the short `promptPreamble` values. These are visible policy, not skill prose.
5. Leave `pi.stateDirectory` as `null` to reuse the existing Pi installation, or point it at an isolated directory.

Inspect the authoritative, resolved contract:

```sh
npm run inspect
```

The output includes both MCP input/output schemas, safety annotations, resolved paths, model patterns, tool allowlists, and limits. It never includes API keys.

## Connect Codex

Copy `codex-config.example.toml` into your user-level `~/.codex/config.toml`, replacing the two Cyberdeck paths and the common workspace path. The important portion is:

```toml
[mcp_servers.cyberdeck]
command = "node"
args = [
  "/absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs",
  "--config",
  "/absolute/path/to/cyberdeck/cyberdeck.config.json",
]
cwd = "/absolute/path/to/your/workspace-parent"
enabled_tools = ["research", "implement"]
env_vars = ["OPENROUTER_API_KEY"]
tool_timeout_sec = 1900

[mcp_servers.cyberdeck.tools.research]
approval_mode = "auto"

[mcp_servers.cyberdeck.tools.implement]
approval_mode = "prompt"
```

Restart Codex after changing MCP configuration. If Pi authenticates from its own auth store rather than an environment variable, `env_vars` can be omitted.

Codex currently supports stdio MCP configuration with per-server commands, working directories, environment-variable forwarding, enabled-tool allowlists, timeouts, and per-tool approval modes. See the official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp).

## Connect Claude Code

Register once at user scope, replacing the two absolute paths:

```sh
claude mcp add --scope user cyberdeck -- node /absolute/path/to/cyberdeck/bin/cyberdeck-mcp.mjs --config /absolute/path/to/cyberdeck/cyberdeck.config.json
```

Claude Code launches stdio servers from the directory the session was started in, so the default `@cwd` workspace root resolves to the current project — the Claude Code equivalent of Codex's explicit `cwd` line. Mirror the Codex approval modes with permission rules in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__cyberdeck__research"],
    "ask": ["mcp__cyberdeck__implement"]
  }
}
```

`claude mcp list` shows connection health. Restart the session after changing MCP or permission configuration.

## Typed calls

The calling skill supplies these fields to either tool:

```json
{
  "task": "A self-contained delegated objective and expected deliverable",
  "working_directory": "/absolute/path/inside/an/allowed/root",
  "model": "provider-model-id-known-to-pi",
  "thinking": "high",
  "context_files": ["/absolute/path/to/relevant-file"],
  "constraints": ["Do not contact external systems"],
  "timeout_seconds": 600,
  "return_characters": 3000
}
```

Only `task`, `working_directory`, and `model` are required. Unknown fields are rejected. Every optional value has a server-side ceiling reflected in the MCP JSON Schema.

Successful structured results include the status, run ID, actual model, reasoning level, Pi tool policy, capped final output, usage, and artifact paths. Validation failures are typed `rejected` tool results, so the caller can correct them without guessing.

## Artifacts

Each accepted call creates:

```text
<artifactDirectory>/<run-id>/
├── request.json   # effective, secret-free request and policy
├── events.jsonl   # complete Pi JSON event stream, subject to the byte cap
├── stderr.log
└── result.json    # typed result and usage
```

Artifacts make the delegation auditable without placing the entire inner-agent trace in Codex's context. They can contain sensitive source excerpts, prompts, and model output; apply an appropriate retention policy.

Concurrency and wall-clock limits reduce accidental fan-out, but Cyberdeck does not impose a token or dollar budget inside a Pi run. Configure OpenRouter account/key spending limits as the hard cost boundary.

## Test

```sh
npm test
```

The test launches Cyberdeck over stdio and uses a fake Pi binary. It verifies current `server/discover`, legacy `initialize`, tool/resource listing, schemas, annotations, model and path rejection, profile-specific tool flags, environment handling, event parsing, usage, and artifacts. It does not access the network or OpenRouter.

## Protocol and design notes

Cyberdeck uses newline-delimited JSON-RPC over stdio with no runtime dependencies. It implements the current MCP `2026-07-28` stateless discovery/result shape and legacy initialization versions used by current Codex and Claude Code clients (Claude Code negotiates `2025-06-18`). The wire implementation is intentionally small enough to inspect in `src/server.mjs`.

OpenAI's current MCP guidance calls for explicit input/output schemas, accurate safety annotations, concise structured results, and server-side enforcement; those requirements shaped the split tool surface. See [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) and [Define tools](https://developers.openai.com/plugins/plan/tools). The protocol details follow the current [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Read `SECURITY.md` before enabling unattended implementation. Pi has no built-in OS sandbox, and nested Pi tool calls are not separately approved by Codex.
