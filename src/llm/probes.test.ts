import assert from "node:assert/strict";
import { test } from "node:test";
import { background, CancellationContext } from "../kernel/context.ts";
import { ResourceStatus, type ResourceCheck } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import {
  CAPABILITY_COPILOT_TOKEN_READ,
  CAPABILITY_KEY_READ,
  CAPABILITY_MODEL_CALL,
  CAPABILITY_MODEL_LIST_READ,
  CAPABILITY_NONE,
  LLM_PLATFORMS,
  MODEL_PROVIDER_PROBES,
  Platform,
} from "./platforms.ts";
import {
  ANTHROPIC_API_KEY_HEADER,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION,
  ANTHROPIC_VERSION_HEADER,
  GITHUB_COPILOT_TOKEN_URL,
  MODELS_PATH,
  OPENAI_CODEX_PROBE_MODEL,
  OPENAI_CODEX_PROBE_PROMPT,
  OPENAI_CODEX_PROBE_REASONING,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_MODELS_URL,
  OPENROUTER_KEY_URL,
  probeAnthropic,
  probeGitHubCopilot,
  probeOpenAI,
  probeOpenAICodex,
  probeOpenAICompatible,
  probeOpenRouter,
  type ModelCall,
} from "./probes.ts";

const SECRET = "test_private-resource-health-secret";
const BASE_URL = "https://models.example/v1";
const FUTURE_MS = 60000;
const NO_CALLS = 0;
const ONE_CALL = 1;
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

const httpProbes: {
  name: string;
  url: string;
  headers: Record<string, string>;
  check: ResourceCheck;
}[] = [
  {
    name: Platform.GitHubCopilot,
    url: GITHUB_COPILOT_TOKEN_URL,
    headers: COPILOT_HEADERS,
    check: (context) =>
      probeGitHubCopilot(REFRESH_SECRET, Date.now() + FUTURE_MS, context),
  },
  {
    name: Platform.Anthropic,
    url: ANTHROPIC_MODELS_URL,
    headers: ANTHROPIC_HEADERS,
    check: (context) => probeAnthropic(SECRET, context),
  },
  {
    name: Platform.OpenAICompatible,
    url: BASE_URL + MODELS_PATH,
    headers: BEARER_HEADERS,
    check: (context) => probeOpenAICompatible(SECRET, BASE_URL, context),
  },
  {
    name: Platform.OpenRouter,
    url: OPENROUTER_KEY_URL,
    headers: BEARER_HEADERS,
    check: (context) => probeOpenRouter(SECRET, context),
  },
  {
    name: Platform.OpenAI,
    url: OPENAI_MODELS_URL,
    headers: BEARER_HEADERS,
    check: (context) => probeOpenAI(SECRET, context),
  },
];

test("every model provider probe selects its validator by platform", async (t) => {
  assert.deepEqual(Object.keys(MODEL_PROVIDER_PROBES).sort(), [
    Platform.Anthropic,
    Platform.OpenAI,
    Platform.OpenAICodex,
    Platform.OpenAICompatible,
    Platform.OpenRouter,
  ]);
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
  assert.equal(LLM_PLATFORMS.groq.capability, CAPABILITY_NONE);
  const urls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(url);
    return new Response(null, { status: HttpStatus.OK });
  });
  const metadata = { baseUrl: BASE_URL, models: [] };
  for (const platform of [
    Platform.Anthropic,
    Platform.OpenAICompatible,
    Platform.OpenRouter,
    Platform.OpenAI,
  ]) {
    assert.equal(
      await MODEL_PROVIDER_PROBES[platform]!(
        { key: SECRET },
        platform === Platform.OpenAICompatible ? metadata : null,
        background,
      ),
      ResourceStatus.Healthy,
    );
  }
  assert.deepEqual(urls, [
    ANTHROPIC_MODELS_URL,
    BASE_URL + MODELS_PATH,
    OPENROUTER_KEY_URL,
    OPENAI_MODELS_URL,
  ]);
});

for (const probe of httpProbes) {
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
  ] as const) {
    test(`${probe.name} maps HTTP ${status} and sends the expected request`, async (t) => {
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async (
          url: Parameters<typeof globalThis.fetch>[0],
          options?: RequestInit,
        ) => {
          assert.equal(url, probe.url);
          assert.equal(options?.method, HttpMethod.Get);
          assert.deepEqual(options?.headers, probe.headers);
          return new Response(null, { status });
        },
      );
      assert.equal(await probe.check(background), expected);
      assert.equal(fetch.mock.callCount(), ONE_CALL);
    });
  }
}

