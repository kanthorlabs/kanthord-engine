import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnownProvider } from "@earendil-works/pi-ai";
import {
  approvedModelSchema,
  isLlmPlatform,
  LLM_PLATFORMS,
  MODEL_DEFAULT_CONTEXT_WINDOW,
  openaiCompatibleMetadataSchema,
  Platform,
} from "./platforms.ts";

const baseUrl = "https://example.com/v1";

const PI_KNOWN_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "google",
  "google-vertex",
  "openai",
  "azure",
  "openai-codex",
  "radius",
  "nvidia",
  "deepseek",
  "github-copilot",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "mistral",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "huggingface",
  "fireworks",
  "together",
  "baseten",
  "opencode",
  "opencode-go",
  "kimi-coding",
  "meta",
  "typesafe",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
] as const satisfies readonly KnownProvider[];
const PLATFORM_COUNT = 44;
test("the platform table holds openai-compatible, anthropic-subscription and every pi-ai known provider", () => {
  const platforms = Object.keys(LLM_PLATFORMS);
  assert.equal(platforms.length, PLATFORM_COUNT);
  assert.deepEqual(
    platforms.toSorted(),
    [
      Platform.OpenAICompatible,
      Platform.AnthropicSubscription,
      ...PI_KNOWN_PROVIDERS,
    ].toSorted(),
  );
  assert.equal(isLlmPlatform("groq"), true);
  assert.equal(isLlmPlatform("github"), false);
  assert.equal(isLlmPlatform("s3"), false);
  assert.equal(isLlmPlatform("unknown"), false);
  assert.equal(isLlmPlatform("toString"), false);
});

test("model defaults permit id alone and constrain max_tokens after defaults", () => {
  assert.deepEqual(approvedModelSchema.parse({ id: "model" }), { id: "model" });
  assert.deepEqual(
    openaiCompatibleMetadataSchema.parse({
      base_url: baseUrl,
      models: [{ id: "model" }],
    }).models,
    [{ id: "model" }],
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      context_window: 32,
      max_tokens: 32,
    }).success,
    true,
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      context_window: 32,
      max_tokens: 33,
    }).success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({ id: "model", context_window: 1 }).success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      max_tokens: MODEL_DEFAULT_CONTEXT_WINDOW + 1,
    }).success,
    false,
  );
});
