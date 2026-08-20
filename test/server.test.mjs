import assert from "node:assert/strict";
import { access, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MODERN_META,
  argumentValue,
  callArguments,
  isProcessAlive,
  makeFixture,
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
  assert.deepEqual(properties.role.enum, ["mechanical", "verify"]);
  assert.equal(properties.role.default, "mechanical");
  assert.deepEqual(properties.thinking.enum, ["off", "minimal", "low", "medium", "high"]);
  assert.equal(properties.model.enum, undefined, "wildcard patterns publish no enum");
  assert.deepEqual(
    implement.inputSchema.properties.model.enum,
    ["implementation/model-k", "implementation/model-b"],
    "role order, then exact patterns",
  );
  assert.equal(properties.working_directory.maxLength, 4096);
  assert.equal(properties.context_files.items.maxLength, 4096);
  assert.equal(properties.model.maxLength, 200);
  assert.equal(properties.timeout_seconds.maximum, 10);
  assert.equal(properties.return_characters.maximum, 5000);
  assert.match(research.outputSchema.properties.final_output.description, /Never stderr/);
  assert.match(research.description, /mechanical \(research\/model-a\)/);
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
  assert.equal(catalog.research.tool, "research");
  assert.equal(catalog.research.roles.mechanical.model, "research/model-a");
  const profiles = JSON.parse(
    (await client.request("resources/read", { uri: "cyberdeck://profiles" })).contents[0].text,
  );
  assert.deepEqual(profiles.profiles.research.tools, RESEARCH_TOOLS);
  assert.match(profiles.securityBoundary, /no built-in OS sandbox/i);
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

test("research: default role, flags, environment, usage, and artifacts", async (t) => {
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
  assert.equal(structured.role, "mechanical");
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
  assert.equal(recordedRequest.role, "mechanical");
  assert.deepEqual(recordedRequest.tools, RESEARCH_TOOLS);
  assert.deepEqual(recordedRequest.contextFiles, [fixture.canonicalContextFile]);
  const recordedResult = JSON.parse(await readFile(structured.artifacts.result, "utf8"));
  assert.equal(recordedResult.run_id, structured.run_id);
  assert.equal((await stat(structured.artifacts.directory)).mode & 0o777, 0o700);
  assert.equal(client.stderr(), "");
});

test("a named role binds its model and its own prompt preamble", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "research", callArguments(fixture, { role: "verify" }));
  assert.equal(result.structuredContent.role, "verify");
  const invocation = JSON.parse(result.structuredContent.final_output);
  assert.equal(argumentValue(invocation.argv, "--model"), "research/model-c");
  assert.equal(argumentValue(invocation.argv, "--thinking"), "high");
  assert.equal(argumentValue(invocation.argv, "--append-system-prompt"), "Verify only.");
});

test("implement uses the write-capable profile", async (t) => {
  const { fixture, client } = await serverFor(t);
  const result = await call(client, "implement", callArguments(fixture, { role: "intellectual" }));
  assert.equal(result.structuredContent.profile, "implementation");
  assert.equal(result.structuredContent.model, "implementation/model-b");
  const invocation = JSON.parse(result.structuredContent.final_output);
  assert.equal(argumentValue(invocation.argv, "--tools"), "read,grep,find,ls,bash,edit,write");
});

test("a model override is accepted inside the profile and rejected outside it", async (t) => {
  const { fixture, client } = await serverFor(t);
  const accepted = await call(client, "research", callArguments(fixture, { model: "research/model-z" }));
  assert.equal(accepted.structuredContent.model, "research/model-z");
  const rejected = await call(
    client,
    "research",
    callArguments(fixture, { model: "implementation/model-b" }),
  );
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.status, "rejected");
  assert.equal(rejected.structuredContent.run_id, null);
  assert.match(rejected.structuredContent.error, /not allowed/);
  assert.match(rejected.content[0].text, /^Cyberdeck research rejected: /);
  const tooLong = await call(client, "research", callArguments(fixture, { model: `research/${"m".repeat(200)}` }));
  assert.match(tooLong.structuredContent.error, /model cannot exceed 200/);
});

test("role and thinking are validated against the catalog", async (t) => {
  const { fixture, client } = await serverFor(t);
  const unknownRole = await call(client, "research", callArguments(fixture, { role: "wizard" }));
  assert.match(unknownRole.structuredContent.error, /role "wizard" is not defined.*cyberdeck:\/\/catalog/);
  const tooHigh = await call(client, "research", callArguments(fixture, { thinking: "max" }));
  assert.match(tooHigh.structuredContent.error, /thinking max exceeds the mechanical maximum high/);
  const atCeiling = await call(client, "research", callArguments(fixture, { thinking: "high" }));
  assert.equal(atCeiling.structuredContent.ok, true);
  const invalid = await call(client, "research", callArguments(fixture, { thinking: "turbo" }));
  assert.match(invalid.structuredContent.error, /thinking must be one of/);
});

test("unknown arguments and oversized fields are rejected before Pi starts", async (t) => {
  const { fixture, client } = await serverFor(t);
  const unknown = await call(client, "research", callArguments(fixture, { extra: 1 }));
  assert.match(unknown.structuredContent.error, /Unknown argument\(s\): extra/);
  const longRole = await call(client, "research", callArguments(fixture, { role: "r".repeat(50000) }));
  assert.match(longRole.structuredContent.error, /role cannot exceed 32/);
  assert.ok(longRole.structuredContent.role.length <= 33, "echoed role is clamped");
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
    [fixture.outside, "outside configured workspace roots"],
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
  if (signalName) client.child.kill(signalName);
  else client.endInput();
  const exit = await client.waitForExit(4000);
  assert.ok(exit, "server did not exit");
  assert.equal(isProcessAlive(pid), false, "pi child survived server shutdown");
  assert.equal(await client.waitForMessage((message) => message.id === 1, 0), null);
}

test("stdin EOF stops reading and terminates running Pi before exiting", (t) => hangingChild(t, null));

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
