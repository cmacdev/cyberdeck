import { THINKING_LEVELS } from "./config.mjs";

export const SERVER_INFO = Object.freeze({ name: "cyberdeck", version: "0.2.0" });
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
export const PROFILE_RESOURCE_URI = "cyberdeck://profiles";
export const CATALOG_RESOURCE_URI = "cyberdeck://catalog";

export const MAX_PATH_CHARACTERS = 4096;
export const MAX_CONSTRAINTS = 20;
export const MAX_CONSTRAINT_CHARACTERS = 500;

function modelLines(config) {
  return Object.entries(config.models).map(
    ([name, model]) =>
      `${name} (${model.tier}, ${model.family}; ${model.thinking.join("|")}, default ${model.defaultThinking}): ${model.strengths}`,
  );
}

function kindLine(config) {
  const kinds = Object.entries(config.kinds).map(([name, kind]) => `${name}→${kind.model}`);
  return kinds.length ? `Optional kind presets set the default model and output: ${kinds.join(", ")}.` : "";
}

export function buildServerInstructions(config) {
  return [
    "Stay in the calling harness. Delegate through these two tools; do not spawn Pi yourself.",
    "research is read-only; implement may write or run shell. Any model works with either tool.",
    "Choose model by tier and strengths; start cheap and escalate to smart after a failure or for long-horizon work.",
    kindLine(config),
    "Omit thinking to use the model default. For reviews pass implemented_by so the reviewer is a different family. Results are capped; read cyberdeck://catalog for the full catalog.",
  ]
    .filter(Boolean)
    .join(" ");
}

function inputSchema(config, modelDescription) {
  const limits = config.limits;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["task", "working_directory"],
    properties: {
      task: {
        type: "string",
        minLength: 1,
        maxLength: limits.maxTaskCharacters,
        description: "Self-contained delegated task and expected deliverable.",
      },
      working_directory: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PATH_CHARACTERS,
        description: "Existing absolute directory inside a configured workspace root.",
      },
      ...(Object.keys(config.kinds).length && {
        kind: {
          type: "string",
          enum: Object.keys(config.kinds),
          description: "Optional preset that sets the default model and output shape.",
        },
      }),
      model: {
        type: "string",
        enum: Object.keys(config.models),
        description: `Catalog model. Omit to use the kind's model, else ${config.defaultModel}. ${modelDescription}`,
      },
      thinking: {
        type: "string",
        enum: THINKING_LEVELS.filter((level) =>
          Object.values(config.models).some((model) => model.thinking.includes(level)),
        ),
        description: "Pi reasoning level; must be one the model lists. Omit to use the model default.",
      },
      implemented_by: {
        type: "string",
        enum: [...new Set(Object.values(config.models).map((model) => model.family))],
        description: "Family that produced the work under review; a model of that family is rejected.",
      },
      context_files: {
        type: "array",
        maxItems: limits.maxContextFiles,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: MAX_PATH_CHARACTERS },
        description: "Optional absolute files inside configured roots, passed to Pi as @file inputs.",
      },
      constraints: {
        type: "array",
        maxItems: MAX_CONSTRAINTS,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: MAX_CONSTRAINT_CHARACTERS },
        description: "Explicit task-specific boundaries forwarded to the delegated agent.",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: limits.maxTimeoutSeconds,
        default: limits.defaultTimeoutSeconds,
        description: "Wall-clock limit for the Pi run.",
      },
      return_characters: {
        type: "integer",
        minimum: 1,
        maximum: limits.maxReturnCharacters,
        default: limits.defaultReturnCharacters,
        description: "Maximum final-answer characters returned to MCP context; artifacts remain complete.",
      },
    },
  };
}

export const OUTPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "ok",
    "run_id",
    "profile",
    "kind",
    "status",
    "model",
    "thinking",
    "tools",
    "exit_code",
    "duration_ms",
    "final_output",
    "output_truncated",
    "usage",
    "artifacts",
    "error",
  ],
  properties: {
    ok: { type: "boolean" },
    run_id: { type: ["string", "null"] },
    profile: { enum: ["research", "implementation"] },
    kind: { type: ["string", "null"] },
    status: {
      enum: ["succeeded", "failed", "timed_out", "cancelled", "output_limit", "rejected"],
    },
    model: { type: ["string", "null"] },
    thinking: { type: ["string", "null"] },
    tools: { type: "array", items: { type: "string" } },
    exit_code: { type: ["integer", "null"] },
    duration_ms: { type: "integer", minimum: 0 },
    final_output: {
      type: "string",
      description: "Assistant's final text; empty when none. Never stderr.",
    },
    output_truncated: { type: "boolean" },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["input", "output", "cache_read", "cache_write", "cost", "turns"],
      properties: {
        input: { type: "number" },
        output: { type: "number" },
        cache_read: { type: "number" },
        cache_write: { type: "number" },
        cost: { type: "number" },
        turns: { type: "integer", minimum: 0 },
      },
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: ["directory", "events", "stderr", "request", "result"],
      properties: {
        directory: { type: ["string", "null"] },
        events: { type: ["string", "null"] },
        stderr: { type: ["string", "null"] },
        request: { type: ["string", "null"] },
        result: { type: ["string", "null"] },
      },
    },
    error: { type: ["string", "null"] },
  },
});

export function buildTools(config) {
  return [
    {
      name: "research",
      title: "Delegate read-only research",
      description: "Read-only Pi agent. Cannot receive bash/edit/write. Choose model by tier and strengths.",
      inputSchema: inputSchema(config, modelLines(config).join(" ")),
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: "implement",
      title: "Delegate implementation",
      description: "Write/shell-capable Pi coding agent. Use only when workspace changes are authorized. Choose model by tier and strengths.",
      inputSchema: inputSchema(config, "Same catalog as the research tool's model list."),
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

export function emptyArtifacts() {
  return {
    directory: null,
    events: null,
    stderr: null,
    request: null,
    result: null,
  };
}

export function emptyUsage() {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, turns: 0 };
}
