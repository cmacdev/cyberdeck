import assert from "node:assert/strict";
import { access, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { createServer } from "../src/server.mjs";

import {
  MODERN_META,
  argumentValue,
  callArguments,
  fakePiPath,
  isProcessAlive,
  makeConfig,
  makeFixture,
  packageDirectory,
  sleep,
  startServer,
} from "./helpers.mjs";

const RESEARCH_TOOLS = ["read", "grep", "find", "ls", "web_search"];

async function serverFor(t, overrides = {}, env = undefined) {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config", overrides);
  const client = startServer(t, configPath, { cwd: fixture.workspace, env });
  return { fixture, client };
}

async function call(client, tool, args) {
  return client.request("tools/call", { name: tool, arguments: args });
}

async function onlyRunResult(fixture) {
  const [runId] = await readdir(fixture.artifactDirectory);
  return JSON.parse(await readFile(path.join(fixture.artifactDirectory, runId, "result.json"), "utf8"));
}

test("server/discover with modern _meta returns the discovery result", async (t) => {
  const { client } = await serverFor(t);
  const result = await client.request("server/discover", { _meta: MODERN_META });
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(Object.keys(result.capabilities).sort(), ["resources", "tools"]);
  assert.match(result.instructions, /research is read-only/);
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "cyberdeck");
});

test("an unsupported modern protocol version is refused with -32022 and the supported list", async (t) => {
  const { client } = await serverFor(t);
  await assert.rejects(
    client.request("server/discover", {
      _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    }),
    (error) => {
      assert.equal(error.code, -32022);
      assert.deepEqual(error.data, { supported: ["2026-07-28"], requested: "1900-01-01" });
      return true;
    },
  );
});

test("a modern request is served whether or not it declares clientCapabilities", async (t) => {
  const { client } = await serverFor(t);
  const versionOnly = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  assert.equal((await client.request("tools/list", { _meta: versionOnly })).tools.length, 2);
  assert.equal((await client.request("tools/list", { _meta: MODERN_META })).tools.length, 2);
});

test("a request without _meta is served under legacy semantics", async (t) => {
  const { client } = await serverFor(t);
  const listed = await client.request("tools/list");
  assert.equal(listed.tools.length, 2);
  const legacyMeta = await client.request("tools/list", { _meta: null });
  assert.equal(legacyMeta.tools.length, 2);
});

test("legacy initialize echoes a known version and falls back to the newest legacy one", async (t) => {
  const { client } = await serverFor(t);
  const known = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(known.protocolVersion, "2025-06-18");
  assert.equal(known.serverInfo.name, "cyberdeck");
  assert.equal(known.resultType, "complete");
  const unknown = await client.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.protocolVersion, "2025-11-25");
});

test("ping returns a result that carries resultType", async (t) => {
  const { client } = await serverFor(t);
  const result = await client.request("ping");
  assert.equal(result.resultType, "complete");
  assert.deepEqual(Object.keys(result).sort(), ["_meta", "resultType"]);
});

test("tools/list exposes exactly research and implement with honest schemas", async (t) => {
  const { client } = await serverFor(t);
  const listed = await client.request("tools/list");
  assert.equal(listed.ttlMs, 60000);
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["research", "implement"]);
  const [research, implement] = listed.tools;
  assert.deepEqual(research.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(implement.annotations.destructiveHint, true);
  assert.equal(implement.annotations.readOnlyHint, false);
  const properties = research.inputSchema.properties;
  assert.deepEqual(research.inputSchema.required, ["task", "working_directory"]);
  assert.equal(research.inputSchema.additionalProperties, false);
  assert.deepEqual(properties.kind.enum, ["review"]);
  assert.deepEqual(properties.model.enum, ["model-a", "model-c", "model-b"]);
  assert.deepEqual(properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "max"]);
  assert.deepEqual(properties.implemented_by.enum, ["alpha", "gamma", "beta"]);
  assert.deepEqual(implement.inputSchema.properties.model.enum, properties.model.enum);
  assert.deepEqual(implement.inputSchema.properties.thinking, properties.thinking);
  assert.equal(properties.working_directory.maxLength, 4096);
  assert.equal(properties.context_files.items.maxLength, 4096);
  assert.equal(properties.timeout_seconds.maximum, 10);
  assert.equal(properties.return_characters.maximum, 5000);
  assert.match(research.outputSchema.properties.final_output.description, /Never stderr/);
  assert.match(properties.model.description, /model-a \(cheap, alpha; off\|minimal\|low\|medium\|high, default medium\): Cheap survey/);

});

test("a catalog without kinds publishes no kind argument", async (t) => {
  const { client } = await serverFor(t, { kinds: {} });
  const [research] = (await client.request("tools/list")).tools;
  assert.equal(research.inputSchema.properties.kind, undefined);
});

