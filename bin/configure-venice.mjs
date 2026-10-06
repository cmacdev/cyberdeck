import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pinnedThinkingMap, THINKING_LEVELS } from "../src/config.mjs";

const baseUrl = "https://api.venice.ai/api/v1";

export async function configureVenice({ existingKey, config, auth, models, fetch: request = fetch }) {
  const key = auth.venice?.key ?? existingKey;
  if (typeof key !== "string" || !key || /^[!$]/.test(key)) throw new Error("Provide a literal Venice inference key in Pi auth.json or VENICE_API_KEY.");
  if (auth.venice && auth.venice.type !== "api_key") throw new Error("Use a Venice inference API key in Pi auth.json.");
  const api = async (endpoint, authenticated = true) => {
    const response = await request(`${baseUrl}${endpoint}`, {
      method: "GET",
      headers: authenticated ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) {
      const fix = response.status === 401 || response.status === 403
        ? "Verify the inference key in Venice API settings."
        : "Check Venice service availability and connectivity.";
      throw new Error(`Venice GET ${endpoint} returned HTTP ${response.status}. ${fix}`);
    }
    return response.json();
  };
  await api("/api_keys/rate_limits");
  const declared = Object.entries(config.models).filter(([, model]) => model.providers.venice);
  const required = declared.map(([, model]) => model.providers.venice.id);
  const catalog = (await api("/models?type=text", false)).data;
  const selected = catalog.filter((model) => required.includes(model.id)
    && model.type === "text" && model.model_spec?.privacy === "private"
    && model.model_spec?.capabilities?.supportsFunctionCalling === true && model.model_spec.offline === false);
  for (const id of required) {
    if (!selected.some((model) => model.id === id)) {
      throw new Error(`Venice model ${id} is unavailable, not private, or lacks tool calling. Update or remove its models entry in cyberdeck.config.json.`);
    }
  }
  for (const [name, model] of declared) {
    const { id, thinking } = model.providers.venice;
    const capabilities = selected.find((item) => item.id === id).model_spec.capabilities;
    const accepted = capabilities.supportsReasoning === true
      ? THINKING_LEVELS.filter((level) => capabilities.reasoningEffortOptions?.includes(level === "off" ? "none" : level))
      : [];
    if (thinking.some((level) => !accepted.includes(level))) {
      throw new Error(`Venice model ${id} accepts thinking ${JSON.stringify(accepted)}. Set models.${name}.providers.venice.thinking in cyberdeck.config.json to [] for no thinking control${accepted.includes(model.defaultThinking) ? `, or to accepted levels that include defaultThinking ${model.defaultThinking}` : ""}.`);
    }
  }
  const provider = models.providers?.venice ?? {};
  if (provider.apiKey || provider.headers || provider.oauth || provider.modelOverrides || provider.models?.some((model) => model.headers || model.api || model.baseUrl)) {
    throw new Error("Remove Venice auth, endpoint, or per-model overrides from models.json before installing; they can bypass the restricted key.");
  }
  const probe = catalog.find((model) => model.id.startsWith("gemini-") && model.model_spec?.privacy === "anonymized" && model.model_spec.offline === false);
  if (!probe) throw new Error("Cannot verify Venice privacy restrictions: no anonymous probe model is available. Retry later.");
  const response = await request(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: probe.id, messages: [{ role: "user", content: "1" }], max_tokens: 1, venice_parameters: { enable_web_search: "off", disable_thinking: true } }),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  const rejection = await response.json();
  const privacyCode = [rejection.code, rejection.error_code, rejection.error?.code, rejection.error].includes("MODEL_PRIVACY_RESTRICTED");
  const privacyMessage = typeof rejection.error === "string" && rejection.error.startsWith(`This API key is set to 'Private models only', but \`${probe.id}\` is an Anonymous model.`);
  if (response.status < 400 || response.status >= 500 || !(privacyCode || privacyMessage)) {
    throw new Error(`Venice privacy check did not confirm enforcement (HTTP ${response.status}). Set this inference key to Private Only in Venice API settings, then re-run. No task data was sent. Response: ${JSON.stringify(rejection).replaceAll(key, "[redacted]").slice(0, 600)}`);
  }
  auth.venice = { type: "api_key", key };
  const thinkingById = new Map(declared.map(([, model]) => [model.providers.venice.id, model.providers.venice.thinking]));
  const registered = selected.map(({ id, model_spec: spec }) => ({
    id,
    name: spec.name,
    reasoning: spec.capabilities.supportsReasoning,
    thinkingLevelMap: pinnedThinkingMap(thinkingById.get(id)),
    input: spec.capabilities.supportsVision ? ["text", "image"] : ["text"],
    contextWindow: spec.availableContextTokens,
    maxTokens: spec.maxCompletionTokens,
    cost: { input: spec.pricing.input.usd, output: spec.pricing.output.usd, cacheRead: spec.pricing.cache_input?.usd ?? 0, cacheWrite: 0 },
    compat: { supportsReasoningEffort: thinkingById.get(id).length > 0 },
    samplingParams: { venice_parameters: { include_venice_system_prompt: false, enable_web_search: "off", enable_web_scraping: false, enable_x_search: false } },
  }));
  (models.providers ??= {}).venice = {
    ...provider,
    baseUrl,
    api: "openai-completions",
    compat: { ...provider.compat, supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
    models: [...(provider.models ?? []).filter((model) => !registered.some((item) => item.id === model.id)), ...registered],
  };
  return { auth, models };
}

export async function writePrivateJson(file, value) {
  const target = await realpath(file).catch(() => file);
  await writeFile(`${target}.cyberdeck.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${target}.cyberdeck.tmp`, target);
  await chmod(target, 0o600);
}

async function main() {
  const read = (file, fallback) => readFile(file, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(`Make ${file} valid JSON and readable, then re-run.`);
  });
  const config = await read(new URL("../cyberdeck.config.json", import.meta.url));
  const authPath = path.join(process.env.PI_AGENT_DIR, "auth.json");
  const modelsPath = path.join(process.env.PI_AGENT_DIR, "models.json");
  const result = await configureVenice({
    existingKey: process.env.VENICE_API_KEY,
    config, auth: await read(authPath, {}), models: await read(modelsPath, {}),
  });
  await mkdir(process.env.PI_AGENT_DIR, { recursive: true, mode: 0o700 });
  for (const [file, value] of [[authPath, result.auth], [modelsPath, result.models]]) await writePrivateJson(file, value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Venice setup: ${error.message}\n`);
    process.exitCode = 1;
  });
}
