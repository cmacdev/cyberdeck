#!/usr/bin/env node

import { constants } from "node:fs";
import { access, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { createServer } from "../src/server.mjs";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cyberdeckHome = process.env.CYBERDECK_HOME || path.join(os.homedir(), ".cyberdeck");

async function start() {
  const workspaceRoot = process.env.CYBERDECK_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) {
    throw new Error(
      "Claude Desktop did not provide a workspace root. Configure the Cyberdeck extension and select one.",
    );
  }

  const piPointer = path.join(cyberdeckHome, "pi-command");
  const piCommand = await readFile(piPointer, "utf8").then((text) => text.trim(), (error) => {
    throw new Error(`Cannot read ${piPointer} (${error.message}). Re-run install.sh.`);
  });
  if (!piCommand) throw new Error(`Pi executable path is empty in ${piPointer}. Re-run install.sh.`);
  try {
    await access(piCommand, constants.X_OK);
  } catch {
    throw new Error(`Pi is not executable at ${piCommand}. Re-run install.sh.`);
  }

  const installedPolicy = path.join(cyberdeckHome, "cyberdeck.config.json");
  const policyPath = await access(installedPolicy)
    .then(() => installedPolicy)
    .catch(() => path.join(packageDirectory, "cyberdeck.config.json"));
  const config = await readFile(policyPath, "utf8").then(JSON.parse).catch((error) => {
    throw new Error(`Cannot use ${policyPath} (${error.message}). Fix that file or re-run install.sh.`);
  });
  if (!config?.pi || typeof config.pi !== "object" || Array.isArray(config.pi)) {
    throw new Error(`${policyPath} has no pi configuration object. Fix that file or re-run install.sh.`);
  }
  config.workspaceRoots = [workspaceRoot];
  config.artifactDirectory = path.join(cyberdeckHome, "claude-desktop-runs");
  config.pi.command = piCommand;

  await mkdir(cyberdeckHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(cyberdeckHome, "claude-desktop.config.json");
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);

  const server = createServer(await loadConfig(configPath));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => server.close());
  }
}

try {
  await start();
} catch (error) {
  process.stderr.write(`Cyberdeck Claude Desktop launcher failed: ${error.message}\n`);
  process.exitCode = 1;
}
