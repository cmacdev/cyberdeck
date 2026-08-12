import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const PROFILE_NAMES = ["research", "implementation"];
const MUTATING_BUILT_INS = new Set(["bash", "edit", "write"]);
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function fail(message) {
  throw new ConfigurationError(message);
}

function expectObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function expectKnownKeys(value, label, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} has unknown key(s): ${unknown.join(", ")}.`);
}

function expectString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function expectBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function expectInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function expectStringArray(
  value,
  label,
  { allowEmpty = false, pattern, maxItems = Infinity, maxItemLength = Infinity } = {},
) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "an array" : "a non-empty array"}.`);
  }
  if (value.length > maxItems) fail(`${label} cannot contain more than ${maxItems} items.`);
  const result = value.map((item, index) => {
    const string = expectString(item, `${label}[${index}]`);
    if (string.length > maxItemLength) {
      fail(`${label}[${index}] cannot exceed ${maxItemLength} characters.`);
    }
    if (pattern && !pattern.test(string)) fail(`${label}[${index}] has an invalid value.`);
    return string;
  });
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates.`);
  return result;
}

function expectThinking(value, label) {
  if (!THINKING_LEVELS.includes(value)) {
    fail(`${label} must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return value;
}

function resolvePath(value, configDirectory, label) {
  const configured = expectString(value, label);
  if (configured === "@cwd") return path.resolve(process.cwd());
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(configDirectory, configured);
}

async function canonicalDirectory(value, configDirectory, label) {
  const resolved = resolvePath(value, configDirectory, label);
  let information;
  try {
    information = await stat(resolved);
  } catch (error) {
    fail(`${label} does not exist: ${resolved} (${error.message})`);
  }
  if (!information.isDirectory()) fail(`${label} is not a directory: ${resolved}`);
  const canonical = await realpath(resolved);
  const home = await realpath(os.homedir());
  if (canonical === path.parse(canonical).root || canonical === home) {
    fail(
      `${label} must not be the filesystem root or the home directory (${canonical}); start the MCP client inside a project, or set explicit workspaceRoots.`,
    );
  }
  return canonical;
}

