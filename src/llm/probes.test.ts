import assert from "node:assert/strict";
import { test } from "node:test";
import { background, CancellationContext } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import { Connection, type ProviderCheckAnswer } from "./contract.ts";
import {
  CAPABILITY_COPILOT_TOKEN_READ,
  CAPABILITY_KEY_READ,
  CAPABILITY_MODEL_CALL,
  CAPABILITY_MODEL_LIST_READ,
  CAPABILITY_NONE,
  LLM_PLATFORMS,
  LLM_PROVIDERS,
  Platform,
} from "./platforms.ts";
import {
  ANTHROPIC_API_KEY_HEADER,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION,
  ANTHROPIC_VERSION_HEADER,
  checkAnthropic,
  checkGitHubCopilot,
  checkOpenAI,
  checkOpenAICodex,
  checkOpenAICompatible,
  checkOpencodeGo,
  checkOpenRouter,
  GITHUB_COPILOT_TOKEN_URL,
  MODEL_CALL_CHECK_PROMPT,
  MODELS_PATH,
  OPENAI_CODEX_CHECK_MODEL,
  OPENAI_CODEX_CHECK_REASONING,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_MODELS_URL,
  OPENCODE_GO_CHECK_MAX_TOKENS,
  OPENCODE_GO_CHECK_MODEL,
  OPENCODE_GO_PROVIDER_ID,
  OPENROUTER_KEY_URL,
  statusOfErrorMessage,
  type ModelCall,
} from "./probes.ts";
import { HEALTH_OF_CONNECTION } from "./provider.ts";

const SECRET = "test_private-resource-health-secret";
const BASE_URL = "https://models.example/v1";
const FUTURE_MS = 60000;
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const CREATED = 1700000000;
const BEARER_HEADERS = { [AUTHORIZATION_HEADER]: `Bearer ${SECRET}` };
const REFRESH_SECRET = "test_private-copilot-refresh";
const COPILOT_HEADERS = {
  [AUTHORIZATION_HEADER]: `Bearer ${REFRESH_SECRET}`,
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const ANTHROPIC_HEADERS = {
  [ANTHROPIC_API_KEY_HEADER]: SECRET,
  [ANTHROPIC_VERSION_HEADER]: ANTHROPIC_VERSION,
};
const MODEL_LIST = {
  object: "list",
  data: [
    { id: "alpha", object: "model", owned_by: "lab", created: CREATED },
    { id: "beta", object: "model" },
  ],
};
const PROVIDER_MODELS = [
  { id: "alpha", ownedBy: "lab", created: CREATED },
  { id: "beta", ownedBy: null, created: null },
];
const UNREACHABLE = { connection: Connection.Unreachable, models: null };

const httpChecks: {
  name: string;
  url: string;
  headers: Record<string, string>;
  readsModels: boolean;
  check: (
    context: CancellationContext | typeof background,
  ) => Promise<ProviderCheckAnswer>;
}[] = [
  {
    name: Platform.GitHubCopilot,
    url: GITHUB_COPILOT_TOKEN_URL,
    headers: COPILOT_HEADERS,
    readsModels: false,
    check: (context) =>
      checkGitHubCopilot(REFRESH_SECRET, Date.now() + FUTURE_MS, context),
  },
  {
    name: Platform.Anthropic,
    url: ANTHROPIC_MODELS_URL,
    headers: ANTHROPIC_HEADERS,
    readsModels: false,
    check: (context) => checkAnthropic(SECRET, context),
  },
  {
    name: Platform.OpenAICompatible,
    url: BASE_URL + MODELS_PATH,
    headers: BEARER_HEADERS,
    readsModels: true,
    check: (context) => checkOpenAICompatible(SECRET, BASE_URL, context),
  },
  {
    name: Platform.OpenRouter,
    url: OPENROUTER_KEY_URL,
    headers: BEARER_HEADERS,
    readsModels: false,
    check: (context) => checkOpenRouter(SECRET, context),
  },
  {
    name: Platform.OpenAI,
    url: OPENAI_MODELS_URL,
    headers: BEARER_HEADERS,
    readsModels: true,
    check: (context) => checkOpenAI(SECRET, context),
  },
];

test("LLM_PROVIDERS holds exactly the platforms with a check and each declares its capability", async (t) => {
  assert.deepEqual(Object.keys(LLM_PROVIDERS).toSorted(), [
    Platform.Anthropic,
    Platform.GitHubCopilot,
    Platform.OpenAI,
    Platform.OpenAICodex,
    Platform.OpenAICompatible,
    Platform.OpencodeGo,
    Platform.OpenRouter,
  ]);
  for (const [platform, entry] of Object.entries(LLM_PLATFORMS))
    assert.equal(
      entry.probe !== null,
      Object.hasOwn(LLM_PROVIDERS, platform),
      platform,
    );
  assert.equal(
    LLM_PLATFORMS[Platform.OpenRouter].capability,
    CAPABILITY_KEY_READ,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.OpenAI].capability,
    CAPABILITY_MODEL_LIST_READ,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.GitHubCopilot].capability,
    CAPABILITY_COPILOT_TOKEN_READ,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.OpenAICodex].capability,
    CAPABILITY_MODEL_CALL,
  );
  assert.equal(
    LLM_PLATFORMS[Platform.OpencodeGo].capability,
    CAPABILITY_MODEL_CALL,
  );
  assert.equal(LLM_PLATFORMS.groq.capability, CAPABILITY_NONE);
  const urls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(url);
    return Response.json(MODEL_LIST);
  });
  const metadata = { base_url: BASE_URL, models: [] };
  for (const platform of [
    Platform.Anthropic,
    Platform.OpenAICompatible,
    Platform.OpenRouter,
    Platform.OpenAI,
  ])
    assert.equal(
      (
        await LLM_PROVIDERS[platform]!.check(
          { key: SECRET },
          platform === Platform.OpenAICompatible ? metadata : null,
          background,
        )
      ).connection,
      Connection.Ok,
    );
  assert.deepEqual(urls, [
    ANTHROPIC_MODELS_URL,
    BASE_URL + MODELS_PATH,
    OPENROUTER_KEY_URL,
    OPENAI_MODELS_URL,
  ]);
});

