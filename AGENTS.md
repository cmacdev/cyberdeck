# Cyberdeck agent notes

- Zero npm dependencies, Node >= 20. Keep it that way; adding a dependency is a design decision, not a convenience.
- `npm test` runs offline against the fake Pi in `fixtures/`. It must stay network-free.
- `npm run inspect` prints the resolved contract (schemas, annotations, policy). Treat its output as the public API; schema or annotation changes are breaking.
- Policy lives in `cyberdeck.config.json`, never in prose or code defaults. Keep the MCP tool catalog at two tools (`research`, `implement`); temperament belongs in `roles`, not extra tools. Descriptions stay terse — context footprint is a design constraint.
- Every installer stop (`die`) names its fix in the message, and the README table "If the installer stops" mirrors every message. An agent repairing a failed install sees only those two places; keep them in step, and never make the installer use sudo to get past a stop.
- Rationale, ADRs, and model-optimisation records live in `../cyberdeck-manager`. This repo stays how-to only; cyberdeck must never reference cyberdeck-manager.
