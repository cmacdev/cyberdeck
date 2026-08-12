import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(packageDirectory, "bin", "cyberdeck-mcp.mjs");
const fakePiPath = path.join(packageDirectory, "fixtures", "fake-pi.mjs");

function makeClient(configPath, cwd) {
  const child = spawn(process.execPath, [serverPath, "--config", configPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`Cyberdeck exited with ${code}: ${stderr}`));
    }
    pending.clear();
  });

  return {
    child,
    request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    close() {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    },
    getStderr() {
      return stderr;
    },
  };
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

test("typed MCP contract enforces profiles and invokes Pi without network", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberdeck-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const outsideWorkspace = path.join(temporaryDirectory, "outside");
  const contextFile = path.join(workspace, "context.txt");
  const configPath = path.join(temporaryDirectory, "config.json");
  const artifactDirectory = path.join(temporaryDirectory, "runs");
  const piStateDirectory = path.join(temporaryDirectory, "pi-state");
  await mkdir(workspace);
  await mkdir(outsideWorkspace);
  await writeFile(contextFile, "fixture context\n", "utf8");
  const canonicalContextFile = await realpath(contextFile);

  const config = {
    provider: "openrouter",
    workspaceRoots: [workspace],
    artifactDirectory,
    pi: {
      command: process.execPath,
      arguments: [fakePiPath],
      stateDirectory: piStateDirectory,
      trustProjectFiles: false,
      loadContextFiles: true,
    },
    limits: {
      maxConcurrentRuns: 1,
      defaultTimeoutSeconds: 5,
      maxTimeoutSeconds: 10,
      defaultReturnCharacters: 3000,
      maxReturnCharacters: 5000,
      maxArtifactBytes: 1048576,
      maxTaskCharacters: 10000,
      maxContextFiles: 4,
    },
    profiles: {
      research: {
        modelPatterns: ["research/*"],
        defaultThinking: "medium",
        maxThinking: "high",
        tools: ["read", "grep", "find", "ls", "web_search"],
        promptPreamble: "Research only.",
      },
      implementation: {
        modelPatterns: ["implementation/*"],
        defaultThinking: "high",
        maxThinking: "max",
        tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        promptPreamble: "Implement and verify.",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const client = makeClient(configPath, workspace);
  t.after(async () => {
    client.close();
    if (client.child.exitCode === null) {
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 1000);
        fallback.unref();
        client.child.once("exit", () => {
          clearTimeout(fallback);
          resolve();
        });
      });
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const discovery = await client.request("server/discover", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    },
  });
  assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
  assert.equal(discovery._meta["io.modelcontextprotocol/serverInfo"].name, "cyberdeck");

  const initialization = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialization.protocolVersion, "2025-11-25");
  assert.equal(initialization.serverInfo.name, "cyberdeck");

  const listed = await client.request("tools/list");
  assert.equal(listed.resultType, "complete");
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["research", "implement"],
  );
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);
  assert.equal(listed.tools[1].annotations.destructiveHint, true);
  assert.deepEqual(listed.tools[0].inputSchema.properties.model.enum, undefined);
  assert.deepEqual(listed.tools[0].inputSchema.properties.thinking.enum, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.ok(listed.tools[0].outputSchema.properties.artifacts);

  const resources = await client.request("resources/list");
  assert.equal(resources.resources[0].uri, "cyberdeck://profiles");
  const profileResource = await client.request("resources/read", {
    uri: "cyberdeck://profiles",
  });
  const resolvedPolicy = JSON.parse(profileResource.contents[0].text);
  assert.deepEqual(resolvedPolicy.profiles.research.tools, config.profiles.research.tools);
  assert.match(resolvedPolicy.securityBoundary, /no built-in OS sandbox/i);

  const researchCall = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "Inspect the fixture and summarize it.",
      working_directory: workspace,
      model: "research/model-a",
      thinking: "high",
      context_files: [contextFile],
      constraints: ["Do not edit files."],
    },
  });
  assert.equal(researchCall.isError, false);
  assert.equal(researchCall.resultType, "complete");
  assert.equal(researchCall.structuredContent.ok, true);
  assert.equal(researchCall.structuredContent.profile, "research");
  const researchInvocation = JSON.parse(researchCall.structuredContent.final_output);
  assert.equal(argumentValue(researchInvocation.argv, "--provider"), "openrouter");
  assert.equal(argumentValue(researchInvocation.argv, "--model"), "research/model-a");
  assert.equal(
    argumentValue(researchInvocation.argv, "--tools"),
    "read,grep,find,ls,web_search",
  );
  assert.ok(researchInvocation.argv.includes("--no-approve"));
  assert.ok(!researchInvocation.argv.includes("--no-context-files"));
  assert.ok(researchInvocation.argv.includes(`@${canonicalContextFile}`));
  assert.match(researchInvocation.argv.at(-1), /Do not edit files\./);
  assert.equal(researchInvocation.piStateDirectory, piStateDirectory);
  assert.equal(researchInvocation.versionCheck, "1");
  assert.equal(researchInvocation.telemetry, "0");
  assert.deepEqual(researchCall.structuredContent.usage, {
    input: 12,
    output: 34,
    cache_read: 5,
    cache_write: 6,
    cost: 0.007,
    turns: 1,
  });
  await access(researchCall.structuredContent.artifacts.events);
  await access(researchCall.structuredContent.artifacts.request);
  await access(researchCall.structuredContent.artifacts.result);
  const recordedRequest = JSON.parse(
    await readFile(researchCall.structuredContent.artifacts.request, "utf8"),
  );
  assert.equal(recordedRequest.model, "research/model-a");
  assert.deepEqual(recordedRequest.tools, config.profiles.research.tools);

  const implementationCall = await client.request("tools/call", {
    name: "implement",
    arguments: {
      task: "Describe the implementation invocation without changing anything.",
      working_directory: workspace,
      model: "implementation/model-b",
    },
  });
  assert.equal(implementationCall.structuredContent.profile, "implementation");
  const implementationInvocation = JSON.parse(
    implementationCall.structuredContent.final_output,
  );
  assert.equal(
    argumentValue(implementationInvocation.argv, "--tools"),
    "read,grep,find,ls,bash,edit,write",
  );

  const rejectedModel = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "This must not launch.",
      working_directory: workspace,
      model: "implementation/model-b",
    },
  });
  assert.equal(rejectedModel.isError, true);
  assert.equal(rejectedModel.structuredContent.status, "rejected");
  assert.match(rejectedModel.structuredContent.error, /not allowed/);
  assert.equal(rejectedModel.structuredContent.run_id, null);

  const rejectedRoot = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "This must not launch either.",
      working_directory: outsideWorkspace,
      model: "research/model-a",
    },
  });
  assert.equal(rejectedRoot.isError, true);
  assert.match(rejectedRoot.structuredContent.error, /outside configured workspace roots/);

  const truncated = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "Return the normal fake payload.",
      working_directory: workspace,
      model: "research/model-a",
      return_characters: 80,
    },
  });
  assert.equal(truncated.structuredContent.output_truncated, true);
  assert.equal(truncated.structuredContent.final_output.length, 80);
  assert.match(truncated.structuredContent.final_output, /artifacts\.events/);

  const failed = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "FAKE_FAIL",
      working_directory: workspace,
      model: "research/model-a",
    },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.status, "failed");
  assert.equal(failed.structuredContent.exit_code, 7);
  assert.equal(failed.structuredContent.error, "Deliberate fake failure.");
  await access(failed.structuredContent.artifacts.stderr);

  const waitingRun = client.request("tools/call", {
    name: "research",
    arguments: {
      task: "FAKE_WAIT",
      working_directory: workspace,
      model: "research/model-a",
      timeout_seconds: 10,
    },
  });
  const concurrencyRejected = await client.request("tools/call", {
    name: "research",
    arguments: {
      task: "This launch exceeds the concurrency ceiling.",
      working_directory: workspace,
      model: "research/model-a",
    },
  });
  assert.equal(concurrencyRejected.isError, true);
  assert.equal(concurrencyRejected.structuredContent.status, "rejected");
  assert.match(concurrencyRejected.structuredContent.error, /Concurrent run limit reached/);
  const waitingResult = await waitingRun;
  assert.equal(
    waitingResult.structuredContent.status,
    "succeeded",
    JSON.stringify(waitingResult.structuredContent),
  );

  assert.equal(client.getStderr(), "");
});
