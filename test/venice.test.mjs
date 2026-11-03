import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { configureOpenRouter } from "../bin/configure-openrouter.mjs";
import { configureVenice } from "../bin/configure-venice.mjs";
import { inferenceKey, veniceFixture, veniceModelIds } from "../fixtures/venice-api.mjs";

const config = JSON.parse(await readFile(new URL("../cyberdeck.config.json", import.meta.url), "utf8"));
const setup = (fixture, overrides = {}) => configureVenice({
  existingKey: inferenceKey, config, auth: {}, models: {}, fetch: fixture.fetch, ...overrides,
});

test("Venice accepts an inference key without making an inference request", async () => {
  const fixture = veniceFixture();
  const result = await setup(fixture, { auth: { openrouter: { type: "api_key", key: "keep" } }, models: { providers: { other: { baseUrl: "keep" } } } });
  assert.deepEqual(result.auth.venice, { type: "api_key", key: inferenceKey });
  assert.equal(result.auth.openrouter.key, "keep");
  assert.equal(result.models.providers.other.baseUrl, "keep");
  assert.deepEqual(fixture.calls.map((call) => call.path), ["/api_keys/rate_limits", "/models"]);
  const provider = result.models.providers.venice;
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.baseUrl, "https://api.venice.ai/api/v1");
  assert.deepEqual(provider.models.map((model) => model.id), veniceModelIds);
  assert.deepEqual(provider.models[0].thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
  assert.equal(provider.models[0].samplingParams.venice_parameters.enable_web_search, "off");
});

test("Venice reuses stored inference credentials and refreshes only model metadata", async () => {
  const fixture = veniceFixture();
  const result = await setup(fixture);
  const again = await setup(veniceFixture(), { ...result, existingKey: undefined });
  assert.deepEqual(again, result);
});

test("Venice registers every text model Venice offers", async () => {
  const result = await setup(veniceFixture({
    modelPrivacy: "anonymized", offline: true, supportsFunctionCalling: false,
    extraModels: [{ id: "extra-text", thinking: ["low", "high"] }, { id: "" }, { id: "extra-text" }],
  }), { models: { providers: { venice: { models: [{ id: "retired-text" }] } } } });
  assert.deepEqual(result.models.providers.venice.models.map((model) => model.id), [...veniceModelIds, "extra-text"]);
  const extra = result.models.providers.venice.models.at(-1);
  assert.deepEqual(extra.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
  assert.equal(extra.samplingParams.venice_parameters.enable_web_search, "off");
  const refreshed = await setup(veniceFixture(), { auth: result.auth, models: result.models, existingKey: undefined });
  assert.deepEqual(refreshed.models.providers.venice.models.map((model) => model.id), veniceModelIds);
});

test("Venice still requires configured catalog models to be offered", async () => {
  for (const modelPrivacy of ["private", "anonymized", "missing", "unknown"]) {
    const result = await setup(veniceFixture({ modelPrivacy, offline: true, supportsFunctionCalling: false }));
    assert.deepEqual(result.models.providers.venice.models.map((model) => model.id), veniceModelIds);
  }
  const missing = structuredClone(config);
  missing.models["grok-4-7"].providers.venice.id = "not-a-venice-model";
  await assert.rejects(
    configureVenice({ existingKey: inferenceKey, config: missing, auth: {}, models: {}, fetch: veniceFixture().fetch }),
    /Venice model not-a-venice-model is unavailable\. Update or remove its models entry in cyberdeck\.config\.json\./,
  );
});

test("Venice rejects failed authentication and catalog requests without exposing secrets", async () => {
  for (const failPath of ["/models", "/api_keys/rate_limits"]) {
    const fixture = veniceFixture({ failPath });
    const auth = {};
    const models = {};
    await assert.rejects(setup(fixture, { auth, models }), (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.ok(!error.message.includes(inferenceKey));
      return true;
    });
    assert.deepEqual(auth, {});
    assert.deepEqual(models, {});
  }
});

test("Venice rejects alternate credentials that could bypass the stored key", async () => {
  for (const provider of [{ apiKey: "override" }, { headers: { Authorization: "override" } }, { modelOverrides: {} }]) {
    const fixture = veniceFixture();
    await assert.rejects(setup(fixture, { models: { providers: { venice: provider } } }), /can bypass/);
    assert.ok(fixture.calls.every((call) => call.method === "GET"));
  }
});

test("Venice pins a model without effort control so Pi sends no effort", async () => {
  const uncontrolled = structuredClone(config);
  uncontrolled.models["grok-4-7"].providers.venice.thinking = [];
  const result = await configureVenice({ existingKey: inferenceKey, config: uncontrolled, auth: {}, models: {}, fetch: veniceFixture().fetch });
  const grok = result.models.providers.venice.models.find((model) => model.id === "grok-4-7");
  assert.ok(Object.values(grok.thinkingLevelMap).every((value) => value === null));
  assert.equal(grok.compat.supportsReasoningEffort, false);
  const declared = structuredClone(config);
  declared.models["glm-flash"].providers.venice.thinking = ["low", "high", "max"];
  await assert.rejects(
    configureVenice({ existingKey: inferenceKey, config: declared, auth: {}, models: {}, fetch: veniceFixture().fetch }),
    /Venice model z-ai-glm-5-3-flash accepts thinking \[\]\./,
  );
});

test("Venice refuses a catalog thinking level the live model does not accept", async () => {
  const strict = structuredClone(config);
  strict.models["grok-4-7"].providers.venice.thinking.push("max");
  const fixture = veniceFixture();
  await assert.rejects(
    configureVenice({ existingKey: inferenceKey, config: strict, auth: {}, models: {}, fetch: fixture.fetch }),
    /Venice model grok-4-7 accepts thinking \["low","medium","high","xhigh"\]\. Set models\.grok-4-7\.providers\.venice\.thinking in cyberdeck\.config\.json to \[\] for no thinking control, or to accepted levels that include defaultThinking high\./,
  );
  assert.equal(fixture.calls.length, 2);
});

test("OpenRouter pins every catalog model to exactly its listed thinking levels under ZDR", () => {
  const models = configureOpenRouter({
    config,
    models: { providers: { openrouter: { compat: { openRouterRouting: { order: ["keep"] } } } } },
  });
  const provider = models.providers.openrouter;
  assert.deepEqual(provider.compat.openRouterRouting, { order: ["keep"] });
  for (const model of Object.values(config.models)) {
    if (!model.providers.openrouter) continue;
    const override = provider.modelOverrides[model.providers.openrouter.id];
    const supported = Object.entries(override.thinkingLevelMap).filter(([, value]) => value !== null).map(([level]) => level);
    assert.deepEqual(supported, model.providers.openrouter.thinking);
    assert.deepEqual(override.compat.openRouterRouting, { zdr: true, data_collection: "deny" });
  }
  assert.deepEqual(configureOpenRouter({ config, models: structuredClone(models) }), models);
});