test("resources list the catalog and resolved profiles", async (t) => {
  const { client } = await serverFor(t);
  const resources = await client.request("resources/list");
  assert.deepEqual(
    resources.resources.map((resource) => resource.uri),
    ["cyberdeck://catalog", "cyberdeck://profiles"],
  );
  const catalog = JSON.parse(
    (await client.request("resources/read", { uri: "cyberdeck://catalog" })).contents[0].text,
  );
  assert.equal(catalog.defaultModel, "model-a");
  assert.equal(catalog.models["model-a"].id, "research/model-a");
  assert.equal(catalog.kinds.review.model, "model-c");
  const profiles = JSON.parse(
    (await client.request("resources/read", { uri: "cyberdeck://profiles" })).contents[0].text,
  );
  assert.deepEqual(profiles.profiles.research.tools, RESEARCH_TOOLS);
  assert.match(profiles.securityBoundary, /no built-in OS sandbox/i);
});

test("a replaced policy is reloaded without a client restart", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config");
  const client = startServer(t, configPath, { cwd: fixture.workspace });
  const before = await client.request("tools/list");
  const updated = makeConfig(fixture, { limits: { maxTaskCharacters: 4321 } });
  updated.models["model-a"].providers.openrouter.id = "research/model-z";
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`);
  const catalog = JSON.parse(
    (await client.request("resources/read", { uri: "cyberdeck://catalog" })).contents[0].text,
  );
  assert.equal(catalog.models["model-a"].id, "research/model-z");
  const after = await client.request("tools/list");
  assert.notEqual(JSON.stringify(after.tools), JSON.stringify(before.tools));
  const changed = await client.waitForMessage(
    (message) => message.method === "notifications/tools/list_changed",
    1000,
  );
  assert.ok(changed, "clients are told to re-fetch tool schemas");
  await client.request("ping");
  await sleep(20);
  assert.equal(
    client.messages.filter((message) => message.method === "notifications/tools/list_changed").length,
    1,
  );
  const result = await call(client, "research", callArguments(fixture));
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.model, "research/model-z");
});

test("an in-flight run keeps the policy it started with", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config");
  const pidFile = path.join(fixture.root, "pi.pid");
  const client = startServer(t, configPath, {
    cwd: fixture.workspace,
    env: { FAKE_PI_PIDFILE: pidFile },
  });
  const slow = call(client, "research", callArguments(fixture, { task: "FAKE_WAIT" }));
  for (let attempt = 0; attempt < 50 && !(await access(pidFile).then(() => true, () => false)); attempt += 1) {
    await sleep(10);
  }
  const updated = makeConfig(fixture, { artifactDirectory: path.join(fixture.root, "other-runs") });
  updated.models["model-a"].providers.openrouter.id = "research/model-z";
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`);
  await client.request("ping");
  const result = await slow;
  assert.equal(result.structuredContent.model, "research/model-a");
  assert.equal((await readdir(fixture.artifactDirectory)).length, 1);
  await assert.rejects(access(path.join(fixture.root, "other-runs")));
});

test("a deleted policy rejects calls until the file is restored", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config");
  const client = startServer(t, configPath, { cwd: fixture.workspace });
  await client.request("ping");
  await rm(configPath);
  const rejected = await call(client, "research", callArguments(fixture));
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.match(rejected.structuredContent.error, /Configuration reload failed/);
  await writeFile(configPath, `${JSON.stringify(makeConfig(fixture), null, 2)}\n`);
  const recovered = await call(client, "research", callArguments(fixture));
  assert.equal(recovered.structuredContent.ok, true);
});

test("an invalid policy replacement rejects calls until the file is repaired", async (t) => {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("config");
  const client = startServer(t, configPath, { cwd: fixture.workspace });
  await client.request("ping");
  await writeFile(configPath, "{ not json\n");
  const rejected = await call(client, "research", callArguments(fixture));
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.match(rejected.structuredContent.error, /Configuration reload failed: Cannot read configuration/);
  await assert.rejects(access(fixture.artifactDirectory), "no run directory was created");
  await writeFile(configPath, `${JSON.stringify(makeConfig(fixture, { limits: { maxTaskCharacters: 9999 } }), null, 2)}\n`);
  const recovered = await call(client, "research", callArguments(fixture));
  assert.equal(recovered.structuredContent.ok, true);
});

test("protocol errors use the JSON-RPC and MCP codes", async (t) => {
  const { client } = await serverFor(t);
  await assert.rejects(client.request("nope"), { code: -32601 });
  await assert.rejects(client.request("tools/call", { name: "shell" }), { code: -32602 });
  await assert.rejects(client.request("resources/read", { uri: "cyberdeck://x" }), { code: -32602 });

  const invalid = [
    ["not json", -32700, null],
    ["[]", -32600, null],
    ['"string"', -32600, null],
    [JSON.stringify({ id: 1, method: "ping" }), -32600, 1],
    [JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }), -32600, null],
    [JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" }), -32600, null],
    [JSON.stringify({ jsonrpc: "2.0", id: true, method: "ping" }), -32600, null],
  ];
  for (const [line] of invalid) client.writeRaw(`${line}\n`);
  await client.request("ping");
  const errors = client.messages.filter((message) => message.error);
  assert.deepEqual(
    errors.map((message) => [message.error.code, message.id]),
    [[-32601, 1], [-32602, 2], [-32602, 3], ...invalid.map(([, code, id]) => [code, id])],
  );
});

