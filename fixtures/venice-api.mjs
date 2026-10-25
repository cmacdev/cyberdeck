import { readFileSync } from "node:fs";

export const inferenceKey = "test-inference-secret-123456";
const veniceModels = Object.values(
  JSON.parse(readFileSync(new URL("../cyberdeck.config.json", import.meta.url), "utf8")).models,
).flatMap((model) => model.providers.venice ?? []);
export const veniceModelIds = veniceModels.map((model) => model.id);

export function veniceFixture({ modelPrivacy = "private", modelPrivacyById = {}, failPath } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    if (!url.startsWith("https://api.venice.ai/api/v1/")) throw new Error("Unexpected test network request");
    calls.push({ path, ...options, body: options.body && JSON.parse(options.body) });
    if (path === failPath) return { ok: false, status: 403, json: async () => ({ code: "UNAUTHORIZED" }) };
    let data;
    if (path === "/models") {
      data = veniceModels.map(({ id, thinking }) => ({
        id, type: "text",
        model_spec: {
          name: id, privacy: modelPrivacyById[id] ?? modelPrivacy, offline: false,
          availableContextTokens: 1000000, maxCompletionTokens: 32768,
          capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: thinking.length > 0, ...(thinking.length ? { reasoningEffortOptions: thinking.map((level) => (level === "off" ? "none" : level)) } : {}), supportsVision: false },
          pricing: { input: { usd: 1 }, output: { usd: 2 } },
        },
      }));
    } else if (path === "/api_keys/rate_limits") {
      data = { accessPermitted: true };
    } else {
      throw new Error(`Unexpected test endpoint ${path}`);
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetch, calls };
}
