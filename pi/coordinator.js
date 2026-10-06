import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, publicCatalog } from "../src/config.mjs";
import { HerdrWorkers, orchestrationGuard, workerSession } from "../src/herdr-workers.mjs";

const instructions = await readFile(new URL("./coordinator.md", import.meta.url), "utf8");

export function coordinator(pi, { configPath = process.env.CYBERDECK_CONFIG || path.join(os.homedir(), ".cyberdeck", "cyberdeck.config.json"), environment = process.env, createWorkers = (options) => new HerdrWorkers(options) } = {}) {
  if (environment.HERDR_ENV !== "1" || environment.CYBERDECK_WORKER === "1") return;
  let manager;
  let catalog;
  let guarded = true;
  let failure;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    manager = undefined;
    failure = undefined;
    try {
      const config = await loadConfig(configPath);
      const session = workerSession(environment.HERDR_SESSION || "default", ctx.sessionManager.getSessionId());
      manager = createWorkers({ config, session, cwd: ctx.cwd, environment });
      catalog = publicCatalog(config);
      ctx.ui.setStatus("cyberdeck", `deck · ${session}`);
    } catch (error) {
      failure = error.message;
      ctx.ui.notify(`Cyberdeck workers unavailable: ${failure}`, "error");
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}\n${manager ? `Worker session: ${manager.session}\nConfigured catalog: ${JSON.stringify(catalog)}` : `Workers unavailable: ${failure}. Report the setup error; do not improvise another worker mechanism.`}` };
  });
  pi.on("tool_call", (event, ctx) => {
    if (ctx.mode === "tui" && guarded && event.toolName === "bash" && orchestrationGuard(event.input.command)) {
      return { block: true, reason: "Use the workers tool for subagents; it keeps them in your background session. Ordinary bash remains available. For intentional manual terminal setup, the operator can run /deck-guardrails off." };
    }
  });
  pi.registerCommand("deck-guardrails", {
    description: "Toggle orchestration mistake checks: on or off",
    handler: async (args, ctx) => {
      if (!["on", "off"].includes(args.trim())) { ctx.ui.notify("Use /deck-guardrails on or off.", "warning"); return; }
      guarded = args.trim() === "on";
      ctx.ui.notify(`Cyberdeck orchestration guardrails ${guarded ? "on" : "off"}.`, "info");
    },
  });
  pi.registerTool({
    name: "workers", label: "Workers",
    description: "Manage your persistent background Pi workers: start, send, read, list, interrupt, close. Send waits for completion; send to different workers concurrently.",
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["start", "send", "read", "list", "interrupt", "close"] },
        name: { type: "string", description: "Unique worker name; reused for follow-ups." },
        task: { type: "string" },
        profile: { type: "string", enum: ["research", "implementation"], description: "Start: research for read-only work; implementation for edits or shell work." },
        kind: { type: "string", description: "Start: optional preset from the configured catalog; sets the default model, not the profile." },
        model: { type: "string", description: "Start: catalog model chosen by tier and strengths; omit for the kind's or default model." },
        thinking: { type: "string", description: "Start: one of the model's thinking levels; omit for its default." },
        implemented_by: { type: "string", description: "Start: family that produced the work under review; a model of that family is rejected." },
        working_directory: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1 },
      }, required: ["action"], additionalProperties: false,
    },
    async execute(_id, input, signal) {
      if (!manager) throw new Error(`Cyberdeck workers unavailable: ${failure || "start an interactive Pi session inside Herdr"}.`);
      return { content: [{ type: "text", text: JSON.stringify(await manager.run(input, signal)) }] };
    },
  });
}

export default coordinator;
