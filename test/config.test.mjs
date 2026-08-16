import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { SERVER_INFO, buildTools } from "../src/contracts.mjs";
import { makeConfig, makeFixture, packageDirectory, runCli } from "./helpers.mjs";

// The stated design constraint: the serialized tool catalog stays small.
const CATALOG_BYTE_CEILING = 10 * 1024;

async function inspect(configPath, options) {
  return runCli(["--config", configPath, "--inspect"], options);
}

// Each case is [override, expected stderr fragment]; every one must refuse to start.
const REFUSALS = [
  [{ profiles: (p) => (p.research.tools.push("bash"), p) }, /profiles\.research\.tools cannot include mutating Pi tools: bash/],
  [{ workspaceRoots: ["/"] }, /must not be the filesystem root or the home directory/],
  [{ workspaceRoots: [os.homedir()] }, /must not be the filesystem root or the home directory/],
  [{ provider: "openai" }, /provider must be exactly "openrouter"/],
  [{ surprise: 1 }, /configuration has unknown key\(s\): surprise/],
  [{ profiles: (p) => ((p.research.extra = 1), p) }, /profiles\.research has unknown key\(s\): extra/],
  [{ profiles: (p) => ((p.research.roles.mechanical.extra = 1), p) }, /roles\.mechanical has unknown key\(s\): extra/],
  [{ profiles: (p) => ((p.research.defaultRole = "ghost"), p) }, /defaultRole "ghost" is not a defined role/],
  [{ profiles: (p) => ((p.research.roles.mechanical.model = "other/x"), p) }, /is not allowed by modelPatterns/],
  [{ profiles: (p) => ((p.research.roles.mechanical.maxThinking = "max"), p) }, /maxThinking cannot exceed the profile maximum high/],
  [{ profiles: (p) => ((p.research.defaultThinking = "max"), p) }, /defaultThinking cannot exceed maxThinking/],
  [{ profiles: (p) => ((p.research.roles["Bad-Name"] = p.research.roles.mechanical), p) }, /invalid role name: Bad-Name/],
  [{ limits: { maxTimeoutSeconds: 86401 } }, /maxTimeoutSeconds cannot exceed 86400/],
  [{ limits: { defaultTimeoutSeconds: 11 } }, /defaultTimeoutSeconds cannot exceed maxTimeoutSeconds/],
  [{ limits: { defaultReturnCharacters: 5001 } }, /defaultReturnCharacters cannot exceed maxReturnCharacters/],
  [{ limits: { maxConcurrentRuns: 33 } }, /maxConcurrentRuns cannot exceed 32/],
  [{ limits: { maxArtifactBytes: 1023 } }, /maxArtifactBytes must be an integer greater than or equal to 1024/],
  [{ pi: { arguments: "-p" } }, /pi\.arguments must be an array/],
];

test("invalid configurations refuse to start with a precise message", async (t) => {
  const fixture = await makeFixture(t);
  for (const [override, expected] of REFUSALS) {
    const overrides = { ...override };
    if (typeof override.profiles === "function") {
      overrides.profiles = override.profiles(structuredClone(makeConfig(fixture).profiles));
    }
    const configPath = await fixture.writeConfig("bad", overrides);
    const { code, stderr } = await inspect(configPath);
    assert.equal(code, 1, `expected refusal for ${JSON.stringify(override)}`);
    assert.match(stderr, /^Cyberdeck failed to start: /);
    assert.match(stderr, expected);
  }
});

test("@cwd resolves to the launch directory and refuses / and $HOME", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("cwd", { workspaceRoots: ["@cwd"] });
  const fromProject = await inspect(configPath, { cwd: fixture.workspace });
  assert.equal(fromProject.code, 0, fromProject.stderr);
  const configuration = JSON.parse(fromProject.stdout).configuration;
  assert.deepEqual(configuration.workspaceRoots, [await realpath(fixture.workspace)]);
  const fromRoot = await inspect(configPath, { cwd: "/" });
  assert.equal(fromRoot.code, 1);
  assert.match(fromRoot.stderr, /start the MCP client inside a project/);
});

test("--inspect prints the resolved contract and never a secret", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config");
  const { code, stdout } = await inspect(configPath, {
    env: { OPENROUTER_API_KEY: "sk-test-secret-value" },
  });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report), [
    "server",
    "supportedProtocolVersions",
    "instructions",
    "tools",
    "resources",
    "catalog",
    "configuration",
  ]);
  assert.deepEqual(report.supportedProtocolVersions, [
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ]);
  assert.deepEqual(report.tools.map((tool) => tool.name), ["research", "implement"]);
  assert.equal(report.resources.length, 2);
  assert.equal(report.configuration.pi.stateDirectory, fixture.piStateDirectory);
  assert.ok(!stdout.includes("sk-test-secret-value"));
  assert.ok(!stdout.includes("OPENROUTER_API_KEY"));
});

test("the CLI handles --help, unknown arguments, and a missing configuration", async (t) => {
  const fixture = await makeFixture(t);
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--config PATH/);
  const unknown = await runCli(["--bogus"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown argument: --bogus/);
  const dangling = await runCli(["--config"]);
  assert.equal(dangling.code, 1);
  assert.match(dangling.stderr, /--config requires a path/);
  const missing = await inspect(path.join(fixture.root, "absent.json"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Cannot read configuration/);
});

test("the advertised server version matches package.json", async () => {
  const pkg = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  assert.equal(SERVER_INFO.version, pkg.version);
});

test("the shipped configuration loads and its tool catalog stays small", async (t) => {
  const fixture = await makeFixture(t);
  const shipped = JSON.parse(await readFile(path.join(packageDirectory, "cyberdeck.config.json"), "utf8"));
  shipped.workspaceRoots = [fixture.workspace];
  const configPath = path.join(fixture.root, "shipped.json");
  await writeFile(configPath, JSON.stringify(shipped));
  const config = await loadConfig(configPath);
  const bytes = Buffer.byteLength(JSON.stringify(buildTools(config)));
  assert.ok(bytes <= CATALOG_BYTE_CEILING, `tool catalog is ${bytes} bytes`);
  assert.equal(config.profiles.research.tools.some((tool) => ["bash", "edit", "write"].includes(tool)), false);
});
