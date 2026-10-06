import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pinnedThinkingMap } from "../src/config.mjs";
import { writePrivateJson } from "./configure-venice.mjs";

export function configureOpenRouter({ config, models }) {
  const overrides = (((models.providers ??= {}).openrouter ??= {}).modelOverrides ??= {});
  for (const model of Object.values(config.models)) {
    const entry = model.providers.openrouter;
    if (!entry) continue;
    const override = (overrides[entry.id] ??= {});
    override.thinkingLevelMap = pinnedThinkingMap(entry.thinking);
    override.compat = {
      ...override.compat,
      openRouterRouting: { ...override.compat?.openRouterRouting, zdr: true, data_collection: "deny" },
    };
  }
  return models;
}

async function main() {
  const config = JSON.parse(await readFile(new URL("../cyberdeck.config.json", import.meta.url), "utf8"));
  const modelsPath = path.join(process.env.PI_AGENT_DIR, "models.json");
  const models = await readFile(modelsPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return {};
    throw new Error(`Make ${modelsPath} valid JSON and readable, then re-run.`);
  });
  await mkdir(process.env.PI_AGENT_DIR, { recursive: true, mode: 0o700 });
  await writePrivateJson(modelsPath, configureOpenRouter({ config, models }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`OpenRouter setup: ${error.message}\n`);
    process.exitCode = 1;
  });
}