const USER_ROLE = "user";
const REASON_COUNT = 2;
const REASON_LIMIT = 400;
const REFRESH = "test_private-refresh-token-value-0123456789";
const credentialOf = (expires: number) => ({
  refresh: REFRESH,
  access: SECRET,
  expires,
});
const codexCall =
  (
    status: number,
    stopReason: "stop" | "error",
    errorMessage?: string,
  ): ModelCall =>
  async (_model, _context, options) => {
    await options.onResponse?.({ status, headers: {} }, _model);
    return { stopReason, errorMessage } as Awaited<ReturnType<ModelCall>>;
  };

test("openai-codex probe sends one model call and maps replies and failures", async (t) => {
  assert.equal(
    LLM_PLATFORMS[Platform.OpenAICodex].capability,
    CAPABILITY_MODEL_CALL,
  );
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
    return codexCall(HttpStatus.OK, "stop")(
      model,
      modelContext,
      options,
      store,
    );
  };
  const future = Date.now() + FUTURE_MS;
  assert.equal(
    await probeOpenAICodex(credentialOf(future), background, recording),
    ResourceStatus.Healthy,
  );
  assert.equal(seen.length, ONE_CALL);
  const [id, messages, options, stored, listed] = seen[0] as [
    string,
    { role: string; content: string }[],
    Record<string, unknown>,
    unknown,
    unknown,
  ];
  assert.equal(id, OPENAI_CODEX_PROBE_MODEL);
  assert.equal(options.reasoning, OPENAI_CODEX_PROBE_REASONING);
  assert.equal(Object.hasOwn(options, "apiKey"), false);
  assert.equal(Object.hasOwn(options, "transport"), false);
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
  assert.equal(messages[0]!.content, OPENAI_CODEX_PROBE_PROMPT);
  for (const [status, expected] of [
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unhealthy],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const)
    assert.equal(
      await probeOpenAICodex(
        credentialOf(future),
        background,
        codexCall(status, "error"),
      ),
      expected,
    );
  assert.equal(
    await probeOpenAICodex(credentialOf(future), background, async () => {
      throw new Error(SECRET);
    }),
    ResourceStatus.Unknown,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("openai-codex probe reports a reason without token material", async () => {
  const reasons: string[] = [];
  const observe = (reason: string) => reasons.push(reason);
  const future = Date.now() + FUTURE_MS;
  const long = "A".repeat(500);
  await probeOpenAICodex(
    credentialOf(future),
    background,
    codexCall(
      HttpStatus.Unauthorized,
      "error",
      `denied Bearer abc.def ${SECRET} ${REFRESH} ${long}`,
    ),
    observe,
  );
  await probeOpenAICodex(
    credentialOf(future),
    background,
    async () => {
      throw new Error(`failed with ${SECRET}`);
    },
    observe,
  );
  assert.equal(reasons.length, REASON_COUNT);
  assert.match(reasons[0]!, /^status=401 stopReason=error errorMessage=denied/);
  assert.match(reasons[1]!, /^Error: failed with/);
  for (const reason of reasons) {
    assert.ok(reason.length <= REASON_LIMIT);
    assert.ok(!reason.includes(SECRET));
    assert.ok(!reason.includes(REFRESH));
    assert.ok(!reason.includes("abc.def"));
    assert.ok(!reason.includes(long));
  }
});

test("openai-codex probe makes no call and refreshes nothing for an expired token or a cancelled context", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  let calls = NO_CALLS;
  const counting: ModelCall = async (model, modelContext, options, store) => {
    calls += ONE_CALL;
    return codexCall(HttpStatus.OK, "stop")(
      model,
      modelContext,
      options,
      store,
    );
  };
  assert.equal(
    await probeOpenAICodex(
      credentialOf(Date.now() - FUTURE_MS),
      background,
      counting,
    ),
    ResourceStatus.Unknown,
  );
  const cancelled = new CancellationContext();
  cancelled.cancel();
  assert.equal(
    await probeOpenAICodex(
      credentialOf(Date.now() + FUTURE_MS),
      cancelled,
      counting,
    ),
    ResourceStatus.Unknown,
  );
  assert.equal(calls, NO_CALLS);
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("Copilot tokens at or before expiry never make a request", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  assert.equal(
    await probeGitHubCopilot(SECRET, now, background),
    ResourceStatus.Unknown,
  );
  assert.equal(
    await probeGitHubCopilot(SECRET, now - FUTURE_MS, background),
    ResourceStatus.Unknown,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});
