import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import {
  builtinModels,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  Context,
  CredentialStore,
  Model,
} from "@earendil-works/pi-ai";

import { PiAiProviderAuth } from "./pi-ai.ts";
import { ProviderAuthError } from "./index.ts";
import type { ProviderAuthRow } from "./index.ts";

const row: ProviderAuthRow = {
  vendorId: "groq",
  defaultModel: "llama-3.1-8b-instant",
  apiKey: "gsk_test_probe_key_ABCDEFGH123456",
  baseUrl: null,
};

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
