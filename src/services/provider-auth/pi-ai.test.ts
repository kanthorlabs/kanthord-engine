import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultProviderAuthContext, lazyOAuth } from "@earendil-works/pi-ai";
import {
  builtinProviders,
  builtinModels,
  getBuiltinProviders,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AssistantMessage,
  AuthPrompt,
  Context,
  CredentialStore,
  Model,
  OAuthAuth,
  OAuthCredential,
  ModelAuth,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";

import { chooseOptionId, PiAiProviderAuth } from "./pi-ai.ts";
import { LoginError, ProviderAuthError } from "./index.ts";
import type {
  CredentialWriter,
  LoginRefusal,
  ProviderAuthRow,
  StartLoginInput,
} from "./index.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";

const row = {
  providerId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
  vendorId: "groq",
  transport: "api-key",
  defaultModel: "llama-3.1-8b-instant",
  apiKey: "gsk_test_probe_key_ABCDEFGH123456",
  baseUrl: null,
} as ProviderAuthRow &
  Readonly<{
    providerId: string;
    transport: "api-key";
    apiKey: string;
  }>;

const SIGNAL = AbortSignal.timeout(30_000);

type FetchCall = Readonly<{
  url: string;
  init: RequestInit | undefined;
}>;

type RecordingFetch = {
  fetch: typeof fetch;
  calls: number;
  requests: FetchCall[];
};

function successFetch(content = "3"): typeof fetch {
  return async (_url, _init) => {
    const body = [
      `data: ${JSON.stringify({
        id: "chatcmpl-t",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: { role: "assistant", content },
            finish_reason: null,
            index: 0,
          },
        ],
        model: "llama-3.1-8b-instant",
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-t",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        model: "llama-3.1-8b-instant",
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

function errorFetch(status: number): typeof fetch {
  return async (_url, _init) =>
    new Response(JSON.stringify({ error: { message: "error" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function recordingFetch(inner: typeof fetch): RecordingFetch {
  const recording: RecordingFetch = {
    fetch: inner,
    calls: 0,
    requests: [],
  };
  recording.fetch = async (url, init) => {
    recording.calls++;
    recording.requests.push({ url: String(url), init });
    return inner(url, init);
  };
  return recording;
}

function onlyRequest(recording: RecordingFetch): FetchCall {
  assert.equal(recording.calls, 1);
  const request = recording.requests[0];
  assert.ok(request !== undefined);
  return request;
}

function assertProbeRequest(request: FetchCall): void {
  const body = request.init?.body;
  if (typeof body !== "string") {
    assert.fail("probe request body must be JSON text");
  }
  const payload = JSON.parse(body) as {
    model?: unknown;
    messages?: unknown;
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
  };
  assert.equal(payload.model, row.defaultModel);
  assert.deepEqual(payload.messages, [
    { role: "user", content: "What time is it?" },
  ]);
  assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 16);

  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${row.apiKey}`);
}

function assertNoSecret(value: unknown): void {
  assert.equal(JSON.stringify(value).includes(row.apiKey), false);
}

describe("src/services/provider-auth/pi-ai", () => {
  it("probes a completion and reports completed", async () => {
    const recording = recordingFetch(successFetch());
    const auth = new PiAiProviderAuth(recording.fetch);

    const outcome = await auth.probe(row, SIGNAL);

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    });
    assert.equal("detail" in outcome, false);
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a 401 response to credential-rejected", async () => {
    const recording = recordingFetch(errorFetch(401));
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a 403 response to credential-rejected with HTTP 403 detail", async () => {
    const recording = recordingFetch(errorFetch(403));
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 403",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a 404 response to model-unavailable", async () => {
    const recording = recordingFetch(errorFetch(404));
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "model-unavailable",
      detail: "HTTP 404",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a 429 response to quota-exceeded", async () => {
    const recording = recordingFetch(errorFetch(429));
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "quota-exceeded",
      detail: "HTTP 429",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a 500 response to endpoint-rejected", async () => {
    const recording = recordingFetch(errorFetch(500));
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-rejected",
      detail: "HTTP 500",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps a network failure to endpoint-unreachable", async () => {
    const throwingFetch: typeof fetch = async () => {
      throw new TypeError("network failure");
    };
    const recording = recordingFetch(throwingFetch);
    const outcome = await new PiAiProviderAuth(recording.fetch).probe(
      row,
      SIGNAL,
    );

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "unreachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-unreachable",
      detail: "transport-error",
    });
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("maps an internal timeout to endpoint-unreachable without aborting the caller", async () => {
    const timeoutValues: number[] = [];
    let timeoutController: AbortController | undefined;
    let composedSignal: AbortSignal | undefined;
    const createTimeoutSignal = (milliseconds: number): AbortSignal => {
      timeoutValues.push(milliseconds);
      timeoutController = new AbortController();
      return timeoutController.signal;
    };
    const pendingFetch: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        throw new Error("probe request did not receive an abort signal");
      }
      composedSignal = signal;
      const controller = timeoutController;
      if (controller === undefined) {
        throw new Error("timeout signal was not created");
      }
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        controller.signal.addEventListener("abort", abort, { once: true });
        controller.abort();
      });
    };
    const recording = recordingFetch(pendingFetch);
    const caller = new AbortController();

    const outcome = await new PiAiProviderAuth(recording.fetch, {
      createTimeoutSignal,
    }).probe(row, caller.signal);

    assert.deepEqual(outcome, {
      model: "llama-3.1-8b-instant",
      reachability: "unreachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-unreachable",
      detail: "timeout-or-abort",
    });
    assert.deepEqual(timeoutValues, [30_000]);
    assert.ok(timeoutController !== undefined);
    assert.equal(timeoutController.signal.aborted, true);
    assert.ok(composedSignal !== undefined);
    assert.equal(composedSignal.aborted, true);
    assert.equal(caller.signal.aborted, false);
    assertProbeRequest(onlyRequest(recording));
    assertNoSecret(outcome);
  });

  it("refuses an unknown vendor without a request", async () => {
    const recording = recordingFetch(successFetch());
    const badRow: ProviderAuthRow = {
      ...row,
      vendorId: "not-a-real-vendor-xyz",
    };

    await assert.rejects(
      () => new PiAiProviderAuth(recording.fetch).probe(badRow, SIGNAL),
      (error: unknown) => {
        assert(error instanceof ProviderAuthError);
        assert.equal(error.refusal, "vendor-not-catalogued");
        return true;
      },
    );
    assert.equal(recording.calls, 0);
  });

  it("does not include the api key in any response outcome", async () => {
    const fetches: (typeof fetch)[] = [
      successFetch(),
      errorFetch(401),
      errorFetch(403),
      errorFetch(404),
      errorFetch(429),
      errorFetch(500),
      async () => {
        throw new TypeError("network failure");
      },
    ];

    for (const implementation of fetches) {
      const outcome = await new PiAiProviderAuth(implementation).probe(
        row,
        SIGNAL,
      );
      assertNoSecret(outcome);
    }
  });

  it("does not include the reply text in the successful outcome", async () => {
    const expected = {
      model: "llama-3.1-8b-instant",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    };

    for (const content of ["", "   ", "The answer is not deterministic"]) {
      const recording = recordingFetch(successFetch(content));
      const outcome = await new PiAiProviderAuth(recording.fetch).probe(
        row,
        SIGNAL,
      );

      assert.deepEqual(outcome, expected);
      assertProbeRequest(onlyRequest(recording));
      assertNoSecret(outcome);
    }
  });

  it("isolates same-vendor credential stores per probe", async () => {
    const firstRow: ProviderAuthRow = {
      ...row,
      apiKey: "gsk_test_first_probe_key_ABCDEFGH123456",
    };
    const secondRow: ProviderAuthRow = {
      ...row,
      apiKey: "gsk_test_second_probe_key_ABCDEFGH123456",
    };
    const stores: CredentialStore[] = [];
    const createModels: typeof builtinModels = (options) => {
      if (options === undefined || options.credentials === undefined) {
        throw new Error("models credentials are required");
      }
      stores.push(options.credentials);
      return builtinModels(options);
    };
    const auth = new PiAiProviderAuth(successFetch(), { createModels });

    await auth.probe(firstRow, SIGNAL);
    await auth.probe(secondRow, SIGNAL);

    assert.equal(stores.length, 2);
    const firstStore = stores[0];
    const secondStore = stores[1];
    assert.ok(firstStore !== undefined);
    assert.ok(secondStore !== undefined);

    for (const [store, ownKey, foreignKey] of [
      [firstStore, firstRow.apiKey, secondRow.apiKey],
      [secondStore, secondRow.apiKey, firstRow.apiKey],
    ] as const) {
      assert.deepEqual(await store.list(), [
        { providerId: "groq", type: "api_key" },
      ]);
      const boundCredential = await store.read("groq");
      assert.deepEqual(boundCredential, { type: "api_key", key: ownKey });
      assert.notEqual(boundCredential?.key, foreignKey);
      assert.equal(await store.read("anthropic"), undefined);

      let callbackInvocations = 0;
      const modified = await store.modify("anthropic", async () => {
        callbackInvocations++;
        return undefined;
      });
      assert.equal(modified, undefined);
      assert.equal(callbackInvocations, 0);
    }
  });
});

