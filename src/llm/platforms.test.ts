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
  approvedModels,
  LLM_PLATFORMS,
  LLM_PROVIDERS,
  MODEL_DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULT_MAX_TOKENS,
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
  Platform.OpencodeGo,
];
const METADATA_FIELDS: Partial<Record<Platform, string[]>> = {
  [Platform.OpenAICompatible]: ["base_url"],
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
      item.secret_shape,
      platform === Platform.GitHubCopilot || platform === Platform.OpenAICodex
        ? SecretShape.OAuth
        : SecretShape.ApiKey,
      platform,
    );
    assert.deepEqual(
      item.login_modes,
      platform === Platform.GitHubCopilot
        ? [LoginSessionMode.Device]
        : platform === Platform.OpenAICodex
          ? [LoginSessionMode.Browser, LoginSessionMode.Device]
          : [],
      platform,
    );
    assert.deepEqual(
      item.metadata_fields,
      METADATA_FIELDS[platform] ?? [],
      platform,
    );
    assert.equal(
      LLM_PLATFORMS[platform].metadata_schema === null,
      METADATA_FIELDS[platform] === undefined,
      platform,
    );
    assert.equal(
      item.verifiable,
      VERIFIABLE_PLATFORMS.includes(platform),
      platform,
    );
    assert.equal(
      item.verifiable,
      Object.hasOwn(LLM_PROVIDERS, platform),
      platform,
    );
  }
  assert.deepEqual(
    Object.keys(LLM_PROVIDERS).toSorted(),
    VERIFIABLE_PLATFORMS.toSorted(),
  );
});

test("secret schema is selected for every platform", () => {
  for (const [platform, entry] of Object.entries(LLM_PLATFORMS))
    assert.equal(
      secretSchemas[entry.secret_shape],
      platform === Platform.GitHubCopilot || platform === Platform.OpenAICodex
        ? oauthSecretSchema
        : apiKeySecretSchema,
      platform,
    );
});

test("openai-compatible metadata requires base_url and models", () => {
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({ models: [] }).success,
    false,
  );
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({ base_url: baseUrl }).success,
    false,
  );
  assert.deepEqual(
    openaiCompatibleMetadataSchema.parse({ base_url: baseUrl, models: [] }),
    {
      base_url: baseUrl,
      models: [],
    },
  );
  assert.equal(
    openaiCompatibleMetadataSchema.safeParse({
      base_url: baseUrl,
      models: [],
      extra: true,
    }).success,
    false,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.OpenAICompatible].metadata_schema,
    openaiCompatibleMetadataSchema,
  );
});

test("openai-compatible base_url refuses query, fragment and trailing slash", () => {
  for (const invalid of [
    `${baseUrl}?key=value`,
    `${baseUrl}#fragment`,
    `${baseUrl}/`,
  ]) {
    assert.equal(
      openaiCompatibleMetadataSchema.safeParse({
        base_url: invalid,
        models: [],
      }).success,
      false,
    );
  }
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
  assert.deepEqual(MODEL_DEFAULT_REASONING_LEVELS, [ReasoningLevel.Off]);
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
  assert.equal(approvedModelSchema.safeParse({ id: "  " }).success, false);
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      reasoning_levels: [ReasoningLevel.High],
    }).success,
    true,
  );
  assert.equal(
    approvedModelSchema.safeParse({
      id: "model",
      reasoning_levels: ["invalid"],
    }).success,
    false,
  );
  assert.equal(
    approvedModelSchema.safeParse({ id: "model", extra: true }).success,
    false,
  );
});

test("only the platforms with metadata fields have metadata schemas", () => {
  assert.equal(LLM_PLATFORMS.groq.metadata_schema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenAI].metadata_schema, null);
  assert.equal(LLM_PLATFORMS[Platform.GitHubCopilot].metadata_schema, null);
  assert.equal(LLM_PLATFORMS[Platform.Anthropic].metadata_schema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenRouter].metadata_schema, null);
  assert.equal(LLM_PLATFORMS[Platform.OpenAICodex].metadata_schema, null);
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

test("approved models answer openai-compatible metadata models with the defaults applied", () => {
  const CONTEXT_WINDOW = 64000;
  const MAX_TOKENS = 4096;
  const metadata = {
    base_url: "https://models.example/v1",
    models: [
      { id: "plain" },
      {
        id: "tuned",
        context_window: CONTEXT_WINDOW,
        max_tokens: MAX_TOKENS,
        reasoning_levels: [ReasoningLevel.High],
      },
    ],
  };
  assert.deepEqual(approvedModels(Platform.OpenAICompatible, metadata), [
    {
      id: "plain",
      context_window: MODEL_DEFAULT_CONTEXT_WINDOW,
      max_tokens: MODEL_DEFAULT_MAX_TOKENS,
      reasoning_levels: MODEL_DEFAULT_REASONING_LEVELS,
    },
    {
      id: "tuned",
      context_window: CONTEXT_WINDOW,
      max_tokens: MAX_TOKENS,
      reasoning_levels: [ReasoningLevel.High],
    },
  ]);
  assert.equal(approvedModels(Platform.OpenAICompatible, null), null);
  assert.equal(approvedModels(Platform.Anthropic, metadata), null);
  assert.throws(() =>
    approvedModels(Platform.OpenAICompatible, { models: "broken" }),
  );
});
