import { statSync } from "node:fs";
import { stat } from "node:fs/promises";

import { loadConfig, publicCatalog, publicConfiguration } from "./config.mjs";
import {
  CATALOG_RESOURCE_URI,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  PROFILE_RESOURCE_URI,
  SERVER_INFO,
  buildServerInstructions,
  buildTools,
  emptyArtifacts,
  emptyUsage,
} from "./contracts.mjs";
import { InputError, runPi } from "./pi-runner.mjs";

const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MAX_LINE_CHARACTERS = 16 * 1024 * 1024;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value) {
  return typeof value === "string" || Number.isInteger(value);
}

function capabilities() {
  return {
    tools: { listChanged: true },
    resources: { subscribe: false, listChanged: false },
  };
}

function resultResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { ...result?._meta, [SERVER_INFO_META_KEY]: SERVER_INFO },
    },
  };
}

function errorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: Number.isInteger(error?.code) ? error.code : -32603,
      message: error?.message || "Internal error",
      ...(error?.data === undefined ? {} : { data: error.data }),
    },
  };
}

function clamp(value, maximum) {
  return typeof value === "string" && value.length > maximum
    ? `${value.slice(0, maximum)}…`
    : value;
}

function rejectedResult(profileName, rawInput, config, error) {
  const profile = config.profiles[profileName];
  const requestedRole =
    typeof rawInput?.role === "string" ? clamp(rawInput.role, 32) : profile.defaultRole;
  const role = profile.roles[requestedRole];
  return {
    ok: false,
    run_id: null,
    profile: profileName,
    role: requestedRole,
    status: "rejected",
    model:
      typeof rawInput?.model === "string"
        ? clamp(rawInput.model, 200)
        : (role?.model ?? null),
    thinking:
      typeof rawInput?.thinking === "string"
        ? clamp(rawInput.thinking, 20)
        : (role?.defaultThinking ?? profile.defaultThinking),
    tools: profile.tools,
    exit_code: null,
    duration_ms: 0,
    final_output: "",
    output_truncated: false,
    usage: emptyUsage(),
    artifacts: emptyArtifacts(),
    error: clamp(error.message, 1000),
  };
}

function summarize(structured) {
  const { profile, run_id: runId, status, error, artifacts } = structured;
  if (runId === null) return `Cyberdeck ${profile} ${status}: ${error}`;
  if (!structured.ok) {
    return `Cyberdeck ${profile} run ${runId} ${status}: ${error} Events at ${artifacts.events}.`;
  }
  if (structured.final_output.length === 0) {
    return `Cyberdeck ${profile} run ${runId} succeeded without assistant text; events at ${artifacts.events}.`;
  }
  return `Cyberdeck ${profile} run ${runId} succeeded. Answer in structuredContent.final_output; events at ${artifacts.events}.`;
}

function toolResult(structured) {
  return {
    content: [{ type: "text", text: summarize(structured) }],
    structuredContent: structured,
    isError: !structured.ok,
  };
}