describe("pi-ai error format contract", () => {
  it("formats a 401 provider error with a 401: prefix in errorMessage", async () => {
    const model = getBuiltinModels("groq").find(
      (candidate) => candidate.id === "llama-3.1-8b-instant",
    ) as Model<Api> | undefined;
    assert.ok(model !== undefined);

    const context: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What time is it?" }],
          timestamp: 1_700_000_000_000,
        },
      ],
    };
    const models = builtinModels({
      credentials: {
        async read() {
          return { type: "api_key" as const, key: "sk-pin-test" };
        },
        async list() {
          return [];
        },
        async modify(_id, fn) {
          return fn({ type: "api_key" as const, key: "sk-pin-test" });
        },
        async delete() {},
      },
      authContext: defaultProviderAuthContext(),
    });
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    const result = await models.completeSimple(model, context, {
      maxTokens: 1,
      fetch: fakeFetch,
    });

    assert.equal(result.stopReason, "error");
    assert(
      result.errorMessage?.startsWith("401:"),
      `expected errorMessage to start with "401:" but got: ${result.errorMessage}`,
    );
  });
});

function providerOauth(vendorId: string): OAuthAuth {
  const provider = builtinProviders().find((entry) => entry.id === vendorId);
  assert.ok(provider !== undefined);
  const oauth = provider.auth.oauth;
  assert.ok(oauth !== undefined);
  return oauth;
}

