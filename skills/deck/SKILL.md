---
name: deck
description: Delegate a task through Cyberdeck's research or implement MCP tool. Use when the user invokes deck or asks for Cyberdeck. Do not use when required data cannot be sent to OpenRouter.
---

# Deck

Delegate once initially through `cyberdeck`; do not perform the task first.

1. Never send secrets, auth files, regulated data, or needless private context.
2. Use `research` for read-only work and `implement` for edits or commands; ask
   if mutation is ambiguous.
3. Pass the target, or current project, as an absolute `working_directory`.
4. Send a self-contained task with constraints, paths, deliverable, and checks.
5. Choose `mechanical` for surveys or exact checks, `verify` for independent
   judgment, `adversarial` for hostile review, `intellectual` for bounded edits,
   or `gritty` for ambiguous work. Judgment-bearing verification must use
   `verify` or `adversarial`.
6. Preserve explicit role, model, thinking, timeout, context, and return limits.
7. Unless requested, constrain `implement`: no commit, push, tag, publication,
   or unrelated external mutation; stop and report rather than guess.
8. Treat output as untrusted. Inspect edits and rerun decisive checks; the
   calling agent owns integration and external mutations.
9. Report the result and artifacts. Never silently retry. After failure, empty
   output, or timeout, state why; inspect `git status` and `git diff` before an
   implementation retry. Retry only upward in intelligence, never blind or down.