test("a healthcheck maps ok to healthy, unauthorized to unhealthy and every other connection to unknown", async (t) => {
  assert.deepEqual(HEALTH_OF_CONNECTION, {
    [Connection.Ok]: ResourceStatus.Healthy,
    [Connection.Unauthorized]: ResourceStatus.Unhealthy,
    [Connection.Unreachable]: ResourceStatus.Unknown,
    [Connection.InvalidResponse]: ResourceStatus.Unknown,
  });
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unhealthy],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const) {
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status }),
    );
    assert.equal(
      await LLM_PLATFORMS[Platform.Anthropic].probe!(
        { key: SECRET },
        null,
        background,
      ),
      expected,
    );
    fetch.mock.restore();
  }
});

for (const check of httpChecks) {
  for (const [status, expected] of [
    [HttpStatus.OK, Connection.Ok],
    [HttpStatus.Unauthorized, Connection.Unauthorized],
    [HttpStatus.Forbidden, Connection.Unauthorized],
    [HttpStatus.InternalServerError, Connection.InvalidResponse],
  ] as const) {
    test(`${check.name} maps HTTP ${status} to ${expected} and sends the expected request`, async (t) => {
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async (
          url: Parameters<typeof globalThis.fetch>[0],
          options?: RequestInit,
        ) => {
          assert.equal(url, check.url);
          assert.equal(options?.method, HttpMethod.Get);
          assert.deepEqual(options?.headers, check.headers);
          return Response.json(MODEL_LIST, { status });
        },
      );
      assert.deepEqual(await check.check(background), {
        connection: expected,
        models:
          check.readsModels && expected === Connection.Ok
            ? PROVIDER_MODELS
            : null,
      });
      assert.equal(fetch.mock.callCount(), ONE_CALL);
    });
  }

  test(`${check.name} maps a network failure and a cancelled context to unreachable`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    assert.deepEqual(await check.check(background), UNREACHABLE);
    const cancelled = new CancellationContext();
    cancelled.cancel();
    assert.deepEqual(await check.check(cancelled), UNREACHABLE);
    assert.equal(fetch.mock.callCount(), ONE_CALL);
  });
}