test("an oversized line is refused once and the stream recovers", async (t) => {
  const { client } = await serverFor(t);
  client.writeRaw(`${"x".repeat(17 * 1024 * 1024)}\n`);
  const result = await client.request("ping");
  assert.equal(result.resultType, "complete");
  const errors = client.messages.filter((message) => message.error);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, -32600);
  assert.match(errors[0].error.message, /exceeds/);
});

test("notifications never receive a response", async (t) => {
  const { client } = await serverFor(t);
  client.notify("notifications/initialized");
  client.notify("notifications/cancelled", { requestId: 999 });
  client.send({ jsonrpc: "2.0", id: 42, method: "notifications/cancelled", params: { requestId: 1 } });
  await client.request("ping");
  assert.equal(client.messages.length, 1);
});

test("research: default model, flags, environment, usage, and artifacts", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", {
    task: "Inspect the fixture and summarize it.",
    working_directory: fixture.workspace,
    thinking: "high",
    context_files: [fixture.contextFile],
    constraints: ["Do not edit files."],
  });
  assert.equal(result.isError, false);
  assert.equal(result.resultType, "complete");
  const structured = result.structuredContent;
  assert.equal(structured.ok, true);
  assert.equal(structured.status, "succeeded");
  assert.equal(structured.profile, "research");
  assert.equal(structured.kind, null);
  assert.equal(structured.model, "research/model-a");
  assert.equal(structured.thinking, "high");
  assert.deepEqual(structured.tools, RESEARCH_TOOLS);
  assert.match(result.content[0].text, /succeeded\. Answer in structuredContent\.final_output/);

  const invocation = JSON.parse(structured.final_output);
  assert.equal(argumentValue(invocation.argv, "--provider"), "openrouter");
  assert.equal(argumentValue(invocation.argv, "--model"), "research/model-a");
  assert.equal(argumentValue(invocation.argv, "--thinking"), "high");
  assert.equal(argumentValue(invocation.argv, "--tools"), RESEARCH_TOOLS.join(","));
  assert.equal(argumentValue(invocation.argv, "--append-system-prompt"), "Research only.");
  assert.ok(invocation.argv.includes("--mode") && invocation.argv.includes("--print"));
  assert.ok(invocation.argv.includes("--no-session"));
  assert.ok(invocation.argv.includes("--no-approve"));
  assert.ok(!invocation.argv.includes("--no-context-files"));
  assert.ok(invocation.argv.includes(`@${fixture.canonicalContextFile}`));
  assert.match(invocation.prompt, /^Task:\nInspect the fixture and summarize it\./);
  assert.match(invocation.prompt, /Constraints supplied by the caller:\n- Do not edit files\.\n\nAttached files:$/);
  assert.ok(
    !invocation.argv.some((argument) => argument.includes("Inspect the fixture")),
    "the task travels on stdin, never on the command line",
  );
  assert.equal(invocation.cwd, await realpath(fixture.workspace));
  assert.equal(invocation.piStateDirectory, fixture.piStateDirectory);
  assert.equal(invocation.versionCheck, "1");
  assert.equal(invocation.telemetry, "0");
  assert.deepEqual(structured.usage, {
    input: 12,
    output: 34,
    cache_read: 5,
    cache_write: 6,
    cost: 0.007,
    turns: 1,
  });

  for (const artifact of ["directory", "events", "stderr", "request", "result"]) {
    await access(structured.artifacts[artifact]);
  }
  const recordedRequest = JSON.parse(await readFile(structured.artifacts.request, "utf8"));
  assert.equal(recordedRequest.model, "research/model-a");
  assert.equal(recordedRequest.kind, null);
  assert.deepEqual(recordedRequest.tools, RESEARCH_TOOLS);
  assert.deepEqual(recordedRequest.contextFiles, [fixture.canonicalContextFile]);
  const recordedResult = JSON.parse(await readFile(structured.artifacts.result, "utf8"));
  assert.equal(recordedResult.run_id, structured.run_id);
  assert.equal((await stat(structured.artifacts.directory)).mode & 0o777, 0o700);
  assert.equal(client.stderr(), "");
});

test("a kind sets its model and appends its preamble", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { kind: "review" }));
  assert.equal(result.structuredContent.kind, "review");
  const invocation = JSON.parse(result.structuredContent.final_output);
  assert.equal(argumentValue(invocation.argv, "--model"), "research/model-c");
  assert.equal(argumentValue(invocation.argv, "--thinking"), "high");
  assert.equal(argumentValue(invocation.argv, "--append-system-prompt"), "Research only.\n\nVerify only.");
  const overridden = await call(client, "research", callArguments(fixture, { kind: "review", model: "model-b", thinking: "max" }));
  const overriddenInvocation = JSON.parse(overridden.structuredContent.final_output);
  assert.equal(argumentValue(overriddenInvocation.argv, "--model"), "implementation/model-b");
  assert.equal(argumentValue(overriddenInvocation.argv, "--thinking"), "max");
});

