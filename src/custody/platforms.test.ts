import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { z } from "zod";
import {
  amazonBedrockMetadataSchema,
  apiKeySecretSchema,
  approvedModelSchema,
  azureOpenAIResponsesMetadataSchema,
  cloudflareAIGatewayMetadataSchema,
  cloudflareWorkersAIMetadataSchema,
  googleVertexMetadataSchema,
  isPlatform,
  metadataFieldsForPlatform,
  CREDENTIAL_NAME_MAX_LENGTH,
  isNonblank,
  metadataSchemaForPlatform,
  MODEL_DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULT_REASONING_LEVELS,
  oauthSecretSchema,
  openaiCompatibleMetadataSchema,
  Platform,
  PLATFORM_VALIDATORS,
  PlatformKind,
  ReasoningLevel,
  RESERVED_NAME_LOGIN,
  RESERVED_NAME_PLATFORM,
  s3AccessKeySecretSchema,
  s3MetadataSchema,
  SecretShape,
  secretSchemaForPlatform,
  validateNameForm,
} from "./platforms.ts";
import { LoginSessionMode } from "./sessions.ts";

const baseUrl = "https://example.com/v1";
const s3Metadata = {
  endpoint: "https://s3.example.com",
  bucket: "bucket",
  region: "us-east-1",
};

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
const PLATFORM_COUNT = 43;
const VERIFIABLE_PLATFORMS: Platform[] = [
  Platform.GitHub,
  Platform.GitHubCopilot,
  Platform.OpenAICodex,
  Platform.Anthropic,
  Platform.OpenAICompatible,
  Platform.OpenRouter,
  Platform.OpenAI,
  Platform.S3,
];
const METADATA_FIELDS: Partial<Record<Platform, string[]>> = {
  [Platform.OpenAICompatible]: ["baseUrl"],
  [Platform.S3]: ["endpoint", "bucket", "region"],
  [Platform.AmazonBedrock]: ["region"],
  [Platform.GoogleVertex]: ["project", "location"],
  [Platform.AzureOpenAIResponses]: ["resource_name"],
  [Platform.CloudflareWorkersAI]: ["account_id"],
  [Platform.CloudflareAIGateway]: ["account_id", "gateway_id"],
};

test("the platform table holds github, s3, openai-compatible and every pi-ai known provider", () => {
  const platforms = Object.keys(PLATFORM_VALIDATORS);
  assert.equal(platforms.length, PLATFORM_COUNT);
  assert.deepEqual(
    platforms.toSorted(),
    [
      Platform.GitHub,
      Platform.S3,
      Platform.OpenAICompatible,
      ...PI_KNOWN_PROVIDERS,
    ].toSorted(),
  );
  assert.equal(isPlatform("groq"), true);
  assert.equal(isPlatform("unknown"), false);
  assert.equal(isPlatform("toString"), false);
});

test("the platform table fixes kind, secret shape, login modes, metadata fields and verifiability", () => {
  for (const [platform, validator] of Object.entries(PLATFORM_VALIDATORS) as [
    Platform,
    (typeof PLATFORM_VALIDATORS)[Platform],
  ][]) {
    assert.equal(
      validator.kind,
      platform === Platform.GitHub
        ? PlatformKind.Git
        : platform === Platform.S3
          ? PlatformKind.Storage
          : PlatformKind.Llm,
      platform,
    );
    assert.equal(
      validator.secretShape,
      platform === Platform.GitHubCopilot || platform === Platform.OpenAICodex
        ? SecretShape.OAuth
        : platform === Platform.S3
          ? SecretShape.S3AccessKey
          : SecretShape.ApiKey,
      platform,
    );
    assert.deepEqual(
      validator.loginModes,
      platform === Platform.GitHubCopilot
        ? [LoginSessionMode.Device]
        : platform === Platform.OpenAICodex
          ? [LoginSessionMode.Browser, LoginSessionMode.Device]
          : [],
      platform,
    );
    assert.deepEqual(
      metadataFieldsForPlatform(platform),
      METADATA_FIELDS[platform] ?? [],
      platform,
    );
    assert.equal(
      validator.metadataSchema === null,
      METADATA_FIELDS[platform] === undefined,
      platform,
    );
    assert.equal(
      validator.verifiable,
      VERIFIABLE_PLATFORMS.includes(platform),
      platform,
    );
  }
});