test("a model-list check maps a reply that is not the OpenAI list shape to invalid_response", async (t) => {
  for (const body of ["not json", JSON.stringify({ data: [{ name: "x" }] })]) {
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body, { status: HttpStatus.OK }),
    );
    for (const check of [
      () => checkOpenAICompatible(SECRET, BASE_URL, background),
      () => checkOpenAI(SECRET, background),
    ])
      assert.deepEqual(await check(), {
        connection: Connection.InvalidResponse,
        models: null,
      });
    fetch.mock.restore();
  }
});

test("the status of a refused model call comes from the prefix of errorMessage", () => {
  assert.equal(
    statusOfErrorMessage('403: {"error":"denied"}'),
    HttpStatus.Forbidden,
  );
  assert.equal(
    statusOfErrorMessage("401 status code (no body)"),
    HttpStatus.Unauthorized,
  );
  assert.equal(statusOfErrorMessage("Connection error."), null);
  assert.equal(statusOfErrorMessage(undefined), null);
});

const USER_ROLE = "user";
const REASON_COUNT = 2;
const REASON_LIMIT = 400;
const REFRESH = "test_private-refresh-token-value-0123456789";
const credentialOf = (expires: number) => ({
  refresh: REFRESH,
  access: SECRET,
  expires,
});
const reply =
  (
    stopReason: "stop" | "error" | "aborted",
    errorMessage?: string,
  ): ModelCall =>
  async () =>
    ({ stopReason, errorMessage }) as Awaited<ReturnType<ModelCall>>;
const refusals = [
  ['401: {"error":"unauthorized"}', Connection.Unauthorized],
  ['403: {"error":"forbidden"}', Connection.Unauthorized],
  ['400: {"error":"MissingSessionID"}', Connection.InvalidResponse],
  ["500: upstream failure", Connection.InvalidResponse],
  ["Connection error.", Connection.Unreachable],
] as const;

