import { z } from "zod";
import { piCredentialSchema, SecretShape } from "./contract.ts";
export { SecretShape } from "./contract.ts";

export const Platform = {
  GitHub: "github",
  GitHubCopilot: "github-copilot",
  Anthropic: "anthropic",
  OpenAICompatible: "openai-compatible",
  S3: "s3",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const PLATFORM_SECRET_SHAPE: Record<Platform, SecretShape> = {
  [Platform.GitHub]: SecretShape.ApiKey,
  [Platform.GitHubCopilot]: SecretShape.OAuth,
  [Platform.Anthropic]: SecretShape.ApiKey,
  [Platform.OpenAICompatible]: SecretShape.ApiKey,
  [Platform.S3]: SecretShape.S3AccessKey,
};
export const OAUTH_PLATFORMS: readonly Platform[] = [Platform.GitHubCopilot];
export const RESERVED_NAME_LOGIN = "login";
export const CREDENTIAL_NAME_MAX_LENGTH = 63;
const EMPTY_STRING_LENGTH = 0;

export function isNonblank(s: string): boolean {
  return s.trim().length > EMPTY_STRING_LENGTH;
}

export const apiKeySecretSchema = z
  .strictObject({
    key: z.string().min(1).refine(isNonblank),
  })
  .refine(
    (secret) =>
      piCredentialSchema.safeParse({ type: SecretShape.ApiKey, ...secret })
        .success,
  );
export const oauthSecretSchema = z
  .strictObject({
    refresh: z.string().min(1),
    access: z.string().min(1),
    expires: z.number().int(),
  })
  .refine(
    (secret) =>
      piCredentialSchema.safeParse({ type: SecretShape.OAuth, ...secret })
        .success,
  );
export const s3AccessKeySecretSchema = z.strictObject({
  accessKeyId: z.string().min(1).refine(isNonblank),
  secretAccessKey: z.string().min(1).refine(isNonblank),
});

export const ReasoningLevel = {
  Off: "off",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const;
export type ReasoningLevel =
  (typeof ReasoningLevel)[keyof typeof ReasoningLevel];

export const MODEL_DEFAULT_CONTEXT_WINDOW = 128000;
export const MODEL_DEFAULT_MAX_TOKENS = 16384;
export const MODEL_DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = [
  ReasoningLevel.Off,
];

export const approvedModelSchema = z
  .strictObject({
    id: z.string().min(1).refine(isNonblank),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoningLevels: z.array(z.enum(ReasoningLevel)).optional(),
  })
  .refine((model) => {
    const contextWindow = model.contextWindow ?? MODEL_DEFAULT_CONTEXT_WINDOW;
    const maxTokens = model.maxTokens ?? MODEL_DEFAULT_MAX_TOKENS;
    return maxTokens <= contextWindow;
  });

export const openaiCompatibleMetadataSchema = z.strictObject({
  baseUrl: z.string().regex(/^https?:\/\/[^?#]+[^?#/]$/),
  models: z.array(approvedModelSchema),
});
export const s3MetadataSchema = z.strictObject({
  endpoint: z.url(),
  bucket: z.string().min(1).refine(isNonblank),
  region: z.string().min(1).refine(isNonblank),
});

const secretSchemas: Record<Platform, z.ZodType> = {
  [Platform.GitHub]: apiKeySecretSchema,
  [Platform.GitHubCopilot]: oauthSecretSchema,
  [Platform.Anthropic]: apiKeySecretSchema,
  [Platform.OpenAICompatible]: apiKeySecretSchema,
  [Platform.S3]: s3AccessKeySecretSchema,
};
const metadataSchemas: Record<Platform, z.ZodType | null> = {
  [Platform.GitHub]: null,
  [Platform.GitHubCopilot]: null,
  [Platform.Anthropic]: null,
  [Platform.OpenAICompatible]: openaiCompatibleMetadataSchema,
  [Platform.S3]: s3MetadataSchema,
};

export function secretSchemaForPlatform(platform: Platform): z.ZodType {
  return secretSchemas[platform];
}

export function metadataSchemaForPlatform(
  platform: Platform,
): z.ZodType | null {
  return metadataSchemas[platform];
}

export function validateNameForm(name: string): boolean {
  return (
    name.length <= CREDENTIAL_NAME_MAX_LENGTH && /^[a-z][a-z0-9-]*$/.test(name)
  );
}
