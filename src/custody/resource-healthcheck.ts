import {
  HeadBucketCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  createModels,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type CredentialStore,
  type Context as ModelContext,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { abortSignal, type Context } from "../kernel/context.ts";
import {
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { isObject } from "../kernel/values.ts";
import {
  apiKeySecretSchema,
  oauthSecretSchema,
  openaiCompatibleMetadataSchema,
  Platform,
} from "./platforms.ts";

export const CAPABILITY_RATE_LIMIT_READ = "rate-limit read";
export const CAPABILITY_COPILOT_TOKEN_READ = "copilot token read";
export const CAPABILITY_MODEL_LIST_READ = "model-list read";
export const CAPABILITY_KEY_READ = "key read";
export const CAPABILITY_MODEL_CALL = "model call";
export const CAPABILITY_BUCKET_HEAD = "bucket head";
export const CAPABILITY_NONE = "none";
export const TARGET_KIND_CREDENTIAL = "credential";

export const PLATFORM_CAPABILITY: Partial<Record<Platform, string>> = {
  [Platform.GitHub]: CAPABILITY_RATE_LIMIT_READ,
  [Platform.GitHubCopilot]: CAPABILITY_COPILOT_TOKEN_READ,
  [Platform.OpenAICodex]: CAPABILITY_MODEL_CALL,
  [Platform.Anthropic]: CAPABILITY_MODEL_LIST_READ,
  [Platform.OpenAICompatible]: CAPABILITY_MODEL_LIST_READ,
  [Platform.OpenRouter]: CAPABILITY_KEY_READ,
  [Platform.OpenAI]: CAPABILITY_MODEL_LIST_READ,
  [Platform.S3]: CAPABILITY_BUCKET_HEAD,
};

export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";
export const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_PROBE_MODEL = "gpt-5.6-luna";
export const OPENAI_CODEX_PROBE_REASONING = "low";
export const OPENAI_CODEX_PROBE_PROMPT = "What time is it?";
const MODEL_CALL_FAILURES: readonly string[] = ["error", "aborted"];
export const MODELS_PATH = "/models";
export const AUTHORIZATION_HEADER = "Authorization";
export const ANTHROPIC_API_KEY_HEADER = "x-api-key";
export const ANTHROPIC_VERSION_HEADER = "anthropic-version";
export const ANTHROPIC_VERSION = "2023-06-01";
export const GITHUB_COPILOT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const REASON_MAX_LENGTH = 300;
const EMPTY_LENGTH = 0;
const REDACTED = "[redacted]";
const BEARER_PATTERN = /Bearer\s+\S+/gi;
const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const TOKEN_PATTERN = /[A-Za-z0-9_\-+/=.]{32,}/g;

export function redactReason(
  text: string,
  secrets: readonly string[] = [],
): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length > EMPTY_LENGTH)
      result = result.split(secret).join(REDACTED);
  return result
    .replace(BEARER_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(TOKEN_PATTERN, REDACTED)
    .slice(0, REASON_MAX_LENGTH);
}

function thrownReason(error: unknown, secrets: readonly string[]): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return redactReason(`${name}: ${message}`, secrets);
}

async function probeHttp(
  url: string,
  headers: Record<string, string>,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return ResourceStatus.Unknown;
      const response = await globalThis.fetch(url, {
        method: HttpMethod.Get,
        headers,
        signal,
        redirect: "manual",
      });
      await response.body?.cancel();
      if (signal.aborted) return ResourceStatus.Unknown;
      if (response.status === HttpStatus.OK) return ResourceStatus.Healthy;
      observe?.(`status=${response.status}`);
      if (response.status === HttpStatus.Forbidden)
        return ResourceStatus.Unknown;
      return ResourceStatus.Unhealthy;
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, Object.values(headers)));
    return ResourceStatus.Unknown;
  }
}

export async function probeGitHub(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    GITHUB_RATE_LIMIT_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
    observe,
  );
}

export async function probeGitHubCopilot(
  refresh: string,
  expires: number,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  if (expires <= Date.now()) return ResourceStatus.Unknown;
  return probeHttp(
    GITHUB_COPILOT_TOKEN_URL,
    {
      ...GITHUB_COPILOT_HEADERS,
      [AUTHORIZATION_HEADER]: `Bearer ${refresh}`,
    },
    context,
    observe,
  );
}

export async function probeAnthropic(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    ANTHROPIC_MODELS_URL,
    {
      [ANTHROPIC_API_KEY_HEADER]: apiKey,
      [ANTHROPIC_VERSION_HEADER]: ANTHROPIC_VERSION,
    },
    context,
    observe,
  );
}

export async function probeOpenAICompatible(
  apiKey: string,
  baseUrl: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    baseUrl + MODELS_PATH,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
    observe,
  );
}

export async function probeOpenRouter(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    OPENROUTER_KEY_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
    observe,
  );
}

export async function probeOpenAI(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    OPENAI_MODELS_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
    observe,
  );
}

export type ModelCall = (
  model: Model<Api>,
  context: ModelContext,
  options: ModelsSimpleStreamOptions,
  credentials: CredentialStore,
) => Promise<AssistantMessage>;

const defaultModelCall: ModelCall = (model, context, options, credentials) => {
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  return models.completeSimple(model, context, options);
};

export interface CodexCredential {
  refresh: string;
  access: string;
  expires: number;
}

