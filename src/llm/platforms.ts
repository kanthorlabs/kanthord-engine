import type { KnownProvider } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  apiKeySecretSchema,
  isNonblank,
  LoginSessionMode,
  oauthSecretSchema,
  SecretShape,
  type CredentialPlatform,
  type PlatformProbe,
} from "../custody/contract.ts";
import {
  checkAnthropic,
  checkGitHubCopilot,
  checkOpenAI,
  checkOpenAICodex,
  checkOpenAICompatible,
  checkOpencodeGo,
  checkOpenRouter,
} from "./probes.ts";
import { HEALTH_OF_CONNECTION, type LlmProvider } from "./provider.ts";

export type Platform = KnownProvider | "openai-compatible";
export const Platform = {
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
  OpencodeGo: "opencode-go",
} as const satisfies Record<string, Platform>;

export const CAPABILITY_COPILOT_TOKEN_READ = "copilot token read";
export const CAPABILITY_MODEL_LIST_READ = "model-list read";
export const CAPABILITY_KEY_READ = "key read";
export const CAPABILITY_MODEL_CALL = "model call";
export const CAPABILITY_NONE = "none";

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
    context_window: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    reasoning_levels: z.array(z.enum(ReasoningLevel)).optional(),
  })
  .refine((model) => {
    const contextWindow = model.context_window ?? MODEL_DEFAULT_CONTEXT_WINDOW;
    const maxTokens = model.max_tokens ?? MODEL_DEFAULT_MAX_TOKENS;
    return maxTokens <= contextWindow;
  });

