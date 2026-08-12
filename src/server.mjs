import { createInterface } from "node:readline";

import { publicConfiguration } from "./config.mjs";
import {
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  PROFILE_RESOURCE_URI,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  buildTools,
  emptyArtifacts,
  emptyUsage,
} from "./contracts.mjs";
import { InputError, runPi } from "./pi-runner.mjs";

const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

function capabilities() {
  return {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
  };
}

function withServerMetadata(result) {
  return {
    ...result,
    _meta: {
      ...(result?._meta ?? {}),
      [SERVER_INFO_META_KEY]: SERVER_INFO,
    },
  };
}

function resultResponse(id, result) {
  return { jsonrpc: "2.0", id, result: withServerMetadata(result) };
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

function rejectedResult(profileName, rawInput, config, error) {
  const profile = config.profiles[profileName];
  return {
    ok: false,
    run_id: null,
    profile: profileName,
    status: "rejected",
    model: typeof rawInput?.model === "string" ? rawInput.model : null,
    thinking:
      typeof rawInput?.thinking === "string" ? rawInput.thinking : profile.defaultThinking,
    tools: profile.tools,
    exit_code: null,
    duration_ms: 0,
    final_output: "",
    output_truncated: false,
    usage: emptyUsage(),
    artifacts: emptyArtifacts(),
    error: error.message,
  };
}

function toolResult(structured) {
  const summary = structured.ok
    ? `Cyberdeck ${structured.profile} run ${structured.run_id} ${structured.status}. Inspect structuredContent for the capped answer; full events are at ${structured.artifacts.events}.`
    : `Cyberdeck ${structured.profile} ${structured.status}: ${structured.error}`;
  return {
    resultType: "complete",
    content: [{ type: "text", text: summary }],
    structuredContent: structured,
    isError: !structured.ok,
  };
}

function legacyProtocolVersion(requested) {
  if (LEGACY_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LEGACY_PROTOCOL_VERSIONS[0];
}

export function inspectServer(config) {
  return {
    server: SERVER_INFO,
    supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
    instructions: SERVER_INSTRUCTIONS,
    tools: buildTools(config),
    resources: [
      {
        uri: PROFILE_RESOURCE_URI,
        name: "Resolved Cyberdeck profiles",
        mimeType: "application/json",
      },
    ],
    configuration: publicConfiguration(config),
  };
}

export function createServer(config, { input = process.stdin, output = process.stdout } = {}) {
  const tools = buildTools(config);
  const activeCalls = new Map();
  let runningToolCalls = 0;
  const lineReader = createInterface({ input, crlfDelay: Infinity });
  let writeQueue = Promise.resolve();

  const requestKey = (id) => `${typeof id}:${String(id)}`;
  const send = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    writeQueue = writeQueue.then(
      () =>
        new Promise((resolve, reject) => {
          output.write(line, "utf8", (error) => (error ? reject(error) : resolve()));
        }),
    );
    writeQueue.catch((error) => {
      if (error?.code !== "EPIPE") console.error(`Cyberdeck stdout error: ${error.message}`);
    });
  };

  const handleRequest = async (message, signal) => {
    const params = message.params ?? {};
    switch (message.method) {
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: capabilities(),
          instructions: SERVER_INSTRUCTIONS,
        };
      case "initialize":
        return {
          protocolVersion: legacyProtocolVersion(params.protocolVersion),
          capabilities: capabilities(),
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        };
      case "ping":
        return {};
      case "tools/list":
        return { resultType: "complete", tools, ttlMs: 60000, cacheScope: "private" };
      case "tools/call": {
        const toolName = params.name;
        const profileName = toolName === "research" ? "research" : "implementation";
        if (toolName !== "research" && toolName !== "implement") {
          throw new RpcError(-32602, `Unknown tool: ${String(toolName)}`);
        }
        if (runningToolCalls >= config.limits.maxConcurrentRuns) {
          return toolResult(
            rejectedResult(
              profileName,
              params.arguments,
              config,
              new InputError(
                `Concurrent run limit reached (${config.limits.maxConcurrentRuns}); retry after another run completes.`,
              ),
            ),
          );
        }
        runningToolCalls += 1;
        try {
          return toolResult(await runPi(profileName, params.arguments ?? {}, config, signal));
        } catch (error) {
          if (error instanceof InputError) {
            return toolResult(rejectedResult(profileName, params.arguments, config, error));
          }
          const failed = rejectedResult(profileName, params.arguments, config, error);
          failed.status = "failed";
          return toolResult(failed);
        } finally {
          runningToolCalls -= 1;
        }
      }
      case "resources/list":
        return {
          resultType: "complete",
          ttlMs: 60000,
          cacheScope: "private",
          resources: [
            {
              uri: PROFILE_RESOURCE_URI,
              name: "Resolved Cyberdeck profiles",
              title: "Cyberdeck profile policy",
              description:
                "Resolved model patterns, Pi tool allowlists, path roots, limits, and security boundary.",
              mimeType: "application/json",
            },
          ],
        };
      case "resources/read":
        if (params.uri !== PROFILE_RESOURCE_URI) {
          throw new RpcError(-32602, `Unknown resource URI: ${String(params.uri)}`);
        }
        return {
          resultType: "complete",
          ttlMs: 60000,
          cacheScope: "private",
          contents: [
            {
              uri: PROFILE_RESOURCE_URI,
              mimeType: "application/json",
              text: `${JSON.stringify(publicConfiguration(config), null, 2)}\n`,
            },
          ],
        };
      default:
        throw new RpcError(-32601, `Method not found: ${message.method}`);
    }
  };

  const dispatch = async (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      send(errorResponse(null, new RpcError(-32600, "Invalid Request")));
      return;
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      send(errorResponse(message.id, new RpcError(-32600, "Invalid Request")));
      return;
    }

    if (message.method === "notifications/cancelled") {
      const cancelledId = message.params?.requestId;
      activeCalls.get(requestKey(cancelledId))?.abort();
      return;
    }
    if (message.id === undefined) return;

    const controller = new AbortController();
    const key = requestKey(message.id);
    activeCalls.set(key, controller);
    try {
      const result = await handleRequest(message, controller.signal);
      send(resultResponse(message.id, result));
    } catch (error) {
      send(errorResponse(message.id, error));
    } finally {
      activeCalls.delete(key);
    }
  };

  lineReader.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(errorResponse(null, new RpcError(-32700, `Parse error: ${error.message}`)));
      return;
    }
    void dispatch(message);
  });
  lineReader.on("close", () => {
    for (const controller of activeCalls.values()) controller.abort();
  });

  return {
    close() {
      lineReader.close();
      for (const controller of activeCalls.values()) controller.abort();
    },
  };
}
