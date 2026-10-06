import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { validateInput } from "./pi-runner.mjs";

const execute = promisify(execFile);

export function workerSession(parent, sessionId) {
  return `deck-${createHash("sha256").update(`${parent}\0${sessionId}`).digest("hex").slice(0, 24)}`;
}

export function herdrEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("HERDR_") || key === "HERDR_CONFIG_PATH"));
}

export class HerdrWorkers {
  constructor({ config, session, cwd, environment = process.env, call, launch }) {
    this.config = config;
    this.session = session;
    this.cwd = cwd;
    this.environment = herdrEnvironment(environment);
    this.binary = environment.HERDR_BIN_PATH || "herdr";
    this.directory = path.join(config.artifactDirectory, "workers", session);
    this.agentDirectory = config.pi.stateDirectory || environment.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    this.call = call || this.command.bind(this);
    this.launch = launch || this.launchServer.bind(this);
    this.pending = new Set();
    this.creation = Promise.resolve();
  }

  async command(args, { signal, timeout = 30000, text = false } = {}) {
    let stdout;
    try {
      ({ stdout } = await execute(this.binary, ["--session", this.session, ...args], {
        cwd: this.cwd, env: this.environment, signal, timeout,
        maxBuffer: this.config.limits.maxArtifactBytes,
      }));
    } catch (error) {
      throw new Error((error.stdout || error.stderr || error.message).trim());
    }
    if (text) return stdout;
    const response = JSON.parse(stdout);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  async launchServer() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const log = await open(path.join(this.directory, "herdr.log"), "a", 0o600);
    try {
      const child = spawn(this.binary, ["--session", this.session, "server"], {
        cwd: this.cwd, env: this.environment, detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await this.call(["workspace", "list"], { timeout: 1000 }); return; } catch { await delay(100); }
    }
    throw new Error(`Herdr did not start. Inspect ${path.join(this.directory, "herdr.log")}.`);
  }

  async ensureServer() {
    if (!this.ready) {
      this.ready = this.call(["workspace", "list"]).catch(() => this.launch());
      this.ready.catch(() => { this.ready = undefined; });
    }
    await this.ready;
  }

  async list() {
    await this.ensureServer();
    try {
      const { agents } = await this.call(["agent", "list"]);
      const { workspaces } = await this.call(["workspace", "list"]);
      const unregistered = workspaces.filter((workspace) => /^[a-z][a-z0-9_-]{0,31}$/.test(workspace.label) && !agents.some((agent) => agent.workspace_id === workspace.workspace_id));
      return [...agents, ...unregistered.map((workspace) => ({ name: workspace.label, workspace_id: workspace.workspace_id, agent_status: "unregistered" }))];
    } catch (error) {
      throw new Error(`Cannot read worker session ${this.session}: ${error.message}. Run /reload to reconnect or restart its server. No worker prompt was retried.`);
    }
  }

  async agent(name, agents) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name || "")) throw new Error("Use a worker name, not a pane ID.");
    const agent = (agents || await this.list()).find((item) => item.name === name);
    if (!agent) throw new Error(`Worker ${name} is not in this coordinator's session. Use list.`);
    return agent;
  }

  async pane(agent) {
    if (agent.pane_id) return agent.pane_id;
    const { panes } = await this.call(["pane", "list", "--workspace", agent.workspace_id]);
    if (panes.length !== 1) throw new Error(`Inspect worker ${agent.name} by attaching to ${this.session}; its workspace no longer has exactly one pane.`);
    return panes[0].pane_id;
  }

  start(input, signal) {
    const operation = this.creation.then(() => this.startWorker(input, signal));
    this.creation = operation.catch(() => {});
    return operation;
  }

  async startWorker(input, signal) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name || "")) throw new Error("Use a unique lowercase worker name (1–32 characters).");
    if (path.basename(this.config.pi.command) !== "pi") throw new Error("Herdr launches Pi by name. Set pi.command to the Pi executable named pi in the Cyberdeck configuration.");
    const profile = input.profile || "research";
    if (!this.config.profiles[profile]) throw new Error("profile must be research or implementation.");
    const resolved = await validateInput(profile, {
      task: "Start an interactive worker.", working_directory: input.working_directory || this.cwd,
      kind: input.kind, model: input.model, thinking: input.thinking, implemented_by: input.implemented_by,
    }, this.config);
    const extension = path.join(this.agentDirectory, "extensions", "herdr-agent-state.ts");
    await access(extension);
    if ((await this.list()).some((item) => item.name === input.name)) throw new Error(`Worker ${input.name} already exists. Read it before sending a follow-up or closing it.`);
    const created = await this.call(["workspace", "create", "--cwd", resolved.workingDirectory, "--label", input.name,
      "--env", "CYBERDECK_WORKER=1", "--env", "PI_OFFLINE=1", "--env", "PI_TELEMETRY=0",
      "--env", `PI_CODING_AGENT_DIR=${this.agentDirectory}`,
      "--env", `PATH=${path.dirname(this.config.pi.command)}:${this.environment.PATH}`, "--no-focus"], { signal });
    const pane = created.root_pane.pane_id;
    const args = [...this.config.pi.arguments, "--provider", this.config.provider,
      "--model", resolved.model, "--thinking", resolved.thinking,
      "--tools", this.config.profiles[profile].tools.join(","),
      "--extension", extension, "--offline", "--name", input.name,
      "--session-dir", path.join(this.directory, "sessions", input.name),
      this.config.pi.trustProjectFiles ? "--approve" : "--no-approve"];
    if (!this.config.pi.loadContextFiles) args.push("--no-context-files");
    if (resolved.promptPreamble) args.push("--append-system-prompt", resolved.promptPreamble);
    try {
      const result = await this.call(["agent", "start", input.name, "--kind", "pi", "--pane", pane, "--", ...args], { signal, timeout: 35000 });
      return { session: this.session, agent: result.agent, profile, kind: resolved.kind, model: resolved.model };
    } catch (error) {
      throw new Error(`${error.message}\nStart may have reached pane ${pane} in ${this.session}. Use workers list/read to inspect ${input.name}; close it explicitly if abandoning the start. Do not blindly retry.`);
    }
  }

  async read(name, signal) {
    const agent = await this.agent(name);
    const target = agent.agent_status === "unregistered" ? ["pane", "read", await this.pane(agent)] : ["agent", "read", name];
    const output = await this.call([...target, "--source", "recent-unwrapped", "--lines", "120"], { signal, text: true });
    return { agent, output: output.slice(-this.config.limits.maxReturnCharacters), truncated: output.length > this.config.limits.maxReturnCharacters };
  }

  async send(input, signal) {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > this.config.limits.maxTaskCharacters) throw new Error("Supply a nonempty task within limits.maxTaskCharacters.");
    if (this.pending.has(input.name)) throw new Error(`A prompt is already pending for ${input.name}. Read before sending again.`);
    if (this.pending.size >= this.config.limits.maxConcurrentRuns) throw new Error("The configured concurrent run limit is reached. Read current workers before submitting more work.");
    this.pending.add(input.name);
    try {
      const agents = await this.list();
      const agent = await this.agent(input.name, agents);
      if (!["idle", "done"].includes(agent.agent_status)) throw new Error(`Worker ${input.name} is ${agent.agent_status}. Read it before sending; interrupt explicitly if needed.`);
      const active = new Set([...this.pending, ...agents.filter((item) => !["idle", "done", "unregistered"].includes(item.agent_status)).map((item) => item.name)]);
      if (active.size > this.config.limits.maxConcurrentRuns) throw new Error("The configured concurrent run limit is reached. Read current workers before submitting more work.");
      const timeout = input.timeout_seconds ?? this.config.limits.defaultTimeoutSeconds;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > this.config.limits.maxTimeoutSeconds) throw new Error("timeout_seconds exceeds the configured limit.");
      try {
        await this.call(["agent", "prompt", input.name, input.task, "--wait", "--timeout", String(timeout * 1000)], { signal, timeout: timeout * 1000 + 2000 });
      } catch (error) {
        throw new Error(`${error.message}\nThe worker may still be running. Use read before retrying; this prompt was not resent.`);
      }
      return await this.read(input.name, signal);
    } finally {
      this.pending.delete(input.name);
    }
  }

  async run(input, signal) {
    if (input.action === "start") return this.start(input, signal);
    if (input.action === "list") return { session: this.session, agents: await this.list() };
    if (input.action === "read") return this.read(input.name, signal);
    if (input.action === "send") return this.send(input, signal);
    const agent = await this.agent(input.name);
    if (input.action === "interrupt") {
      await this.call(["pane", "send-keys", await this.pane(agent), "esc"], { signal, text: true });
      return { sent: true };
    }
    if (input.action === "close") {
      if (this.pending.has(input.name) || !["idle", "done", "unregistered"].includes(agent.agent_status)) throw new Error("Worker is active or blocked. Read it and interrupt explicitly before closing.");
      return this.call(["workspace", "close", agent.workspace_id], { signal });
    }
    throw new Error("Unknown worker action.");
  }
}

export function orchestrationGuard(command) {
  const heredocs = [];
  const executable = String(command).split("\n").map((line) => {
    if (heredocs.length) {
      const { delimiter, tabs } = heredocs[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) heredocs.shift();
      return "";
    }
    for (const match of line.matchAll(/(?<!<)<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/g)) {
      heredocs.push({ delimiter: match[2] || match[3] || match[4], tabs: match[1] === "-" });
    }
    return line;
  }).join("\n");
  const invocations = executable.matchAll(/(?:^|[\n;&|]|\$\()\s*(?:(?:command|exec)\s+)?(?:[^\s;"']*\/)?(herdr|pi)\b([^\n;&|]*)/g);
  return [...invocations].some(([, binary, args]) => binary === "herdr"
    ? /\b(?:pane\s+split|(?:tab|workspace)\s+create|agent\s+start)\b/.test(args)
    : /(?:^|\s)(?:--mode[=\s]+(?:rpc|json)\b|--print\b|-p\b)/.test(args));
}
