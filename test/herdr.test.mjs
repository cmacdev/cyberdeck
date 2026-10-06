import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { coordinator } from "../pi/coordinator.js";
import { loadConfig } from "../src/config.mjs";
import { HerdrWorkers, herdrEnvironment, orchestrationGuard, workerSession } from "../src/herdr-workers.mjs";
import { makeFixture } from "./helpers.mjs";

async function setup(t, overrides) {
  const fixture = await makeFixture(t);
  const configPath = await fixture.writeConfig("herdr", overrides);
  const config = await loadConfig(configPath);
  config.pi.command = "/configured/bin/pi";
  await mkdir(path.join(config.pi.stateDirectory, "extensions"), { recursive: true });
  await writeFile(path.join(config.pi.stateDirectory, "extensions/herdr-agent-state.ts"), "");
  const calls = [];
  const agents = [];
  const workspaces = [];
  let next = 0;
  const manager = new HerdrWorkers({ config, cwd: fixture.workspace, session: "deck-test", environment: { PATH: "/bin", HERDR_SOCKET_PATH: "/visible.sock" },
    call: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "workspace" && args[1] === "list") return { workspaces };
      if (args[0] === "workspace" && args[1] === "create") {
        workspaces.push({ workspace_id: `w${++next}`, label: args[args.indexOf("--label") + 1] });
        return { root_pane: { pane_id: `w${next}:p1` } };
      }
      if (args[0] === "workspace" && args[1] === "close") {
        const index = agents.findIndex((a) => a.workspace_id === args[2]);
        if (index !== -1) agents.splice(index, 1);
        workspaces.splice(workspaces.findIndex((w) => w.workspace_id === args[2]), 1);
        return { closed: true };
      }
      if (args[0] === "pane" && args[1] === "list") return { panes: [{ pane_id: `${args[3]}:p1` }] };
      if (args[1] === "list") return { agents };
      if (args[1] === "start") { const a = { name: args[2], agent_status: "idle", pane_id: args[6], workspace_id: args[6].split(":")[0] }; agents.push(a); return { agent: a }; }
      if (args[1] === "prompt") return { agent: agents.find((a) => a.name === args[2]) };
      if (args[1] === "read") return "worker reply";
      if (args[1] === "send-keys") return { sent: true };
      throw new Error(`Unexpected call ${args}`);
    },
  });
  return { fixture, config, configPath, manager, calls, agents, workspaces };
}

test("worker identity survives reload and changes for other sessions and forks", () => {
  assert.equal(workerSession("visible", "pi-1"), workerSession("visible", "pi-1"));
  assert.notEqual(workerSession("visible", "pi-1"), workerSession("visible", "pi-2"));
  assert.notEqual(workerSession("visible", "pi-1"), workerSession("other", "pi-1"));
  assert.deepEqual(herdrEnvironment({ PATH: "/bin", HERDR_ENV: "1", HERDR_SOCKET_PATH: "wrong", HERDR_PANE_ID: "wrong", HERDR_SESSION: "wrong", HERDR_CONFIG_PATH: "config" }), { PATH: "/bin", HERDR_CONFIG_PATH: "config" });
});

test("worker launch reuses profile policy and preserves sessions without enabling coordinator recursion", async (t) => {
  const { manager, calls, config } = await setup(t);
  await manager.run({ action: "start", name: "scout", kind: "review" });
  const created = calls.find(({ args }) => args[1] === "create").args;
  assert.ok(created.includes("CYBERDECK_WORKER=1"));
  assert.ok(created.includes(`PI_CODING_AGENT_DIR=${config.pi.stateDirectory}`));
  const args = calls.find(({ args }) => args[1] === "start").args;
  for (const [flag, value] of [["--provider", "openrouter"], ["--model", "research/model-c"], ["--tools", "read,grep,find,ls,web_search"]]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes("--session-dir"));
  assert.ok(args.includes("--extension"));
  assert.ok(!args.includes("--no-session"));
  await assert.rejects(manager.run({ action: "start", name: "scout" }), /already exists/);
  await assert.rejects(manager.run({ action: "start", name: "outside", working_directory: "/" }), /workspaceRoots/);
  await assert.rejects(manager.run({ action: "start", name: "bad", model: "wrong/model" }), /not a model available/);
  await assert.rejects(manager.run({ action: "start", name: "same", kind: "review", implemented_by: "gamma" }), /gamma family that implemented the work/);
});