function failureReason(
  status: number,
  reply: AssistantMessage,
  secrets: readonly string[],
): string {
  const message = redactReason(reply.errorMessage ?? "", secrets);
  return `status=${status} stopReason=${reply.stopReason} errorMessage=${message}`;
}

export async function probeOpenAICodex(
  credential: CodexCredential,
  context: Context,
  call: ModelCall = defaultModelCall,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  const { refresh, access, expires } = credential;
  const secrets = [refresh, access];
  if (expires <= Date.now()) {
    observe?.("access token expired");
    return ResourceStatus.Unknown;
  }
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return ResourceStatus.Unknown;
      const model = getBuiltinModels(OPENAI_CODEX_PROVIDER_ID).find(
        ({ id }) => id === OPENAI_CODEX_PROBE_MODEL,
      );
      if (!model) {
        observe?.("probe model not found");
        return ResourceStatus.Unknown;
      }
      const credentials = new InMemoryCredentialStore();
      await credentials.modify(OPENAI_CODEX_PROVIDER_ID, async () => ({
        type: "oauth" as const,
        refresh,
        access,
        expires,
      }));
      let status = 0;
      const reply = await call(
        model,
        {
          messages: [
            {
              role: "user",
              content: OPENAI_CODEX_PROBE_PROMPT,
              timestamp: Date.now(),
            },
          ],
        },
        {
          reasoning: OPENAI_CODEX_PROBE_REASONING,
          signal,
          onResponse: (response) => {
            status = response.status;
          },
        },
        credentials,
      );
      if (signal.aborted) return ResourceStatus.Unknown;
      if (!MODEL_CALL_FAILURES.includes(reply.stopReason))
        return ResourceStatus.Healthy;
      observe?.(failureReason(status, reply, secrets));
      if (status === HttpStatus.Unauthorized || status === HttpStatus.Forbidden)
        return ResourceStatus.Unhealthy;
      return ResourceStatus.Unknown;
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, secrets));
    return ResourceStatus.Unknown;
  }
}

export interface LlmProviderValidator {
  probe(
    secret: unknown,
    metadata: unknown,
    context: Context,
    observe?: ResourceObserver,
  ): Promise<ResourceStatusValue>;
}

export const LLM_PROVIDER_VALIDATORS: Partial<
  Record<Platform, LlmProviderValidator>
> = {
  [Platform.OpenAICodex]: {
    probe: (secret, _metadata, context, observe) =>
      probeOpenAICodex(
        oauthSecretSchema.parse(secret),
        context,
        undefined,
        observe,
      ),
  },
  [Platform.Anthropic]: {
    probe: (secret, _metadata, context, observe) =>
      probeAnthropic(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.OpenAICompatible]: {
    probe: (secret, metadata, context, observe) =>
      probeOpenAICompatible(
        apiKeySecretSchema.parse(secret).key,
        openaiCompatibleMetadataSchema.parse(metadata).baseUrl,
        context,
        observe,
      ),
  },
  [Platform.OpenRouter]: {
    probe: (secret, _metadata, context, observe) =>
      probeOpenRouter(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.OpenAI]: {
    probe: (secret, _metadata, context, observe) =>
      probeOpenAI(apiKeySecretSchema.parse(secret).key, context, observe),
  },
};

type BucketClient = {
  send(
    command: HeadBucketCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
};
type CreateBucketClient = (config: S3ClientConfig) => BucketClient;

function bucketStatus(
  value: unknown,
  secrets: readonly string[],
  observe?: ResourceObserver,
): ResourceStatusValue {
  if (!isObject(value) || !("$metadata" in value)) {
    observe?.(thrownReason(value, secrets));
    return ResourceStatus.Unknown;
  }
  const metadata = value.$metadata;
  if (!isObject(metadata) || !("httpStatusCode" in metadata)) {
    observe?.(thrownReason(value, secrets));
    return ResourceStatus.Unknown;
  }
  if (metadata.httpStatusCode === HttpStatus.OK) return ResourceStatus.Healthy;
  observe?.(`status=${String(metadata.httpStatusCode)}`);
  if (metadata.httpStatusCode === HttpStatus.NotFound)
    return ResourceStatus.Unhealthy;
  return ResourceStatus.Unknown;
}

async function headBucket(
  client: BucketClient,
  bucket: string,
  signal: AbortSignal,
  secrets: readonly string[],
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const response = await client.send(
      new HeadBucketCommand({ Bucket: bucket }),
      {
        abortSignal: signal,
      },
    );
    return signal.aborted
      ? ResourceStatus.Unknown
      : bucketStatus(response, secrets, observe);
  } catch (error) {
    return signal.aborted
      ? ResourceStatus.Unknown
      : bucketStatus(error, secrets, observe);
  } finally {
    client.destroy();
  }
}

export async function probeS3(
  accessKeyId: string,
  secretAccessKey: string,
  endpoint: string,
  bucket: string,
  region: string,
  context: Context,
  createClient: CreateBucketClient = (config) => new S3Client(config),
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return ResourceStatus.Unknown;
      const client = createClient({
        endpoint,
        region,
        credentials: { accessKeyId, secretAccessKey },
      });
      return await headBucket(
        client,
        bucket,
        signal,
        [accessKeyId, secretAccessKey],
        observe,
      );
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, [accessKeyId, secretAccessKey]));
    return ResourceStatus.Unknown;
  }
}
