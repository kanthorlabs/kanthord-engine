import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  Type,
  type Api,
  type AssistantMessage,
  type Credential,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type ModelsSimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  apiKeySecretSchema,
  oauthSecretSchema,
  SecretShape,
} from "../custody/contract.ts";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { redactReason, thrownReason } from "../kernel/probe.ts";
import {
  LlmErrorCode,
  ModelCheckResult,
  type ModelCheckAnswer,
} from "./contract.ts";
import {
  createModelRuntime,
  type ModelRuntimeModule,
} from "./model-connector.ts";
import { MODEL_CALL_FAILURES } from "./probes.ts";
import {
  LLM_PLATFORMS,
  piProviderId,
  ReasoningLevel,
  type Platform,
} from "./platforms.ts";
import { providerFailureOf } from "./provider-failure.ts";

export const MODEL_CHECK_PROMPT =
  "Call the check_tool tool once. After the tool answers, reply with the word done.";
export const MODEL_CHECK_TOOL_NAME = "check_tool";
export const MODEL_CHECK_TOOL_RESULT = "ready";
export const MODEL_CHECK_TOOL_MISSING = "The model did not call the tool.";
export const MODEL_CHECK_TOKEN_EXPIRED = "The access token is expired.";
export const MODEL_CHECK_INTERRUPTED =
  "The model check ended before the model answered.";
const TOOL_CALL_BLOCK = "toolCall";
const FAILURE_WITHOUT_TEXT = "The model call failed.";

const CHECK_TOOL: Tool = {
  name: MODEL_CHECK_TOOL_NAME,
  description: "Answer the word ready.",
  parameters: Type.Object({}),
};

export interface ModelCheckInput {
  credential: string;
  platform: Platform;
  secret: unknown;
  metadata: unknown;
  model_identifier: string;
  reasoning_effort: string;
}

type ReleasedCredential = {
  credential: Credential;
  secrets: readonly string[];
};

function releasedCredential(
  platform: Platform,
  secret: unknown,
): ReleasedCredential {
  if (LLM_PLATFORMS[platform].secret_shape === SecretShape.OAuth) {
    const { refresh, access, expires } = oauthSecretSchema.parse(secret);
    return {
      credential: { type: SecretShape.OAuth, refresh, access, expires },
      secrets: [refresh, access],
    };
  }
  const { key } = apiKeySecretSchema.parse(secret);
  return {
    credential: { type: SecretShape.ApiKey, key },
    secrets: [key],
  };
}

function modelError(code: string, message: string): OperationError {
  return new OperationError(HttpStatus.BadRequest, code, message);
}

function failure(
  reply: AssistantMessage,
  secrets: readonly string[],
): ModelCheckAnswer {
  const message = redactReason(reply.errorMessage ?? "", secrets);
  return {
    result: providerFailureOf(reply.errorMessage ?? ""),
    message: message || FAILURE_WITHOUT_TEXT,
  };
}

function toolCallOf(reply: AssistantMessage): ToolCall | undefined {
  return reply.content.find(
    (block): block is ToolCall =>
      block.type === TOOL_CALL_BLOCK && block.name === MODEL_CHECK_TOOL_NAME,
  );
}

type ConnectedModel = {
  runtime: ModelRuntime;
  model: Model<Api>;
  effort: ModelThinkingLevel;
};

async function connectedModel(
  input: ModelCheckInput,
  pi: ModelRuntimeModule,
  credential: Credential,
  signal: AbortSignal,
): Promise<ConnectedModel> {
  const { platform, model_identifier: modelIdentifier } = input;
  const providerId = piProviderId(platform);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => credential);
  const runtime = await createModelRuntime(pi, {
    credentials,
    handoverItem: { credential_id: input.credential, provider_id: providerId },
    credentialId: input.credential,
    configuration: {
      agent_provider: input.credential,
      provider: platform,
      model_identifier: modelIdentifier,
      reasoning_effort: ReasoningLevel.Off,
    },
    metadata: input.metadata,
    signal,
  });
  const model = runtime.getModel(providerId, modelIdentifier);
  if (!model)
    throw modelError(
      LlmErrorCode.ModelUnknown,
      "The model is not in the model list of the credential.",
    );
  const effort = getSupportedThinkingLevels(model).find(
    (level) => level === input.reasoning_effort,
  );
  if (effort === undefined)
    throw modelError(
      LlmErrorCode.ModelReasoningUnsupported,
      "The model does not support the reasoning effort.",
    );
  return { runtime, model, effort };
}

function interrupted(): ModelCheckAnswer {
  return {
    result: ModelCheckResult.Unavailable,
    message: MODEL_CHECK_INTERRUPTED,
  };
}

async function toolRoundTrip(
  connected: ConnectedModel,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<ModelCheckAnswer> {
  const { runtime, model, effort } = connected;
  const options: ModelsSimpleStreamOptions = {
    signal,
    ...(effort === ReasoningLevel.Off ? {} : { reasoning: effort }),
  };
  const complete = (messages: Message[]) =>
    runtime.completeSimple(model, { messages, tools: [CHECK_TOOL] }, options);
  const prompt: Message = {
    role: "user",
    content: MODEL_CHECK_PROMPT,
    timestamp: Date.now(),
  };
  const first = await complete([prompt]);
  if (signal.aborted) return interrupted();
  if (MODEL_CALL_FAILURES.includes(first.stopReason))
    return failure(first, secrets);
  const call = toolCallOf(first);
  if (!call)
    return {
      result: ModelCheckResult.BadRequest,
      message: MODEL_CHECK_TOOL_MISSING,
    };
  const second = await complete([
    prompt,
    first,
    {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: MODEL_CHECK_TOOL_RESULT }],
      isError: false,
      timestamp: Date.now(),
    },
  ]);
  if (signal.aborted) return interrupted();
  if (MODEL_CALL_FAILURES.includes(second.stopReason))
    return failure(second, secrets);
  return { result: ModelCheckResult.Ok, message: null };
}

export async function checkModel(
  input: ModelCheckInput,
  pi: ModelRuntimeModule,
  context: Context,
): Promise<ModelCheckAnswer> {
  const { credential, secrets } = releasedCredential(
    input.platform,
    input.secret,
  );
  const { signal } = context;
  try {
    const connected = await connectedModel(input, pi, credential, signal);
    if (
      credential.type === SecretShape.OAuth &&
      credential.expires <= Date.now()
    )
      return {
        result: ModelCheckResult.Unauthorized,
        message: MODEL_CHECK_TOKEN_EXPIRED,
      };
    return await toolRoundTrip(connected, signal, secrets);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    const message = thrownReason(error, secrets);
    return { result: providerFailureOf(message), message };
  }
}