test("implement uses the write-capable tools with any catalog model", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "implement", callArguments(fixture, { model: "model-c" }));
  assert.equal(result.structuredContent.profile, "implementation");
  assert.equal(result.structuredContent.model, "research/model-c");
  const invocation = JSON.parse(result.structuredContent.final_output);
  assert.equal(argumentValue(invocation.argv, "--tools"), "read,grep,find,ls,bash,edit,write");
  assert.equal(argumentValue(invocation.argv, "--append-system-prompt"), "Implement and verify.");
});

test("a Venice model without thinking control runs without a thinking flag and rejects one", async (t) => {
  const { fixture, client } = await serverFor(t, { provider: "venice" });
  const result = await call(client, "research", callArguments(fixture, { model: "model-c" }));
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.thinking, null);
  assert.ok(!JSON.parse(result.structuredContent.final_output).argv.includes("--thinking"));
  const echoed = await call(client, "research", callArguments(fixture, { model: "model-c", thinking: null }));
  assert.equal(echoed.structuredContent.ok, true);
  const rejected = await call(client, "research", callArguments(fixture, { model: "model-c", thinking: "high" }));
  assert.match(rejected.structuredContent.error, /model-c on venice has no thinking control; omit thinking/);
});

test("model, kind, thinking, and reviewer family are validated against the catalog", async (t) => {
  const { fixture, client } = await serverFor(t);
  const unknownModel = await call(client, "research", callArguments(fixture, { model: "research/model-a" }));
  assert.equal(unknownModel.isError, true);
  assert.equal(unknownModel.structuredContent.status, "rejected");
  assert.equal(unknownModel.structuredContent.run_id, null);
  assert.match(unknownModel.structuredContent.error, /model "research\/model-a" is not a model available on openrouter.*cyberdeck:\/\/catalog/);
  assert.match(unknownModel.content[0].text, /^Cyberdeck research rejected: /);
  const tooLong = await call(client, "research", callArguments(fixture, { model: "m".repeat(33) }));
  assert.match(tooLong.structuredContent.error, /model cannot exceed 32/);
  const unknownKind = await call(client, "research", callArguments(fixture, { kind: "wizard" }));
  assert.match(unknownKind.structuredContent.error, /kind "wizard" is not defined.*cyberdeck:\/\/catalog/);
  const inherited = await call(client, "research", callArguments(fixture, { kind: "constructor", model: "toString" }));
  assert.equal(inherited.structuredContent.status, "rejected");
  const unsupported = await call(client, "research", callArguments(fixture, { thinking: "max" }));
  assert.match(unsupported.structuredContent.error, /thinking max is not supported by model-a on openrouter; use one of: off, minimal, low, medium, high\./);
  const invalid = await call(client, "research", callArguments(fixture, { thinking: "turbo" }));
  assert.match(invalid.structuredContent.error, /thinking turbo is not supported/);
  const notString = await call(client, "research", callArguments(fixture, { thinking: 5 }));
  assert.match(notString.structuredContent.error, /thinking must be a non-empty string/);
  const sameFamily = await call(client, "research", callArguments(fixture, { kind: "review", implemented_by: "gamma" }));
  assert.match(sameFamily.structuredContent.error, /model-c is in the gamma family that implemented the work; choose another family/);
  const unknownFamily = await call(client, "research", callArguments(fixture, { kind: "review", implemented_by: "Gamma" }));
  assert.match(unknownFamily.structuredContent.error, /implemented_by "Gamma" is not a catalog family/);
  const otherFamily = await call(client, "research", callArguments(fixture, { kind: "review", implemented_by: "beta" }));
  assert.equal(otherFamily.structuredContent.ok, true);
});

test("unknown arguments and oversized fields are rejected before Pi starts", async (t) => {
  const { fixture, client } = await serverFor(t);
  const unknown = await call(client, "research", callArguments(fixture, { extra: 1 }));
  assert.match(unknown.structuredContent.error, /Unknown argument\(s\): extra/);
  const longKind = await call(client, "research", callArguments(fixture, { kind: "r".repeat(50000) }));
  assert.match(longKind.structuredContent.error, /kind cannot exceed 32/);
  assert.ok(longKind.structuredContent.kind.length <= 33, "echoed kind is clamped");
  const longTask = await call(client, "research", callArguments(fixture, { task: "t".repeat(10001) }));
  assert.match(longTask.structuredContent.error, /task cannot exceed 10000/);
  const manyConstraints = await call(
    client,
    "research",
    callArguments(fixture, { constraints: Array.from({ length: 21 }, (_, index) => `c${index}`) }),
  );
  assert.match(manyConstraints.structuredContent.error, /constraints must be an array with at most 20/);
  const notObject = await client.request("tools/call", { name: "research", arguments: [] });
  assert.match(notObject.structuredContent.error, /must be an object/);
  await assert.rejects(access(fixture.artifactDirectory), "no run directory was created");
});

