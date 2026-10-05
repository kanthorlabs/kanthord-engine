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
import { HttpStatus } from "../kernel/http.ts";
import {
  AUTHORIZATION_HEADER,
  probeHttp,
  redactReason,
  thrownReason,
} from "../kernel/probe.ts";

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
