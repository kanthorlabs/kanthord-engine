import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  type CredentialStore,
  fauxAssistantMessage,
  fauxToolCall,
  type OAuthAuth,
} from "@earendil-works/pi-ai";
import { loadPi } from "../agent/pi.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { LlmErrorCode, ModelCheckResult } from "./contract.ts";
import {
  checkModel,
  MODEL_CHECK_TOKEN_EXPIRED,
  MODEL_CHECK_TOOL_MISSING,
  MODEL_CHECK_TOOL_NAME,
  MODEL_CHECK_TOOL_RESULT,
  type ModelCheckInput,
} from "./model-check.ts";
import { Platform } from "./platforms.ts";
import { ANTHROPIC_SUBSCRIPTION_CHECK_MODEL } from "./probes.ts";
import { scriptedModelRuntime } from "./test-support.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const LOW_EFFORT = "low";
const SYSTEM_ROLE = "system";
const TOOL_RESULT_ROLE = "toolResult";
const FUNCTION_CALL_OUTPUT = "function_call_output";
const COMPATIBLE_MODEL = "thinker";
const API_KEY = "sk-model-check-secret-value";
const MODEL = "scripted-model";
const TOOL_CALL_ID = "call_model_check";
const FIRST_CALL = 0;
const SECOND_CALL = 1;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const NO_CALLS = 0;
const SUBSCRIPTION_LIFETIME_MS = 3600000;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function input(overrides: Partial<ModelCheckInput> = {}): ModelCheckInput {
  return {
    credential: "anthropic-key",
    platform: Platform.Anthropic,
    secret: { key: API_KEY },
    metadata: null,
    model_identifier: MODEL,
    reasoning_effort: "low",
    ...overrides,
  };
}

const toolCall = () =>
  fauxAssistantMessage(
    [fauxToolCall(MODEL_CHECK_TOOL_NAME, {}, { id: TOOL_CALL_ID })],
    { stopReason: "toolUse" },
  );
const finalAnswer = () => fauxAssistantMessage("done");
const providerError = (errorMessage: string) =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage });

async function run(
  script: Parameters<typeof scriptedModelRuntime>[1],
  overrides: Partial<ModelCheckInput> = {},
) {
  const scripted = scriptedModelRuntime(await loadPi(), script);
  const answer = await checkModel(
    input(overrides),
    scripted.module,
    background,
  );
  return { answer, calls: scripted.calls };
}

test("a model that calls the tool and answers after the tool result is ok", async () => {
  const { answer, calls } = await run([toolCall(), finalAnswer()]);
  assert.deepEqual(answer, { result: "ok", message: null });
  assert.equal(calls.length, TWO_CALLS);
  assert.deepEqual(calls[FIRST_CALL]!.tools, [MODEL_CHECK_TOOL_NAME]);
  assert.deepEqual(calls[SECOND_CALL]!.tools, [MODEL_CHECK_TOOL_NAME]);
  assert.equal(calls[FIRST_CALL]!.options?.reasoning, LOW_EFFORT);
  const second = calls[SECOND_CALL]!.messages.filter(
    ({ role }) => role !== SYSTEM_ROLE,
  );
  assert.deepEqual(
    second.map(({ role }) => role),
    ["user", "assistant", "toolResult"],
  );
  const result = second[2]!;
  assert.ok(result.role === TOOL_RESULT_ROLE);
  assert.equal(result.toolCallId, TOOL_CALL_ID);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [
    { type: "text", text: MODEL_CHECK_TOOL_RESULT },
  ]);
});

test("a model that does not call the tool answers bad_request", async () => {
  const { answer, calls } = await run([fauxAssistantMessage("It is noon.")]);
  assert.deepEqual(answer, {
    result: "bad_request",
    message: MODEL_CHECK_TOOL_MISSING,
  });
  assert.equal(calls.length, ONE_CALL);
});

test("a model that calls another tool answers bad_request", async () => {
  const { answer } = await run([
    fauxAssistantMessage([fauxToolCall("other_tool", {})], {
      stopReason: "toolUse",
    }),
  ]);
  assert.equal(answer.result, ModelCheckResult.BadRequest);
});