class StopPrompt extends Error {}

async function firstPrompt(vendorId: string): Promise<AuthPrompt> {
  const oauth = providerOauth(vendorId);
  let seen: AuthPrompt | undefined;

  await assert.rejects(
    () =>
      oauth.login({
        signal: new AbortController().signal,
        prompt: async (prompt) => {
          seen = prompt;
          throw new StopPrompt();
        },
        notify: () => {},
      }),
    (error: unknown) => error instanceof StopPrompt,
  );

  assert.ok(seen !== undefined);
  return seen;
}

describe("the oauth vendor set", () => {
  it("derives the admitted set from the library, not from a list", () => {
    const auth = new PiAiProviderAuth();
    const ids = auth.oauthVendors().map((vendor) => vendor.id);
    const expected = builtinProviders()
      .filter((provider) => provider.auth.oauth !== undefined)
      .filter((provider) =>
        new Set<string>(getBuiltinProviders()).has(provider.id),
      )
      .map((provider) => provider.id)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );

    assert.deepEqual(ids, [
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "openai-codex",
      "openrouter",
      "xai",
    ]);
    assert.deepEqual(ids, expected);
  });

  it("excludes radius because the catalogue does not carry it", () => {
    assert.equal(
      builtinProviders().some((provider) => provider.id === "radius"),
      true,
    );
    assert.equal(getBuiltinProviders().includes("radius" as never), false);
    assert.deepEqual(getBuiltinModels("radius" as never), []);
    assert.equal(
      new PiAiProviderAuth()
        .oauthVendors()
        .some((vendor) => vendor.id === "radius"),
      false,
    );
  });

  it("reads the eager oauth properties without loading a flow module", () => {
    let loaded = false;
    const oauth = lazyOAuth({
      name: "Lazy OAuth",
      isSubscription: true,
      loginLabel: "Lazy sign-in",
      load: async () => {
        loaded = true;
        throw new Error("flow loaded");
      },
    });
    const provider = { auth: { oauth } };
    const resolveOauth = (candidate: typeof provider): OAuthAuth | undefined =>
      candidate.auth.oauth;
    const resolved = resolveOauth(provider);

    assert.ok(resolved !== undefined);
    assert.equal(resolved.name, "Lazy OAuth");
    assert.equal(resolved.isSubscription, true);
    assert.equal(resolved.loginLabel, "Lazy sign-in");
    assert.ok(Array.isArray(new PiAiProviderAuth().oauthVendors()));
    assert.equal(loaded, false);
  });

  it("labels each vendor with loginLabel when it has one and name otherwise", () => {
    assert.deepEqual(new PiAiProviderAuth().oauthVendors(), [
      {
        id: "anthropic",
        label: "Anthropic (Claude Pro/Max)",
        isSubscription: true,
      },
      { id: "github-copilot", label: "GitHub Copilot", isSubscription: true },
      {
        id: "kimi-coding",
        label: "Sign in with Kimi Code",
        isSubscription: true,
      },
      {
        id: "openai-codex",
        label: "OpenAI (ChatGPT Plus/Pro)",
        isSubscription: true,
      },
      {
        id: "openrouter",
        label: "Sign in with OpenRouter",
        isSubscription: false,
      },
      {
        id: "xai",
        label: "Sign in with SuperGrok or X Premium",
        isSubscription: true,
      },
    ]);
  });

  it("excludes a provider with no oauth", () => {
    const ids = new Set(
      new PiAiProviderAuth().oauthVendors().map((vendor) => vendor.id),
    );

    assert.equal(ids.has("openai"), false);
    assert.equal(ids.has("groq"), false);
    assert.equal(ids.has("openai-compatible"), false);
  });
});

