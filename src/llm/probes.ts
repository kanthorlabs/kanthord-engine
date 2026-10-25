import { randomUUID } from "node:crypto";
import {
  createModels,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Credential,
  type CredentialStore,
  type KnownProvider,
  type Context as ModelContext,
  type Model,
  type ModelsSimpleStreamOptions,
  type Provider,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { z } from "zod";
import { SecretShape } from "../custody/contract.ts";
import type { Context } from "../kernel/context.ts";
import {
  ResourceFailureReason,
  type ResourceObserver,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  ANTHROPIC_SUBSCRIPTION_PLATFORM,
  piProviderId,
} from "../kernel/pi-provider.ts";
import {
  AUTHORIZATION_HEADER,
  failureReasonOfStatus,
  headerSecrets,
  redactReason,
  thrownFailureReason,
  thrownReason,
} from "../kernel/probe.ts";
import { Connection, type ProviderCheckAnswer } from "./contract.ts";

export const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_CHECK_MODEL = "gpt-5.6-luna";
export const OPENAI_CODEX_CHECK_REASONING = "low";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
export const OPENCODE_GO_CHECK_MODEL = "deepseek-v4-flash";
export const OPENCODE_GO_CHECK_MAX_TOKENS = 1;
export const ANTHROPIC_SUBSCRIPTION_CHECK_MODEL = "claude-haiku-5-5";
export const ANTHROPIC_SUBSCRIPTION_CHECK_MAX_TOKENS = 1;
export const MODEL_CALL_CHECK_PROMPT = "What time is it?";
export const MODEL_CALL_FAILURES: readonly string[] = ["error", "aborted"];
export const ACCESS_TOKEN_EXPIRED_REASON = "access token expired";
export const ACCESS_TOKEN_REFRESH_FAILED_REASON = "access token refresh failed";
const ERROR_MESSAGE_STATUS = /^([1-5]\d{2})[:\s]/;
const UNAUTHORIZED_STATUSES: readonly number[] = [
  HttpStatus.Unauthorized,
  HttpStatus.Forbidden,
];
export const MODELS_PATH = "/models";
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

const openAIModelListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      owned_by: z.string().optional(),
      created: z.number().int().optional(),
    }),
  ),
});
const MALFORMED_BODY = Symbol("malformed body");

const UNREACHABLE: ProviderCheckAnswer = {
  connection: Connection.Unreachable,
  models: null,
};
const UNAUTHORIZED: ProviderCheckAnswer = {
  connection: Connection.Unauthorized,
  models: null,
};
const INVALID_RESPONSE: ProviderCheckAnswer = {
  connection: Connection.InvalidResponse,
  models: null,
};
const OK_WITHOUT_MODELS: ProviderCheckAnswer = {
  connection: Connection.Ok,
  models: null,
};

export function connectionOfStatus(status: number): Connection {
  return UNAUTHORIZED_STATUSES.includes(status)
    ? Connection.Unauthorized
    : Connection.InvalidResponse;
}

function refusedStatus(
  responseStatus: number | null,
  errorMessage: string | undefined,
): number | null {
  if (responseStatus === null || responseStatus === HttpStatus.OK)
    return statusOfErrorMessage(errorMessage);
  return responseStatus;
}

export function statusOfErrorMessage(
  errorMessage: string | undefined,
): number | null {
  const match = ERROR_MESSAGE_STATUS.exec(errorMessage ?? "");
  return match ? Number(match[1]) : null;
}

async function httpCheck(
  url: string,
  headers: Record<string, string>,
  readModels: boolean,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  try {
    const { signal } = context;
    if (signal.aborted) return UNREACHABLE;
    const response = await globalThis.fetch(url, {
      method: HttpMethod.Get,
      headers,
      signal,
      redirect: "manual",
    });
    if (!response.ok || !readModels) {
      await response.body?.cancel();
      if (signal.aborted) return UNREACHABLE;
      if (response.ok) return OK_WITHOUT_MODELS;
      observe?.(
        `status=${response.status}`,
        failureReasonOfStatus(response.status),
      );
      return {
        connection: connectionOfStatus(response.status),
        models: null,
      };
    }
    const body: unknown = await response.json().catch(() => MALFORMED_BODY);
    if (signal.aborted) return UNREACHABLE;
    const list = openAIModelListSchema.safeParse(body);
    if (!list.success) {
      observe?.("model list malformed", ResourceFailureReason.InvalidResponse);
      return INVALID_RESPONSE;
    }
    return {
      connection: Connection.Ok,
      models: list.data.data.map((model) => ({
        id: model.id,
        owned_by: model.owned_by ?? null,
        created: model.created ?? null,
      })),
    };
  } catch (error) {
    observe?.(
      thrownReason(error, headerSecrets(headers)),
      thrownFailureReason(context),
    );
    return UNREACHABLE;
  }
}