test("a provider error of the first call answers its failure code", async () => {
  const cases: [string, string][] = [
    ["429 Rate limit exceeded", "rate_limited"],
    ["You exceeded your current quota, check your billing", "quota_exhausted"],
    ["401 Unauthorized", "unauthorized"],
    ["403 Forbidden", "unauthorized"],
    ["400 Invalid request", "bad_request"],
    ["503 Service Unavailable", "unavailable"],
    ["fetch failed", "unavailable"],
  ];
  for (const [errorMessage, result] of cases) {
    const { answer, calls } = await run([providerError(errorMessage)]);
    assert.deepEqual(answer, { result, message: errorMessage }, errorMessage);
    assert.equal(calls.length, ONE_CALL);
  }
});

test("a provider error of the final call answers its failure code", async () => {
  const { answer, calls } = await run([
    toolCall(),
    providerError("429 Rate limit exceeded"),
  ]);
  assert.deepEqual(answer, {
    result: "rate_limited",
    message: "429 Rate limit exceeded",
  });
  assert.equal(calls.length, TWO_CALLS);
});

test("the message of a failure does not hold the secret", async () => {
  const { answer } = await run([
    providerError(`401 Incorrect API key provided: ${API_KEY}`),
  ]);
  assert.equal(answer.result, ModelCheckResult.Unauthorized);
  assert.ok(answer.message);
  assert.ok(!answer.message.includes(API_KEY));
  assert.match(answer.message, /\[redacted\]/);
});

test("the effort off sends no reasoning option", async () => {
  const { answer, calls } = await run([toolCall(), finalAnswer()], {
    reasoning_effort: "off",
  });
  assert.equal(answer.result, ModelCheckResult.Ok);
  assert.equal(calls[FIRST_CALL]!.options?.reasoning, undefined);
});

test("an unknown model answers 400 llm.model.model_unknown without a call", async () => {
  const scripted = scriptedModelRuntime(await loadPi(), [finalAnswer()]);
  await assert.rejects(
    checkModel(
      input({ model_identifier: "missing" }),
      scripted.module,
      background,
    ),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === LlmErrorCode.ModelUnknown,
  );
  assert.equal(scripted.calls.length, NO_CALLS);
});

test("an unsupported reasoning effort answers 400 llm.model.reasoning_unsupported without a call", async () => {
  const scripted = scriptedModelRuntime(await loadPi(), [finalAnswer()], {
    models: [{ id: MODEL, reasoning: false }],
  });
  for (const reasoning_effort of ["high", "unknown"])
    await assert.rejects(
      checkModel(input({ reasoning_effort }), scripted.module, background),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.BadRequest &&
        error.code === LlmErrorCode.ModelReasoningUnsupported,
    );
  assert.equal(scripted.calls.length, NO_CALLS);
});

test("an expired OAuth access token answers unauthorized without a call", async () => {
  const scripted = scriptedModelRuntime(await loadPi(), [finalAnswer()], {
    providerId: Platform.OpenAICodex,
  });
  const answer = await checkModel(
    input({
      platform: Platform.OpenAICodex,
      secret: {
        refresh: "refresh-secret",
        access: "access-secret",
        expires: 1,
      },
    }),
    scripted.module,
    background,
  );
  assert.deepEqual(answer, {
    result: "unauthorized",
    message: MODEL_CHECK_TOKEN_EXPIRED,
  });
  assert.equal(scripted.calls.length, NO_CALLS);
});

test("an anthropic-subscription credential resolves its model under the anthropic pi provider and sends the call to Anthropic", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(String(url));
    return Response.json(
      { type: "error" },
      { status: HttpStatus.Unauthorized },
    );
  });
  const answer = await checkModel(
    input({
      platform: Platform.AnthropicSubscription,
      secret: {
        refresh: "refresh-secret",
        access: "access-secret",
        expires: Date.now() + SUBSCRIPTION_LIFETIME_MS,
      },
      model_identifier: ANTHROPIC_SUBSCRIPTION_CHECK_MODEL,
    }),
    await loadPi(),
    background,
  );
  assert.equal(answer.result, ModelCheckResult.Unauthorized);
  assert.equal(urls.length, ONE_CALL);
  assert.ok(urls[FIRST_CALL]!.startsWith(ANTHROPIC_MESSAGES_URL));
});