test("working_directory must be an existing absolute directory inside a root", async (t) => {
  const { fixture, client } = await serverFor(t);
  const cases = [
    ["relative", "must be an absolute path"],
    [path.join(fixture.workspace, "missing"), "does not exist"],
    [fixture.contextFile, "is not a directory"],
    [fixture.outside, "outside configured workspace roots.*edit workspaceRoots in .*config.*reloads that file"],
    [path.join(fixture.workspace, "x".repeat(4096)), "cannot exceed 4096"],
  ];
  for (const [workingDirectory, expected] of cases) {
    const result = await call(client, "research", { task: "t", working_directory: workingDirectory });
    assert.equal(result.structuredContent.status, "rejected", workingDirectory);
    assert.match(result.structuredContent.error, new RegExp(expected));
  }
});

test("context_files must be regular files inside a root", async (t) => {
  const { fixture, client } = await serverFor(t);
  const outsideFile = path.join(fixture.outside, "secret.txt");
  await writeFile(outsideFile, "x");
  const cases = [
    [[outsideFile], "outside configured workspace roots"],
    [[fixture.workspace], "not a regular file"],
    [["relative.txt"], "must be an absolute path"],
    [[fixture.contextFile, fixture.contextFile], "must not contain duplicates"],
    [[path.join(fixture.workspace, "y".repeat(4096))], "cannot exceed 4096"],
    [Array.from({ length: 5 }, (_, index) => path.join(fixture.workspace, `f${index}`)), "at most 4 items"],
  ];
  for (const [contextFiles, expected] of cases) {
    const result = await call(client, "research", callArguments(fixture, { context_files: contextFiles }));
    assert.equal(result.structuredContent.status, "rejected");
    assert.match(result.structuredContent.error, new RegExp(expected));
  }
});

test("timeout_seconds and return_characters respect their ceilings", async (t) => {
  const { fixture, client } = await serverFor(t);
  const timeout = await call(client, "research", callArguments(fixture, { timeout_seconds: 11 }));
  assert.match(timeout.structuredContent.error, /timeout_seconds must be an integer from 1 through 10/);
  const characters = await call(client, "research", callArguments(fixture, { return_characters: 0 }));
  assert.match(characters.structuredContent.error, /return_characters must be an integer from 1 through 5000/);
});

test("the concurrency ceiling rejects overlapping runs and releases the slot", async (t) => {
  const { fixture, client } = await serverFor(t);
  const slow = call(client, "research", callArguments(fixture, { task: "FAKE_WAIT" }));
  const rejected = await call(client, "research", callArguments(fixture));
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.match(rejected.structuredContent.error, /Concurrent run limit reached \(1\)/);
  assert.equal((await slow).structuredContent.status, "succeeded");
  assert.equal((await call(client, "research", callArguments(fixture))).structuredContent.status, "succeeded");
});

test("final_output is truncated to exactly return_characters with a marker", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { return_characters: 80 }));
  assert.equal(result.structuredContent.output_truncated, true);
  assert.equal(result.structuredContent.final_output.length, 80);
  assert.match(result.structuredContent.final_output, /\[truncated; see artifacts\.events\]$/);
});

test("pi flags follow the configuration", async (t) => {
  const { fixture, client } = await serverFor(
    t,
    { pi: { trustProjectFiles: true, loadContextFiles: false, stateDirectory: null } },
    { PI_CODING_AGENT_DIR: null },
  );
  const result = await call(client, "research", callArguments(fixture));
  const invocation = JSON.parse(result.structuredContent.final_output);
  assert.ok(invocation.argv.includes("--approve"));
  assert.ok(!invocation.argv.includes("--no-approve"));
  assert.ok(invocation.argv.includes("--no-context-files"));
  assert.equal(invocation.piStateDirectory, null, "no PI_CODING_AGENT_DIR when stateDirectory is null");
});

test("the shipped policy disables extension and skill discovery for both tools", async (t) => {
  const shipped = JSON.parse(await readFile(path.join(packageDirectory, "cyberdeck.config.json"), "utf8"));
  const { fixture, client } = await serverFor(t, {
    pi: { arguments: [fakePiPath, ...shipped.pi.arguments] },
  });
  for (const tool of ["research", "implement"]) {
    const result = await call(client, tool, callArguments(fixture));
    assert.equal(result.isError, false);
    const invocation = JSON.parse(result.structuredContent.final_output);
    assert.ok(invocation.argv.includes("--no-extensions"));
    assert.ok(invocation.argv.includes("--no-skills"));
    const request = JSON.parse(await readFile(result.structuredContent.artifacts.request, "utf8"));
    assert.deepEqual(request.pi.prefixArguments, [fakePiPath, ...shipped.pi.arguments]);
  }
});

