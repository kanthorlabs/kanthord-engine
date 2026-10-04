import type { KnownProvider } from "@earendil-works/pi-ai";
import { z } from "zod";
import { piCredentialSchema, PlatformKind, SecretShape } from "./contract.ts";
import { LoginSessionMode } from "./sessions.ts";
export { PlatformKind, SecretShape } from "./contract.ts";

export type Platform = KnownProvider | "github" | "s3" | "openai-compatible";
export const Platform = {
  GitHub: "github",
  GitHubCopilot: "github-copilot",
  OpenAICodex: "openai-codex",
  Anthropic: "anthropic",
  OpenAICompatible: "openai-compatible",
  OpenRouter: "openrouter",
  OpenAI: "openai",
  AmazonBedrock: "amazon-bedrock",
  GoogleVertex: "google-vertex",
  AzureOpenAIResponses: "azure-openai-responses",
  CloudflareWorkersAI: "cloudflare-workers-ai",
  CloudflareAIGateway: "cloudflare-ai-gateway",
  S3: "s3",
} as const satisfies Record<string, Platform>;

export const RESERVED_NAME_LOGIN = "login";
export const RESERVED_NAME_PLATFORM = "platform";
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
  models: z
    .array(approvedModelSchema)
    .refine(
      (models) => new Set(models.map(({ id }) => id)).size === models.length,
    ),
});
export const s3MetadataSchema = z.strictObject({
  endpoint: z.url(),
  bucket: z.string().min(1).refine(isNonblank),
  region: z.string().min(1).refine(isNonblank),
});

const nonblankStringSchema = z.string().min(1).refine(isNonblank);
export const amazonBedrockMetadataSchema = z.strictObject({
  region: nonblankStringSchema,
});
export const googleVertexMetadataSchema = z.strictObject({
  project: nonblankStringSchema,
  location: nonblankStringSchema,
});
export const azureOpenAIResponsesMetadataSchema = z.strictObject({
  resource_name: nonblankStringSchema,
});
export const cloudflareWorkersAIMetadataSchema = z.strictObject({
  account_id: nonblankStringSchema,
});
export const cloudflareAIGatewayMetadataSchema = z.strictObject({
  account_id: nonblankStringSchema,
  gateway_id: nonblankStringSchema,
});

export type PlatformValidator = {
  kind: PlatformKind;
  secretShape: SecretShape;
  loginModes: readonly LoginSessionMode[];
  metadataSchema: z.ZodObject | null;
  verifiable: boolean;
};

const NO_LOGIN_MODES: readonly LoginSessionMode[] = [];

function llmApiKey(
  verifiable: boolean,
  metadataSchema: z.ZodObject | null = null,
): PlatformValidator {
  return {
    kind: PlatformKind.Llm,
    secretShape: SecretShape.ApiKey,
    loginModes: NO_LOGIN_MODES,
    metadataSchema,
    verifiable,
  };
}

function llmOAuth(loginModes: readonly LoginSessionMode[]): PlatformValidator {
  return {
    kind: PlatformKind.Llm,
    secretShape: SecretShape.OAuth,
    loginModes,
    metadataSchema: null,
    verifiable: true,
  };
}

export const PLATFORM_VALIDATORS: Readonly<
  Record<Platform, PlatformValidator>
> = {
  [Platform.GitHub]: {
    kind: PlatformKind.Git,
    secretShape: SecretShape.ApiKey,
    loginModes: NO_LOGIN_MODES,
    metadataSchema: null,
    verifiable: true,
  },
  [Platform.GitHubCopilot]: llmOAuth([LoginSessionMode.Device]),
  [Platform.OpenAICodex]: llmOAuth([
    LoginSessionMode.Browser,
    LoginSessionMode.Device,
  ]),
  [Platform.Anthropic]: llmApiKey(true),
  [Platform.OpenAICompatible]: llmApiKey(true, openaiCompatibleMetadataSchema),
  [Platform.OpenRouter]: llmApiKey(true),
  [Platform.OpenAI]: llmApiKey(true),
  [Platform.AmazonBedrock]: llmApiKey(false, amazonBedrockMetadataSchema),
  [Platform.GoogleVertex]: llmApiKey(false, googleVertexMetadataSchema),
  [Platform.AzureOpenAIResponses]: llmApiKey(
    false,
    azureOpenAIResponsesMetadataSchema,
  ),
  [Platform.CloudflareWorkersAI]: llmApiKey(
    false,
    cloudflareWorkersAIMetadataSchema,
  ),
  [Platform.CloudflareAIGateway]: llmApiKey(
    false,
    cloudflareAIGatewayMetadataSchema,
  ),
  "ant-ling": llmApiKey(false),
  google: llmApiKey(false),
  radius: llmApiKey(false),
  nvidia: llmApiKey(false),
  deepseek: llmApiKey(false),
  xai: llmApiKey(false),
  groq: llmApiKey(false),
  cerebras: llmApiKey(false),
  "vercel-ai-gateway": llmApiKey(false),
  zai: llmApiKey(false),
  "zai-coding-cn": llmApiKey(false),
  mistral: llmApiKey(false),
  minimax: llmApiKey(false),
  "minimax-cn": llmApiKey(false),
  moonshotai: llmApiKey(false),
  "moonshotai-cn": llmApiKey(false),
  huggingface: llmApiKey(false),
  fireworks: llmApiKey(false),
  together: llmApiKey(false),
  baseten: llmApiKey(false),
  opencode: llmApiKey(false),
  "opencode-go": llmApiKey(false),
  "kimi-coding": llmApiKey(false),
  "qwen-token-plan": llmApiKey(false),
  "qwen-token-plan-cn": llmApiKey(false),
  "qwen-token-plan-individual": llmApiKey(false),
  xiaomi: llmApiKey(false),
  "xiaomi-token-plan-cn": llmApiKey(false),
  "xiaomi-token-plan-ams": llmApiKey(false),
  "xiaomi-token-plan-sgp": llmApiKey(false),
  [Platform.S3]: {
    kind: PlatformKind.Storage,
    secretShape: SecretShape.S3AccessKey,
    loginModes: NO_LOGIN_MODES,
    metadataSchema: s3MetadataSchema,
    verifiable: true,
  },
};

const secretSchemas: Record<SecretShape, z.ZodType> = {
  [SecretShape.ApiKey]: apiKeySecretSchema,
  [SecretShape.OAuth]: oauthSecretSchema,
  [SecretShape.S3AccessKey]: s3AccessKeySecretSchema,
};
const STRING_FIELD_TYPE = "string";

export function isPlatform(value: string): value is Platform {
  return Object.hasOwn(PLATFORM_VALIDATORS, value);
}

export function secretSchemaForPlatform(platform: Platform): z.ZodType {
  return secretSchemas[PLATFORM_VALIDATORS[platform].secretShape];
}

export function metadataSchemaForPlatform(
  platform: Platform,
): z.ZodObject | null {
  return PLATFORM_VALIDATORS[platform].metadataSchema;
}

export function metadataFieldsForPlatform(platform: Platform): string[] {
  const schema = metadataSchemaForPlatform(platform);
  if (schema === null) return [];
  return Object.entries(schema.shape)
    .filter(([, field]) => field._zod.def.type === STRING_FIELD_TYPE)
    .map(([name]) => name);
}

export function validateNameForm(name: string): boolean {
  return (
    name.length <= CREDENTIAL_NAME_MAX_LENGTH && /^[a-z][a-z0-9-]*$/.test(name)
  );
}
