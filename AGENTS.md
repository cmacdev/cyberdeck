# Cyberdeck agent notes

- Zero npm dependencies, Node >= 20. Keep it that way; adding a dependency is a design decision, not a convenience.
- `npm test` runs offline against the fake Pi in `fixtures/`. It must stay network-free. `test/repo.test.mjs` enforces the repo rules below; keep it green.
- `npm run inspect` prints the resolved contract (schemas, annotations, policy). Treat its output as the public API; schema or annotation changes are breaking.
- Policy lives in `cyberdeck.config.json`, never in prose or code defaults. Keep the MCP tool catalog at two tools (`research`, `implement`); temperament belongs in `roles`, not extra tools. Descriptions stay terse — context footprint is a design constraint.
- No code comments. Names, structure, and tests carry the explanation.
- Every installer stop (`die`) names its fix in the message, and the install-helper.md table "If the installer stops" mirrors every message; the README role table mirrors the shipped config. An agent repairing a failed install sees only those places; keep them in step, and never make the installer use sudo to get past a stop.
- This repo stays how-to only. Rationale, decision records, and design history live outside it and are never referenced from here.