describe("the login method rule", () => {
  it("prefers the underscore device spelling", () => {
    assert.equal(
      chooseOptionId("openai-codex", ["browser", "device_code"]),
      "device_code",
    );
  });

  it("prefers the hyphen device spelling", () => {
    assert.equal(
      chooseOptionId("radius", ["browser", "device-code"]),
      "device-code",
    );
  });

  it("falls back to the browser option", () => {
    assert.equal(chooseOptionId("x", ["browser"]), "browser");
  });

  it("refuses an option set with no recognized spelling", () => {
    assert.throws(
      () => chooseOptionId("x", ["qr", "sms"]),
      (error: unknown) => {
        if (!(error instanceof LoginError)) return false;
        assert.equal(error.refusal, "login-method-unavailable");
        assert.equal(error.detail, "qr,sms");
        return true;
      },
    );
  });

  it("prefers device over browser regardless of order", () => {
    assert.equal(
      chooseOptionId("x", ["device_code", "browser"]),
      "device_code",
    );
    assert.equal(
      chooseOptionId("x", ["browser", "device_code"]),
      "device_code",
    );
  });
});

describe("the installed oauth prompts", () => {
  it("pins the openai-codex select option ids against the installed library", async () => {
    const seen = await firstPrompt("openai-codex");

    assert.equal(seen.type, "select");
    assert.equal(seen.message, "Select OpenAI Codex login method:");
    assert.deepEqual(
      seen.options.map((option) => option.id),
      ["browser", "device_code"],
    );
    assert.equal(
      chooseOptionId("openai-codex", ["browser", "device_code"]),
      "device_code",
    );
  });

  it("pins the radius select option ids against the installed library", async () => {
    const seen = await firstPrompt("radius");

    assert.equal(seen.type, "select");
    assert.equal(seen.message, "Sign in to Radius:");
    assert.deepEqual(
      seen.options.map((option) => option.id),
      ["browser", "device-code"],
    );
    assert.equal(
      chooseOptionId("radius", ["browser", "device-code"]),
      "device-code",
    );
  });

  it("pins the github-copilot enterprise prompt message against the installed library", async () => {
    const seen = await firstPrompt("github-copilot");

    assert.equal(seen.type, "text");
    assert.equal(
      seen.message,
      "GitHub Enterprise URL/domain (blank for github.com)",
    );
  });

  it("pins kimi-coding as a promptless device-code flow", async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    let prompts = 0;
    globalThis.fetch = (async () => {
      throw new Error("NETWORK-BLOCKED");
    }) as typeof fetch;

    await assert.rejects(
      () =>
        providerOauth("kimi-coding").login({
          signal: new AbortController().signal,
          prompt: async () => {
            prompts++;
            return "unexpected";
          },
          notify: () => {},
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "NETWORK-BLOCKED");
        return true;
      },
    );
    assert.equal(prompts, 0);
  });

  it("pins xai as a promptless device-code flow", async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    let prompts = 0;
    globalThis.fetch = (async () => {
      throw new Error("NETWORK-BLOCKED");
    }) as typeof fetch;

    await assert.rejects(
      () =>
        providerOauth("xai").login({
          signal: new AbortController().signal,
          prompt: async () => {
            prompts++;
            return "unexpected";
          },
          notify: () => {},
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "NETWORK-BLOCKED");
        return true;
      },
    );
    assert.equal(prompts, 0);
  });
});

function fakeOauth(
  run: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
): OAuthAuth {
  return {
    name: "Fake",
    login: run,
    refresh: async (credential) => credential,
    toAuth: async () => ({ type: "api_key", key: "" }) as unknown as ModelAuth,
  };
}

const LOGIN_NOW = 1_700_000_000_000;
const LOGIN_CREDENTIAL: OAuthCredential = {
  type: "oauth",
  access: "at-1",
  refresh: "rt-1",
  expires: 1_700_000_600_000,
};

function createLoginAuth(
  resolveOauth: (vendorId: string) => OAuthAuth | undefined,
  clock = createMockClock({ start: LOGIN_NOW }),
): PiAiProviderAuth {
  return new PiAiProviderAuth(fetch, { resolveOauth, clock });
}

const OAUTH_CREDENTIAL: OAuthCredential = {
  type: "oauth",
  access: "access-store-before",
  refresh: "refresh-store-before",
  expires: LOGIN_NOW + 600_000,
  enterpriseUrl: "https://enterprise.example.test",
};

const oauthRow = {
  providerId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
  vendorId: "openai-codex",
  transport: "oauth",
  credential: OAUTH_CREDENTIAL,
  defaultModel: "gpt-5.4",
  baseUrl: null,
} as unknown as ProviderAuthRow &
  Readonly<{
    providerId: string;
  }>;

