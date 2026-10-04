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
  type Context as ModelContext,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { abortSignal, type Context } from "../kernel/context.ts";
import { ResourceStatus, type ResourceStatusValue } from "../kernel/health.ts";
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
export const TARGET_KIND_CREDENTIAL = "credential";

export const PLATFORM_CAPABILITY: Record<Platform, string> = {
  [Platform.GitHub]: CAPABILITY_RATE_LIMIT_READ,
  [Platform.GitHubCopilot]: CAPABILITY_COPILOT_TOKEN_READ,
  [Platform.OpenAICodex]: CAPABILITY_MODEL_CALL,
  [Platform.Anthropic]: CAPABILITY_MODEL_LIST_READ,
  [Platform.OpenAICompatible]: CAPABILITY_MODEL_LIST_READ,
  [Platform.OpenRouter]: CAPABILITY_KEY_READ,
  [Platform.S3]: CAPABILITY_BUCKET_HEAD,
};

export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";
export const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
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

async function probeHttp(
  url: string,
  headers: Record<string, string>,
  context: Context,
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
      if (response.status === HttpStatus.Forbidden)
        return ResourceStatus.Unknown;
      return ResourceStatus.Unhealthy;
    } finally {
      dispose();
    }
  } catch {
    return ResourceStatus.Unknown;
  }
}

export async function probeGitHub(
  apiKey: string,
  context: Context,
): Promise<ResourceStatusValue> {
  return probeHttp(
    GITHUB_RATE_LIMIT_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
  );
}

export async function probeGitHubCopilot(
  access: string,
  expires: number,
  context: Context,
): Promise<ResourceStatusValue> {
  if (expires <= Date.now()) return ResourceStatus.Unknown;
  return probeHttp(
    GITHUB_COPILOT_TOKEN_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${access}` },
    context,
  );
}

export async function probeAnthropic(
  apiKey: string,
  context: Context,
): Promise<ResourceStatusValue> {
  return probeHttp(
    ANTHROPIC_MODELS_URL,
    {
      [ANTHROPIC_API_KEY_HEADER]: apiKey,
      [ANTHROPIC_VERSION_HEADER]: ANTHROPIC_VERSION,
    },
    context,
  );
}

export async function probeOpenAICompatible(
  apiKey: string,
  baseUrl: string,
  context: Context,
): Promise<ResourceStatusValue> {
  return probeHttp(
    baseUrl + MODELS_PATH,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
  );
}

export async function probeOpenRouter(
  apiKey: string,
  context: Context,
): Promise<ResourceStatusValue> {
  return probeHttp(
    OPENROUTER_KEY_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
  );
}

export type ModelCall = (
  model: Model<Api>,
  context: ModelContext,
  options: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

const defaultModelCall: ModelCall = (model, context, options) => {
  const models = createModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(openaiCodexProvider());
  return models.completeSimple(model, context, options);
};

export async function probeOpenAICodex(
  access: string,
  expires: number,
  context: Context,
  call: ModelCall = defaultModelCall,
): Promise<ResourceStatusValue> {
  if (expires <= Date.now()) return ResourceStatus.Unknown;
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return ResourceStatus.Unknown;
      const model = getBuiltinModels(OPENAI_CODEX_PROVIDER_ID).find(
        ({ id }) => id === OPENAI_CODEX_PROBE_MODEL,
      );
      if (!model) return ResourceStatus.Unknown;
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
          apiKey: access,
          reasoning: OPENAI_CODEX_PROBE_REASONING,
          transport: "sse",
          signal,
          onResponse: (response) => {
            status = response.status;
          },
        },
      );
      if (signal.aborted) return ResourceStatus.Unknown;
      if (!MODEL_CALL_FAILURES.includes(reply.stopReason))
        return ResourceStatus.Healthy;
      if (status === HttpStatus.Unauthorized || status === HttpStatus.Forbidden)
        return ResourceStatus.Unhealthy;
      return ResourceStatus.Unknown;
    } finally {
      dispose();
    }
  } catch {
    return ResourceStatus.Unknown;
  }
}

export interface LlmProviderValidator {
  probe(
    secret: unknown,
    metadata: unknown,
    context: Context,
  ): Promise<ResourceStatusValue>;
}

export const LLM_PROVIDER_VALIDATORS: Partial<
  Record<Platform, LlmProviderValidator>
> = {
  [Platform.OpenAICodex]: {
    probe: (secret, _metadata, context) => {
      const { access, expires } = oauthSecretSchema.parse(secret);
      return probeOpenAICodex(access, expires, context);
    },
  },
  [Platform.Anthropic]: {
    probe: (secret, _metadata, context) =>
      probeAnthropic(apiKeySecretSchema.parse(secret).key, context),
  },
  [Platform.OpenAICompatible]: {
    probe: (secret, metadata, context) =>
      probeOpenAICompatible(
        apiKeySecretSchema.parse(secret).key,
        openaiCompatibleMetadataSchema.parse(metadata).baseUrl,
        context,
      ),
  },
  [Platform.OpenRouter]: {
    probe: (secret, _metadata, context) =>
      probeOpenRouter(apiKeySecretSchema.parse(secret).key, context),
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

function bucketStatus(value: unknown): ResourceStatusValue {
  if (!isObject(value) || !("$metadata" in value))
    return ResourceStatus.Unknown;
  const metadata = value.$metadata;
  if (!isObject(metadata) || !("httpStatusCode" in metadata))
    return ResourceStatus.Unknown;
  if (metadata.httpStatusCode === HttpStatus.OK) return ResourceStatus.Healthy;
  if (metadata.httpStatusCode === HttpStatus.NotFound)
    return ResourceStatus.Unhealthy;
  return ResourceStatus.Unknown;
}

async function headBucket(
  client: BucketClient,
  bucket: string,
  signal: AbortSignal,
): Promise<ResourceStatusValue> {
  try {
    const response = await client.send(
      new HeadBucketCommand({ Bucket: bucket }),
      {
        abortSignal: signal,
      },
    );
    return signal.aborted ? ResourceStatus.Unknown : bucketStatus(response);
  } catch (error) {
    return signal.aborted ? ResourceStatus.Unknown : bucketStatus(error);
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
      return await headBucket(client, bucket, signal);
    } finally {
      dispose();
    }
  } catch {
    return ResourceStatus.Unknown;
  }
}