test("an answer cut short by the model token limit fails with its partial output", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_TOKEN_LIMIT" }));
  const structured = result.structuredContent;
  assert.equal(result.isError, true);
  assert.equal(structured.ok, false);
  assert.equal(structured.status, "failed");
  assert.equal(structured.exit_code, 0);
  assert.equal(structured.final_output, "Partial answer.");
  assert.equal(structured.output_truncated, true);
  assert.match(structured.error, /output token limit.*incomplete/);
  assert.deepEqual(await onlyRunResult(fixture), structured);
});

test("a completed answer after a token limit is successful", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_TOKEN_LIMIT_RECOVERED" }));
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.final_output, "Complete answer.");
  assert.equal(result.structuredContent.output_truncated, false);
  assert.equal(result.structuredContent.error, null);
  assert.equal(result.structuredContent.usage.turns, 2);
});

test("a crash after a token limit preserves the process failure", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_TOKEN_LIMIT_CRASH" }));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.exit_code, 3);
  assert.equal(result.structuredContent.final_output, "Partial answer.");
  assert.equal(result.structuredContent.output_truncated, true);
  assert.match(result.structuredContent.error, /fake pi crashed after partial output/);
});

test("a Pi error message becomes a failed result", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_FAIL" }));
  assert.equal(result.isError, true);
  const structured = result.structuredContent;
  assert.equal(structured.status, "failed");
  assert.equal(structured.exit_code, 7);
  assert.equal(structured.error, "Deliberate fake failure.");
  assert.match(result.content[0].text, /run \S+ failed: Deliberate fake failure\. Events at /);
  assert.equal((await readFile(structured.artifacts.stderr, "utf8")).trim(), "fake pi failed");
});

test("a crash without JSON reports stderr in error and leaves final_output empty", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_STDERR_ONLY" }));
  const structured = result.structuredContent;
  assert.equal(structured.status, "failed");
  assert.equal(structured.exit_code, 3);
  assert.equal(structured.final_output, "");
  assert.match(structured.error, /crashed before emitting JSON/);
  assert.equal(structured.usage.turns, 0);
});

test("a run with no assistant text succeeds with an empty final_output", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_SILENT" }));
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.final_output, "");
  assert.equal(result.structuredContent.output_truncated, false);
  assert.match(result.content[0].text, /succeeded without assistant text; events at /);
});

test("malformed and non-event Pi output cannot crash the server", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_NOISE" }));
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(result.structuredContent.usage.turns, 1);
  assert.equal((await client.request("ping")).resultType, "complete");
});

test("a zero exit without an assistant completion fails the run", async (t) => {
  const { fixture, client } = await serverFor(t);
  for (const task of ["FAKE_NO_EVENTS", "FAKE_NOISE FAKE_NO_EVENTS"]) {
    const result = await call(client, "research", callArguments(fixture, { task }));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "failed");
    assert.equal(result.structuredContent.exit_code, 0);
    assert.equal(result.structuredContent.usage.turns, 0);
    assert.equal(result.structuredContent.error, "Pi exited without an assistant completion.");
  }
});

test("a missing Pi binary is a failed run with a null exit code and artifacts", async (t) => {
  const { fixture, client } = await serverFor(t, { pi: { command: "cyberdeck-no-such-binary", arguments: [] } });
  const result = await call(client, "research", callArguments(fixture));
  const structured = result.structuredContent;
  assert.equal(structured.status, "failed");
  assert.equal(structured.exit_code, null);
  assert.match(structured.error, /ENOENT/);
  assert.ok(structured.run_id);
  await access(structured.artifacts.result);
});

test("an unusable artifact directory fails the call without a crash", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.artifactDirectory, "not a directory");
  const configPath = await fixture.writeConfig("config");
  const client = startServer(t, configPath, { cwd: fixture.workspace });
  const result = await call(client, "research", callArguments(fixture));
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.run_id, null);
  assert.match(result.structuredContent.error, /ENOTDIR|not a directory/);
  assert.equal((await client.request("ping")).resultType, "complete");
});

test("a run past its timeout is terminated and reported as timed_out", async (t) => {
  const { fixture, client } = await serverFor(t);
  const started = Date.now();
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_HANG", timeout_seconds: 1 }));
  const structured = result.structuredContent;
  assert.equal(structured.status, "timed_out");
  assert.equal(structured.exit_code, null);
  assert.equal(structured.error, "Pi run ended because of timed_out.");
  assert.ok(Date.now() - started >= 1000);
  assert.ok(structured.duration_ms < 4000, `took ${structured.duration_ms}ms`);
  assert.equal((await onlyRunResult(fixture)).status, "timed_out");
});

test("a child that ignores SIGTERM is killed after the grace period", async (t) => {
  const { fixture, client } = await serverFor(t);
  const started = Date.now();
  const result = await call(
    client,
    "research",
    callArguments(fixture, { task: "FAKE_IGNORE_TERM", timeout_seconds: 1 }),
  );
  assert.equal(result.structuredContent.status, "timed_out");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 3000 && elapsed < 10000, `took ${elapsed}ms`);
});