test("a codemode worker loads Cyberdeck's extension with the profile's mode", async (t) => {
  const { manager, calls } = await setup(t, {
    profiles: {
      research: { tools: ["read"], codemode: "off", promptPreamble: "" },
      implementation: { tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], codemode: "on", promptPreamble: "" },
    },
  });
  await manager.run({ action: "start", name: "coder", profile: "implementation" });
  assert.ok(calls.find(({ args }) => args[1] === "create").args.includes("CYBERDECK_CODEMODE=on"));
  const args = calls.find(({ args }) => args[1] === "start").args;
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,bash,edit,write,codemode");
  assert.ok(args.includes(fileURLToPath(new URL("../pi/codemode.js", import.meta.url))));
  assert.ok(args.includes("--no-mcp"));
});

test("a codemode worker refuses a Pi that lacks createCodemodeExtension", async (t) => {
  const { manager, calls, fixture } = await setup(t, {
    profiles: {
      research: { tools: ["read"], codemode: "only", promptPreamble: "" },
      implementation: { tools: ["read", "bash", "edit", "write"], codemode: "on", promptPreamble: "" },
    },
  });
  const root = path.join(fixture.root, "old-pi");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"@earendil-works/pi-coding-agent"}\n');
  await writeFile(path.join(root, "dist", "index.js"), "export {}\n");
  const command = path.join(root, "pi");
  await writeFile(command, "");
  manager.config.pi.command = command;
  await assert.rejects(manager.run({ action: "start", name: "scout", profile: "research" }), /createCodemodeExtension/);
  assert.equal(calls.length, 0);
});

