import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { z } from "zod";
import {
  apiKeySecretSchema,
  credentialPlatformList,
  LoginSessionMode,
  oauthSecretSchema,
  secretSchemas,
  SecretShape,
} from "../custody/contract.ts";
import {
  amazonBedrockMetadataSchema,
  approvedModelSchema,
  azureOpenAIResponsesMetadataSchema,
  cloudflareAIGatewayMetadataSchema,
  cloudflareWorkersAIMetadataSchema,
  googleVertexMetadataSchema,
  isLlmPlatform,
  LLM_PLATFORMS,
  MODEL_DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULT_REASONING_LEVELS,
  openaiCompatibleMetadataSchema,
  Platform,
  ReasoningLevel,
} from "./platforms.ts";

const baseUrl = "https://example.com/v1";

const PI_KNOWN_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "google",
  "google-vertex",
  "openai",
  "azure-openai-responses",
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
const PLATFORM_COUNT = 41;
const VERIFIABLE_PLATFORMS: Platform[] = [
  Platform.GitHubCopilot,
  Platform.OpenAICodex,
  Platform.Anthropic,
  Platform.OpenAICompatible,
  Platform.OpenRouter,
  Platform.OpenAI,
];
const METADATA_FIELDS: Partial<Record<Platform, string[]>> = {
  [Platform.OpenAICompatible]: ["baseUrl"],
  [Platform.AmazonBedrock]: ["region"],
  [Platform.GoogleVertex]: ["project", "location"],
  [Platform.AzureOpenAIResponses]: ["resource_name"],
  [Platform.CloudflareWorkersAI]: ["account_id"],
  [Platform.CloudflareAIGateway]: ["account_id", "gateway_id"],
};

test("the platform table holds openai-compatible and every pi-ai known provider", () => {
  const platforms = Object.keys(LLM_PLATFORMS);
  assert.equal(platforms.length, PLATFORM_COUNT);
  assert.deepEqual(
    platforms.toSorted(),
    [Platform.OpenAICompatible, ...PI_KNOWN_PROVIDERS].toSorted(),
  );
  assert.equal(isLlmPlatform("groq"), true);
  assert.equal(isLlmPlatform("github"), false);
  assert.equal(isLlmPlatform("s3"), false);
  assert.equal(isLlmPlatform("unknown"), false);
  assert.equal(isLlmPlatform("toString"), false);
});

test("the platform list fixes secret shape, login modes, metadata fields and verifiability", () => {
  const { items } = credentialPlatformList(LLM_PLATFORMS);
  assert.equal(items.length, PLATFORM_COUNT);
  for (const item of items) {
    const platform = item.platform as Platform;
    assert.equal(
      item.secretShape,
      platform === Platform.GitHubCopilot || platform === Platform.OpenAICodex
        ? SecretShape.OAuth
        : SecretShape.ApiKey,
      platform,
    );
    assert.deepEqual(
      item.loginModes,
      platform === Platform.GitHubCopilot
        ? [LoginSessionMode.Device]
        : platform === Platform.OpenAICodex
          ? [LoginSessionMode.Browser, LoginSessionMode.Device]
          : [],
      platform,
    );
    assert.deepEqual(
      item.metadataFields,
      METADATA_FIELDS[platform] ?? [],
      platform,
    );
    assert.equal(
      LLM_PLATFORMS[platform].metadataSchema === null,
      METADATA_FIELDS[platform] === undefined,
      platform,
    );
    assert.equal(
      item.verifiable,
      VERIFIABLE_PLATFORMS.includes(platform),
      platform,
    );
  }
});

test("secret schema is selected for every platform", () => {
  for (const [platform, entry] of Object.entries(LLM_PLATFORMS))
    assert.equal(
      secretSchemas[entry.secretShape],
      platform === Platform.GitHubCopilot || platform === Platform.OpenAICodex
        ? oauthSecretSchema
        : apiKeySecretSchema,
      platform,
    );
});

