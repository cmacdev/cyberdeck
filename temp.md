# Venice.ai Cheap vs Smart Coding-Model Taxonomy (October 2026)

Every model you named is on Venice, but the routing mostly depends on three facts. First, the effort levels differ by model family: DeepSeek, GLM and Kimi accept `low/high/max`, Grok 4.7 accepts `low/medium/high/xhigh`, and GPT-6 Luna accepts `none`→`max`. [venicestats +4](https://venicestats.com/venice-models) Second, Venice does not map an unsupported level to the nearest one; it returns a 400. [venice](https://docs.venice.ai/guides/features/reasoning-models) Third, on Venice Kimi K3 costs nearly 3× Grok 4.7 for output tokens, so treat K3 as a high-priced specialist, not a typical mid-tier model. [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing) For a cheap-only plan → implement → review loop, use DeepSeek V4.1 Flash to plan (high effort), GLM 5.3 Flash to implement (high), DeepSeek V4.1 Flash to review (max), with GPT-6 Luna (max) as a second reviewer from a different vendor. In the smart tier, Grok 4.7 does the default work and Kimi K3 is kept for long-horizon autonomy and hard reviews.

## TL;DR
- **Cheap tier (output ≤ ~$1.50/M):** use `z-ai-glm-5-3-flash` for implementation and tool calling, `deepseek-v4-1-flash` for planning, debugging and review, `deepseek-v4-flash-0731` for bulk reading and trivial work, and `openai-gpt-6-luna` / `xiaomi-mimo-v2-6-flash` for a review from a different vendor. Use `high` as the default effort and `max` only for planning and review. Do not send `medium` to the DeepSeek, GLM or Kimi families.
- **Smart tier:** default to `grok-4-7` ($2.27/$6.80) at `high`, dropping to `medium` for routine tool loops. Escalate to `kimi-k3` ($3.75/$18.75, always reasons, `max` by default) only for long-horizon autonomy and adversarial review, and always set its effort explicitly, or every call runs at max. [kimi](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- **Verify at runtime:** Venice's reasoning docs have not caught up with the current catalog. Your router should read `supportsReasoningEffort` and the accepted effort values from `GET /api/v1/models` at startup and validate effort levels before sending. [venice](https://featurebase.venice.ai/changelog) [venice](https://docs.venice.ai/guides/features/reasoning-models) Several per-model values below come from the upstream vendor and have not been confirmed on Venice.

## Key Findings

**1. How Venice exposes reasoning control (docs.venice.ai, retrieved Oct 2026)**
- **Parameter:** top-level `reasoning_effort`, or nested `reasoning: { effort }`. Accepted values: `none | minimal | low | medium | high | xhigh | max`. [venice](https://docs.venice.ai/guides/features/reasoning-models) [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **No fallback:** Venice "does **not** auto-map to the nearest supported level. Unsupported values return a 400 error from the upstream provider." Its own examples: `xhigh` sent to Claude fails, and `max` sent to GPT-5.2 fails. [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **Disabling reasoning:** `reasoning: { enabled: false }` is the recommended toggle. [venice](https://docs.venice.ai/guides/features/reasoning-models) It is handled at the Venice level and "prevents reasoning parameters from being sent to the provider". `effort: "none"` is passed through to the provider, and only some providers (e.g. GPT-5.x) accept it. [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **Legacy flags:** `venice_parameters.strip_thinking_response` and `venice_parameters.disable_thinking` also exist, but they are for older models that use `<think>` tags. [venice](https://docs.venice.ai/api-reference/api-spec) [apidog](https://apidog.com/blog/venice-api-integration-guide/)
- **Reading the output:** reasoning comes back in `message.reasoning_content` (or the streamed `delta.reasoning_content`). [venice](https://docs.venice.ai/guides/features/reasoning-models) Anthropic, Google, OpenAI and Qwen return an encrypted placeholder instead of the reasoning text. [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **Token caps include reasoning:** `max_completion_tokens` (or `max_tokens`) limits reasoning plus answer combined. [venice](https://featurebase.venice.ai/changelog) Set it too low and you get empty `content` with `finish_reason: "length"`. [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **Capability flags:** `/v1/models` exposes `supportsReasoning`, `supportsReasoningEffort`, `supportsFunctionCalling`, `supportsResponseSchema`, `supportsVision` and `maxCompletionTokens`. The changelog says the endpoint "now returns which reasoning_effort values each supported model accepts." [venice](https://docs.venice.ai/api-reference/endpoint/models/list) [venice](https://featurebase.venice.ai/changelog) I could not fetch the live endpoint, so I could not confirm the exact field name.
- **Stale docs:** the per-model support table on Venice's reasoning page covers only older models (GPT-5.2, Claude 4.5/4.6, Gemini 3, Kimi K2.5, MiniMax M2.5, GLM 5.1). [venice](https://docs.venice.ai/guides/features/reasoning-models) It also still says Grok models reject `reasoning_effort`, which is true for Grok 4.1 Fast and Code Fast [venice](https://docs.venice.ai/guides/features/reasoning-models) but contradicts xAI's own docs for Grok 4.7. [x](https://docs.x.ai/developers/model-capabilities/text/reasoning)

**2. Name resolution for the models you listed**
- **"DeepSeek V4 Flash"** maps to four Venice IDs:
  - `deepseek-v4-flash` is the April "0423" preview ($0.14/$0.28). [venice](https://docs.venice.ai/models/text)
  - `deepseek-v4-flash-0731` is the official release ($0.17/$0.35). [venice](https://docs.venice.ai/models/text)
  - `deepseek-v4-flash-0731-fast` costs $0.35/$0.70. [venice](https://docs.venice.ai/models/text)
  - `e2ee-deepseek-v4-flash` is the TEE/end-to-end-encrypted version ($0.18/$0.37). [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing)
  - Use **0731**. The preview scored 7.3 on DeepSWE against 0731's 54.4. [vllm](https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4-Flash) [huggingface](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) Also, Venice's Aug 2026 changelog lists "DeepSeek V4 Flash" under deprecations, so the preview ID may disappear. [venice](https://featurebase.venice.ai/changelog)
- **"GLM 5.3 Flash":** `z-ai-glm-5-3-flash` ($0.15/$0.50, 1,049K context). The TEE version is `e2ee-glm-5-3-flash`. [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing)
- **"Grok 4.7":** `grok-4-7` ($2.27/$6.80, 500K context). [venice](https://docs.venice.ai/models/text) Prices double beyond 200K of context. [venice](https://docs.venice.ai/overview/pricing)
- **"Kimi K3":** `kimi-k3` ($3.75/$18.75, 1M context). Variants are `e2ee-kimi-k3-p` and `kimi-k3-fast-api` ($4.50/$22.50). [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing)
- **Kimi K3 is not really mid-priced on Venice.** Its output costs more than Claude Sonnet 5.5 ($12.50) and GPT-6 Sol ($12.50). [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing)

**3. Upstream reasoning-effort semantics per family (from the vendor docs)**

| Family | Accepted levels | Default | Can it be disabled? | Source |
|---|---|---|---|---|
| DeepSeek V4 Flash 0731 / V4 Pro | `low`, `high`, `max` | not stated | upstream has a "Non-think" mode; **on Venice, unverified** | DeepSeek HF model card | [together +2](https://www.together.ai/models/deepseek-v4-flash-0731)
| DeepSeek V4.1 Flash | `low`/`high`/`xhigh`/`max`, or an integer 1–100 (`none` turns thinking off; `minimal` and `medium` are rejected) | thinking on at 50 when nothing is set | yes upstream | vLLM recipe, DeepSeek paper | [vllm](https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4.1-Flash)
| GLM 5.3 Flash | `low`, `high`, `max` | `max` | no (always on) | Venice model page; LumaDock | [lumadock](https://lumadock.com/blog/glm-5-3-flash)
| Kimi K3 | `low`, `high`, `max` | `max` | no on Moonshot (Together does allow disabling) | Kimi API docs | [kimi +2](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
| Grok 4.7 | `low`, `medium`, `high`, `xhigh` | `high` | no | xAI docs; AWS Bedrock | [x](https://docs.x.ai/developers/model-capabilities/text/reasoning) [amazon](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-7.html)
| GPT-6 Luna / Sol | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` | yes (`none`) | OpenAI coverage (tosea, kingy) | [tosea](https://tosea.ai/blog/gpt-6-sol-luna-complete-guide)

- **Warning about DeepSeek on Venice:** OpenClaw's Venice provider docs say it "strips thinking/reasoning/reasoning_effort from the request payload (Venice rejects DeepSeek's native thinking control on these models)". It also fills in the `reasoning_content` replay field "when Venice omits it". That statement names `deepseek-v4-flash` and `deepseek-v4-pro`. [openclaw](https://docs.openclaw.ai/providers/venice) It is OpenClaw's finding, not Venice's, and it may be out of date now that Venice advertises per-model effort options. Test with one request per ID before relying on effort control for DeepSeek on Venice.
- **Replay rule for Kimi K3:** Moonshot requires the complete assistant message, "including reasoning_content and tool_calls", to be passed back on every turn. [kimi](https://platform.kimi.ai/docs/guide/use-reasoning-effort) If your agent loop strips reasoning, K3 multi-turn tool use will degrade. Moonshot also warns that switching effort mid-session invalidates the context cache, so pick one effort level per session. [kimi +2](https://platform.kimi.ai/docs/guide/use-reasoning-effort)

## Summary Table: Cheap and Smart Models on Venice

Prices are USD per 1M input/output tokens, taken from docs.venice.ai/overview/pricing (retrieved Oct 5, 2026). "Effort" lists the values the vendor accepts. ✔︎ means Venice lists the capability. "?" means not verified on Venice; check `supportsResponseSchema` and `supportsReasoningEffort`.

| Venice ID | Family | Tier | Context | In / Out | Tools | Struct. out | Reasoning / effort | Vision | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `z-ai-glm-5-3-flash` | Z.ai GLM-5.3-Flash (320B/18B MoE) | cheap | 1,049K | $0.15 / $0.50 | ✔︎ | ✔︎ (JSON schema per the Venice page) | always on; low/high/max | ✔︎ (+video) | TB2.1 84.3, DeepSWE 63.4 (vendor). Venice's default for coding agents. ~49 tok/s | [venice](https://venice.ai/models/z-ai-glm-5-3-flash) [datacamp](https://www.datacamp.com/blog/glm-5-3-flash)
| `e2ee-glm-5-3-flash` | same, in a TEE | cheap | 1,000K | $0.16 / $0.54 | ✔︎ | ? | same | ✔︎ | use when you need end-to-end encryption | [venice](https://docs.venice.ai/overview/pricing)
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash (284B/13B) | cheap | 1,000K | $0.17 / $0.35 | ✔︎ | ? | low/high/max (on Venice: ?) | ✗ | TB2.1 82.7, DeepSWE 54.4, Toolathlon 70.3. AA-LCR 79.7% | [huggingface](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731)
| `deepseek-v4-flash-0731-fast` | same, faster | cheap | 1,000K | $0.35 / $0.70 | ✔︎ | ? | same | ✗ | 128K max output on the API | [venice](https://featurebase.venice.ai/changelog)
| `deepseek-v4-flash` | V4 Flash 0423 preview | cheap | 1,000K | $0.14 / $0.28 | ✔︎ | ? | same | ✗ | **avoid**: DeepSWE 7.3, possibly deprecated | [huggingface](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731)
| `deepseek-v4-1-flash` | DeepSeek V4.1 Flash (multimodal MoE) | cheap (top) | 1,000K | $0.30 / $1.20 | ✔︎ | ? | low/high/xhigh/max or 1–100 (on Venice: ?) | ✔︎ | TB2.1 90.6, DeepSWE 74.2 (vendor). AA index 40. ~207–214 tok/s. Cache read $0.0075 | [huggingface +2](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)
| `xiaomi-mimo-v2-6-flash` | Xiaomi MiMo-V2.6-Flash (309B) | cheap | 1,000K | $0.17 / $0.35 | ✔︎ | ? | reasoning; effort levels ? | ✔︎ | DeepSWE 67.9, TB2.1 87.6, Toolathlon 73.6 (vendor). Weaker on security work | [huggingface](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL) [computingforgeeks](https://computingforgeeks.com/xiaomi-mimo-v2-6-pro-flash/)
| `openai-gpt-6-luna` | OpenAI GPT-6 Luna | cheap | 1,050K | $0.13 / $0.63 | ✔︎ | ? | none→max, default medium | ✔︎ | DeepSWE 66.6% at max, 2.4% at low. Anonymized, not private. Reasoning is encrypted | [venice](https://docs.venice.ai/overview/pricing) [kingy](https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/)
| `qwen-3-8-flash` | Alibaba Qwen 3.8 Flash | cheap | 1,000K | $0.14 / $0.49 | ✔︎ | ? | ? | ✔︎ | **no coding benchmarks verified**. Anonymized |
| `minimax-m3-preview` | MiniMax M3 Preview | cheap | 524K | $0.30 / $1.20 | ✔︎ | ? | ? | ✔︎ | preview build. **No benchmarks verified** |
| `openai-gpt-oss-120b` | OpenAI gpt-oss-120b | cheap (floor) | 128K | $0.07 / $0.30 | ✔︎ | ? | ? | ✗ | fallback for trivial tasks only |
| `grok-4-7` | xAI Grok 4.7 | smart | 500K | $2.27 / $6.80 (>200K: $4.53 / $13.60) | ✔︎ | ✔︎ (xAI) | low/medium/high/xhigh, default high, cannot be disabled | ✔︎ | DeepSWE 71.0, CursorBench 46.3 (xAI). xhigh uses ~81K output tokens per task | [learnetto](https://learnetto.com/ai-resources/grok-4-7-explained-39b90117) [evolink](https://evolink.ai/blog/grok-4-7-vs-grok-4-6)
| `grok-4-6` | xAI Grok 4.6 | smart | 500K | $2.27 / $6.80 | ✔︎ | ✔︎ | same levels | ✔︎ | same price as 4.7, so prefer 4.7 | [evolink](https://evolink.ai/blog/grok-4-7-vs-grok-4-6)
| `grok-build-0-1` | xAI Grok Build | smart (budget) | 256K | $1.00 / $2.00 | ✔︎ | ? | ? | ✔︎ | code-tagged. **No benchmarks verified** |
| `kimi-k3` | Moonshot Kimi K3 (2.8T/104B) | smart (premium-priced) | 1,000K | $3.75 / $18.75 | ✔︎ | ✔︎ (NVIDIA card) | always on; low/high/max, default max | ✔︎ | TB2.1 88.3, DeepSWE 67.5, SWE-Marathon 42.0 (vendor). Very verbose | [emergent](https://emergent.sh/learn/kimi-k3-benchmark) [nvidia](https://build.nvidia.com/moonshotai/kimi-k3/modelcard)
| `kimi-k3-fast-api` | Kimi K3 Fast | smart | 1,000K | $4.50 / $22.50 | ✔︎ | ? | same as K3 | ✔︎ | pay for latency only | [venice](https://docs.venice.ai/overview/pricing)
| `deepseek-v4-pro-0813` | DeepSeek V4 Pro | smart | 1,000K | $1.65 / $4.95 | ✔︎ | ? | low/high/max (on Venice: ?) | ✗ | Venice's `default_code` trait points here | [venice](https://featurebase.venice.ai/changelog)
| `z-ai-glm-5-3` | Z.ai GLM-5.3 | smart | 1,000K | $1.75 / $5.50 | ✔︎ | ? | ? | ✗ | 11× the output price of Flash for a small gain (AA 60 vs 57) | [datacamp](https://www.datacamp.com/blog/glm-5-3-flash)
| `qwen-3-8-max` | Qwen 3.8 Max | smart | 1,000K | $2.50 / $7.50 | ✔︎ | ? | ? | ✔︎ | TB2.1 86.6 (vendor). Anonymized | [emergent](https://emergent.sh/learn/qwen-3-8-benchmarks)
| `kimi-k2-7-code` | Moonshot K2.7 Code | smart (budget) | 256K | $0.75 / $3.50 | ✔︎ | ? | always thinks, no effort parameter | ✔︎ | older generation | [kimi](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model)
| `openai-gpt-6-sol` | OpenAI GPT-6 Sol | smart (upper) | 1,050K | $2.50 / $12.50 | ✔︎ | ? | none→max | ✔︎ | included for contrast. Anonymized | [venice](https://docs.venice.ai/overview/pricing)

Excluded as premium: Claude Opus/Fable, GPT-6 Astra, GPT-5.6 Sol and GPT-5.5.

## Task-to-Model Matrix

| Task | Cheap pick (effort) | Smart pick (effort) | Why |
|---|---|---|---|
| (a) Cross-repo research / exploration | `deepseek-v4-flash-0731` (low) → fallback `z-ai-glm-5-3-flash` (low) | `grok-4-7` (medium) → `deepseek-v4-pro-0813` (high) | Reading-heavy work is priced by input tokens. 0731 has cheap input and AA-LCR 79.7% |
| (b) Planning / decomposition | `deepseek-v4-1-flash` (high; max for big refactors) | `kimi-k3` (high) → `grok-4-7` (high) | Plans are short to write but costly when wrong, so spend effort here |
| (c) Implementation / edits | `z-ai-glm-5-3-flash` (high) → `deepseek-v4-flash-0731` (high) | `grok-4-7` (high) → `kimi-k3` (high) | GLM Flash: TB2.1 84.3 at $0.50 output, and Venice's own coding-agent default | [github](https://github.com/veniceai/api-docs/pull/548) [datacamp](https://www.datacamp.com/blog/glm-5-3-flash)
| (d) Adversarial / security review | `deepseek-v4-1-flash` (max) + `openai-gpt-6-luna` (max) | `kimi-k3` (high; max for security) → `grok-4-7` (xhigh) | Use a different family from the implementer. V4.1 Flash claims the open-model state of the art on cyber tasks | [arxiv](https://arxiv.org/pdf/2609.19969)
| (e) Autonomous long-horizon | `deepseek-v4-1-flash` (high) → `z-ai-glm-5-3-flash` (high) | `kimi-k3` (high) → `grok-4-7` (high) | In Moonshot's model card K3 leads SWE-Marathon at 42.0, ahead of Claude Fable 5 (35.0), GPT-5.6 Sol (39.0) and Opus 4.8 (40.0). OpenRouter's K3 page claims "stable multi-agent behavior through 200–300 tool calls", but that figure was first credited to Kimi K2 Thinking and may have been carried over |
| (f) Heavy tool calling / orchestration | `z-ai-glm-5-3-flash` (low) → `xiaomi-mimo-v2-6-flash` | `grok-4-7` (medium) → `kimi-k3` (low) | Orchestrators make many short turns, so low effort keeps latency down |
| (g) Test writing | `deepseek-v4-flash-0731` (high) → `xiaomi-mimo-v2-6-flash` | `grok-4-7` (medium) | A different family from the implementer surfaces different edge cases |
| (h) Debugging from logs / stack traces | `deepseek-v4-1-flash` (high) → `z-ai-glm-5-3-flash` (max) | `grok-4-7` (high) → `kimi-k3` (high) | Root-cause work rewards reasoning depth |
| (i) Docs / commit messages | `deepseek-v4-flash-0731` (low) → `openai-gpt-6-luna` (none) | `grok-4-7` (low) → drop to cheap | Don't pay smart-tier prices for commit messages |
| (j) Large-context reading (>500K) | `deepseek-v4-flash-0731` (low) → `deepseek-v4-1-flash` (low) | `deepseek-v4-pro-0813` (high) → `kimi-k3` (low) | Grok 4.7 stops at 500K and doubles in price above 200K | [venice](https://docs.venice.ai/overview/pricing)

## TypeScript Typed Reference

```ts
// venice-models.ts — snapshot 2026-10-05. Validate against GET /api/v1/models at boot.
export type Tier = 'cheap' | 'smart';

/** Every value Venice accepts at the API layer (docs.venice.ai reasoning-models). */
export type ReasoningEffort =
  | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Sentinel: send `reasoning: { enabled: false }` instead of an effort. */
export type EffortChoice = ReasoningEffort | 'disabled' | 'omit';

export type CodingTask =
  | 'research'        // (a) cross-repo exploration & summarization
  | 'planning'        // (b)
  | 'implementation'  // (c)
  | 'review'          // (d) adversarial / security review
  | 'autonomous'      // (e) long-horizon agentic work
  | 'orchestration'   // (f) heavy tool calling / subagent dispatch
  | 'tests'           // (g)
  | 'debugging'       // (h)
  | 'docs'            // (i) docs / commit messages
  | 'longContext';    // (j)

type Verified = boolean | 'unverified';

export interface VeniceModel {
  id: string;
  family: string;
  tier: Tier;
  contextWindow: number;
  pricing: { inputPerM: number; outputPerM: number; cacheReadPerM?: number; longContextNote?: string };
  capabilities: {
    toolCalling: Verified;
    structuredOutput: Verified;
    reasoning: 'always' | 'hybrid' | 'none' | 'unverified';
    vision: Verified;
    reasoningContentReturned: boolean | 'encrypted' | 'unverified';
    mustReplayReasoning?: boolean;
  };
  /** Upstream-vendor-documented levels; empty = do not send effort. */
  supportedEfforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort | 'unknown';
  effortVerifiedOnVenice: boolean;
  strengths: readonly string[];
  weaknesses: readonly string[];
}

export const MODELS: readonly VeniceModel[] = [
  {
    id: 'z-ai-glm-5-3-flash', family: 'Z.ai GLM-5.3-Flash', tier: 'cheap', contextWindow: 1_049_000,
    pricing: { inputPerM: 0.15, outputPerM: 0.50, cacheReadPerM: 0.03 },
    capabilities: { toolCalling: true, structuredOutput: true, reasoning: 'always', vision: true, reasoningContentReturned: true },
    supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max', effortVerifiedOnVenice: true,
    strengths: ['implementation', 'tool calling', 'TB2.1 84.3', 'cheapest strong coder'],
    weaknesses: ['~49 tok/s output', 'no medium effort', 'defaults to max — always set effort'],
  },
  {
    id: 'deepseek-v4-1-flash', family: 'DeepSeek V4.1 Flash', tier: 'cheap', contextWindow: 1_000_000,
    pricing: { inputPerM: 0.30, outputPerM: 1.20, cacheReadPerM: 0.0075 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'hybrid', vision: true, reasoningContentReturned: true, mustReplayReasoning: true },
    supportedEfforts: ['low', 'high', 'xhigh', 'max'], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['strongest cheap agent (TB2.1 90.6, DeepSWE 74.2 vendor)', 'fast ~200 tok/s', 'security review'],
    weaknesses: ['verbose output', 'Venice effort pass-through unverified', '2.4x GLM Flash output price'],
  },
  {
    id: 'deepseek-v4-flash-0731', family: 'DeepSeek V4 Flash', tier: 'cheap', contextWindow: 1_000_000,
    pricing: { inputPerM: 0.17, outputPerM: 0.35, cacheReadPerM: 0.04 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'hybrid', vision: false, reasoningContentReturned: true, mustReplayReasoning: true },
    supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['bulk reading', 'long-context recall (AA-LCR 79.7%)', 'tests', 'trivial tasks'],
    weaknesses: ['weaker on long trajectories than V4.1', 'OpenClaw reports Venice rejecting DeepSeek thinking params'],
  },
  {
    id: 'xiaomi-mimo-v2-6-flash', family: 'Xiaomi MiMo-V2.6-Flash', tier: 'cheap', contextWindow: 1_000_000,
    pricing: { inputPerM: 0.17, outputPerM: 0.35, cacheReadPerM: 0.0037 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'unverified', vision: true, reasoningContentReturned: 'unverified' },
    supportedEfforts: [], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['tool calling (Toolathlon 73.6)', 'diversity reviewer', 'automation'],
    weaknesses: ['security (ExploitBench 25.3)', 'self-correction drops on Agents Last Exam', 'repetition 0.07-1.02%'],
  },
  {
    id: 'openai-gpt-6-luna', family: 'OpenAI GPT-6 Luna', tier: 'cheap', contextWindow: 1_050_000,
    pricing: { inputPerM: 0.13, outputPerM: 0.63, cacheReadPerM: 0.01, longContextNote: '>272K: $0.25/$0.94' },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'hybrid', vision: true, reasoningContentReturned: 'encrypted' },
    supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', effortVerifiedOnVenice: false,
    strengths: ['cross-vendor reviewer', 'DeepSWE 66.6% at max'],
    weaknesses: ['useless for agents at low (DeepSWE 2.4%)', 'anonymized not private', 'reasoning encrypted'],
  },
  {
    id: 'qwen-3-8-flash', family: 'Qwen 3.8 Flash', tier: 'cheap', contextWindow: 1_000_000,
    pricing: { inputPerM: 0.14, outputPerM: 0.49, cacheReadPerM: 0.01 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'unverified', vision: true, reasoningContentReturned: 'encrypted' },
    supportedEfforts: [], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['cheap fallback'], weaknesses: ['no verified coding benchmarks', 'anonymized'],
  },
  {
    id: 'minimax-m3-preview', family: 'MiniMax M3 Preview', tier: 'cheap', contextWindow: 524_000,
    pricing: { inputPerM: 0.30, outputPerM: 1.20, cacheReadPerM: 0.06 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'unverified', vision: true, reasoningContentReturned: 'unverified' },
    supportedEfforts: [], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['family diversity'], weaknesses: ['preview', 'no verified benchmarks'],
  },
  {
    id: 'grok-4-7', family: 'xAI Grok 4.7', tier: 'smart', contextWindow: 500_000,
    pricing: { inputPerM: 2.27, outputPerM: 6.80, cacheReadPerM: 0.57, longContextNote: '>200K: $4.53/$13.60' },
    capabilities: { toolCalling: true, structuredOutput: true, reasoning: 'always', vision: true, reasoningContentReturned: 'unverified' },
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', effortVerifiedOnVenice: false,
    strengths: ['default smart worker', 'DeepSWE 71.0 (xAI)', 'only family with medium'],
    weaknesses: ['no max (400s)', 'xhigh ~2x tokens of 4.6-high', '500K ceiling, price doubles >200K'],
  },
  {
    id: 'kimi-k3', family: 'Moonshot Kimi K3', tier: 'smart', contextWindow: 1_000_000,
    pricing: { inputPerM: 3.75, outputPerM: 18.75, cacheReadPerM: 0.38 },
    capabilities: { toolCalling: true, structuredOutput: true, reasoning: 'always', vision: true, reasoningContentReturned: true, mustReplayReasoning: true },
    supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max', effortVerifiedOnVenice: false,
    strengths: ['long-horizon autonomy (SWE-Marathon 42.0)', 'hard reviews', '200-300 stable tool calls'],
    weaknesses: ['$18.75 output', 'very verbose', 'defaults to max', 'switching effort busts cache'],
  },
  {
    id: 'deepseek-v4-pro-0813', family: 'DeepSeek V4 Pro', tier: 'smart', contextWindow: 1_000_000,
    pricing: { inputPerM: 1.65, outputPerM: 4.95, cacheReadPerM: 0.17 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'hybrid', vision: false, reasoningContentReturned: true, mustReplayReasoning: true },
    supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['1M-context smart reader', "Venice's default_code trait"],
    weaknesses: ['beaten by V4.1 Flash on vendor agentic benches at 4x price'],
  },
  {
    id: 'z-ai-glm-5-3', family: 'Z.ai GLM-5.3', tier: 'smart', contextWindow: 1_000_000,
    pricing: { inputPerM: 1.75, outputPerM: 5.50, cacheReadPerM: 0.33 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'unverified', vision: false, reasoningContentReturned: true },
    supportedEfforts: [], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['faster than Flash (~86 tok/s)'], weaknesses: ['11x Flash price for +3 AA points'],
  },
  {
    id: 'grok-build-0-1', family: 'xAI Grok Build', tier: 'smart', contextWindow: 256_000,
    pricing: { inputPerM: 1.00, outputPerM: 2.00, cacheReadPerM: 0.20 },
    capabilities: { toolCalling: true, structuredOutput: 'unverified', reasoning: 'unverified', vision: true, reasoningContentReturned: 'unverified' },
    supportedEfforts: [], defaultEffort: 'unknown', effortVerifiedOnVenice: false,
    strengths: ['cheapest Grok coder'], weaknesses: ['no verified benchmarks'],
  },
] as const;

type Route = { model: string; effort: EffortChoice; fallback?: string };

export const ROUTING: Record<CodingTask, Record<Tier, Route>> = {
  research:       { cheap: { model: 'deepseek-v4-flash-0731', effort: 'low',  fallback: 'z-ai-glm-5-3-flash' },
                    smart: { model: 'grok-4-7',               effort: 'medium', fallback: 'deepseek-v4-pro-0813' } },
  planning:       { cheap: { model: 'deepseek-v4-1-flash',    effort: 'high', fallback: 'z-ai-glm-5-3-flash' },
                    smart: { model: 'kimi-k3',                effort: 'high', fallback: 'grok-4-7' } },
  implementation: { cheap: { model: 'z-ai-glm-5-3-flash',     effort: 'high', fallback: 'deepseek-v4-flash-0731' },
                    smart: { model: 'grok-4-7',               effort: 'high', fallback: 'kimi-k3' } },
  review:         { cheap: { model: 'deepseek-v4-1-flash',    effort: 'max',  fallback: 'openai-gpt-6-luna' },
                    smart: { model: 'kimi-k3',                effort: 'high', fallback: 'grok-4-7' } },
  autonomous:     { cheap: { model: 'deepseek-v4-1-flash',    effort: 'high', fallback: 'z-ai-glm-5-3-flash' },
                    smart: { model: 'kimi-k3',                effort: 'high', fallback: 'grok-4-7' } },
  orchestration:  { cheap: { model: 'z-ai-glm-5-3-flash',     effort: 'low',  fallback: 'xiaomi-mimo-v2-6-flash' },
                    smart: { model: 'grok-4-7',               effort: 'medium', fallback: 'kimi-k3' } },
  tests:          { cheap: { model: 'deepseek-v4-flash-0731', effort: 'high', fallback: 'xiaomi-mimo-v2-6-flash' },
                    smart: { model: 'grok-4-7',               effort: 'medium', fallback: 'deepseek-v4-pro-0813' } },
  debugging:      { cheap: { model: 'deepseek-v4-1-flash',    effort: 'high', fallback: 'z-ai-glm-5-3-flash' },
                    smart: { model: 'grok-4-7',               effort: 'high', fallback: 'kimi-k3' } },
  docs:           { cheap: { model: 'deepseek-v4-flash-0731', effort: 'low',  fallback: 'openai-gpt-6-luna' },
                    smart: { model: 'grok-4-7',               effort: 'low',  fallback: 'deepseek-v4-flash-0731' } },
  longContext:    { cheap: { model: 'deepseek-v4-flash-0731', effort: 'low',  fallback: 'deepseek-v4-1-flash' },
                    smart: { model: 'deepseek-v4-pro-0813',   effort: 'high', fallback: 'kimi-k3' } },
};

/** Venice does NOT auto-map efforts; coerce to the nearest supported level yourself. */
const ORDER: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function coerceEffort(m: VeniceModel, want: ReasoningEffort): ReasoningEffort | undefined {
  if (m.supportedEfforts.length === 0) return undefined; // omit the param entirely
  if (m.supportedEfforts.includes(want)) return want;
  const i = ORDER.indexOf(want);
  // prefer rounding UP (e.g. medium -> high on DeepSeek/GLM/Kimi; max -> xhigh on Grok is the down case)
  return m.supportedEfforts.find(e => ORDER.indexOf(e) >= i)
      ?? [...m.supportedEfforts].reverse().find(e => ORDER.indexOf(e) < i);
}
```

**Example Venice request body.** These are the real parameter names from docs.venice.ai/api-reference/endpoint/chat/completions:

```json
POST https://api.venice.ai/api/v1/chat/completions
{
  "model": "z-ai-glm-5-3-flash",
  "messages": [
    { "role": "system", "content": "You are the implementer. Emit unified diffs only." },
    { "role": "user", "content": "Implement the plan in PLAN.md step 3." }
  ],
  "reasoning": { "effort": "high" },
  "max_completion_tokens": 64000,
  "tools": [ { "type": "function", "function": { "name": "apply_patch", "parameters": { "type": "object", "properties": { "diff": { "type": "string" } }, "required": ["diff"] } } } ],
  "venice_parameters": { "include_venice_system_prompt": false },
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

- **Flat form also works:** `"reasoning_effort": "high"`. [venice](https://docs.venice.ai/api-reference/endpoint/chat/completions) If both are set, the top-level value wins (per the venice-py SDK). [github](https://github.com/sethbang/venice-py) [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **Turning reasoning off:** use `"reasoning": { "enabled": false }` on models that allow it. [venice](https://docs.venice.ai/guides/features/reasoning-models) [venice](https://docs.venice.ai/guides/features/reasoning-models)
- **System prompt:** set `include_venice_system_prompt: false`. Otherwise Venice adds its own defaults to your agent's system prompt. [venice](https://docs.venice.ai/api-reference/api-spec)

## The Cheap-Only Plan → Implement → Review Cycle

A cheap cycle is viable. Vendor numbers for GLM 5.3 Flash (TB2.1 84.3), V4.1 Flash (90.6) and MiMo Flash (87.6) sit in the same band as Opus 4.8 (85.0). [huggingface +2](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) The catch is that harnesses differ between those runs and nearly all the numbers are vendor-reported. I recommend this assignment:

1. **Planner:** `deepseek-v4-1-flash` at `high`. Escalate to `max` for refactors that touch more than ~5 files or anything architectural.
   - The plan is a small output that conditions everything downstream, so this is where reasoning tokens pay off most.
   - Ask for a structured plan: steps, files, acceptance tests and risks. Validate it with `response_format` only if `supportsResponseSchema` is true. [venice](https://docs.venice.ai/overview/guides/structured-responses)
2. **Explorer / context gatherer:** `deepseek-v4-flash-0731` at `low`. Run it in parallel subagents and have each return a compressed summary to the planner.
3. **Implementer:** `z-ai-glm-5-3-flash` at `high`. Drop to `low` for mechanical edits such as renames, boilerplate and applying an already-specified diff.
   - Always send an explicit effort. Its default is `max`, which wastes tokens on simple edits. [lumadock](https://lumadock.com/blog/glm-5-3-flash)
4. **Test writer:** `deepseek-v4-flash-0731` at `high`. It is a different family from the implementer, so it is less likely to share the implementer's blind spots.
5. **Reviewer:** `deepseek-v4-1-flash` at `max`, plus `openai-gpt-6-luna` at `max` as a second reviewer from a different vendor on high-risk diffs.
   - Never review GLM output with GLM.
   - Never run Luna below `high` for agentic or review work. AICatchup's per-effort table for Luna on DeepSWE 1.1 shows 2.4% at `low` ($0.006/task), 59.3% at `high` ($0.084) and 66.6% at `max` ($0.22).
6. **Debug loop on test failure:** `deepseek-v4-1-flash` at `high`, fed the failing test output and the stack trace.

**Known failure modes and mitigations**
- **Truncated output with an empty answer.**
  - *Cause:* reasoning tokens count against `max_completion_tokens`, and V4.1 Flash thinks at effort 50 by default. [venice](https://featurebase.venice.ai/changelog) [vllm](https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4.1-Flash)
  - *Fix:* set caps of at least 32–64K for high/max. DeepSeek recommends allowing up to 384K output for high/max. [lmstudio](https://lmstudio.ai/models/deepseek-v4-flash) [huggingface](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) Treat `finish_reason: "length"` with empty `content` as a retryable error, retried at lower effort.
- **400 errors from effort values.**
  - *Cause:* sending `medium` to DeepSeek, GLM or Kimi, or `max` to Grok.
  - *Fix:* run every request through `coerceEffort`.
- **Lost reasoning context in multi-turn tool loops.**
  - *Cause:* DeepSeek V4 and Kimi K3 need `reasoning_content` echoed back. [kimi +2](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
  - *Fix:* persist the full assistant message, including `reasoning_content` and `tool_calls`. OpenClaw reports that Venice sometimes omits this field for DeepSeek V4, so backfill it with an empty string if it is missing. [openclaw](https://docs.openclaw.ai/providers/venice)
- **Looping and repetition.**
  - *Evidence:* Xiaomi measured repetition rates of 0.07–1.02% for MiMo Flash depending on the harness. Tabbit AI's comparison of MiMo-V2.6 Pro and Flash finds that on error recovery Flash "degrades into cyclic retries": it scores 27.6 on Agents' Last Exam against Pro's 31.6, a 14.5% capability drop.
  - *Fix:* cap turns per subagent, detect repeated identical tool calls, and escalate to the smart tier after N failed attempts.
- **Cheap models fall off on long trajectories.**
  - *Evidence:* the Terminal-Bench 4.0 scores of cheap models (V4.1 Flash 31.2, MiMo 28.8, GLM Flash 32.8) are far below their TB2.1 scores. [huggingface +2](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)
  - *Fix:* keep cheap subagents on bounded tasks with a clear exit condition, and let the orchestrator own the long horizon.
- **Privacy drift.**
  - GPT-6 Luna and Qwen 3.8 Flash are "Anonymized" (proxied to the vendor). DeepSeek, GLM, MiMo, Grok and Kimi are "Private" on Venice. [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing)
  - If repo confidentiality matters, replace Luna with MiMo as the cross-family reviewer.

## Cost-Effectiveness: Effort Multiplies the Bill

- **List-price gap:** output-price ratios against GLM 5.3 Flash ($0.50) are 13.6× for Grok 4.7 and 37.5× for Kimi K3. [venice](https://docs.venice.ai/models/text) [venice](https://docs.venice.ai/overview/pricing) Even if a cheap model at `max` burns 3–4× the tokens of a smart model at `low`, the cheap model still costs less per task.
- **Grok 4.7 at xhigh:** about 81K output tokens per task, roughly 2.2× Grok 4.6 at high. That is about $0.55 of output per task on Venice. Moving from high to xhigh added 2.4 CursorBench points for about 28% more cost. [learnetto](https://learnetto.com/ai-resources/grok-4-7-explained-39b90117) [kingy](https://kingy.ai/blog/grok-4-7-benchmarks-specs-frontier-comparison/) **Default Grok to `high`, never `xhigh`, unless a retry has already failed.**
- **Kimi K3 verbosity:**
  - Artificial Analysis found K3 used 130M output tokens running its Intelligence Index, against a 63M median.
  - On TrilogyAI's StackPerf benchmark, reasoning-token use across identical prompts varied by 275% through Kimi Code and 351% through OpenRouter. Some requests spent 4,093 of 4,096 completion tokens on reasoning and returned no visible answer.
  - Explicit `low`/`high` is mandatory.
- **Cheap at max vs smart at low:**
  - In OpenAI's launch charts (as reported by Kingy AI), GPT-6 Luna at max scores 66.6% on DeepSWE at about $0.22 per task at OpenAI list price; Venice charges ~26% more. OpenAI's claim that Luna at max beats GPT-5.6 Sol at medium for one-tenth the cost refers to OSWorld 2.0, not DeepSWE.
  - DeepSeek V4.1 Flash at max (vendor DeepSWE 74.2) beats Grok 4.7's xAI-reported 71.0 on the same benchmark, at about 1/6 the output price. [evolink](https://evolink.ai/blog/grok-4-7-vs-grok-4-6) [arxiv](https://arxiv.org/pdf/2609.19969)
  - On vendor numbers, the strongest cheap models at high/max effort match or beat the mid tier at low/medium on bounded agentic coding.
  - The smart tier's real advantage is long-horizon robustness (SWE-Marathon, TB4.0). Pay for it on autonomous runs, not on routine edits.
- **Cache economics:** V4.1 Flash cache reads cost $0.0075/M and MiMo's $0.0037/M. [venice](https://docs.venice.ai/overview/pricing) With stable system prompts and repo context these are very cheap to re-read. Keep effort constant within a session, because changing it invalidates the cache on Kimi. [kimi](https://www.kimi.com/code/docs/en/kimi-code/models.html)

## Caveats
- **Most coding benchmarks here are vendor-reported:** DeepSeek, Z.ai, Xiaomi, Moonshot, xAI and OpenAI each used different harnesses (DeepSeek Harness, Claude Code, Kimi Code, mini-SWE-agent). Treat cross-vendor comparisons as directional.
  - Artificial Analysis index numbers come from different index versions (e.g. GLM Flash 57 vs V4.1 Flash 40 vs DSV4 Flash 0731 at 34.3), so do not compare them directly.
  - I could not verify SWE-bench Verified, Aider Polyglot or BFCL scores for most of the October 2026 models. The ecosystem has largely moved to DeepSWE and Terminal-Bench 2.1/4.0.
- **Not verified on Venice:** exact per-model effort acceptance for DeepSeek V4/V4.1, GLM 5.3 (non-Flash), MiMo, Qwen 3.8 Flash, MiniMax M3 Preview, Grok Build and GPT-6 Luna. Also unverified: whether Venice's `reasoning.enabled: false` works on Kimi K3, GLM Flash and Grok 4.7, which upstream are always-on. I could not fetch the live `/v1/models` endpoint; run `curl -s 'https://api.venice.ai/api/v1/models?type=text'` to confirm.
- **No coding benchmark data found:** Qwen 3.8 Flash, MiniMax M3 Preview and Grok Build 0.1. They are listed for completeness, not recommended.
- **Pricing conflict:** a search snippet of Venice's text-models page showed DeepSeek V4.1 Flash at $0.38/$1.50, while the fetched pricing page shows $0.30/$1.20. [venice](https://docs.venice.ai/overview/pricing) [venice](https://docs.venice.ai/models/text) This may be a promotion. Read `pricing` from `/v1/models` at runtime, which now includes promotional rates. [venice](https://featurebase.venice.ai/changelog)
- **No practitioner reports:** I found no Reddit, Hacker News, Aider or Cline/Roo reports specific to these models on Venice. The reliability notes above come from vendor cards, Venice's own docs (which switched coding-agent examples to GLM 5.3 Flash because "GLM 5.1 is performing poorly as a coding and agent default"), OpenClaw's provider notes, and third-party reviews. [github](https://github.com/veniceai/api-docs/pull/548)