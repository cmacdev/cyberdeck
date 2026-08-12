import { THINKING_LEVELS } from "./config.mjs";

export const SERVER_INFO = Object.freeze({ name: "cyberdeck", version: "0.1.0" });
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
export const PROFILE_RESOURCE_URI = "cyberdeck://profiles";

export const SERVER_INSTRUCTIONS =
  "Use research for delegated read-only investigation. Use implement only when workspace changes are authorized. Model IDs are explicit and checked against visible profile policy. Results are capped; full Pi event logs are saved as local artifacts. Read cyberdeck://profiles for resolved policy.";

function modelProperty(profile) {
  const exactModels = profile.modelPatterns.filter((pattern) => !pattern.includes("*"));
  const hasWildcard = profile.modelPatterns.some((pattern) => pattern.includes("*"));
  return {
    type: "string",
    minLength: 1,
    ...(hasWildcard ? {} : { enum: exactModels }),
    description: "Exact OpenRouter model ID allowed by this profile's visible configuration.",
  };
}

function inputSchema(config, profileName) {
  const profile = config.profiles[profileName];
  const limits = config.limits;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["task", "working_directory", "model"],
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
        description: "Existing absolute directory inside a configured workspace root.",
      },
      model: modelProperty(profile),
      thinking: {
        type: "string",
        enum: THINKING_LEVELS.slice(
          0,
          THINKING_LEVELS.indexOf(profile.maxThinking) + 1,
        ),
        default: profile.defaultThinking,
        description: "Pi reasoning level, capped by this profile.",
      },
      context_files: {
        type: "array",
        maxItems: limits.maxContextFiles,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
        description: "Optional absolute files inside configured roots, passed to Pi as @file inputs.",
      },
      constraints: {
        type: "array",
        maxItems: 20,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: "Explicit task-specific boundaries forwarded to the delegated agent.",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: limits.maxTimeoutSeconds,
        default: limits.defaultTimeoutSeconds,
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
    status: {
      enum: ["succeeded", "failed", "timed_out", "cancelled", "output_limit", "rejected"],
    },
    model: { type: ["string", "null"] },
    thinking: { type: ["string", "null"] },
    tools: { type: "array", items: { type: "string" } },
    exit_code: { type: ["integer", "null"] },
    duration_ms: { type: "integer", minimum: 0 },
    final_output: { type: "string" },
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
      description:
        "Run an ephemeral Pi/OpenRouter agent under the server's read-only tool policy. Use for investigation, review, comparison, or critique; it cannot receive Pi's bash/edit/write built-ins.",
      inputSchema: inputSchema(config, "research"),
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
      description:
        "Run an ephemeral Pi/OpenRouter coding agent in a validated workspace. Use only for authorized implementation because its configured policy may include shell and file-write tools.",
      inputSchema: inputSchema(config, "implementation"),
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
