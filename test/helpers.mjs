import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverPath = path.join(packageDirectory, "bin", "cyberdeck-mcp.mjs");
export const fakePiPath = path.join(packageDirectory, "fixtures", "fake-pi.mjs");

export const MODERN_META = Object.freeze({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

// A disposable workspace: <root>/workspace (allowed), <root>/outside, a
// context file, artifact and Pi-state directories. Removed after the test.
export async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberdeck-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const contextFile = path.join(workspace, "context.txt");
  await writeFile(contextFile, "fixture context\n", "utf8");
  return {
    root,
    workspace,
    outside,
    contextFile,
    canonicalContextFile: await realpath(contextFile),
    artifactDirectory: path.join(root, "runs"),
    piStateDirectory: path.join(root, "pi-state"),
    async writeConfig(name, overrides = {}) {
      const configPath = path.join(root, `${name}.json`);
      await writeFile(configPath, `${JSON.stringify(makeConfig(this, overrides), null, 2)}\n`);
      return configPath;
    },
  };
}

// The base configuration used by the server tests. `research` uses a
// wildcard model pattern (no enum in the schema); `implementation` lists
// exact IDs (enum present).
export function makeConfig(fixture, overrides = {}) {
  const base = {
    provider: "openrouter",
    workspaceRoots: [fixture.workspace],
    artifactDirectory: fixture.artifactDirectory,
    pi: {
      command: process.execPath,
      arguments: [fakePiPath],
      stateDirectory: fixture.piStateDirectory,
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
        defaultRole: "mechanical",
        defaultThinking: "medium",
        maxThinking: "high",
        tools: ["read", "grep", "find", "ls", "web_search"],
        promptPreamble: "Research only.",
        roles: {
          mechanical: {
            model: "research/model-a",
            when: "Cheap survey and citation.",
            defaultThinking: "medium",
            maxThinking: "high",
          },
          verify: {
            model: "research/model-c",
            when: "Independent check of claimed results.",
            defaultThinking: "high",
            maxThinking: "high",
            promptPreamble: "Verify only.",
          },
        },
      },
      implementation: {
        modelPatterns: ["implementation/model-k", "implementation/model-b"],
        defaultRole: "intellectual",
        defaultThinking: "high",
        maxThinking: "max",
        tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        promptPreamble: "Implement and verify.",
        roles: {
          gritty: {
            model: "implementation/model-k",
            when: "Ambiguous or cross-cutting implementation.",
          },
          intellectual: {
            model: "implementation/model-b",
            when: "Bounded spec-exact diffs.",
          },
        },
      },
    },
  };
  const { limits, pi, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    limits: { ...base.limits, ...(limits ?? {}) },
    pi: { ...base.pi, ...(pi ?? {}) },
  };
}

// Child environment: the test's own, plus overrides; a null value removes a key.
function childEnvironment(overrides) {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

// Launches the server and returns a minimal JSON-RPC client over its stdio.
export function startServer(t, configPath, { cwd, env } = {}) {
  const child = spawn(process.execPath, [serverPath, "--config", configPath], {
    cwd,
    env: childEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const messages = [];
  const listeners = new Set();
  let nextId = 1;
  let stderr = "";
  let exit = null;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const listener of listeners) listener(message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        Object.assign(new Error(message.error.message), {
          code: message.error.code,
          data: message.error.data,
        }),
      );
    } else {
      waiter.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`Cyberdeck exited with ${code}: ${stderr}`));
    }
    pending.clear();
  });

  const client = {
    child,
    messages,
    writeRaw(text) {
      child.stdin.write(text);
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      client.send({ jsonrpc: "2.0", id, method, params });
      return response;
    },
    notify(method, params = {}) {
      client.send({ jsonrpc: "2.0", method, params });
    },
    // Resolves with the first message matching `predicate`, or null after `ms`.
    waitForMessage(predicate, ms) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          resolve(null);
        }, ms);
        const listener = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message);
        };
        listeners.add(listener);
      });
    },
    stderr: () => stderr,
    exit: () => exit,
    async waitForExit(ms) {
      const timer = new Promise((resolve) => setTimeout(() => resolve(null), ms).unref());
      return Promise.race([exited, timer]);
    },
    endInput() {
      child.stdin.end();
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      if (!(await client.waitForExit(3000))) child.kill("SIGKILL");
    },
  };
  t.after(() => client.close());
  return client;
}

// Runs the CLI to completion.
export function runCli(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath, ...args], {
      cwd,
      env: childEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

export function callArguments(fixture, extra = {}) {
  return { task: "Inspect the fixture.", working_directory: fixture.workspace, ...extra };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