function legacyProtocolVersion(requested) {
  if (LEGACY_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LEGACY_PROTOCOL_VERSIONS[0];
}

function listedResources() {
  return [
    {
      uri: CATALOG_RESOURCE_URI,
      name: "Cyberdeck role catalog",
      title: "Cyberdeck role catalog",
      description: "Recommended roles, bound models, and when to use each one.",
      mimeType: "application/json",
    },
    {
      uri: PROFILE_RESOURCE_URI,
      name: "Resolved Cyberdeck profiles",
      title: "Cyberdeck profile policy",
      description:
        "Resolved roles, model patterns, Pi tool allowlists, path roots, limits, and security boundary.",
      mimeType: "application/json",
    },
  ];
}

function readResource(uri, config) {
  if (uri === CATALOG_RESOURCE_URI) {
    return {
      uri,
      mimeType: "application/json",
      text: `${JSON.stringify(publicCatalog(config), null, 2)}\n`,
    };
  }
  if (uri === PROFILE_RESOURCE_URI) {
    return {
      uri,
      mimeType: "application/json",
      text: `${JSON.stringify(publicConfiguration(config), null, 2)}\n`,
    };
  }
  return null;
}

function checkRequestMeta(params) {
  const meta = isPlainObject(params._meta) ? params._meta : undefined;
  const version = meta?.[PROTOCOL_VERSION_META_KEY];
  if (version === undefined || version === MODERN_PROTOCOL_VERSION) return null;
  return new RpcError(-32022, "Unsupported protocol version", {
    supported: [MODERN_PROTOCOL_VERSION],
    requested: String(version),
  });
}

export function inspectServer(config) {
  return {
    server: SERVER_INFO,
    supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
    instructions: buildServerInstructions(config),
    tools: buildTools(config),
    resources: listedResources().map(({ uri, name, mimeType }) => ({ uri, name, mimeType })),
    catalog: publicCatalog(config),
    configuration: publicConfiguration(config),
  };
}

function policyFileStampSync(configPath) {
  try {
    const info = statSync(configPath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

export function createServer(config, { input = process.stdin, output = process.stdout } = {}) {
  let current = config;
  let tools = buildTools(current);
  let reloadError = null;
  let announceTools = false;
  let policyStamp = policyFileStampSync(config.configPath);
  let reloadInFlight = null;
  const activeCalls = new Map();
  let runningToolCalls = 0;
  let writeQueue = Promise.resolve();
  let closed = false;

  const requestKey = (id) => `${typeof id}:${String(id)}`;
  const send = (message) => {
    if (output.destroyed || output.writableEnded) return;
    const line = `${JSON.stringify(message)}\n`;
    writeQueue = writeQueue
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (output.destroyed || output.writableEnded) return resolve();
            output.write(line, "utf8", (error) => (error ? reject(error) : resolve()));
          }),
      )
      .catch((error) => {
        if (error?.code !== "EPIPE") console.error(`Cyberdeck stdout error: ${error.message}`);
        shutdown();
      });
  };

  const maybeReload = async () => {
    if (reloadInFlight) return reloadInFlight;
    reloadInFlight = (async () => {
      try {
        const stamp = await stat(current.configPath)
          .then((info) => `${info.mtimeMs}:${info.size}`)
          .catch(() => "missing");
        if (stamp === policyStamp && reloadError === null) return;
        try {
          const next = await loadConfig(current.configPath);
          const previousTools = JSON.stringify(tools);
          current = next;
          tools = buildTools(next);
          reloadError = null;
          policyStamp = await stat(current.configPath)
            .then((info) => `${info.mtimeMs}:${info.size}`)
            .catch(() => "missing");
          if (JSON.stringify(tools) !== previousTools) announceTools = true;
        } catch (error) {
          reloadError = error;
        }
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  };

  const handleRequest = async (message, signal) => {
    await maybeReload();
    const params = isPlainObject(message.params) ? message.params : {};
    switch (message.method) {
      case "server/discover":
        return {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: capabilities(),
          instructions: buildServerInstructions(current),
        };
      case "initialize":
        return {
          protocolVersion: legacyProtocolVersion(params.protocolVersion),
          capabilities: capabilities(),
          serverInfo: SERVER_INFO,
          instructions: buildServerInstructions(current),
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools, ttlMs: 60000, cacheScope: "private" };
      case "tools/call": {
        const toolName = params.name;
        if (toolName !== "research" && toolName !== "implement") {
          throw new RpcError(-32602, `Unknown tool: ${String(toolName)}`);
        }
        const profileName = toolName === "research" ? "research" : "implementation";
        const policy = current;
        if (signal.aborted) return null;
        if (reloadError) {
          return toolResult(
            rejectedResult(
              profileName,
              params.arguments,
              policy,
              new InputError(`Configuration reload failed: ${reloadError.message}`),
            ),
          );
        }
        if (runningToolCalls >= policy.limits.maxConcurrentRuns) {
          return toolResult(
            rejectedResult(
              profileName,
              params.arguments,
              policy,
              new InputError(
                `Concurrent run limit reached (${policy.limits.maxConcurrentRuns}); retry after another run completes.`,
              ),
            ),
          );
        }
        runningToolCalls += 1;
        try {
          const structured = await runPi(profileName, params.arguments ?? {}, policy, signal);
          if (structured === null || structured.status === "cancelled") return null;
          return toolResult(structured);
        } catch (error) {
          if (signal.aborted) return null;
          if (error instanceof InputError) {
            return toolResult(rejectedResult(profileName, params.arguments, policy, error));
          }
          const failed = rejectedResult(profileName, params.arguments, policy, error);
          failed.status = "failed";
          return toolResult(failed);
        } finally {
          runningToolCalls -= 1;
        }
      }
      case "resources/list":
        return { ttlMs: 60000, cacheScope: "private", resources: listedResources() };
      case "resources/read": {
        const resource = readResource(params.uri, current);
        if (!resource) {
          throw new RpcError(-32602, `Unknown resource URI: ${String(params.uri)}`);
        }
        return { ttlMs: 0, cacheScope: "private", contents: [resource] };
      }
      default:
        throw new RpcError(-32601, `Method not found: ${message.method}`);
    }
  };

  const dispatch = async (message) => {
    if (!isPlainObject(message)) {
      send(errorResponse(null, new RpcError(-32600, "Invalid Request")));
      return;
    }
    const id = isRequestId(message.id) ? message.id : null;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      send(errorResponse(id, new RpcError(-32600, "Invalid Request")));
      return;
    }
    if (message.method === "notifications/cancelled") {
      const params = isPlainObject(message.params) ? message.params : {};
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      activeCalls.get(requestKey(params.requestId))?.abort(reason);
      return;
    }
    if (message.id === undefined) return;
    if (id === null) {
      send(errorResponse(null, new RpcError(-32600, "Invalid Request: id must be a string or integer.")));
      return;
    }
    const metaError = checkRequestMeta(isPlainObject(message.params) ? message.params : {});
    if (metaError) {
      send(errorResponse(id, metaError));
      return;
    }

    const controller = new AbortController();
    const key = requestKey(id);
    if (activeCalls.has(key)) {
      send(errorResponse(id, new RpcError(-32600, "Invalid Request: id is already active.")));
      return;
    }
    activeCalls.set(key, controller);
    try {
      const result = await handleRequest(message, controller.signal);
      if (result !== null) send(resultResponse(id, result));
      if (announceTools) {
        announceTools = false;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    } catch (error) {
      send(errorResponse(id, error));
    } finally {
      activeCalls.delete(key);
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(errorResponse(null, new RpcError(-32700, `Parse error: ${error.message}`)));
      return;
    }
    void dispatch(message);
  };

  let pending = "";
  let overflowing = false;
  const feed = (chunk) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (!overflowing) {
        if (pending.length + (end - start) > MAX_LINE_CHARACTERS) {
          overflowing = true;
          pending = "";
          send(
            errorResponse(
              null,
              new RpcError(-32600, `Invalid Request: message exceeds ${MAX_LINE_CHARACTERS} characters.`),
            ),
          );
        } else {
          pending += chunk.slice(start, end);
        }
      }
      if (newline === -1) return;
      if (overflowing) {
        overflowing = false;
      } else {
        const line = pending;
        pending = "";
        handleLine(line);
      }
      start = newline + 1;
    }
  };

  const shutdown = () => {
    if (closed) return;
    closed = true;
    input.off("data", feed);
    input.off("end", onEnd);
    input.off("close", shutdown);
    input.off("error", shutdown);
    if (!input.destroyed) input.destroy();
    for (const controller of activeCalls.values()) controller.abort();
  };
  const onEnd = () => {
    if (pending.length > 0 && !overflowing) handleLine(pending);
    pending = "";
    shutdown();
  };

  input.setEncoding("utf8");
  input.on("data", feed);
  input.on("end", onEnd);
  input.on("close", shutdown);
  input.on("error", shutdown);
  output.on("error", shutdown);
  output.on("close", shutdown);

  return { close: shutdown };
}