test("output beyond maxArtifactBytes stops the run and caps the artifact", async (t) => {
  const { fixture, client } = await serverFor(t, { limits: { maxArtifactBytes: 1024 } });
  const result = await call(client, "research", callArguments(fixture, { task: "FAKE_FLOOD" }));
  const structured = result.structuredContent;
  assert.equal(structured.status, "output_limit");
  assert.equal(structured.error, "Pi run ended because of output_limit.");
  assert.ok((await stat(structured.artifacts.events)).size <= 1024);
});

async function awaitRunEvents(fixture, pattern, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const events = await readdir(fixture.artifactDirectory)
      .then(([runId]) => readFile(path.join(fixture.artifactDirectory, runId, "events.jsonl"), "utf8"))
      .catch(() => "");
    if (pattern.test(events)) return;
    assert.ok(Date.now() < deadline, `events never matched ${pattern}`);
    await sleep(25);
  }
}

async function awaitRunResult(fixture, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await onlyRunResult(fixture).catch(() => null);
    if (result) return result;
    assert.ok(Date.now() < deadline, "result.json never appeared");
    await sleep(25);
  }
}

test("a cancelled request terminates Pi, gets no response, and is recorded", async (t) => {
  const { fixture, client } = await serverFor(t);
  const id = 77;
  client.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "research", arguments: callArguments(fixture, { task: "FAKE_HANG", timeout_seconds: 10 }) },
  });
  await sleep(300);
  client.notify("notifications/cancelled", { requestId: id, reason: "user pressed escape" });
  const recorded = await awaitRunResult(fixture);
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error, "Pi run ended because of cancelled. Reason: user pressed escape");
  assert.equal((await client.request("ping")).resultType, "complete");
  assert.equal(client.messages.some((message) => message.id === id), false);
});

test("a cancellation that lands during validation stops the call before anything is written", async (t) => {
  const { fixture, client } = await serverFor(t);
  const id = 78;
  const request = { jsonrpc: "2.0", id, method: "tools/call", params: { name: "research", arguments: callArguments(fixture) } };
  const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } };
  client.writeRaw(`${JSON.stringify(request)}\n${JSON.stringify(cancel)}\n`);
  assert.equal((await client.request("ping")).resultType, "complete");
  await sleep(200);
  assert.equal(client.messages.some((message) => message.id === id), false);
  await assert.rejects(readdir(fixture.artifactDirectory), "no run directory was created");
});

test("a duplicate request ID leaves the original run cancellable", async (t) => {
  const { fixture, client } = await serverFor(t);
  const id = 82;
  client.send({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "research", arguments: callArguments(fixture, { task: "FAKE_HANG" }) },
  });
  await awaitRunEvents(fixture, /fake-session/);
  client.send({ jsonrpc: "2.0", id: String(id), method: "ping" });
  assert.ok((await client.waitForMessage((message) => message.id === String(id), 1000))?.result);
  client.send({ jsonrpc: "2.0", id, method: "ping" });
  const duplicate = await client.waitForMessage((message) => message.id === id, 1000);
  assert.equal(duplicate?.error?.code, -32600);
  client.notify("notifications/cancelled", { requestId: id });
  assert.equal((await awaitRunResult(fixture)).status, "cancelled");
  assert.equal((await call(client, "research", callArguments(fixture))).structuredContent.ok, true);
});

test("a cancellation after Pi exited but before its pipes closed does not relabel the run", async (t) => {
  const { fixture, client } = await serverFor(t);
  const id = 79;
  client.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "research", arguments: callArguments(fixture, { task: "FAKE_LINGER" }) },
  });
  await awaitRunEvents(fixture, /lingered/);
  await sleep(200);
  client.notify("notifications/cancelled", { requestId: id });
  const response = await client.waitForMessage((message) => message.id === id, 4000);
  assert.ok(response, "the completed run must still be reported");
  assert.equal(response.result.structuredContent.status, "succeeded");
  assert.equal(response.result.structuredContent.final_output, "lingered");
});

test("a cancellation for a finished request is ignored", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture));
  assert.equal(result.structuredContent.status, "succeeded");
  client.notify("notifications/cancelled", { requestId: 1 });
  assert.equal((await client.request("ping")).resultType, "complete");
});

test("inherited output pipes cannot retain a completed run slot", async (t) => {
  const fixture = await makeFixture(t);
  const pidFile = path.join(fixture.root, "descendant.pid");
  const client = startServer(t, await fixture.writeConfig("config"), {
    env: { FAKE_PI_DESCENDANT_PIDFILE: pidFile },
  });
  let descendantPid;
  t.after(() => {
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });
  client.send({
    jsonrpc: "2.0", id: 80, method: "tools/call",
    params: { name: "research", arguments: callArguments(fixture, { task: "FAKE_HOLD_PIPE", timeout_seconds: 1 }) },
  });
  const result = await client.waitForMessage((message) => message.id === 80, 5000);
  descendantPid = Number(await readFile(pidFile, "utf8"));
  assert.ok(result, "inherited stdout blocked the completed result");
  assert.equal(result.result.structuredContent.status, "succeeded");
  assert.equal((await call(client, "research", callArguments(fixture))).structuredContent.ok, true);
  client.child.kill("SIGTERM");
  assert.ok(await client.waitForExit(5000), "inherited stdout blocked shutdown");
});

