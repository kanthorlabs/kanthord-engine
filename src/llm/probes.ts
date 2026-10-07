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
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { z } from "zod";
import { abortSignal, type Context } from "../kernel/context.ts";
import type { ResourceObserver } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AUTHORIZATION_HEADER,
  headerSecrets,
  redactReason,
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
export const MODEL_CALL_CHECK_PROMPT = "What time is it?";
const MODEL_CALL_FAILURES: readonly string[] = ["error", "aborted"];
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
    const { signal, dispose } = abortSignal(context);
    try {
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
        observe?.(`status=${response.status}`);
        return {
          connection: connectionOfStatus(response.status),
          models: null,
        };
      }
      const body: unknown = await response.json().catch(() => MALFORMED_BODY);
      if (signal.aborted) return UNREACHABLE;
      const list = openAIModelListSchema.safeParse(body);
      if (!list.success) {
        observe?.("model list malformed");
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
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, headerSecrets(headers)));
    return UNREACHABLE;
  }
}

export async function checkGitHubCopilot(
  refresh: string,
  expires: number,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  if (expires <= Date.now()) {
    observe?.("access token expired");
    return UNREACHABLE;
  }
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
};

async function modelCallCheck(
  check: ModelCallCheck,
  context: Context,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  const { providerId, modelId, credential, options, secrets, call } = check;
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return UNREACHABLE;
      const model = getBuiltinModels(providerId).find(
        ({ id }) => id === modelId,
      );
      if (!model) {
        observe?.("check model not found");
        return INVALID_RESPONSE;
      }
      const credentials = new InMemoryCredentialStore();
      await credentials.modify(providerId, async () => credential);
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
        { ...options, signal },
        credentials,
      );
      if (signal.aborted) return UNREACHABLE;
      if (!MODEL_CALL_FAILURES.includes(reply.stopReason))
        return OK_WITHOUT_MODELS;
      observe?.(failureReason(reply, secrets));
      const status = statusOfErrorMessage(reply.errorMessage);
      if (status === null) return UNREACHABLE;
      return { connection: connectionOfStatus(status), models: null };
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, secrets));
    return UNREACHABLE;
  }
}

export interface CodexCredential {
  refresh: string;
  access: string;
  expires: number;
}

export async function checkOpenAICodex(
  credential: CodexCredential,
  context: Context,
  call: ModelCall = codexModelCall,
  observe?: ResourceObserver,
): Promise<ProviderCheckAnswer> {
  const { refresh, access, expires } = credential;
  if (expires <= Date.now()) {
    observe?.("access token expired");
    return UNREACHABLE;
  }
  return modelCallCheck(
    {
      providerId: OPENAI_CODEX_PROVIDER_ID,
      modelId: OPENAI_CODEX_CHECK_MODEL,
      credential: { type: "oauth", refresh, access, expires },
      options: { reasoning: OPENAI_CODEX_CHECK_REASONING },
      secrets: [refresh, access],
      call,
    },
    context,
    observe,
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
