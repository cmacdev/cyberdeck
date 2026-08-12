# Cyberdeck agent notes

- Zero npm dependencies, Node >= 20. Keep it that way; adding a dependency is a design decision, not a convenience.
- `npm test` runs offline against the fake Pi in `fixtures/`. It must stay network-free.
- `npm run inspect` prints the resolved contract (schemas, annotations, policy). Treat its output as the public API; schema or annotation changes are breaking.
- Policy lives in `cyberdeck.config.json`, never in prose or code defaults. Keep the MCP tool catalog small and descriptions terse — context footprint is a design constraint.
- Rationale, ADRs, and model-optimisation records live in `../cyberdeck-manager`. This repo stays how-to only; cyberdeck must never reference cyberdeck-manager.
