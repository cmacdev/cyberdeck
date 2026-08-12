#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { createServer, inspectServer } from "../src/server.mjs";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: cyberdeck-mcp [--config PATH] [--inspect]\n\n` +
    `  --config PATH  Use a specific configuration file.\n` +
    `  --inspect      Print resolved schemas and policy, then exit.\n` +
    `  --help         Show this help.\n`;
}

function parseArguments(argv) {
  let configPath = process.env.CYBERDECK_CONFIG || path.join(packageDirectory, "cyberdeck.config.json");
  let inspect = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      configPath = value;
      index += 1;
    } else if (argument === "--inspect") {
      inspect = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { configPath, inspect, help: false };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const config = await loadConfig(options.configPath);
    if (options.inspect) {
      process.stdout.write(`${JSON.stringify(inspectServer(config), null, 2)}\n`);
    } else {
      createServer(config);
    }
  }
} catch (error) {
  process.stderr.write(`Cyberdeck failed to start: ${error.message}\n`);
  process.exitCode = 1;
}
