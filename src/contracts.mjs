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
export const CATALOG_RESOURCE_URI = "cyberdeck://catalog";

// Fixed input bounds shared by the JSON Schema and the validator.
export const MAX_PATH_CHARACTERS = 4096;
export const MAX_MODEL_CHARACTERS = 200;
export const MAX_CONSTRAINTS = 20;
export const MAX_CONSTRAINT_CHARACTERS = 500;

function roleLines(profile) {
  return Object.entries(profile.roles).map(
    ([name, role]) => `${name} (${role.model}): ${role.when}`,
  );
}

export function buildServerInstructions(config) {
  const research = config.profiles.research;
  const implementation = config.profiles.implementation;
  return [
    "Stay in the calling harness. Delegate through these two tools; do not spawn Pi yourself.",
    `research is read-only. Default role ${research.defaultRole}. Roles: ${roleLines(research).join(" | ")}`,
    `implement may write or run shell. Default role ${implementation.defaultRole}. Roles: ${roleLines(implementation).join(" | ")}`,
    "Omit model to use the role default. Override model only when the task needs a listed OpenRouter ID. Results are capped; read cyberdeck://catalog for the role table.",
  ].join(" ");
}

function allowedModels(profile) {
  return [
    ...new Set([
      ...Object.values(profile.roles).map((role) => role.model),
      ...profile.modelPatterns.filter((pattern) => !pattern.includes("*")),
    ]),
  ];
}

function modelProperty(profile) {
  const hasWildcard = profile.modelPatterns.some((pattern) => pattern.includes("*"));
  const listed = allowedModels(profile);
  return {
    type: "string",
    minLength: 1,
    maxLength: MAX_MODEL_CHARACTERS,
    ...(hasWildcard || listed.length === 0 ? {} : { enum: listed }),
    description:
      "Optional OpenRouter model ID. Omit to use the selected role's model. Must match this profile's modelPatterns.",
  };
}

function roleProperty(profile) {
  return {
    type: "string",
    enum: Object.keys(profile.roles),
    default: profile.defaultRole,
    description: `Preset agent for this tool. ${roleLines(profile).join(" ")}`,
  };
}

// The enum shows the profile ceiling; the selected role's own ceiling is
// enforced server-side and stated in the description.
function thinkingProperty(profile) {
  return {
    type: "string",
    enum: THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(profile.maxThinking) + 1),
    description: "Pi reasoning level, capped by the selected role. Omit to use the role default.",
  };
}

function inputSchema(config, profileName) {
  const profile = config.profiles[profileName];
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
      role: roleProperty(profile),
      model: modelProperty(profile),
      thinking: thinkingProperty(profile),
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
    "role",
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
    role: { type: ["string", "null"] },
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
  const research = config.profiles.research;
  const implementation = config.profiles.implementation;
  return [
    {
      name: "research",
      title: "Delegate read-only research",
      description: `Read-only Pi/OpenRouter agent. Cannot receive bash/edit/write. Pick a role or accept default ${research.defaultRole}. ${roleLines(research).join(" ")}`,
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
      description: `Write/shell-capable Pi/OpenRouter coding agent. Use only when workspace changes are authorized. Pick a role or accept default ${implementation.defaultRole}. ${roleLines(implementation).join(" ")}`,
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