function parseProfile(raw, name) {
  const profile = expectObject(raw, `profiles.${name}`);
  expectKnownKeys(
    profile,
    `profiles.${name}`,
    new Set(["modelPatterns", "defaultThinking", "maxThinking", "tools", "promptPreamble"]),
  );
  const modelPatterns = expectStringArray(
    profile.modelPatterns,
    `profiles.${name}.modelPatterns`,
    { maxItems: 32, maxItemLength: 200 },
  );
  const defaultThinking = expectThinking(
    profile.defaultThinking,
    `profiles.${name}.defaultThinking`,
  );
  const maxThinking = expectThinking(profile.maxThinking, `profiles.${name}.maxThinking`);
  if (THINKING_LEVELS.indexOf(defaultThinking) > THINKING_LEVELS.indexOf(maxThinking)) {
    fail(`profiles.${name}.defaultThinking cannot exceed maxThinking.`);
  }
  const tools = expectStringArray(profile.tools, `profiles.${name}.tools`, {
    pattern: TOOL_NAME,
    maxItems: 64,
    maxItemLength: 128,
  });
  if (name === "research") {
    const forbidden = tools.filter((tool) => MUTATING_BUILT_INS.has(tool));
    if (forbidden.length > 0) {
      fail(`profiles.research.tools cannot include mutating Pi tools: ${forbidden.join(", ")}.`);
    }
  }
  const promptPreamble = expectString(
    profile.promptPreamble,
    `profiles.${name}.promptPreamble`,
    { allowEmpty: true },
  );
  if (promptPreamble.length > 4000) {
    fail(`profiles.${name}.promptPreamble cannot exceed 4000 characters.`);
  }
  return { modelPatterns, defaultThinking, maxThinking, tools, promptPreamble };
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  } catch (error) {
    fail(`Cannot read configuration ${absoluteConfigPath}: ${error.message}`);
  }

  const raw = expectObject(parsed, "configuration");
  expectKnownKeys(
    raw,
    "configuration",
    new Set([
      "$schema",
      "provider",
      "workspaceRoots",
      "artifactDirectory",
      "pi",
      "limits",
      "profiles",
    ]),
  );
  if (raw.provider !== "openrouter") {
    fail('provider must be exactly "openrouter".');
  }
  const configDirectory = path.dirname(absoluteConfigPath);
  const workspaceRootValues = expectStringArray(raw.workspaceRoots, "workspaceRoots", {
    maxItems: 32,
    maxItemLength: 4096,
  });
  const workspaceRoots = [];
  for (let index = 0; index < workspaceRootValues.length; index += 1) {
    workspaceRoots.push(
      await canonicalDirectory(
        workspaceRootValues[index],
        configDirectory,
        `workspaceRoots[${index}]`,
      ),
    );
  }

  const piRaw = expectObject(raw.pi, "pi");
  expectKnownKeys(
    piRaw,
    "pi",
    new Set([
      "command",
      "arguments",
      "stateDirectory",
      "trustProjectFiles",
      "loadContextFiles",
    ]),
  );
  const pi = {
    command: expectString(piRaw.command, "pi.command"),
    arguments: expectStringArray(piRaw.arguments, "pi.arguments", {
      allowEmpty: true,
      maxItems: 32,
      maxItemLength: 4096,
    }),
    stateDirectory:
      piRaw.stateDirectory === null
        ? null
        : resolvePath(piRaw.stateDirectory, configDirectory, "pi.stateDirectory"),
    trustProjectFiles: expectBoolean(piRaw.trustProjectFiles, "pi.trustProjectFiles"),
    loadContextFiles: expectBoolean(piRaw.loadContextFiles, "pi.loadContextFiles"),
  };

  const limitsRaw = expectObject(raw.limits, "limits");
  expectKnownKeys(
    limitsRaw,
    "limits",
    new Set([
      "maxConcurrentRuns",
      "defaultTimeoutSeconds",
      "maxTimeoutSeconds",
      "defaultReturnCharacters",
      "maxReturnCharacters",
      "maxArtifactBytes",
      "maxTaskCharacters",
      "maxContextFiles",
    ]),
  );
  const limits = {
    maxConcurrentRuns: expectInteger(
      limitsRaw.maxConcurrentRuns,
      "limits.maxConcurrentRuns",
      1,
    ),
    defaultTimeoutSeconds: expectInteger(
      limitsRaw.defaultTimeoutSeconds,
      "limits.defaultTimeoutSeconds",
      1,
    ),
    maxTimeoutSeconds: expectInteger(
      limitsRaw.maxTimeoutSeconds,
      "limits.maxTimeoutSeconds",
      1,
    ),
    defaultReturnCharacters: expectInteger(
      limitsRaw.defaultReturnCharacters,
      "limits.defaultReturnCharacters",
      1,
    ),
    maxReturnCharacters: expectInteger(
      limitsRaw.maxReturnCharacters,
      "limits.maxReturnCharacters",
      1,
    ),
    maxArtifactBytes: expectInteger(
      limitsRaw.maxArtifactBytes,
      "limits.maxArtifactBytes",
      1024,
    ),
    maxTaskCharacters: expectInteger(
      limitsRaw.maxTaskCharacters,
      "limits.maxTaskCharacters",
      1,
    ),
    maxContextFiles: expectInteger(
      limitsRaw.maxContextFiles,
      "limits.maxContextFiles",
      0,
    ),
  };
  if (limits.maxConcurrentRuns > 32) fail("limits.maxConcurrentRuns cannot exceed 32.");
  if (limits.defaultTimeoutSeconds > limits.maxTimeoutSeconds) {
    fail("limits.defaultTimeoutSeconds cannot exceed maxTimeoutSeconds.");
  }
  if (limits.defaultReturnCharacters > limits.maxReturnCharacters) {
    fail("limits.defaultReturnCharacters cannot exceed maxReturnCharacters.");
  }
  if (limits.maxContextFiles > 100) fail("limits.maxContextFiles cannot exceed 100.");

  const profilesRaw = expectObject(raw.profiles, "profiles");
  expectKnownKeys(profilesRaw, "profiles", new Set(PROFILE_NAMES));
  const profiles = Object.fromEntries(
    PROFILE_NAMES.map((name) => [name, parseProfile(profilesRaw[name], name)]),
  );

  return {
    configPath: absoluteConfigPath,
    configDirectory,
    provider: "openrouter",
    workspaceRoots: [...new Set(workspaceRoots)],
    artifactDirectory: resolvePath(
      raw.artifactDirectory,
      configDirectory,
      "artifactDirectory",
    ),
    pi,
    limits,
    profiles,
  };
}

export function matchesModelPattern(model, patterns) {
  return patterns.some((pattern) => {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(model);
  });
}

export function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function publicConfiguration(config) {
  return {
    provider: config.provider,
    configPath: config.configPath,
    workspaceRoots: config.workspaceRoots,
    artifactDirectory: config.artifactDirectory,
    pi: {
      command: config.pi.command,
      arguments: config.pi.arguments,
      stateDirectory: config.pi.stateDirectory,
      trustProjectFiles: config.pi.trustProjectFiles,
      loadContextFiles: config.pi.loadContextFiles,
    },
    limits: config.limits,
    profiles: {
      research: {
        permission: "read-only tool policy",
        ...config.profiles.research,
      },
      implementation: {
        permission: "write/shell-capable tool policy",
        ...config.profiles.implementation,
      },
    },
    securityBoundary:
      "Cyberdeck validates roots and Pi tool names, but Pi has no built-in OS sandbox. Run it in an OS/container sandbox for a hard filesystem or network boundary.",
  };
}
