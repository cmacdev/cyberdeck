import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { SERVER_INFO, buildTools } from "../src/contracts.mjs";
import { makeConfig, makeFixture, packageDirectory, runCli } from "./helpers.mjs";

const CATALOG_BYTE_CEILING = 10 * 1024;

async function inspect(configPath, options) {
  return runCli(["--config", configPath, "--inspect"], options);
}

const REFUSALS = [
  [{ mutate: (c) => c.profiles.research.tools.push("bash") }, /profiles\.research\.tools cannot include mutating Pi tools: bash/],
  [{ workspaceRoots: ["/"] }, /must not be the filesystem root or the home directory/],
  [{ workspaceRoots: [os.homedir()] }, /must not be the filesystem root or the home directory/],
  [{ provider: "openai" }, /provider must be "openrouter" or "venice"/],
  [{ surprise: 1 }, /configuration has unknown key\(s\): surprise/],
  [{ mutate: (c) => (c.profiles.research.extra = 1) }, /profiles\.research has unknown key\(s\): extra/],
  [{ mutate: (c) => (c.models["model-a"].extra = 1) }, /models\.model-a has unknown key\(s\): extra/],
  [{ mutate: (c) => (c.defaultModel = "ghost") }, /defaultModel "ghost" is not a model available on openrouter/],
  [{ mutate: (c) => (c.kinds.review.model = "ghost") }, /kinds\.review\.model "ghost" is not a model available on openrouter/],
  [{ mutate: (c) => (c.models["model-a"].defaultThinking = "max") }, /models\.model-a\.defaultThinking must be in models\.model-a\.providers\.openrouter\.thinking/],
  [{ mutate: (c) => (c.models["model-b"].providers.openrouter.thinking = []) }, /models\.model-b\.providers\.openrouter\.thinking must be a non-empty array/],
  [{ mutate: (c) => (c.models["model-b"].providers = {}) }, /models\.model-b\.providers must list at least one provider/],
  [{ mutate: (c) => (c.models["model-a"].providers.openrouter.thinking = ["turbo"]) }, /thinking\[0\] must be one of/],
  [{ mutate: (c) => (c.models["model-a"].tier = "mid") }, /models\.model-a\.tier must be "cheap" or "smart"/],
  [{ mutate: (c) => (c.models["Bad-Name"] = c.models["model-a"]) }, /invalid model name: Bad-Name/],
  [{ mutate: (c) => (c.defaultModel = "constructor") }, /defaultModel "constructor" is not a model available/],
  [{ limits: { maxTimeoutSeconds: 86401 } }, /maxTimeoutSeconds cannot exceed 86400/],
  [{ limits: { defaultTimeoutSeconds: 11 } }, /defaultTimeoutSeconds cannot exceed maxTimeoutSeconds/],
  [{ limits: { defaultReturnCharacters: 5001 } }, /defaultReturnCharacters cannot exceed maxReturnCharacters/],
  [{ limits: { maxConcurrentRuns: 33 } }, /maxConcurrentRuns cannot exceed 32/],
  [{ limits: { maxArtifactBytes: 1023 } }, /maxArtifactBytes must be an integer greater than or equal to 1024/],
  [{ pi: { arguments: "-p" } }, /pi\.arguments must be an array/],
];

test("Venice resolves catalog models to Venice IDs and drops models it does not serve", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("venice", { provider: "venice" });
  const result = await inspect(configPath);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configuration.provider, "venice");
  assert.deepEqual(Object.keys(report.catalog.models), ["model-a", "model-c"]);
  assert.equal(report.catalog.models["model-a"].id, "model-a");
  assert.deepEqual(report.tools.map((tool) => tool.name), ["research", "implement"]);
  assert.deepEqual(report.tools[0].inputSchema.properties.model.enum, ["model-a", "model-c"]);
  assert.deepEqual(report.tools[0].inputSchema.properties.thinking.enum, ["low", "medium", "high"]);
});

test("invalid configurations refuse to start with a precise message", async (t) => {
  const fixture = await makeFixture(t);
  for (const [override, expected] of REFUSALS) {
    let overrides = override;
    if (typeof override.mutate === "function") {
      overrides = structuredClone(makeConfig(fixture));
      override.mutate(overrides);
    }
    const configPath = await fixture.writeConfig("bad", overrides);
    const { code, stderr } = await inspect(configPath);
    assert.equal(code, 1, `expected refusal for ${expected}`);
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
  const family = (name) => config.models[name].family;
  const reviewer = family(config.kinds.review.model);
  assert.notEqual(reviewer, family(config.kinds.implement.model), "the review kind must not share the implement kind's family");
  assert.notEqual(reviewer, family(config.defaultModel), "the review kind must not share the default model's family");
});
