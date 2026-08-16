import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import {
  THINKING_LEVELS,
  isWithinRoot,
  matchesModelPattern,
} from "./config.mjs";
import {
  MAX_CONSTRAINTS,
  MAX_CONSTRAINT_CHARACTERS,
  MAX_MODEL_CHARACTERS,
  MAX_PATH_CHARACTERS,
  emptyUsage,
} from "./contracts.mjs";

const INPUT_KEYS = new Set([
  "task",
  "working_directory",
  "role",
  "model",
  "thinking",
  "context_files",
  "constraints",
  "timeout_seconds",
  "return_characters",
]);
const SIGKILL_GRACE_MS = 2000;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function inputFail(message) {
  throw new InputError(message);
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    inputFail("Tool arguments must be an object.");
  }
  const unknown = Object.keys(value).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) inputFail(`Unknown argument(s): ${unknown.join(", ")}.`);
  return value;
}

function requiredString(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0) {
    inputFail(`${label} must be a non-empty string.`);
  }
  if (maximum !== undefined && value.length > maximum) {
    inputFail(`${label} cannot exceed ${maximum} characters.`);
  }
  return value;
}

function optionalInteger(value, label, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    inputFail(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function stringArray(value, label, maximum, itemMaximum) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    inputFail(`${label} must be an array with at most ${maximum} items.`);
  }
  const result = value.map((item, index) =>
    requiredString(item, `${label}[${index}]`, itemMaximum),
  );
  if (new Set(result).size !== result.length) inputFail(`${label} must not contain duplicates.`);
  return result;
}

async function canonicalExistingDirectory(value, config) {
  if (!path.isAbsolute(value)) inputFail("working_directory must be an absolute path.");
  let information;
  let canonical;
  try {
    information = await stat(value);
    canonical = await realpath(value);
  } catch (error) {
    inputFail(`working_directory does not exist: ${value} (${error.message})`);
  }
  if (!information.isDirectory()) inputFail(`working_directory is not a directory: ${value}`);
  if (!config.workspaceRoots.some((root) => isWithinRoot(canonical, root))) {
    inputFail(`working_directory is outside configured workspace roots: ${canonical}`);
  }
  return canonical;
}

async function canonicalContextFiles(values, config) {
  const result = [];
  for (const value of values) {
    if (!path.isAbsolute(value)) inputFail(`context_files entries must be absolute: ${value}`);
    let information;
    let canonical;
    try {
      information = await stat(value);
      canonical = await realpath(value);
    } catch (error) {
      inputFail(`context file does not exist: ${value} (${error.message})`);
    }
    if (!information.isFile()) inputFail(`context file is not a regular file: ${value}`);
    if (!config.workspaceRoots.some((root) => isWithinRoot(canonical, root))) {
      inputFail(`context file is outside configured workspace roots: ${canonical}`);
    }
    result.push(canonical);
  }
  if (new Set(result).size !== result.length) {
    inputFail("context_files resolves to duplicate files.");
  }
  return result;
}