export async function checkGitHubCopilot(
  refresh: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return httpCheck(
    GITHUB_COPILOT_TOKEN_URL,
    {
      ...GITHUB_COPILOT_HEADERS,
      [AUTHORIZATION_HEADER]: `Bearer ${refresh}`,
    },
    false,
    context,
    observe,
  );
}

export async function checkAnthropic(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return httpCheck(
    ANTHROPIC_MODELS_URL,
    {
      [ANTHROPIC_API_KEY_HEADER]: apiKey,
      [ANTHROPIC_VERSION_HEADER]: ANTHROPIC_VERSION,
    },
    false,
    context,
    observe,
  );
}

export async function checkOpenAICompatible(
  apiKey: string,
  baseUrl: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return httpCheck(
    baseUrl + MODELS_PATH,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    true,
    context,
    observe,
  );
}

export async function checkOpenRouter(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return httpCheck(
    OPENROUTER_KEY_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    false,
    context,
    observe,
  );
}

export async function checkOpenAI(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return httpCheck(
    OPENAI_MODELS_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    true,
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

function providerModelCall(provider: () => Provider): ModelCall {
  return (model, context, options, credentials) => {
    const models = createModels({ credentials });
    models.setProvider(provider());
    return models.completeSimple(model, context, options);
  };
}

const codexModelCall = providerModelCall(openaiCodexProvider);
const anthropicSubscriptionModelCall = providerModelCall(anthropicProvider);
const opencodeGoModelCall = providerModelCall(opencodeGoProvider);

function failureReason(
  reply: AssistantMessage,
  secrets: readonly string[],
): string {
  const message = redactReason(reply.errorMessage ?? "", secrets);
  return `stopReason=${reply.stopReason} errorMessage=${message}`;
}

type ModelCallCheck = {
  providerId: KnownProvider;
  modelId: string;
  credential: Credential;
  options: Omit<ModelsSimpleStreamOptions, "signal">;
  secrets: readonly string[];
  call: ModelCall;
  refreshStore?: CredentialStore;
};

type RefreshWatch = { store: CredentialStore; refreshFailed(): boolean };

function refreshWatch(store: CredentialStore): RefreshWatch {
  let failed = false;
  return {
    store: {
      read: (providerId, options) => store.read(providerId, options),
      list: (options) => store.list(options),
      delete: (providerId, options) => store.delete(providerId, options),
      modify: (providerId, fn, options) =>
        store.modify(
          providerId,
          async (current) => {
            try {
              return await fn(current);
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          options,
        ),
    },
    refreshFailed: () => failed,
  };
}

async function seededStore(
  providerId: string,
  credential: Credential,
): Promise<CredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify(providerId, async () => credential);
  return store;
}

async function storedSecrets(
  store: CredentialStore,
  providerId: string,
): Promise<string[]> {
  const stored = await store.read(providerId);
  return stored?.type === SecretShape.OAuth
    ? [stored.refresh, stored.access]
    : [];
}

async function modelCallCheck(
  check: ModelCallCheck,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  const { providerId, modelId, credential, options, call, refreshStore } =
    check;
  try {
    const { signal } = context;
    if (signal.aborted) return UNREACHABLE;
    const model = getBuiltinModels(providerId).find(({ id }) => id === modelId);
    if (!model) {
      observe?.("check model not found", ResourceFailureReason.Unclassified);
      return INVALID_RESPONSE;
    }
    const watch = refreshWatch(
      refreshStore ?? (await seededStore(providerId, credential)),
    );
    let responseStatus: number | null = null;
    const reply = await call(
      model,
      {
        messages: [
          {
            role: "user",
            content: MODEL_CALL_CHECK_PROMPT,
            timestamp: Date.now(),
          },
        ],
      },
      {
        ...options,
        signal,
        onResponse: ({ status }) => {
          responseStatus = status;
        },
      },
      watch.store,
    );
    if (signal.aborted) return UNREACHABLE;
    if (watch.refreshFailed()) {
      observe?.(
        ACCESS_TOKEN_REFRESH_FAILED_REASON,
        ResourceFailureReason.Unauthorized,
      );
      return UNAUTHORIZED;
    }
    const secrets = [
      ...check.secrets,
      ...(await storedSecrets(watch.store, providerId)),
    ];
    if (!MODEL_CALL_FAILURES.includes(reply.stopReason))
      return OK_WITHOUT_MODELS;
    const status = refusedStatus(responseStatus, reply.errorMessage);
    observe?.(
      failureReason(reply, secrets),
      status === null
        ? ResourceFailureReason.Unreachable
        : failureReasonOfStatus(status),
    );
    if (status === null) return UNREACHABLE;
    return { connection: connectionOfStatus(status), models: null };
  } catch (error) {
    observe?.(thrownReason(error, check.secrets), thrownFailureReason(context));
    return UNREACHABLE;
  }
}

export interface CodexCredential {
  refresh: string;
  access: string;
  expires: number;
}

type OAuthModelCallCheck = Omit<
  ModelCallCheck,
  "credential" | "secrets" | "refreshStore"
>;

async function oauthModelCallCheck(
  check: OAuthModelCallCheck,
  credential: CodexCredential,
  context: Context,
  observe?: ResourceObserver,
  refreshStore?: CredentialStore,
): Promise<ProviderCheckAnswer> {
  const { refresh, access, expires } = credential;
  if (refreshStore === undefined && expires <= Date.now()) {
    observe?.(ACCESS_TOKEN_EXPIRED_REASON, ResourceFailureReason.Unauthorized);
    return UNAUTHORIZED;
  }
  return modelCallCheck(
    {
      ...check,
      credential: { type: "oauth", refresh, access, expires },
      secrets: [refresh, access],
      refreshStore,
    },
    context,
    observe,
  );
}

export async function checkOpenAICodex(
  credential: CodexCredential,
  context: Context,
  call: ModelCall = codexModelCall,
  observe?: ResourceObserver,
  refreshStore?: CredentialStore,
): Promise<ProviderCheckAnswer> {
  return oauthModelCallCheck(
    {
      providerId: OPENAI_CODEX_PROVIDER_ID,
      modelId: OPENAI_CODEX_CHECK_MODEL,
      options: { reasoning: OPENAI_CODEX_CHECK_REASONING },
      call,
    },
    credential,
    context,
    observe,
    refreshStore,
  );
}

export async function checkAnthropicSubscription(
  credential: CodexCredential,
  context: Context,
  call: ModelCall = anthropicSubscriptionModelCall,
  observe?: ResourceObserver,
  refreshStore?: CredentialStore,
): Promise<ProviderCheckAnswer> {
  return oauthModelCallCheck(
    {
      providerId: piProviderId(ANTHROPIC_SUBSCRIPTION_PLATFORM),
      modelId: ANTHROPIC_SUBSCRIPTION_CHECK_MODEL,
      options: { maxTokens: ANTHROPIC_SUBSCRIPTION_CHECK_MAX_TOKENS },
      call,
    },
    credential,
    context,
    observe,
    refreshStore,
  );
}

export async function checkOpencodeGo(
  apiKey: string,
  context: Context,
  call: ModelCall = opencodeGoModelCall,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  return modelCallCheck(
    {
      providerId: OPENCODE_GO_PROVIDER_ID,
      modelId: OPENCODE_GO_CHECK_MODEL,
      credential: { type: "api_key", key: apiKey },
      options: {
        maxTokens: OPENCODE_GO_CHECK_MAX_TOKENS,
        sessionId: randomUUID(),
      },
      secrets: [apiKey],
      call,
    },
    context,
    observe,
  );
}