async function capturedOauthStore(
  writer?: CredentialWriter,
): Promise<CredentialStore> {
  let captured: CredentialStore | undefined;
  const createModels: typeof builtinModels = (options) => {
    const credentials = options?.credentials;
    if (credentials === undefined) {
      throw new Error("models credentials are required");
    }
    captured = credentials;
    return {
      completeSimple: async () =>
        ({ stopReason: "stop" }) as unknown as AssistantMessage,
    } as unknown as ReturnType<typeof builtinModels>;
  };
  const dependencies = {
    createModels,
    ...(writer === undefined ? {} : { credentialWriter: writer }),
  } as ConstructorParameters<typeof PiAiProviderAuth>[1];
  await new PiAiProviderAuth(successFetch(), dependencies).probe(
    oauthRow,
    new AbortController().signal,
  );
  assert.ok(captured !== undefined);
  return captured;
}

function startInput(input: Partial<StartLoginInput> = {}): StartLoginInput {
  return {
    loginId: input.loginId ?? "login-1",
    vendorId: input.vendorId ?? "fake-vendor",
    answers: input.answers ?? {},
  };
}

async function assertLoginError(
  operation: () => Promise<unknown>,
  refusal: LoginRefusal,
  detail?: string,
): Promise<LoginError> {
  let captured: LoginError | undefined;
  await assert.rejects(operation, (error: unknown) => {
    if (!(error instanceof LoginError)) return false;
    captured = error;
    assert.equal(error.refusal, refusal);
    if (detail !== undefined) assert.equal(error.detail, detail);
    return true;
  });
  assert.ok(captured instanceof LoginError);
  return captured;
}

