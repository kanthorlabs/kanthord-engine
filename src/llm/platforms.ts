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
  probeAnthropic,
  probeGitHubCopilot,
  probeOpenAI,
  probeOpenAICodex,
  probeOpenAICompatible,
  probeOpenRouter,
} from "./probes.ts";

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

function apiKey(
  metadataSchema: z.ZodObject | null = null,
  capability = CAPABILITY_NONE,
  probe: PlatformProbe | null = null,
): CredentialPlatform {
  return {
    secretShape: SecretShape.ApiKey,
    loginModes: NO_LOGIN_MODES,
    metadataSchema,
    capability,
    probe,
  };
}

function oauth(
  loginModes: readonly LoginSessionMode[],
  capability: string,
  probe: PlatformProbe,
): CredentialPlatform {
  return {
    secretShape: SecretShape.OAuth,
    loginModes,
    metadataSchema: null,
    capability,
    probe,
  };
}

export const MODEL_PROVIDER_PROBES: Readonly<
  Partial<Record<Platform, PlatformProbe>>
> = {
  [Platform.OpenAICodex]: (secret, _metadata, context, observe) =>
    probeOpenAICodex(
      oauthSecretSchema.parse(secret),
      context,
      undefined,
      observe,
    ),
  [Platform.Anthropic]: (secret, _metadata, context, observe) =>
    probeAnthropic(apiKeySecretSchema.parse(secret).key, context, observe),
  [Platform.OpenAICompatible]: (secret, metadata, context, observe) =>
    probeOpenAICompatible(
      apiKeySecretSchema.parse(secret).key,
      openaiCompatibleMetadataSchema.parse(metadata).baseUrl,
      context,
      observe,
    ),
  [Platform.OpenRouter]: (secret, _metadata, context, observe) =>
    probeOpenRouter(apiKeySecretSchema.parse(secret).key, context, observe),
  [Platform.OpenAI]: (secret, _metadata, context, observe) =>
    probeOpenAI(apiKeySecretSchema.parse(secret).key, context, observe),
};

const probeCopilot: PlatformProbe = (secret, _metadata, context, observe) => {
  const { refresh, expires } = oauthSecretSchema.parse(secret);
  return probeGitHubCopilot(refresh, expires, context, observe);
};

export const LLM_PLATFORMS: Readonly<Record<Platform, CredentialPlatform>> = {
  [Platform.GitHubCopilot]: oauth(
    [LoginSessionMode.Device],
    CAPABILITY_COPILOT_TOKEN_READ,
    probeCopilot,
  ),
  [Platform.OpenAICodex]: oauth(
    [LoginSessionMode.Browser, LoginSessionMode.Device],
    CAPABILITY_MODEL_CALL,
    MODEL_PROVIDER_PROBES[Platform.OpenAICodex]!,
  ),
  [Platform.Anthropic]: apiKey(
    null,
    CAPABILITY_MODEL_LIST_READ,
    MODEL_PROVIDER_PROBES[Platform.Anthropic]!,
  ),
  [Platform.OpenAICompatible]: apiKey(
    openaiCompatibleMetadataSchema,
    CAPABILITY_MODEL_LIST_READ,
    MODEL_PROVIDER_PROBES[Platform.OpenAICompatible]!,
  ),
  [Platform.OpenRouter]: apiKey(
    null,
    CAPABILITY_KEY_READ,
    MODEL_PROVIDER_PROBES[Platform.OpenRouter]!,
  ),
  [Platform.OpenAI]: apiKey(
    null,
    CAPABILITY_MODEL_LIST_READ,
    MODEL_PROVIDER_PROBES[Platform.OpenAI]!,
  ),
  [Platform.AmazonBedrock]: apiKey(amazonBedrockMetadataSchema),
  [Platform.GoogleVertex]: apiKey(googleVertexMetadataSchema),
  [Platform.AzureOpenAIResponses]: apiKey(azureOpenAIResponsesMetadataSchema),
  [Platform.CloudflareWorkersAI]: apiKey(cloudflareWorkersAIMetadataSchema),
  [Platform.CloudflareAIGateway]: apiKey(cloudflareAIGatewayMetadataSchema),
  "ant-ling": apiKey(),
  google: apiKey(),
  radius: apiKey(),
  nvidia: apiKey(),
  deepseek: apiKey(),
  xai: apiKey(),
  groq: apiKey(),
  cerebras: apiKey(),
  "vercel-ai-gateway": apiKey(),
  zai: apiKey(),
  "zai-coding-cn": apiKey(),
  mistral: apiKey(),
  minimax: apiKey(),
  "minimax-cn": apiKey(),
  moonshotai: apiKey(),
  "moonshotai-cn": apiKey(),
  huggingface: apiKey(),
  fireworks: apiKey(),
  together: apiKey(),
  baseten: apiKey(),
  opencode: apiKey(),
  "opencode-go": apiKey(),
  "kimi-coding": apiKey(),
  "qwen-token-plan": apiKey(),
  "qwen-token-plan-cn": apiKey(),
  "qwen-token-plan-individual": apiKey(),
  xiaomi: apiKey(),
  "xiaomi-token-plan-cn": apiKey(),
  "xiaomi-token-plan-ams": apiKey(),
  "xiaomi-token-plan-sgp": apiKey(),
};

export function isLlmPlatform(value: string): value is Platform {
  return Object.hasOwn(LLM_PLATFORMS, value);
}