test("openai-compatible metadata requires baseUrl and models", () => {
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({ models: [] }).success,
    false,
  );
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({ baseUrl }).success,
    false,
  );
  assert.deepEqual(
    openaiCompatibleMetadataSchema.parse({ baseUrl, models: [] }),
    {
      baseUrl,
      models: [],
    },
  );
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({
      baseUrl,
      models: [],
      extra: true,
    }).success,
    false,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.OpenAICompatible].metadataSchema,
    openaiCompatibleMetadataSchema,
  );
});

test("openai-compatible baseUrl refuses query, fragment and trailing slash", () => {
  for (const invalid of [
    `${baseUrl}?key=value`,
    `${baseUrl}#fragment`,
    `${baseUrl}/`,
  ]) {
    assert.equal(
      openaiCompatibleMetadataSchema.safeParse({ baseUrl: invalid, models: [] })
        .success,
      false,
    );
  }
});

test("model defaults permit id alone and constrain maxTokens after defaults", () => {
  assert.deepEqual(approvedModelSchema.parse({ id: "model" }), { id: "model" });
  assert.deepEqual(
    openaiCompatibleMetadataSchema.parse({ baseUrl, models: [{ id: "model" }] })
      .models,
    [{ id: "model" }],
  );
  assert.deepEqual(MODEL_DEFAULT_REASONING_LEVELS, [ReasoningLevel.Off]);
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      contextWindow: 32,
      maxTokens: 32,
    }).success,
    true,
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      contextWindow: 32,
      maxTokens: 33,
    }).success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({ id: "model", contextWindow: 1 }).success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      maxTokens: MODEL_DEFAULT_CONTEXT_WINDOW + 1,
    }).success,
    false,
  );
  assert.equal(approvedModelSchema.safeParse({ id: "  " }).success, false);
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      reasoningLevels: [ReasoningLevel.High],
    }).success,
    true,
  );
  assert.equal(
    approvedModelSchema.safeParse({ id: "model", reasoningLevels: ["invalid"] })
      .success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({ id: "model", extra: true }).success,
    false,
  );
});

test("only the platforms with metadata fields have metadata schemas", () => {
  assert.equal(LLM_PLATFORMS.groq.metadataSchema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenAI].metadataSchema, null);
  assert.equal(LLM_PLATFORMS[Platform.GitHubCopilot].metadataSchema, null);
  assert.equal(LLM_PLATFORMS[Platform.Anthropic].metadataSchema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenRouter].metadataSchema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenAICodex].metadataSchema, null);
});

const llmMetadataSchemas: {
  schema: z.ZodType;
  valid: Record<string, string>;
}[] = [
  { schema: amazonBedrockMetadataSchema, valid: { region: "us-east-1" } },
  {
    schema: googleVertexMetadataSchema,
    valid: { project: "project", location: "us-central1" },
  },
  {
    schema: azureOpenAIResponsesMetadataSchema,
    valid: { resource_name: "resource" },
  },
  { schema: cloudflareWorkersAIMetadataSchema, valid: { account_id: "acct" } },
  {
    schema: cloudflareAIGatewayMetadataSchema,
    valid: { account_id: "acct", gateway_id: "gateway" },
  },
];

test("llm metadata requires every field as a nonblank string and refuses unknown fields", () => {
  for (const { schema, valid } of llmMetadataSchemas) {
    assert.deepEqual(schema.parse(valid), valid);
    assert.equal(schema.safeParse({ ...valid, extra: "x" }).success, false);
    for (const field of Object.keys(valid)) {
      assert.equal(
        schema.safeParse({ ...valid, [field]: "  " }).success,
        false,
      );
      assert.equal(schema.safeParse({ ...valid, [field]: 1 }).success, false);
      const missing: Record<string, string> = { ...valid };
      delete missing[field];
      assert.equal(schema.safeParse(missing).success, false);
    }
  }
});
