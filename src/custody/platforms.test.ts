import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiKeySecretSchema,
  approvedModelSchema,
  CREDENTIAL_NAME_MAX_LENGTH,
  isNonblank,
  metadataSchemaForPlatform,
  MODEL_DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULT_REASONING_LEVELS,
  OAUTH_PLATFORMS,
  oauthSecretSchema,
  openaiCompatibleMetadataSchema,
  Platform,
  PLATFORM_SECRET_SHAPE,
  ReasoningLevel,
  RESERVED_NAME_LOGIN,
  s3AccessKeySecretSchema,
  s3MetadataSchema,
  SecretShape,
  secretSchemaForPlatform,
  validateNameForm,
} from "./platforms.ts";

const baseUrl = "https://example.com/v1";
const s3Metadata = {
  endpoint: "https://s3.example.com",
  bucket: "bucket",
  region: "us-east-1",
};

test("platforms map to the correct secret shapes", () => {
  assert.deepEqual(PLATFORM_SECRET_SHAPE, {
    [Platform.GitHub]: SecretShape.ApiKey,
    [Platform.GitHubCopilot]: SecretShape.OAuth,
    [Platform.OpenAICodex]: SecretShape.OAuth,
    [Platform.Anthropic]: SecretShape.ApiKey,
    [Platform.OpenAICompatible]: SecretShape.ApiKey,
    [Platform.OpenRouter]: SecretShape.ApiKey,
    [Platform.S3]: SecretShape.S3AccessKey,
  });
  assert.deepEqual(OAUTH_PLATFORMS, [
    Platform.GitHubCopilot,
    Platform.OpenAICodex,
  ]);
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

test("only openai-compatible and s3 platforms have metadata schemas", () => {
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
  assert.equal(isNonblank("  "), false);
  assert.equal(isNonblank(" a "), true);
});
