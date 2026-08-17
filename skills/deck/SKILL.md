---
name: deck
description: Delegate a user-supplied task through the Cyberdeck MCP research or implement tool. Use when the user invokes deck, asks to use Cyberdeck, or explicitly wants work delegated through Cyberdeck rather than performed by the outer agent.
---

# Deck

Delegate the requested work through the `cyberdeck` MCP server. Do not perform
the delegated task with the outer agent's own tools first.

1. Select `research` for investigation, explanation, review, verification, or
   any task that must not modify files or external state.
2. Select `implement` when the requested outcome requires edits, shell
   commands, tests, or other state changes. If mutation is genuinely ambiguous,
   ask before selecting `implement`.
3. Use the user's target directory when supplied; otherwise use the current
   project directory. Pass it as an absolute `working_directory` inside the
   configured Cyberdeck workspace root.
4. Turn the user's request into a self-contained `task`. Preserve stated
   constraints, relevant paths, expected deliverables, and verification.
5. Choose the role that best matches the request:
   - Research: `mechanical` for survey/evidence, `verify` for an independent
     check, or `adversarial` for a hostile review.
   - Implementation: `intellectual` for bounded spec-exact work or `gritty`
     for ambiguous or cross-cutting work.
6. Preserve any role, model, thinking, timeout, context-file, or return-length
   override the user explicitly supplies. Otherwise rely on Cyberdeck defaults.
7. Call exactly one Cyberdeck tool initially. After it returns, report its
   result and artifact location. Do not silently redo the delegated work
   yourself. Make another Cyberdeck call only when the result identifies a
   concrete follow-up and the user requested iterative completion.