test("each worker model selects its configured thinking while preserving explicit overrides", async (t) => {
  const { manager, calls, config } = await setup(t);
  for (const [profile, policy] of Object.entries(config.profiles)) {
    for (const [name, model] of Object.entries(config.models)) {
      await manager.run({ action: "start", name: `${profile.slice(0, 4)}-${name}`, profile, model: name });
      const args = calls.filter(({ args }) => args[1] === "start").at(-1).args;
      assert.equal(args[args.indexOf("--model") + 1], model.id);
      assert.equal(args[args.indexOf("--thinking") + 1], model.defaultThinking);
      assert.equal(args[args.indexOf("--tools") + 1], policy.tools.join(","));
    }
  }
  await manager.run({ action: "start", name: "explicit", profile: "research", kind: "review", model: "model-a", thinking: "low" });
  const args = calls.filter(({ args }) => args[1] === "start").at(-1).args;
  assert.equal(args[args.indexOf("--model") + 1], "research/model-a");
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("a worker on a Venice model without thinking control gets no thinking flag", async (t) => {
  const { manager, calls } = await setup(t, { provider: "venice" });
  await manager.run({ action: "start", name: "plain", model: "model-c" });
  assert.ok(!calls.find(({ args }) => args[1] === "start").args.includes("--thinking"));
});

test("send gates completion and preserves worker identity across follow-ups", async (t) => {
  const { manager, calls } = await setup(t);
  await manager.run({ action: "start", name: "scout" });
  for (const task of ["first task", "follow-up"]) {
    const result = await manager.run({ action: "send", name: "scout", task });
    assert.equal(result.output, "worker reply");
    assert.equal(result.agent.name, "scout");
  }
  const prompts = calls.filter(({ args }) => args[1] === "prompt");
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(({ args }) => args.includes("--wait")));
  assert.equal(calls.filter(({ args }) => args[1] === "start").length, 1);
  await assert.rejects(manager.run({ action: "close", name: "w99:p1" }), /worker name/);
  await assert.rejects(manager.run({ action: "read", name: "foreign" }), /not in this coordinator/);
  await manager.run({ action: "close", name: "scout" });
  assert.deepEqual((await manager.run({ action: "list" })).agents, []);
});

test("busy, blocked and timed-out workers are inspected rather than blindly resubmitted", async (t) => {
  const { manager, agents, calls } = await setup(t);
  await manager.run({ action: "start", name: "scout" });
  agents[0].agent_status = "blocked";
  await assert.rejects(manager.run({ action: "send", name: "scout", task: "do it" }), /blocked/);
  await assert.rejects(manager.run({ action: "close", name: "scout" }), /active or blocked/);
  assert.equal(calls.filter(({ args }) => args[1] === "prompt").length, 0);
  agents[0].agent_status = "idle";
  const call = manager.call;
  let prompts = 0;
  manager.call = (args, options) => {
    if (args[1] === "prompt") { prompts++; throw new Error("timeout"); }
    return call(args, options);
  };
  await assert.rejects(manager.run({ action: "send", name: "scout", task: "do it" }), /read before retrying/);
  assert.equal(prompts, 1);
  assert.equal(manager.pending.size, 0);
});

test("different workers can run concurrently while duplicate sends are rejected", async (t) => {
  const { manager, config } = await setup(t);
  config.limits.maxConcurrentRuns = 2;
  await Promise.all(["one", "two"].map((name) => manager.run({ action: "start", name })));
  const call = manager.call;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  manager.call = async (args, options) => { if (args[1] === "prompt") await gate; return call(args, options); };
  const sends = ["one", "two"].map((name) => manager.run({ action: "send", name, task: "work" }));
  await assert.rejects(manager.run({ action: "send", name: "one", task: "duplicate" }), /already pending/);
  assert.equal(manager.pending.size, 2);
  release();
  await Promise.all(sends);
});

test("timed-out workers retain their concurrency slots across reload until they finish", async (t) => {
  const { manager, config, agents, calls } = await setup(t);
  config.limits.maxConcurrentRuns = 1;
  for (const name of ["one", "two"]) await manager.run({ action: "start", name });
  const call = manager.call;
  const prompted = [];
  manager.call = async (args, options) => {
    if (args[1] === "prompt") {
      prompted.push(args[2]);
      agents.find((agent) => agent.name === args[2]).agent_status = "working";
      throw new Error("wait timeout");
    }
    return call(args, options);
  };
  await assert.rejects(manager.send({ name: "one", task: "work" }), /wait timeout/);
  await assert.rejects(manager.send({ name: "two", task: "work" }), /concurrent run limit/);
  const reloaded = new HerdrWorkers({ config, session: manager.session, cwd: manager.cwd, call: manager.call });
  await assert.rejects(reloaded.send({ name: "two", task: "work" }), /concurrent run limit/);
  assert.deepEqual(prompted, ["one"]);
  agents[0].agent_status = "done";
  await assert.rejects(reloaded.send({ name: "two", task: "work" }), /wait timeout/);
  assert.deepEqual(prompted, ["one", "two"]);
  assert.equal(calls.filter(({ args }) => args[1] === "send-keys" || args[1] === "close").length, 0);
});

test("remote active workers and concurrent local submissions share the configured limit", async (t) => {
  const { manager, config, agents } = await setup(t);
  config.limits.maxConcurrentRuns = 2;
  for (const name of ["one", "two", "three"]) await manager.run({ action: "start", name });
  agents[0].agent_status = "working";
  const call = manager.call;
  const prompted = [];
  manager.call = async (args, options) => {
    if (args[1] === "prompt") prompted.push(args[2]);
    return call(args, options);
  };
  const results = await Promise.allSettled(["two", "three"].map((name) => manager.send({ name, task: "work" })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(prompted.length, 1);
});

test("failed-start workspaces remain discoverable and closable after reload", async (t) => {
  const { manager, config, calls, workspaces } = await setup(t);
  const call = manager.call;
  manager.call = async (args, options) => {
    if (args[0] === "agent" && args[1] === "start") throw new Error("readiness timeout");
    return call(args, options);
  };
  await assert.rejects(manager.run({ action: "start", name: "scout" }), /close it explicitly/);
  const reloaded = new HerdrWorkers({ config, session: manager.session, cwd: manager.cwd, call: manager.call });
  assert.deepEqual((await reloaded.run({ action: "list" })).agents, [{ name: "scout", workspace_id: "w1", agent_status: "unregistered" }]);
  assert.equal((await reloaded.run({ action: "read", name: "scout" })).output, "worker reply");
  await assert.rejects(reloaded.run({ action: "start", name: "scout" }), /already exists/);
  await assert.rejects(reloaded.run({ action: "send", name: "scout", task: "work" }), /unregistered/);
  await reloaded.run({ action: "interrupt", name: "scout" });
  assert.equal(calls.find(({ args }) => args.join(" ") === "pane send-keys w1:p1 esc").options.text, true);
  await reloaded.run({ action: "close", name: "scout" });
  assert.deepEqual(workspaces, []);
  assert.deepEqual((await reloaded.run({ action: "list" })).agents, []);
});

test("an uncertain start never automatically closes an agent that registered late", async (t) => {
  const { manager, agents, workspaces, calls } = await setup(t);
  const call = manager.call;
  manager.call = async (args, options) => {
    const result = await call(args, options);
    if (args[0] === "agent" && args[1] === "start") throw new Error("response lost");
    return result;
  };
  await assert.rejects(manager.run({ action: "start", name: "scout" }), /response lost/);
  agents[0].agent_status = "working";
  assert.equal((await manager.run({ action: "list" })).agents[0].agent_status, "working");
  await assert.rejects(manager.run({ action: "close", name: "scout" }), /active or blocked/);
  assert.equal(workspaces.length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "close").length, 0);
});

test("guardrails catch common creation mistakes and leave ordinary shell available", () => {
  for (const command of ['herdr pane split --current', 'herdr --session visible agent start alpha --kind pi --pane w1:p2', 'herdr tab create', 'pi --mode rpc', 'pi --mode=rpc', 'pi -p "work"']) assert.equal(orchestrationGuard(command), true, command);
  for (const command of ['git status', 'npm test', 'python3 compute.py', 'herdr agent list', 'herdr pane read w1:p1', 'echo "herdr pane split"', 'cat >> result.md << END\n- Blocked: herdr pane split\nEND']) assert.equal(orchestrationGuard(command), false, command);
});

test("guardrails ignore heredoc documentation while checking commands outside it", () => {
  for (const command of [
    "cat > /tmp/example.md <<'EOF'\nherdr pane split --current\nEOF",
    'cat <<"END HERE"\npi --mode rpc\nEND HERE',
    "cat <<-EOF\n\therdr pane split\n\tEOF",
    "cat <<\\EOF\nherdr pane split\nEOF",
    "cat <<A <<'B'\nherdr pane split\nA\npi --mode rpc\nB",
  ]) {
    assert.equal(orchestrationGuard(command), false, command);
    assert.equal(orchestrationGuard(`${command}\nherdr pane split --current`), true, command);
  }
  assert.equal(orchestrationGuard("herdr pane split <<EOF\ntext\nEOF"), true);
  assert.equal(orchestrationGuard("cat <<< text\nherdr pane split"), true);
});

test("coordinator injects guidance on every turn, reconnects on resume and supports operator override", async (t) => {
  const { configPath, fixture } = await setup(t);
  const events = new Map();
  const commands = new Map();
  const tools = [];
  const pi = { on: (name, fn) => events.set(name, fn), registerCommand: (name, cmd) => commands.set(name, cmd), registerTool: (tool) => tools.push(tool) };
  const managers = [];
  coordinator(pi, { configPath, environment: { HERDR_ENV: "1", HERDR_SESSION: "primary" }, createWorkers: (options) => { managers.push(options); return options; } });
  const ctx = { mode: "tui", cwd: fixture.workspace, sessionManager: { getSessionId: () => "persistent" }, ui: { setStatus() {}, notify() {} } };
  await events.get("session_start")({ reason: "startup" }, ctx);
  const first = events.get("before_agent_start")({ systemPrompt: "Original" }, ctx).systemPrompt;
  assert.ok(first.startsWith("Original"));
  assert.match(first, /workers tool/);
  const catalog = JSON.parse(first.split("Configured catalog: ")[1]);
  assert.equal(catalog.models["model-c"].id, "research/model-c");
  assert.equal(catalog.kinds.review.model, "model-c");
  assert.equal(events.get("before_agent_start")({ systemPrompt: "Original" }, ctx).systemPrompt, first);
  await events.get("session_start")({ reason: "resume" }, ctx);
  assert.equal(managers[0].session, managers[1].session);
  const call = { toolName: "bash", input: { command: "herdr pane split" } };
  assert.equal(events.get("tool_call")(call, ctx).block, true);
  await commands.get("deck-guardrails").handler("off", ctx);
  assert.equal(events.get("tool_call")(call, ctx), undefined);
  assert.equal(events.get("before_agent_start")({ systemPrompt: "Original" }, ctx).systemPrompt, first);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "workers");
  let registrations = 0;
  coordinator({ on() { registrations++; } }, { environment: { HERDR_ENV: "1", CYBERDECK_WORKER: "1" } });
  assert.equal(registrations, 0);
  assert.match(await readFile(new URL("../pi/coordinator.md", import.meta.url), "utf8"), /not a sandbox/);
});

test("a stopped worker server gives a recovery instruction without replaying prompts", async (t) => {
  const { manager } = await setup(t);
  await manager.list();
  manager.call = async () => { throw new Error("socket not found"); };
  await assert.rejects(manager.list(), /Run \/reload.*No worker prompt was retried/);
});