export const openaiCompatibleMetadataSchema = z.strictObject({
  base_url: z.string().regex(/^https?:\/\/[^?#]+[^?#/]$/),
  models: z
    .array(approvedModelSchema)
    .refine(
      (models) => new Set(models.map(({ id }) => id)).size === models.length,
    ),
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

const NO_LOGIN_MODES: readonly LoginSessionMode[] = [];

export type ApprovedModel = {
  id: string;
  context_window: number;
  max_tokens: number;
  reasoning_levels: readonly ReasoningLevel[];
};

export function approvedModels(
  platform: string,
  metadata: unknown,
): ApprovedModel[] | null {
  if (platform !== Platform.OpenAICompatible || metadata === null) return null;
  return openaiCompatibleMetadataSchema.parse(metadata).models.map((model) => ({
    id: model.id,
    context_window: model.context_window ?? MODEL_DEFAULT_CONTEXT_WINDOW,
    max_tokens: model.max_tokens ?? MODEL_DEFAULT_MAX_TOKENS,
    reasoning_levels: model.reasoning_levels ?? MODEL_DEFAULT_REASONING_LEVELS,
  }));
}

export const LLM_PROVIDERS: Readonly<Partial<Record<Platform, LlmProvider>>> = {
  [Platform.GitHubCopilot]: {
    check: (secret, _metadata, context, observe) => {
      const { refresh, expires } = oauthSecretSchema.parse(secret);
      return checkGitHubCopilot(refresh, expires, context, observe);
    },
  },
  [Platform.OpenAICodex]: {
    check: (secret, _metadata, context, observe) =>
      checkOpenAICodex(
        oauthSecretSchema.parse(secret),
        context,
        undefined,
        observe,
      ),
  },
  [Platform.Anthropic]: {
    check: (secret, _metadata, context, observe) =>
      checkAnthropic(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.OpenAICompatible]: {
    check: (secret, metadata, context, observe) =>
      checkOpenAICompatible(
        apiKeySecretSchema.parse(secret).key,
        openaiCompatibleMetadataSchema.parse(metadata).base_url,
        context,
        observe,
      ),
  },
  [Platform.OpenRouter]: {
    check: (secret, _metadata, context, observe) =>
      checkOpenRouter(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.OpenAI]: {
    check: (secret, _metadata, context, observe) =>
      checkOpenAI(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.OpencodeGo]: {
    check: (secret, _metadata, context, observe) =>
      checkOpencodeGo(
        apiKeySecretSchema.parse(secret).key,
        context,
        undefined,
        observe,
      ),
  },
};

function providerProbe(platform: Platform): PlatformProbe | null {
  const provider = LLM_PROVIDERS[platform];
  if (!provider) return null;
  return async (secret, metadata, context, observe) =>
    HEALTH_OF_CONNECTION[
      (await provider.check(secret, metadata, context, observe)).connection
    ];
}

function apiKey(
  platform: Platform,
  metadataSchema: z.ZodObject | null = null,
  capability = CAPABILITY_NONE,
): CredentialPlatform {
  return {
    secret_shape: SecretShape.ApiKey,
    login_modes: NO_LOGIN_MODES,
    metadata_schema: metadataSchema,
    capability,
    probe: providerProbe(platform),
  };
}

function oauth(
  platform: Platform,
  loginModes: readonly LoginSessionMode[],
  capability: string,
): CredentialPlatform {
  return {
    secret_shape: SecretShape.OAuth,
    login_modes: loginModes,
    metadata_schema: null,
    capability,
    probe: providerProbe(platform),
  };
}

export const LLM_PLATFORMS: Readonly<Record<Platform, CredentialPlatform>> = {
  [Platform.GitHubCopilot]: oauth(
    Platform.GitHubCopilot,
    [LoginSessionMode.Device],
    CAPABILITY_COPILOT_TOKEN_READ,
  ),
  [Platform.OpenAICodex]: oauth(
    Platform.OpenAICodex,
    [LoginSessionMode.Browser, LoginSessionMode.Device],
    CAPABILITY_MODEL_CALL,
  ),
  [Platform.Anthropic]: apiKey(
    Platform.Anthropic,
    null,
    CAPABILITY_MODEL_LIST_READ,
  ),
  [Platform.OpenAICompatible]: apiKey(
    Platform.OpenAICompatible,
    openaiCompatibleMetadataSchema,
    CAPABILITY_MODEL_LIST_READ,
  ),
  [Platform.OpenRouter]: apiKey(Platform.OpenRouter, null, CAPABILITY_KEY_READ),
  [Platform.OpenAI]: apiKey(Platform.OpenAI, null, CAPABILITY_MODEL_LIST_READ),
  [Platform.AmazonBedrock]: apiKey(
    Platform.AmazonBedrock,
    amazonBedrockMetadataSchema,
  ),
  [Platform.GoogleVertex]: apiKey(
    Platform.GoogleVertex,
    googleVertexMetadataSchema,
  ),
  [Platform.AzureOpenAIResponses]: apiKey(
    Platform.AzureOpenAIResponses,
    azureOpenAIResponsesMetadataSchema,
  ),
  [Platform.CloudflareWorkersAI]: apiKey(
    Platform.CloudflareWorkersAI,
    cloudflareWorkersAIMetadataSchema,
  ),
  [Platform.CloudflareAIGateway]: apiKey(
    Platform.CloudflareAIGateway,
    cloudflareAIGatewayMetadataSchema,
  ),
  [Platform.OpencodeGo]: apiKey(
    Platform.OpencodeGo,
    null,
    CAPABILITY_MODEL_CALL,
  ),
  "ant-ling": apiKey("ant-ling"),
  google: apiKey("google"),
  radius: apiKey("radius"),
  nvidia: apiKey("nvidia"),
  deepseek: apiKey("deepseek"),
  xai: apiKey("xai"),
  groq: apiKey("groq"),
  cerebras: apiKey("cerebras"),
  "vercel-ai-gateway": apiKey("vercel-ai-gateway"),
  zai: apiKey("zai"),
  "zai-coding-cn": apiKey("zai-coding-cn"),
  mistral: apiKey("mistral"),
  minimax: apiKey("minimax"),
  "minimax-cn": apiKey("minimax-cn"),
  moonshotai: apiKey("moonshotai"),
  "moonshotai-cn": apiKey("moonshotai-cn"),
  huggingface: apiKey("huggingface"),
  fireworks: apiKey("fireworks"),
  together: apiKey("together"),
  baseten: apiKey("baseten"),
  opencode: apiKey("opencode"),
  "kimi-coding": apiKey("kimi-coding"),
  "qwen-token-plan": apiKey("qwen-token-plan"),
  "qwen-token-plan-cn": apiKey("qwen-token-plan-cn"),
  "qwen-token-plan-individual": apiKey("qwen-token-plan-individual"),
  xiaomi: apiKey("xiaomi"),
  "xiaomi-token-plan-cn": apiKey("xiaomi-token-plan-cn"),
  "xiaomi-token-plan-ams": apiKey("xiaomi-token-plan-ams"),
  "xiaomi-token-plan-sgp": apiKey("xiaomi-token-plan-sgp"),
};

export function isLlmPlatform(value: string): value is Platform {
  return Object.hasOwn(LLM_PLATFORMS, value);
}