test("secret schema is selected for every platform", () => {
  assert.equal(secretSchemaForPlatform(Platform.GitHub), apiKeySecretSchema);
  assert.equal(
    secretSchemaForPlatform(Platform.GitHubCopilot),
    oauthSecretSchema,
  );
  assert.equal(
    secretSchemaForPlatform(Platform.OpenAICodex),
    oauthSecretSchema,
  );
  assert.equal(secretSchemaForPlatform(Platform.Anthropic), apiKeySecretSchema);
  assert.equal(
    secretSchemaForPlatform(Platform.OpenAICompatible),
    apiKeySecretSchema,
  );
  assert.equal(
    secretSchemaForPlatform(Platform.OpenRouter),
    apiKeySecretSchema,
  );
  assert.equal(secretSchemaForPlatform(Platform.S3), s3AccessKeySecretSchema);
  assert.equal(secretSchemaForPlatform(Platform.OpenAI), apiKeySecretSchema);
  assert.equal(secretSchemaForPlatform("groq"), apiKeySecretSchema);
});

test("secret schemas reject unknown fields and blank key material", () => {
  assert.deepEqual(apiKeySecretSchema.parse({ key: "token" }), {
    key: "token",
  });
  assert.equal(apiKeySecretSchema.safeParse({ key: "  " }).success, false);
  assert.equal(
    apiKeySecretSchema.safeParse({ key: "token", extra: 1 }).success,
    false,
  );
  assert.deepEqual(
    oauthSecretSchema.parse({ refresh: " ", access: " ", expires: 0 }),
    {
      refresh: " ",
      access: " ",
      expires: 0,
    },
  );
  assert.equal(
    oauthSecretSchema.safeParse({ refresh: "", access: "a", expires: 1 })
      .success,
    false,
  );
  assert.equal(
    oauthSecretSchema.safeParse({ refresh: "r", access: "", expires: 1 })
      .success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: " ",
      secretAccessKey: "s",
    }).success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: "a",
      secretAccessKey: " ",
    }).success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
    }).success,
    false,
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
    metadataSchemaForPlatform(Platform.OpenAICompatible),
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
  assert.equal(metadataSchemaForPlatform("groq"), null);
  assert.equal(metadataSchemaForPlatform(Platform.OpenAI), null);
  assert.equal(metadataSchemaForPlatform(Platform.GitHub), null);
  assert.equal(metadataSchemaForPlatform(Platform.GitHubCopilot), null);
  assert.equal(metadataSchemaForPlatform(Platform.Anthropic), null);
  assert.equal(metadataSchemaForPlatform(Platform.OpenRouter), null);
  assert.equal(metadataSchemaForPlatform(Platform.OpenAICodex), null);
  assert.equal(metadataSchemaForPlatform(Platform.S3), s3MetadataSchema);
});

test("s3 metadata requires a URL and nonblank bucket and region", () => {
  assert.deepEqual(s3MetadataSchema.parse(s3Metadata), s3Metadata);
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, endpoint: "not-a-url" })
      .success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, bucket: "  " }).success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, region: "  " }).success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, extra: 1 }).success,
    false,
  );
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

test("names must be lower-case, start with a letter and fit in 63 chars", () => {
  assert.equal(validateNameForm("a"), true);
  assert.equal(validateNameForm("valid-name-123"), true);
  assert.equal(validateNameForm("a".repeat(CREDENTIAL_NAME_MAX_LENGTH)), true);
  assert.equal(
    validateNameForm("a".repeat(CREDENTIAL_NAME_MAX_LENGTH + 1)),
    false,
  );
  assert.equal(validateNameForm("1name"), false);
  assert.equal(validateNameForm("Name"), false);
  assert.equal(validateNameForm(""), false);
  assert.equal(validateNameForm("a_b"), false);
  assert.equal(validateNameForm(RESERVED_NAME_LOGIN), true);
  assert.equal(validateNameForm(RESERVED_NAME_PLATFORM), true);
  assert.equal(isNonblank("  "), false);
  assert.equal(isNonblank(" a "), true);
});
