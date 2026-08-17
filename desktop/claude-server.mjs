#!/usr/bin/env node

import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cyberdeckHome = path.join(os.homedir(), ".cyberdeck");

async function start() {
  const workspaceRoot = process.env.CYBERDECK_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) {
    throw new Error(
      "Claude Desktop did not provide a workspace root. Configure the Cyberdeck extension and select one.",
    );
  }

  const piPointer = path.join(cyberdeckHome, "pi-command");
  const piCommand = (await readFile(piPointer, "utf8")).trim();
  if (!piCommand) throw new Error(`Pi executable path is empty in ${piPointer}. Re-run install.sh.`);
  try {
    await access(piCommand, constants.X_OK);
  } catch {
    throw new Error(`Pi is not executable at ${piCommand}. Re-run install.sh.`);
  }

  const sourceConfig = path.join(packageDirectory, "cyberdeck.config.json");
  const config = JSON.parse(await readFile(sourceConfig, "utf8"));
  config.$schema = path.join(packageDirectory, "cyberdeck.config.schema.json");
  config.workspaceRoots = [workspaceRoot];
  config.artifactDirectory = path.join(cyberdeckHome, "claude-desktop-runs");
  config.pi.command = piCommand;

  await mkdir(cyberdeckHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(cyberdeckHome, "claude-desktop.config.json");
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);

  process.argv = [
    process.execPath,
    path.join(packageDirectory, "bin", "cyberdeck-mcp.mjs"),
    "--config",
    configPath,
  ];
  await import("../bin/cyberdeck-mcp.mjs");
}

try {
  await start();
} catch (error) {
  process.stderr.write(`Cyberdeck Claude Desktop launcher failed: ${error.message}\n`);
  process.exitCode = 1;
}