async function validateInput(profileName, rawInput, config) {
  const input = asObject(rawInput);
  const profile = config.profiles[profileName];
  const task = requiredString(input.task, "task", config.limits.maxTaskCharacters);
  const roleName = input.role === undefined ? profile.defaultRole : requiredString(input.role, "role");
  const role = profile.roles[roleName];
  if (!role) {
    inputFail(
      `role ${JSON.stringify(roleName)} is not defined for ${profileName}; inspect cyberdeck://catalog.`,
    );
  }
  const model =
    input.model === undefined
      ? role.model
      : requiredString(input.model, "model", MAX_MODEL_CHARACTERS).trim();
  if (!matchesModelPattern(model, profile.modelPatterns)) {
    inputFail(
      `model ${JSON.stringify(model)} is not allowed by the ${profileName} profile; inspect cyberdeck://catalog.`,
    );
  }
  const thinking = input.thinking ?? role.defaultThinking;
  if (!THINKING_LEVELS.includes(thinking)) {
    inputFail(`thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  if (THINKING_LEVELS.indexOf(thinking) > THINKING_LEVELS.indexOf(role.maxThinking)) {
    inputFail(`thinking ${thinking} exceeds the ${roleName} maximum ${role.maxThinking}.`);
  }
  const contextValues = stringArray(
    input.context_files,
    "context_files",
    config.limits.maxContextFiles,
    MAX_PATH_CHARACTERS,
  );
  const constraints = stringArray(
    input.constraints,
    "constraints",
    MAX_CONSTRAINTS,
    MAX_CONSTRAINT_CHARACTERS,
  );
  return {
    task,
    role: roleName,
    model,
    thinking,
    promptPreamble: role.promptPreamble,
    constraints,
    timeoutSeconds: optionalInteger(
      input.timeout_seconds,
      "timeout_seconds",
      config.limits.defaultTimeoutSeconds,
      config.limits.maxTimeoutSeconds,
    ),
    returnCharacters: optionalInteger(
      input.return_characters,
      "return_characters",
      config.limits.defaultReturnCharacters,
      config.limits.maxReturnCharacters,
    ),
    workingDirectory: await canonicalExistingDirectory(
      requiredString(input.working_directory, "working_directory", MAX_PATH_CHARACTERS),
      config,
    ),
    contextFiles: await canonicalContextFiles(contextValues, config),
  };
}

function makePrompt(task, constraints) {
  const constraintBlock = constraints.length
    ? `\n\nConstraints supplied by the caller:\n${constraints.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `Task:\n${task}${constraintBlock}`;
}

function makeRunId() {
  return `${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z_")}${randomUUID().slice(0, 8)}`;
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function updateFromEvent(state, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== "message_end" || !event.message) return;
  const message = event.message;
  if (message.role !== "assistant") return;
  const text = extractAssistantText(message);
  if (text.length > 0) state.finalOutput = text;
  state.usage.turns += 1;
  const usage = message.usage ?? {};
  state.usage.input += numeric(usage.input);
  state.usage.output += numeric(usage.output);
  state.usage.cache_read += numeric(usage.cacheRead);
  state.usage.cache_write += numeric(usage.cacheWrite);
  state.usage.cost += numeric(
    typeof usage.cost === "object" && usage.cost !== null ? usage.cost.total : usage.cost,
  );
  if (typeof message.model === "string") state.reportedModel = message.model;
  if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
}

function truncateOutput(value, maximum) {
  if (value.length <= maximum) return { value, truncated: false };
  const suffix = "\n\n[truncated; see artifacts.events]";
  if (maximum <= suffix.length) {
    return { value: suffix.slice(0, maximum), truncated: true };
  }
  return {
    value: `${value.slice(0, maximum - suffix.length)}${suffix}`,
    truncated: true,
  };
}

function truncateError(value, maximum = 1000) {
  if (value.length <= maximum) return value;
  const suffix = "… [truncated; see stderr artifact]";
  return `${value.slice(0, maximum - suffix.length)}${suffix}`;
}

async function executePi({ args, environment, workingDirectory, paths, config, signal }) {
  const state = {
    finalOutput: "",
    usage: emptyUsage(),
    reportedModel: null,
    stopReason: null,
    errorMessage: null,
  };
  let artifactError = null;
  const recordArtifactError = (error) => {
    artifactError ??= error;
  };
  const stdoutFile = createWriteStream(paths.events, { encoding: null, mode: 0o600 });
  const stderrFile = createWriteStream(paths.stderr, { encoding: null, mode: 0o600 });
  stdoutFile.on("error", recordArtifactError);
  stderrFile.on("error", recordArtifactError);
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";
  let stderrTail = "";
  let capturedBytes = 0;
  let terminationReason = null;
  let spawnError = null;
  let child;
  let forceKillTimer;

  // Records a reason only when we actually signal a live child, so a late
  // abort or timer cannot relabel a run that already finished on its own.
  const terminate = (reason) => {
    if (terminationReason || !child || child.exitCode !== null || child.signalCode !== null) return;
    terminationReason = reason;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    forceKillTimer.unref();
  };

  const writeCapped = (stream, chunk, isStdout) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, config.limits.maxArtifactBytes - capturedBytes);
    const retained = buffer.subarray(0, remaining);
    capturedBytes += buffer.length;
    if (retained.length > 0) stream.write(retained);
    if (isStdout && retained.length > 0) {
      lineBuffer += decoder.write(retained);
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) updateFromEvent(state, line);
      }
    } else if (!isStdout && retained.length > 0) {
      stderrTail = `${stderrTail}${retained.toString("utf8")}`.slice(-4000);
    }
    if (buffer.length > remaining) terminate("output_limit");
  };

  let exitCode = null;
  if (signal?.aborted) {
    terminationReason = "cancelled";
  } else {
    try {
      child = spawn(config.pi.command, [...config.pi.arguments, ...args], {
        cwd: workingDirectory,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error;
    }
  }

  if (child) {
    child.stdout.on("data", (chunk) => writeCapped(stdoutFile, chunk, true));
    child.stderr.on("data", (chunk) => writeCapped(stderrFile, chunk, false));
    child.stdout.on("error", recordArtifactError);
    child.stderr.on("error", recordArtifactError);
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => terminate("timed_out"), config.timeoutMilliseconds);
    timeout.unref();
    const abort = () => terminate("cancelled");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const closeCode = await new Promise((resolve) => {
      child.once("close", (code) => resolve(Number.isInteger(code) ? code : null));
    });
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener("abort", abort);
    // A child that never started reports the errno as its close code.
    exitCode = child.pid === undefined ? null : closeCode;
  }

  lineBuffer += decoder.end();
  if (lineBuffer.trim()) updateFromEvent(state, lineBuffer);
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([
    finished(stdoutFile).catch(recordArtifactError),
    finished(stderrFile).catch(recordArtifactError),
  ]);

  return {
    state,
    stderrTail: stderrTail.trim(),
    exitCode,
    terminationReason,
    spawnError,
    artifactError,
    cancelReason: typeof signal?.reason === "string" ? signal.reason : null,
  };
}

