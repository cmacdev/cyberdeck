# Security boundary

Cyberdeck is a typed policy and audit boundary, not an operating-system sandbox.

It enforces the following before Pi starts:

- The selected role must exist on the chosen profile. The resolved model must match that profile's `modelPatterns`.
- The working directory and attached context files must resolve inside a configured workspace root.
- The research profile cannot contain Pi's built-in `bash`, `edit`, or `write` tools.
- Concurrent runs, thinking, timeout, task size, attachment count, path lengths, returned text, artifact size, and stdio line length are capped.
- Pi runs without a saved conversation (`--no-session`) and without implicitly trusting project-local Pi extensions (`--no-approve`) by default.
- The task text is passed to Pi on stdin, never as a command-line argument, so it does not appear in process listings or command-line audit logs. Model, tool list, prompt preamble, and context-file paths remain command-line arguments.
- OpenRouter credentials are inherited from the process environment or Pi's own auth store. They are not MCP arguments or run-record fields.
- When installed by `install.sh`, Pi's OpenRouter routing is pinned to zero-data-retention endpoints that do not train on submitted data (`zdr: true`, `data_collection: "deny"` in `~/.pi/agent/models.json`). This applies to every Pi OpenRouter request on the machine; a model without such an endpoint fails rather than falling back.
- When the client closes stdin or the process receives `SIGTERM`/`SIGINT`/`SIGHUP`, every running Pi is terminated (SIGTERM, then SIGKILL) before the server exits; a cancelled or killed call cannot leave the Pi process itself writing or spending.

It does **not** enforce these boundaries:

- Pi has no built-in sandbox. Every Pi tool, including the read-only built-ins `read`, `grep`, `find`, and `ls`, runs with the Pi process's OS permissions and can reach any path that user can read, such as `~/.pi/agent/auth.json` or `~/.ssh`; a shell tool or extension can also write there.
- Pi inherits the MCP server's entire environment, which is the environment of the client that launched it. Any secret in that environment is readable by Pi's tools and by the model driving them.
- `workspaceRoots` validates Cyberdeck's inputs; it cannot prevent an enabled Pi shell or custom extension from reaching other host paths.
- A custom tool on the research allowlist may still have side effects. Cyberdeck only knows that Pi's three mutating built-ins are forbidden there.
- If Pi ignores SIGTERM and has to be SIGKILLed, shell processes it started may outlive it.
- The calling MCP client approves the outer call. Nested Pi tool calls are not separately visible in that client's approval UI.
- Repository context, source files, tool output, and web results can contain prompt injection.
- Concurrency and time are capped, but per-run token or dollar spend is not. Use OpenRouter-side key/account limits for a hard budget.

For untrusted code or unattended implementation, run the entire MCP/Pi process in a container, VM, or other OS-enforced sandbox with narrow mounts and network policy. Treat `implement` as a consequential tool and keep the calling client's approval mode on prompt/ask unless you intentionally accept unattended writes.

Run artifacts contain prompts and model output. They are created beneath `artifactDirectory` in per-run directories with restrictive permissions, but you should still apply an appropriate retention policy and avoid committing them.

## Reporting

Report vulnerabilities privately through this repository's Security tab (GitHub private vulnerability reporting), not in a public issue.