describe("the suspended login", () => {
  it("refuses a vendor with no oauth flow and makes no call", async () => {
    let resolvedVendor: string | undefined;
    const auth = createLoginAuth((vendorId) => {
      resolvedVendor = vendorId;
      return undefined;
    });

    const error = await assertLoginError(
      () => auth.startLogin(startInput()),
      "provider-not-oauth-capable",
    );

    assert.equal(resolvedVendor, "fake-vendor");
    assert.equal(error.detail, "");
  });

  it("answers a select with the device-code option", async () => {
    let answer: string | undefined;
    const oauth = fakeOauth(async (interaction) => {
      answer = await interaction.prompt({
        type: "select",
        message: "Choose a method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      });
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());

    assert.equal(answer, "device_code");
    auth.abortLogin("login-1");
  });

  it("refuses a select with no recognized option and prompts no further", async () => {
    let prompts = 0;
    const oauth = fakeOauth(async (interaction) => {
      prompts++;
      await interaction.prompt({
        type: "select",
        message: "Choose a method",
        options: [
          { id: "qr", label: "QR" },
          { id: "sms", label: "SMS" },
        ],
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    const error = await assertLoginError(
      () => auth.startLogin(startInput()),
      "login-method-unavailable",
      "qr,sms",
    );

    assert.equal(prompts, 1);
    assert.equal(error.detail, "qr,sms");
  });

  it("answers a text prompt from answers", async () => {
    const message = "GitHub Enterprise URL/domain (blank for github.com)";
    let answer: string | undefined;
    const oauth = fakeOauth(async (interaction) => {
      answer = await interaction.prompt({ type: "text", message });
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput({ answers: { [message]: "" } }));

    assert.equal(answer, "");
    auth.abortLogin("login-1");
  });

  it("refuses a text prompt with no matching answer and carries the message", async () => {
    const message = "GitHub Enterprise URL/domain (blank for github.com)";
    const oauth = fakeOauth(async (interaction) => {
      await interaction.prompt({ type: "text", message });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    const error = await assertLoginError(
      () => auth.startLogin(startInput()),
      "login-input-required",
      message,
    );

    assert.equal(error.detail, message);
  });

  it("returns the device challenge with the event interval in milliseconds", async () => {
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
        intervalSeconds: 7,
        expiresInSeconds: 300,
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(
      () => oauth,
      createMockClock({ start: LOGIN_NOW }),
    );

    const challenge = await auth.startLogin(startInput());

    assert.deepEqual(challenge, {
      method: "device-code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://v.test/device",
      pollIntervalMs: 7000,
      expiresAt: 1_700_000_300_000,
    });
    auth.abortLogin("login-1");
  });

  it("falls back to five seconds and ten minutes when the event omits them", async () => {
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(
      () => oauth,
      createMockClock({ start: LOGIN_NOW }),
    );

    const challenge = await auth.startLogin(startInput());

    assert.ok(challenge.method === "device-code");
    assert.equal(challenge.pollIntervalMs, 5000);
    assert.equal(challenge.expiresAt, 1_700_000_600_000);
    auth.abortLogin("login-1");
  });

  it("times the device expiry from the event, not from the start", async () => {
    const clock = createMockClock({ start: LOGIN_NOW, step: 120_000 });
    const oauth = fakeOauth(async (interaction) => {
      void clock.now();
      await interaction.prompt({ type: "text", message: "before device" });
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
        expiresInSeconds: 300,
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth, clock);

    const challenge = await auth.startLogin(
      startInput({ answers: { "before device": "done" } }),
    );

    assert.ok(challenge.method === "device-code");
    assert.equal(challenge.expiresAt, 1_700_000_420_000);
    assert.notEqual(challenge.expiresAt, 1_700_000_300_000);
    auth.abortLogin("login-1");
  });

  it("returns the manual challenge from the auth_url event", async () => {
    let suspended = false;
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
        instructions: "Complete login in your browser.",
      });
      suspended = true;
      await interaction.prompt({
        type: "manual_code",
        message: "Paste the code",
      });
      suspended = false;
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    const challenge = await auth.startLogin(startInput());

    try {
      assert.deepEqual(challenge, {
        method: "manual-code",
        authUrl: "https://vendor.test/authorize?x=1",
        instructions: "Complete login in your browser.",
        expiresAt: null,
      });
      assert.equal(suspended, true);
    } finally {
      auth.abortLogin("login-1");
    }
  });

  it("ignores progress and info events", async () => {
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({ type: "progress", message: "working" });
      interaction.notify({ type: "info", message: "additional information" });
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
        instructions: "Complete login in your browser.",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    const challenge = await auth.startLogin(startInput());

    try {
      assert.deepEqual(challenge, {
        method: "manual-code",
        authUrl: "https://vendor.test/authorize?x=1",
        instructions: "Complete login in your browser.",
        expiresAt: null,
      });
    } finally {
      auth.abortLogin("login-1");
    }
  });

  it("supplies the pasted code to the suspended manual prompt", async () => {
    let receivedCode: string | undefined;
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      receivedCode = await interaction.prompt({
        type: "manual_code",
        message: "Paste",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    const outcome = await auth.completeLogin({
      loginId: "login-1",
      code: "abc-123",
    });

    assert.equal(receivedCode, "abc-123");
    assert.deepEqual(outcome, {
      status: "completed",
      login: {
        credential: LOGIN_CREDENTIAL,
        availableModelIds: null,
      },
    });
  });

  it("completes a manual login the callback already resolved, with no code", async () => {
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    const outcome = await auth.completeLogin({ loginId: "login-1" });

    assert.deepEqual(outcome, {
      status: "completed",
      login: {
        credential: LOGIN_CREDENTIAL,
        availableModelIds: null,
      },
    });
  });

  it("refuses an absent code on a still-suspended manual arm", async () => {
    let resolved = false;
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      resolved = true;
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    try {
      await assertLoginError(
        () => auth.completeLogin({ loginId: "login-1" }),
        "code-required",
      );
      assert.equal(resolved, false);
    } finally {
      auth.abortLogin("login-1");
    }
  });

  it("answers pending while the device flow still polls", async () => {
    let resolveFlow!: (credential: OAuthCredential) => void;
    const flow = new Promise<OAuthCredential>((resolve) => {
      resolveFlow = resolve;
    });
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return flow;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    const pending = await auth.completeLogin({ loginId: "login-1" });
    assert.deepEqual(pending, { status: "pending" });

    resolveFlow(LOGIN_CREDENTIAL);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed = await auth.completeLogin({ loginId: "login-1" });

    assert.deepEqual(completed, {
      status: "completed",
      login: {
        credential: LOGIN_CREDENTIAL,
        availableModelIds: null,
      },
    });
  });

  it("answers lost for an unknown loginId", async () => {
    const auth = createLoginAuth(() => undefined);

    const outcome = await auth.completeLogin({ loginId: "missing-login" });

    assert.deepEqual(outcome, { status: "lost" });
  });

  it("reads availableModelIds when the credential carries them", async () => {
    const credential: OAuthCredential = {
      ...LOGIN_CREDENTIAL,
      availableModelIds: ["gpt-5-codex", "gpt-5"],
    };
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return credential;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    const outcome = await auth.completeLogin({ loginId: "login-1" });

    assert.deepEqual(outcome, {
      status: "completed",
      login: {
        credential,
        availableModelIds: ["gpt-5-codex", "gpt-5"],
      },
    });
  });

  it("answers null model ids when the key is absent or malformed", async () => {
    const variants: readonly OAuthCredential[] = [
      { ...LOGIN_CREDENTIAL },
      { ...LOGIN_CREDENTIAL, availableModelIds: "not-an-array" },
      { ...LOGIN_CREDENTIAL, availableModelIds: ["a", 2] },
    ];

    for (const [index, credential] of variants.entries()) {
      const oauth = fakeOauth(async (interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: `CODE-${index}`,
          verificationUri: "https://v.test/device",
        });
        return credential;
      });
      const auth = createLoginAuth(() => oauth);
      const loginId = `login-${index}`;

      await auth.startLogin(startInput({ loginId }));
      const outcome = await auth.completeLogin({ loginId });

      assert.equal(outcome.status, "completed");
      if (outcome.status === "completed") {
        assert.equal(outcome.login.availableModelIds, null);
      }
    }
  });

  it("aborts the live flow through its signal and forgets it", async () => {
    let signal: AbortSignal | undefined;
    const oauth = fakeOauth(async (interaction) => {
      signal = interaction.signal;
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    auth.abortLogin("login-1");

    assert.ok(signal !== undefined);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await auth.completeLogin({ loginId: "login-1" }), {
      status: "lost",
    });
    assert.doesNotThrow(() => auth.abortLogin("login-1"));
  });

  it("propagates a login failure as login-failed", async () => {
    const oauth = fakeOauth(async () => {
      throw new Error("vendor said no");
    });
    const auth = createLoginAuth(() => oauth);

    await assertLoginError(() => auth.startLogin(startInput()), "login-failed");
  });

  it("does not leak the token into the LoginError message or detail", async () => {
    const oauth = fakeOauth(async () => {
      throw new Error("vendor rejected at-1 and rt-1");
    });
    const auth = createLoginAuth(() => oauth);

    const error = await assertLoginError(
      () => auth.startLogin(startInput()),
      "login-failed",
    );
    const serialized = JSON.stringify({
      name: error.name,
      message: error.message,
      refusal: error.refusal,
      detail: error.detail,
    });

    assert.equal(serialized.includes("at-1"), false);
    assert.equal(serialized.includes("rt-1"), false);
  });

  it("answers a prompt issued synchronously before login returns", async () => {
    let answer: string | undefined;
    const oauth = fakeOauth((interaction) => {
      const prompt = interaction.prompt({
        type: "select",
        message: "Choose a method",
        options: [{ id: "device_code", label: "Device code" }],
      });
      return prompt.then((value) => {
        answer = value;
        interaction.notify({
          type: "device_code",
          userCode: "WDJB-MJHT",
          verificationUri: "https://v.test/device",
        });
        return LOGIN_CREDENTIAL;
      });
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());

    assert.equal(answer, "device_code");
    auth.abortLogin("login-1");
  });

  it("aborts the flow when the vendor answers nothing before the start deadline", async () => {
    let signal: AbortSignal | undefined;
    const oauth = fakeOauth(async (interaction) => {
      signal = interaction.signal;
      return await new Promise<OAuthCredential>(() => {});
    });
    const auth = createLoginAuth(() => oauth);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: unknown) => {
      if (typeof handler !== "function")
        throw new Error("timer handler required");
      handler();
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      await assertLoginError(
        () => auth.startLogin(startInput()),
        "login-failed",
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.ok(signal !== undefined);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await auth.completeLogin({ loginId: "login-1" }), {
      status: "lost",
    });
  });

  it("aborts the flow when startLogin fails before a challenge", async () => {
    let signal: AbortSignal | undefined;
    const oauth = fakeOauth(async (interaction) => {
      signal = interaction.signal;
      throw new Error("failed before challenge");
    });
    const auth = createLoginAuth(() => oauth);

    await assertLoginError(() => auth.startLogin(startInput()), "login-failed");

    assert.ok(signal !== undefined);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await auth.completeLogin({ loginId: "login-1" }), {
      status: "lost",
    });
  });

  it("refuses a second concurrent start for one vendor before calling the flow", async () => {
    let loginCalls = 0;
    const oauth = fakeOauth(async (interaction) => {
      loginCalls++;
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    const first = auth.startLogin(startInput({ loginId: "login-a" }));
    await assertLoginError(
      () => auth.startLogin(startInput({ loginId: "login-b" })),
      "login-in-progress",
    );
    await first;

    assert.equal(loginCalls, 1);
    auth.abortLogin("login-a");
  });

  it("admits a concurrent start for a different vendor", async () => {
    let loginCalls = 0;
    const oauth = fakeOauth(async (interaction) => {
      loginCalls++;
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await Promise.all([
      auth.startLogin(startInput({ loginId: "login-a", vendorId: "vendor-a" })),
      auth.startLogin(startInput({ loginId: "login-b", vendorId: "vendor-b" })),
    ]);

    assert.equal(loginCalls, 2);
    auth.abortLogin("login-a");
    auth.abortLogin("login-b");
  });

  it("holds the claim after startLogin returns", async () => {
    const oauth = fakeOauth(async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput());
    await assertLoginError(
      () => auth.startLogin(startInput({ loginId: "login-2" })),
      "login-in-progress",
    );

    auth.abortLogin("login-1");
  });

  it("releases the claim when the flow fails", async () => {
    let loginCalls = 0;
    const oauth = fakeOauth(async (interaction) => {
      loginCalls++;
      if (loginCalls === 1) throw new Error("first failure");
      interaction.notify({
        type: "device_code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://v.test/device",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await assertLoginError(
      () => auth.startLogin(startInput({ loginId: "login-a" })),
      "login-failed",
    );
    await auth.startLogin(startInput({ loginId: "login-b" }));

    assert.equal(loginCalls, 2);
    auth.abortLogin("login-b");
  });

  it("releases the claim on abort", async () => {
    let loginCalls = 0;
    const oauth = fakeOauth(async (interaction) => {
      loginCalls++;
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste" });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput({ loginId: "login-a" }));
    auth.abortLogin("login-a");
    await auth.startLogin(startInput({ loginId: "login-b" }));

    assert.equal(loginCalls, 2);
    auth.abortLogin("login-b");
  });

  it("releases the claim when the login completes", async () => {
    let loginCalls = 0;
    const oauth = fakeOauth(async (interaction) => {
      loginCalls++;
      interaction.notify({
        type: "auth_url",
        url: "https://vendor.test/authorize?x=1",
      });
      return LOGIN_CREDENTIAL;
    });
    const auth = createLoginAuth(() => oauth);

    await auth.startLogin(startInput({ loginId: "login-a" }));
    const completed = await auth.completeLogin({ loginId: "login-a" });
    assert.equal(completed.status, "completed");
    await auth.startLogin(startInput({ loginId: "login-b" }));

    assert.equal(loginCalls, 2);
    auth.abortLogin("login-b");
  });

  it("releases the claim for a vendor with no oauth flow", async () => {
    const auth = createLoginAuth(() => undefined);

    const first = await assertLoginError(
      () => auth.startLogin(startInput({ loginId: "login-a" })),
      "provider-not-oauth-capable",
    );
    const second = await assertLoginError(
      () => auth.startLogin(startInput({ loginId: "login-b" })),
      "provider-not-oauth-capable",
    );

    assert.equal(first.refusal, "provider-not-oauth-capable");
    assert.equal(second.refusal, "provider-not-oauth-capable");
  });
});

describe("the oauth credential store", () => {
  it("serves the oauth credential to the library store", async () => {
    const store = await capturedOauthStore();

    assert.deepEqual(await store.read("openai-codex"), OAUTH_CREDENTIAL);
    assert.deepEqual(await store.list(), [
      { providerId: "openai-codex", type: "oauth" },
    ]);
  });

  it("persists a refreshed oauth credential through the writer", async () => {
    const calls: {
      providerId: string;
      credential: Readonly<Record<string, unknown>>;
    }[] = [];
    const writer: CredentialWriter = {
      write(providerId: string, credential: Readonly<Record<string, unknown>>) {
        calls.push({ providerId, credential });
      },
    };
    const store = await capturedOauthStore(writer);
    const rotated: OAuthCredential = {
      type: "oauth",
      access: "access-store-after",
      refresh: "refresh-store-after",
      expires: LOGIN_NOW + 900_000,
      enterpriseUrl: "https://enterprise.example.test",
    };

    const result = await store.modify("openai-codex", async () => rotated);

    assert.deepEqual(calls, [
      { providerId: oauthRow.providerId, credential: rotated },
    ]);
    assert.deepEqual(result, rotated);
  });

  it("writes nothing when the modify callback answers undefined", async () => {
    const calls: string[] = [];
    const writer: CredentialWriter = {
      write(providerId: string) {
        calls.push(providerId);
      },
    };
    const store = await capturedOauthStore(writer);

    const result = await store.modify("openai-codex", async () => undefined);

    assert.equal(result, undefined);
    assert.deepEqual(calls, []);
  });

  it("writes nothing when the modify callback rejects", async () => {
    const calls: string[] = [];
    const writer: CredentialWriter = {
      write(providerId: string) {
        calls.push(providerId);
      },
    };
    const store = await capturedOauthStore(writer);

    await assert.rejects(
      () =>
        store.modify("openai-codex", async () => {
          throw new Error("refresh failed");
        }),
      (error: unknown) =>
        error instanceof Error && error.message === "refresh failed",
    );
    assert.deepEqual(calls, []);
  });

  it("writes nothing for an api-key credential", async () => {
    const calls: string[] = [];
    const writer: CredentialWriter = {
      write(providerId: string) {
        calls.push(providerId);
      },
    };
    const store = await capturedOauthStore(writer);

    const result = await store.modify("openai-codex", async () => ({
      type: "api_key",
      key: "rotated-api-key",
    }));

    assert.deepEqual(result, { type: "api_key", key: "rotated-api-key" });
    assert.deepEqual(calls, []);
  });

  it("admits an oauth-only vendor", async () => {
    const store = await capturedOauthStore();

    assert.deepEqual(await store.read("openai-codex"), OAUTH_CREDENTIAL);
  });

  it("still refuses an api-key row for a vendor with no api-key auth", async () => {
    let calls = 0;
    const auth = new PiAiProviderAuth(async () => {
      calls++;
      return successFetch()("https://unused.test", {});
    });
    const apiKeyRow = {
      ...row,
      vendorId: "openai-codex",
      defaultModel: "gpt-5.4",
    };

    await assert.rejects(
      () => auth.probe(apiKeyRow, new AbortController().signal),
      (error: unknown) => {
        assert(error instanceof ProviderAuthError);
        assert.equal(error.refusal, "vendor-not-catalogued");
        return true;
      },
    );
    assert.equal(calls, 0);
  });
});