async function hangingChild(t, signalName) {
  const fixture = await makeFixture(t);
  const pidFile = path.join(fixture.root, "pi.pid");
  const configPath = await fixture.writeConfig("config");
  const client = startServer(t, configPath, { cwd: fixture.workspace, env: { FAKE_PI_PIDFILE: pidFile } });
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "research", arguments: callArguments(fixture, { task: "FAKE_HANG", timeout_seconds: 10 }) },
  });
  let pid = null;
  for (let attempt = 0; attempt < 50 && pid === null; attempt += 1) {
    await sleep(50);
    pid = await readFile(pidFile, "utf8").then(Number).catch(() => null);
  }
  assert.ok(pid, "fake pi did not start");
  assert.ok(isProcessAlive(pid));
  if (signalName === "stdout") {
    client.child.stdout.destroy();
    client.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  } else if (signalName) client.child.kill(signalName);
  else client.endInput();
  const exit = await client.waitForExit(4000);
  assert.ok(exit, "server did not exit");
  assert.equal(exit.code, 0, client.stderr());
  assert.equal(isProcessAlive(pid), false, "pi child survived server shutdown");
  assert.equal(await client.waitForMessage((message) => message.id === 1, 0), null);
}

test("stdin EOF stops reading and terminates running Pi before exiting", (t) => hangingChild(t, null));
test("a broken stdout pipe terminates running Pi before exiting", (t) => hangingChild(t, "stdout"));

for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`${signalName} terminates running Pi before exiting`, (t) => hangingChild(t, signalName));

  test(`${signalName} exits promptly when idle`, async (t) => {
    const { client } = await serverFor(t);
    assert.equal((await client.request("ping")).resultType, "complete");
    client.child.kill(signalName);
    const exit = await client.waitForExit(2000);
    assert.ok(exit, "server did not exit");
    assert.equal(exit.code, 0);
  });
}

async function progressHarness(t) {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("progress");
  const config = await loadConfig(configPath);
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  createInterface({ input: output, crlfDelay: Infinity }).on("line", (line) => {
    messages.push(JSON.parse(line));
  });
  const server = createServer(config, { input, output, progressIntervalMs: 10 });
  t.after(() => server.close());
  let nextId = 1;
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate, ms = 4000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) return null;
      await sleep(5);
    }
  };
  const progress = (id) =>
    messages.filter((message) => message.method === "notifications/progress" && message.params.progressToken === id);
  return {
    fixture,
    messages,
    progress,
    waitFor,
    call(token) {
      const id = nextId;
      nextId += 1;
      send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "research",
          arguments: { task: "FAKE_WAIT report", working_directory: fixture.workspace },
          _meta: token === undefined ? MODERN_META : { ...MODERN_META, progressToken: token },
        },
      });
      return id;
    },
    async response(id) {
      const message = await waitFor((candidate) => candidate.id === id);
      assert.ok(message, `no response for ${id}`);
      return message;
    },
    cancel(id) {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    },
  };
}

test("a call with a progress token reports progress until the response and then stops", async (t) => {
  const { messages, progress, call, response } = await progressHarness(t);
  const id = call("token-1");
  const result = await response(id);
  assert.equal(result.error, undefined);
  const beats = progress("token-1");
  assert.ok(beats.length >= 2, `expected progress heartbeats, got ${beats.length}`);
  for (let index = 1; index < beats.length; index += 1) {
    assert.ok(beats[index].params.progress > beats[index - 1].params.progress);
  }
  const afterResponse = beats.length;
  await sleep(60);
  assert.equal(progress("token-1").length, afterResponse);
  assert.equal(
    messages.filter((message) => message.method === "notifications/progress" && message.params.progressToken !== "token-1").length,
    0,
  );
});

test("a call without a progress token emits no progress notifications", async (t) => {
  const { messages, call, response } = await progressHarness(t);
  const id = call(undefined);
  await response(id);
  assert.equal(messages.filter((message) => message.method === "notifications/progress").length, 0);
});

test("a cancelled call stops reporting progress and gets no response", async (t) => {
  const { messages, progress, waitFor, call, cancel } = await progressHarness(t);
  const id = call(7);
  const first = await waitFor(
    (message) => message.method === "notifications/progress" && message.params.progressToken === 7,
  );
  assert.ok(first, "no heartbeat before cancel");
  cancel(id);
  let settled = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    settled = progress(7).length;
    await sleep(40);
    if (progress(7).length === settled) break;
  }
  await sleep(80);
  assert.equal(progress(7).length, settled);
  assert.equal(messages.some((message) => message.id === id), false);
});