test("a cancelled context answers unavailable", async () => {
  const controller = new AbortController();
  const scripted = scriptedModelRuntime(await loadPi(), [
    () => {
      controller.abort();
      return providerError("Request was aborted");
    },
  ]);
  const context = { signal: controller.signal, deadline: null };
  const answer = await checkModel(input(), scripted.module, context);
  assert.equal(answer.result, ModelCheckResult.Unavailable);
});

type CompatibleRequest = {
  authorization: string | undefined;
  body: {
    model: string;
    input: { type?: string }[];
    tools: { name: string }[];
  };
};

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const COMPLETED = {
  type: "response.completed",
  response: { id: "resp_1", status: "completed" },
};

function toolCallEvents(): object[] {
  const item = {
    type: "function_call",
    id: "fc_1",
    call_id: TOOL_CALL_ID,
    name: MODEL_CHECK_TOOL_NAME,
    arguments: "",
  };
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, arguments: "{}" },
    },
    COMPLETED,
  ];
}

function answerEvents(): object[] {
  const item = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [],
  };
  return [
    { type: "response.created", response: { id: "resp_2" } },
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...item,
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    },
    COMPLETED,
  ];
}

async function compatibleServer(
  t: TestContext,
  respond: (request: CompatibleRequest) => { status: number; body: string },
) {
  const requests: CompatibleRequest[] = [];
  const server = createServer(async (request, response) => {
    const captured: CompatibleRequest = {
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    };
    requests.push(captured);
    const { status, body } = respond(captured);
    response.writeHead(status, { "content-type": "text/event-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopAfter(t, () => server.close());
  const { port } = server.address() as AddressInfo;
  return { requests, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function compatibleInput(
  baseUrl: string,
  overrides: Partial<ModelCheckInput> = {},
): ModelCheckInput {
  return input({
    credential: "compatible-key",
    platform: Platform.OpenAICompatible,
    metadata: {
      base_url: baseUrl,
      models: [
        { id: "basic" },
        { id: "thinker", reasoning_levels: ["off", "low"] },
      ],
    },
    model_identifier: "thinker",
    ...overrides,
  });
}

test("an openai-compatible credential runs the tool round trip against its base URL", async (t) => {
  const server = await compatibleServer(t, ({ body }) => ({
    status: 200,
    body: sse(
      body.input.some(({ type }) => type === FUNCTION_CALL_OUTPUT)
        ? answerEvents()
        : toolCallEvents(),
    ),
  }));
  const answer = await checkModel(
    compatibleInput(server.baseUrl),
    await loadPi(),
    background,
  );
  assert.deepEqual(answer, { result: "ok", message: null });
  assert.equal(server.requests.length, TWO_CALLS);
  for (const request of server.requests) {
    assert.equal(request.authorization, `Bearer ${API_KEY}`);
    assert.equal(request.body.model, COMPATIBLE_MODEL);
    assert.deepEqual(
      request.body.tools.map(({ name }) => name),
      [MODEL_CHECK_TOOL_NAME],
    );
  }
});

test("an openai-compatible credential answers the status of a provider error", async (t) => {
  const server = await compatibleServer(t, () => ({
    status: 429,
    body: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
  }));
  const answer = await checkModel(
    compatibleInput(server.baseUrl),
    await loadPi(),
    background,
  );
  assert.equal(answer.result, ModelCheckResult.RateLimited);
  assert.ok(answer.message);
  assert.ok(!answer.message.includes(API_KEY));
  assert.equal(server.requests.length, ONE_CALL);
});

test("an openai-compatible credential refuses a model outside its list and an effort outside the model levels", async (t) => {
  const server = await compatibleServer(t, () => ({ status: 500, body: "" }));
  const refusal = async (overrides: Partial<ModelCheckInput>, code: string) =>
    assert.rejects(
      checkModel(
        compatibleInput(server.baseUrl, overrides),
        await loadPi(),
        background,
      ),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.BadRequest &&
        error.code === code,
    );
  await refusal({ model_identifier: "missing" }, LlmErrorCode.ModelUnknown);
  await refusal(
    { reasoning_effort: "high" },
    LlmErrorCode.ModelReasoningUnsupported,
  );
  await refusal(
    { model_identifier: "basic", reasoning_effort: "low" },
    LlmErrorCode.ModelReasoningUnsupported,
  );
  assert.equal(server.requests.length, NO_CALLS);
});

const INSIDE_REFRESH_WINDOW_MS = 60000;

test("an OAuth access token inside the pi-ai refresh window answers unauthorized without a call when no refresh store exists", async () => {
  const scripted = scriptedModelRuntime(await loadPi(), [finalAnswer()], {
    providerId: Platform.OpenAICodex,
  });
  const answer = await checkModel(
    input({
      platform: Platform.OpenAICodex,
      secret: {
        refresh: "refresh-value",
        access: "access-value",
        expires: Date.now() + INSIDE_REFRESH_WINDOW_MS,
      },
    }),
    scripted.module,
    background,
  );
  assert.deepEqual(answer, {
    result: ModelCheckResult.Unauthorized,
    message: MODEL_CHECK_TOKEN_EXPIRED,
  });
  assert.equal(scripted.calls.length, NO_CALLS);
});

const PI_REFRESH_WINDOW_MS = 300000;
const OUTSIDE_WINDOW_MARGIN_MS = 1000;
const WINDOW_CROSSING_MS = 2000;
const ROTATED_ACCESS = "rotated-access-q7";
const ROTATED_REFRESH = "rotated-refresh-q7";

function countingOAuth(counter: { refreshes: number }): OAuthAuth {
  return {
    name: "scripted OAuth",
    login: async () => {
      throw new Error("UNEXPECTED_LOGIN");
    },
    refresh: async () => {
      counter.refreshes += 1;
      return {
        type: "oauth",
        refresh: ROTATED_REFRESH,
        access: ROTATED_ACCESS,
        expires: Date.now() + SUBSCRIPTION_LIFETIME_MS,
      };
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
}

test("a model check without a refresh store never refreshes when the token enters the pi-ai window between the two model calls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const counter = { refreshes: 0 };
  const scripted = scriptedModelRuntime(
    await loadPi(),
    [
      () => {
        t.mock.timers.tick(WINDOW_CROSSING_MS);
        return toolCall();
      },
      finalAnswer(),
    ],
    { providerId: Platform.OpenAICodex, oauth: countingOAuth(counter) },
  );
  const answer = await checkModel(
    input({
      platform: Platform.OpenAICodex,
      secret: {
        refresh: "stored-refresh",
        access: "stored-access",
        expires: Date.now() + PI_REFRESH_WINDOW_MS + OUTSIDE_WINDOW_MARGIN_MS,
      },
    }),
    scripted.module,
    background,
  );
  assert.deepEqual(answer, { result: ModelCheckResult.Ok, message: null });
  assert.equal(scripted.calls.length, TWO_CALLS);
  assert.equal(counter.refreshes, NO_CALLS);
});

function droppingStore(providerId: string): CredentialStore {
  const stored = {
    type: "oauth" as const,
    refresh: "stored-refresh",
    access: "stored-access",
    expires: 1,
  };
  return {
    read: async (id) => (id === providerId ? stored : undefined),
    list: async () => [{ providerId, type: "oauth" }],
    delete: async () => {},
    modify: async (_id, fn) => (await fn(stored)) ?? stored,
  };
}

test("a model check redacts the refreshed tokens from the provider error, even when the store drops the write", async () => {
  const counter = { refreshes: 0 };
  const scripted = scriptedModelRuntime(
    await loadPi(),
    [providerError(`401: denied ${ROTATED_ACCESS} ${ROTATED_REFRESH}`)],
    { providerId: Platform.OpenAICodex, oauth: countingOAuth(counter) },
  );
  const answer = await checkModel(
    input({
      platform: Platform.OpenAICodex,
      secret: {
        refresh: "stored-refresh",
        access: "stored-access",
        expires: 1,
      },
    }),
    scripted.module,
    background,
    droppingStore(Platform.OpenAICodex),
  );
  assert.equal(counter.refreshes, ONE_CALL);
  assert.equal(answer.result, ModelCheckResult.Unauthorized);
  assert.ok(!answer.message?.includes(ROTATED_ACCESS), answer.message ?? "");
  assert.ok(!answer.message?.includes(ROTATED_REFRESH), answer.message ?? "");
});