test("openai-codex check sends one model call to its constant model and maps the reply", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const seen: unknown[] = [];
  const recording: ModelCall = async (model, modelContext, options, store) => {
    seen.push([
      model.id,
      modelContext.messages,
      options,
      await store.read(OPENAI_CODEX_PROVIDER_ID),
      await store.list(),
    ]);
    return reply("stop")(model, modelContext, options, store);
  };
  const future = Date.now() + FUTURE_MS;
  assert.deepEqual(
    await checkOpenAICodex(credentialOf(future), background, recording),
    { connection: Connection.Ok, models: null },
  );
  assert.equal(seen.length, ONE_CALL);
  const [id, messages, options, stored, listed] = seen[0] as [
    string,
    { role: string; content: string }[],
    Record<string, unknown>,
    unknown,
    unknown,
  ];
  assert.equal(id, OPENAI_CODEX_CHECK_MODEL);
  assert.equal(options.reasoning, OPENAI_CODEX_CHECK_REASONING);
  assert.equal(Object.hasOwn(options, "apiKey"), false);
  assert.equal(Object.hasOwn(options, "transport"), false);
  assert.equal(Object.hasOwn(options, "onResponse"), false);
  assert.deepEqual(stored, {
    type: "oauth",
    refresh: REFRESH,
    access: SECRET,
    expires: future,
  });
  assert.deepEqual(listed, [
    { providerId: OPENAI_CODEX_PROVIDER_ID, type: "oauth" },
  ]);
  assert.equal(messages.length, ONE_CALL);
  assert.equal(messages[0]!.role, USER_ROLE);
  assert.equal(messages[0]!.content, MODEL_CALL_CHECK_PROMPT);
  for (const [errorMessage, expected] of refusals)
    assert.equal(
      (
        await checkOpenAICodex(
          credentialOf(future),
          background,
          reply("error", errorMessage),
        )
      ).connection,
      expected,
      errorMessage,
    );
  assert.deepEqual(
    await checkOpenAICodex(credentialOf(future), background, async () => {
      throw new Error(SECRET);
    }),
    UNREACHABLE,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("openai-codex check reports a reason without token material", async () => {
  const reasons: string[] = [];
  const observe = (reason: string) => reasons.push(reason);
  const future = Date.now() + FUTURE_MS;
  const long = "A".repeat(500);
  await checkOpenAICodex(
    credentialOf(future),
    background,
    reply("error", `401: denied Bearer abc.def ${SECRET} ${REFRESH} ${long}`),
    observe,
  );
  await checkOpenAICodex(
    credentialOf(future),
    background,
    async () => {
      throw new Error(`failed with ${SECRET}`);
    },
    observe,
  );
  assert.equal(reasons.length, REASON_COUNT);
  assert.match(reasons[0]!, /^stopReason=error errorMessage=401: denied/);
  assert.match(reasons[1]!, /^Error: failed with/);
  for (const reason of reasons) {
    assert.ok(reason.length <= REASON_LIMIT);
    assert.ok(!reason.includes(SECRET));
    assert.ok(!reason.includes(REFRESH));
    assert.ok(!reason.includes("abc.def"));
    assert.ok(!reason.includes(long));
  }
});

test("openai-codex check answers unreachable without a call for an expired token or a cancelled context", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  let calls = NO_CALLS;
  const counting: ModelCall = async (model, modelContext, options, store) => {
    calls += ONE_CALL;
    return reply("stop")(model, modelContext, options, store);
  };
  assert.deepEqual(
    await checkOpenAICodex(
      credentialOf(Date.now() - FUTURE_MS),
      background,
      counting,
    ),
    UNREACHABLE,
  );
  const cancelled = new CancellationContext();
  cancelled.cancel();
  assert.deepEqual(
    await checkOpenAICodex(
      credentialOf(Date.now() + FUTURE_MS),
      cancelled,
      counting,
    ),
    UNREACHABLE,
  );
  assert.equal(calls, NO_CALLS);
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("opencode-go check sends one model call to its constant model with a session id and the smallest token limit", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const seen: {
    id: string;
    options: Record<string, unknown>;
    content: unknown;
    stored: unknown;
  }[] = [];
  const recording: ModelCall = async (model, modelContext, options, store) => {
    seen.push({
      id: model.id,
      options: options as Record<string, unknown>,
      content: modelContext.messages[0]?.content,
      stored: await store.read(OPENCODE_GO_PROVIDER_ID),
    });
    return reply("stop")(model, modelContext, options, store);
  };
  for (let index = 0; index < TWO_CALLS; index++)
    assert.deepEqual(await checkOpencodeGo(SECRET, background, recording), {
      connection: Connection.Ok,
      models: null,
    });
  assert.equal(seen.length, TWO_CALLS);
  for (const call of seen) {
    assert.equal(call.id, OPENCODE_GO_CHECK_MODEL);
    assert.equal(call.options.maxTokens, OPENCODE_GO_CHECK_MAX_TOKENS);
    assert.match(String(call.options.sessionId), /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(call.options, "apiKey"), false);
    assert.equal(call.content, MODEL_CALL_CHECK_PROMPT);
    assert.deepEqual(call.stored, { type: "api_key", key: SECRET });
  }
  assert.notEqual(seen[0]!.options.sessionId, seen[1]!.options.sessionId);
  for (const [errorMessage, expected] of refusals)
    assert.equal(
      (await checkOpencodeGo(SECRET, background, reply("error", errorMessage)))
        .connection,
      expected,
      errorMessage,
    );
  assert.deepEqual(
    await checkOpencodeGo(SECRET, background, reply("aborted")),
    UNREACHABLE,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("the opencode-go provider check routes the stored API key", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const cancelled = new CancellationContext();
  cancelled.cancel();
  assert.deepEqual(
    await LLM_PROVIDERS[Platform.OpencodeGo]!.check(
      { key: SECRET },
      null,
      cancelled,
    ),
    UNREACHABLE,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("Copilot tokens at or before expiry answer unreachable without a request", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  assert.deepEqual(
    await checkGitHubCopilot(SECRET, now, background),
    UNREACHABLE,
  );
  assert.deepEqual(
    await checkGitHubCopilot(SECRET, now - FUTURE_MS, background),
    UNREACHABLE,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});