// Resolves to null when the request was cancelled before anything started;
// nothing is spawned or written in that case.
export async function runPi(profileName, rawInput, config, signal) {
  const input = await validateInput(profileName, rawInput, config);
  if (signal?.aborted) return null;
  const profile = config.profiles[profileName];
  const runId = makeRunId();
  const runDirectory = path.join(config.artifactDirectory, runId);
  const paths = {
    directory: runDirectory,
    events: path.join(runDirectory, "events.jsonl"),
    stderr: path.join(runDirectory, "stderr.log"),
    request: path.join(runDirectory, "request.json"),
    result: path.join(runDirectory, "result.json"),
  };
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  if (config.pi.stateDirectory) {
    await mkdir(config.pi.stateDirectory, { recursive: true, mode: 0o700 });
  }

  const prompt = makePrompt(input.task, input.constraints);
  const piArgs = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--provider",
    config.provider,
    "--model",
    input.model,
    "--thinking",
    input.thinking,
    "--tools",
    profile.tools.join(","),
    config.pi.trustProjectFiles ? "--approve" : "--no-approve",
  ];
  if (!config.pi.loadContextFiles) piArgs.push("--no-context-files");
  if (input.promptPreamble) {
    piArgs.push("--append-system-prompt", input.promptPreamble);
  }
  for (const file of input.contextFiles) piArgs.push(`@${file}`);
  piArgs.push(prompt);

  const requestRecord = {
    runId,
    createdAt: new Date().toISOString(),
    profile: profileName,
    role: input.role,
    provider: config.provider,
    model: input.model,
    thinking: input.thinking,
    tools: profile.tools,
    workingDirectory: input.workingDirectory,
    contextFiles: input.contextFiles,
    constraints: input.constraints,
    task: input.task,
    timeoutSeconds: input.timeoutSeconds,
    returnCharacters: input.returnCharacters,
    pi: {
      command: config.pi.command,
      prefixArguments: config.pi.arguments,
      trustProjectFiles: config.pi.trustProjectFiles,
      loadContextFiles: config.pi.loadContextFiles,
      stateDirectory: config.pi.stateDirectory,
    },
  };
  await writeFile(paths.request, `${JSON.stringify(requestRecord, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const environment = {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...(config.pi.stateDirectory
      ? { PI_CODING_AGENT_DIR: config.pi.stateDirectory }
      : {}),
  };
  const started = Date.now();
  const execution = await executePi({
    args: piArgs,
    environment,
    workingDirectory: input.workingDirectory,
    paths,
    config: {
      pi: config.pi,
      limits: config.limits,
      timeoutMilliseconds: input.timeoutSeconds * 1000,
    },
    signal,
  });
  const durationMs = Date.now() - started;

  let status = "succeeded";
  if (execution.terminationReason) status = execution.terminationReason;
  else if (
    execution.spawnError ||
    execution.artifactError ||
    execution.exitCode !== 0 ||
    execution.state.stopReason === "error" ||
    execution.state.stopReason === "aborted"
  ) {
    status = "failed";
  }
  const ok = status === "succeeded";
  const returned = truncateOutput(execution.state.finalOutput, input.returnCharacters);
  let rawError = null;
  if (!ok) {
    if (execution.terminationReason) {
      rawError = `Pi run ended because of ${execution.terminationReason}.`;
      if (execution.terminationReason === "cancelled" && execution.cancelReason) {
        rawError += ` Reason: ${execution.cancelReason}`;
      }
    } else if (execution.artifactError) {
      rawError = `Artifact write failed: ${execution.artifactError.message}`;
    } else {
      rawError =
        execution.state.errorMessage ||
        execution.spawnError?.message ||
        execution.stderrTail ||
        `Pi exited with code ${execution.exitCode}.`;
    }
  }
  const error = rawError === null ? null : truncateError(rawError);

  const result = {
    ok,
    run_id: runId,
    profile: profileName,
    role: input.role,
    status,
    model: execution.state.reportedModel || input.model,
    thinking: input.thinking,
    tools: profile.tools,
    exit_code: execution.exitCode,
    duration_ms: durationMs,
    final_output: returned.value,
    output_truncated: returned.truncated,
    usage: execution.state.usage,
    artifacts: paths,
    error,
  };
  try {
    await writeFile(paths.result, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (writeError) {
    // The response is the last resort when the artifact directory has failed.
    if (result.ok) {
      result.ok = false;
      result.status = "failed";
      result.error = truncateError(`Artifact write failed: ${writeError.message}`);
    }
  }
  return result;
}
