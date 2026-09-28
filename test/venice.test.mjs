import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { configureVenice } from "../bin/configure-venice.mjs";
import { inferenceKey, veniceFixture } from "../fixtures/venice-api.mjs";

const config = JSON.parse(await readFile(new URL("../cyberdeck.config.json", import.meta.url), "utf8"));
const setup = (fixture, overrides = {}) => configureVenice({
  existingKey: inferenceKey, config, auth: {}, models: {}, fetch: fixture.fetch, ...overrides,
});

test("Venice accepts an inference key and proves anonymous requests are rejected without managing keys", async () => {
  const fixture = veniceFixture();
  const result = await setup(fixture, { auth: { openrouter: { type: "api_key", key: "keep" } }, models: { providers: { other: { baseUrl: "keep" } } } });
  assert.deepEqual(result.auth.venice, { type: "api_key", key: inferenceKey });
  assert.equal(result.auth.openrouter.key, "keep");
  assert.equal(result.models.providers.other.baseUrl, "keep");
  assert.deepEqual(fixture.calls.map((call) => call.path), ["/api_keys/rate_limits", "/models", "/chat/completions"]);
  assert.deepEqual(fixture.calls.at(-1).body.messages, [{ role: "user", content: "1" }]);
  const provider = result.models.providers.venice;
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.baseUrl, "https://api.venice.ai/api/v1");
  assert.deepEqual(provider.models.map((model) => model.id), ["deepseek-v4-flash-0731", "kimi-k3", "grok-4-7"]);
  assert.equal(provider.models[0].thinkingLevelMap.off, "none");
  assert.equal(provider.models[0].thinkingLevelMap.medium, null);
  assert.equal(provider.models[0].thinkingLevelMap.max, "max");
  assert.equal(provider.models[0].samplingParams.venice_parameters.enable_web_search, "off");
});

test("Venice reuses stored inference credentials and refreshes only model metadata", async () => {
  const fixture = veniceFixture();
  const result = await setup(fixture);
  const again = await setup(veniceFixture(), { ...result, existingKey: undefined });
  assert.deepEqual(again, result);
});

test("Venice refuses unrestricted keys without weakening ZDR or sending task data", async () => {
  const fixture = veniceFixture({ privacy: "ALL" });
  const auth = {};
  await assert.rejects(setup(fixture, { auth }), /Set this inference key to Private Only/);
  assert.deepEqual(auth, {});
  assert.equal(fixture.calls.at(-1).body.max_tokens, 1);
});

test("Venice fails closed on anonymous or unverified role models before probing", async () => {
  for (const modelPrivacy of ["anonymized", "missing", "unknown"]) {
    const fixture = veniceFixture({ modelPrivacy });
    await assert.rejects(setup(fixture), /not private/);
    assert.equal(fixture.calls.length, 2);
  }
});

test("Venice rejects failed authentication and unrelated refusals without exposing secrets", async () => {
  for (const failPath of ["/models", "/api_keys/rate_limits", "/chat/completions"]) {
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

test("Venice rejects alternate credentials that could bypass the restricted key", async () => {
  for (const provider of [{ apiKey: "override" }, { headers: { Authorization: "override" } }, { modelOverrides: {} }]) {
    const fixture = veniceFixture();
    await assert.rejects(setup(fixture, { models: { providers: { venice: provider } } }), /can bypass/);
    assert.ok(fixture.calls.every((call) => call.method === "GET"));
  }
});

test("Venice also accepts the documented privacy error code", async () => {
  const result = await setup(veniceFixture({ errorFormat: "code" }));
  assert.equal(result.models.providers.venice.models.length, 3);
});
