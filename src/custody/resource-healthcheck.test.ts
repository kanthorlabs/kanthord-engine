import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import pino from "pino";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import {
  HealthScope,
  ResourceStatus,
  type ResourceCheck,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { CUSTODY_SERVICE_NAME } from "./contract.ts";
import { encrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { Platform } from "./platforms.ts";
import {
  ANTHROPIC_API_KEY_HEADER,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION,
  ANTHROPIC_VERSION_HEADER,
  AUTHORIZATION_HEADER,
  CAPABILITY_BUCKET_HEAD,
  CAPABILITY_COPILOT_TOKEN_READ,
  CAPABILITY_KEY_READ,
  CAPABILITY_MODEL_CALL,
  OPENAI_CODEX_PROBE_MODEL,
  OPENAI_CODEX_PROBE_PROMPT,
  OPENAI_CODEX_PROBE_REASONING,
  probeOpenAICodex,
  type ModelCall,
  CAPABILITY_MODEL_LIST_READ,
  CAPABILITY_RATE_LIMIT_READ,
  GITHUB_COPILOT_TOKEN_URL,
  GITHUB_RATE_LIMIT_URL,
  MODELS_PATH,
  OPENROUTER_KEY_URL,
  PLATFORM_CAPABILITY,
  LLM_PROVIDER_VALIDATORS,
  TARGET_KIND_CREDENTIAL,
  probeAnthropic,
  probeGitHub,
  probeGitHubCopilot,
  probeOpenAICompatible,
  probeOpenRouter,
  probeS3,
} from "./resource-healthcheck.ts";
import { CustodyComponent } from "./service.ts";

const SECRET = "test_private-resource-health-secret";
const ACCESS_KEY_ID = "test_private-s3-access-id";
const BASE_URL = "https://models.example/v1";
const ENDPOINT = "https://storage.example";
const BUCKET = "test-bucket";
const REGION = "us-east-1";
const FUTURE_MS = 60000;
const NO_CALLS = 0;
const ONE_CALL = 1;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const ENVELOPE_KEY = Buffer.alloc(32, 7);
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
    name: Platform.GitHub,
    url: GITHUB_RATE_LIMIT_URL,
    headers: BEARER_HEADERS,
    check: (context) => probeGitHub(SECRET, context),
  },
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
];

test("every LLM platform selects its validator by platform", async (t) => {
  assert.deepEqual(Object.keys(LLM_PROVIDER_VALIDATORS).sort(), [
    Platform.Anthropic,
    Platform.OpenAICodex,
    Platform.OpenAICompatible,
    Platform.OpenRouter,
  ]);
  assert.equal(PLATFORM_CAPABILITY[Platform.OpenRouter], CAPABILITY_KEY_READ);
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
  ]) {
    assert.equal(
      await LLM_PROVIDER_VALIDATORS[platform]!.probe(
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
  ]);
});

for (const probe of httpProbes) {
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
    [HttpStatus.InternalServerError, ResourceStatus.Unhealthy],
  ] as const) {
    test(`${probe.name} maps HTTP ${status}, sends the expected request and releases the body`, async (t) => {
      const cancel = t.mock.fn();
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
          assert.ok(options?.signal instanceof AbortSignal);
          return new Response(new ReadableStream({ cancel }), { status });
        },
      );
      const result = await probe.check(background);
      assert.equal(result, expected);
      assert.equal(fetch.mock.callCount(), ONE_CALL);
      assert.equal(cancel.mock.callCount(), ONE_CALL);
      assert.ok(!result.includes(SECRET));
    });
  }

  test(`${probe.name} hides network errors`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error(SECRET);
    });
    const result = await probe.check(background);
    assert.equal(result, ResourceStatus.Unknown);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });

  test(`${probe.name} skips cancelled and expired contexts`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected request");
    });
    const cancelled = new CancellationContext();
    cancelled.cancel();
    const expired = new CancellationContext(background, Date.now());
    assert.equal(await probe.check(cancelled), ResourceStatus.Unknown);
    assert.equal(await probe.check(expired), ResourceStatus.Unknown);
    assert.equal(fetch.mock.callCount(), NO_CALLS);
  });

  test(`${probe.name} aborts an in-flight request and disposes the context bridge`, async (t) => {
    const context = new CancellationContext();
    const entered = Promise.withResolvers<AbortSignal>();
    const dispose = t.mock.fn();
    const original = context.onCancel.bind(context);
    t.mock.method(context, "onCancel", (listener: (error: Error) => void) => {
      const unsubscribe = original(listener);
      return () => {
        unsubscribe();
        dispose();
      };
    });
    t.after(() => context.cancel());
    t.mock.method(
      globalThis,
      "fetch",
      (_url: Parameters<typeof globalThis.fetch>[0], options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options!.signal!;
          signal.addEventListener("abort", () => reject(new Error(SECRET)), {
            once: true,
          });
          entered.resolve(signal);
        }),
    );
    const pending = probe.check(context);
    const signal = await entered.promise;
    context.cancel();
    assert.equal(await pending, ResourceStatus.Unknown);
    assert.equal(signal.aborted, true);
    assert.equal(dispose.mock.callCount(), ONE_CALL);
  });
}

const USER_ROLE = "user";
const codexCall =
  (status: number, stopReason: "stop" | "error"): ModelCall =>
  async (_model, _context, options) => {
    await options.onResponse?.({ status, headers: {} }, _model);
    return { stopReason } as Awaited<ReturnType<ModelCall>>;
  };

test("openai-codex probe sends one model call and maps replies and failures", async (t) => {
  assert.equal(
    PLATFORM_CAPABILITY[Platform.OpenAICodex],
    CAPABILITY_MODEL_CALL,
  );
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const seen: unknown[] = [];
  const recording: ModelCall = async (model, modelContext, options) => {
    seen.push([
      model.id,
      modelContext.messages,
      options.reasoning,
      options.apiKey,
    ]);
    return codexCall(HttpStatus.OK, "stop")(model, modelContext, options);
  };
  const future = Date.now() + FUTURE_MS;
  assert.equal(
    await probeOpenAICodex(SECRET, future, background, recording),
    ResourceStatus.Healthy,
  );
  assert.equal(seen.length, ONE_CALL);
  const [id, messages, reasoning, apiKey] = seen[0] as [
    string,
    { role: string; content: string }[],
    string,
    string,
  ];
  assert.equal(id, OPENAI_CODEX_PROBE_MODEL);
  assert.equal(reasoning, OPENAI_CODEX_PROBE_REASONING);
  assert.equal(apiKey, SECRET);
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
        SECRET,
        future,
        background,
        codexCall(status, "error"),
      ),
      expected,
    );
  assert.equal(
    await probeOpenAICodex(SECRET, future, background, async () => {
      throw new Error(SECRET);
    }),
    ResourceStatus.Unknown,
  );
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

test("openai-codex probe makes no call for an expired token or a cancelled context", async () => {
  let calls = NO_CALLS;
  const counting: ModelCall = async (model, modelContext, options) => {
    calls += ONE_CALL;
    return codexCall(HttpStatus.OK, "stop")(model, modelContext, options);
  };
  assert.equal(
    await probeOpenAICodex(
      SECRET,
      Date.now() - FUTURE_MS,
      background,
      counting,
    ),
    ResourceStatus.Unknown,
  );
  const cancelled = new CancellationContext();
  cancelled.cancel();
  assert.equal(
    await probeOpenAICodex(SECRET, Date.now() + FUTURE_MS, cancelled, counting),
    ResourceStatus.Unknown,
  );
  assert.equal(calls, NO_CALLS);
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

const s3Check = (
  context: Context,
  createClient: NonNullable<Parameters<typeof probeS3>[6]>,
) =>
  probeS3(
    ACCESS_KEY_ID,
    SECRET,
    ENDPOINT,
    BUCKET,
    REGION,
    context,
    createClient,
  );

for (const throws of [false, true]) {
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.NotFound, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
    [HttpStatus.Unauthorized, ResourceStatus.Unknown],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const) {
    test(`S3 maps ${status} from ${throws ? "error" : "response"} and destroys the client`, async (t) => {
      const destroy = t.mock.fn();
      const send = t.mock.fn(
        async (
          command: HeadBucketCommand,
          options: { abortSignal: AbortSignal },
        ) => {
          assert.ok(command instanceof HeadBucketCommand);
          assert.deepEqual(command.input, { Bucket: BUCKET });
          assert.equal(options.abortSignal.aborted, false);
          const response = { $metadata: { httpStatusCode: status } };
          if (throws) throw Object.assign(new Error(SECRET), response);
          return response;
        },
      );
      const result = await s3Check(background, (config) => {
        assert.deepEqual(config, {
          endpoint: ENDPOINT,
          region: REGION,
          credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
        });
        return { send, destroy };
      });
      assert.equal(result, expected);
      assert.equal(send.mock.callCount(), ONE_CALL);
      assert.equal(destroy.mock.callCount(), ONE_CALL);
      assert.ok(!result.includes(SECRET));
      assert.ok(!result.includes(ACCESS_KEY_ID));
    });
  }
}

test("S3 network, construction and cleanup errors remain unknown without leaking secrets", async (t) => {
  const destroy = t.mock.fn();
  assert.equal(
    await s3Check(background, () => ({
      send: async () => {
        throw new Error(SECRET);
      },
      destroy,
    })),
    ResourceStatus.Unknown,
  );
  assert.equal(destroy.mock.callCount(), ONE_CALL);
  assert.equal(
    await s3Check(background, () => {
      throw new Error(SECRET);
    }),
    ResourceStatus.Unknown,
  );
  assert.equal(
    await s3Check(background, () => ({
      send: async () => ({ $metadata: { httpStatusCode: HttpStatus.OK } }),
      destroy: () => {
        throw new Error(SECRET);
      },
    })),
    ResourceStatus.Unknown,
  );
});

test("S3 skips cancelled contexts and aborts an in-flight request, destroying its client", async (t) => {
  const context = new CancellationContext();
  t.after(() => context.cancel());
  const entered = Promise.withResolvers<AbortSignal>();
  const destroy = t.mock.fn();
  const createClient = t.mock.fn(() => ({
    send: async (
      _command: HeadBucketCommand,
      options: { abortSignal: AbortSignal },
    ) =>
      new Promise((_resolve, reject) => {
        entered.resolve(options.abortSignal);
        options.abortSignal.addEventListener(
          "abort",
          () => reject({ $metadata: { httpStatusCode: HttpStatus.NotFound } }),
          { once: true },
        );
      }),
    destroy,
  }));
  const pending = s3Check(context, createClient);
  const signal = await entered.promise;
  context.cancel();
  assert.equal(await pending, ResourceStatus.Unknown);
  assert.equal(signal.aborted, true);
  assert.equal(destroy.mock.callCount(), ONE_CALL);
  assert.equal(await s3Check(context, createClient), ResourceStatus.Unknown);
  const expired = new CancellationContext(background, Date.now());
  assert.equal(await s3Check(expired, createClient), ResourceStatus.Unknown);
  assert.equal(createClient.mock.callCount(), ONE_CALL);
});

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const component = new CustodyComponent({
    executions: {
      requireRunning: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      pinCredential: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      liveExecutionsPinning: () => [],
    },
    authorization: {
      authorizeModelInference: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    envelopeKey: ENVELOPE_KEY,
    logger: pino({ enabled: false }),
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    enablementsDependentOnModel: () => [],
  });
  return { store, component };
}

const credentials = [
  {
    platform: Platform.GitHub,
    secret: { key: SECRET },
    metadata: null,
    capability: CAPABILITY_RATE_LIMIT_READ,
    url: GITHUB_RATE_LIMIT_URL,
    headers: BEARER_HEADERS,
  },
  {
    platform: Platform.GitHubCopilot,
    secret: {
      access: SECRET,
      refresh: REFRESH_SECRET,
      expires: Date.now() + FUTURE_MS,
    },
    metadata: null,
    capability: CAPABILITY_COPILOT_TOKEN_READ,
    url: GITHUB_COPILOT_TOKEN_URL,
    headers: COPILOT_HEADERS,
  },
  {
    platform: Platform.Anthropic,
    secret: { key: SECRET },
    metadata: null,
    capability: CAPABILITY_MODEL_LIST_READ,
    url: ANTHROPIC_MODELS_URL,
    headers: ANTHROPIC_HEADERS,
  },
  {
    platform: Platform.OpenAICompatible,
    secret: { key: SECRET },
    metadata: { baseUrl: BASE_URL, models: [] },
    capability: CAPABILITY_MODEL_LIST_READ,
    url: BASE_URL + MODELS_PATH,
    headers: BEARER_HEADERS,
  },
  {
    platform: Platform.S3,
    secret: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
    metadata: { endpoint: ENDPOINT, bucket: BUCKET, region: REGION },
    capability: CAPABILITY_BUCKET_HEAD,
    url: null,
    headers: null,
  },
];

type CredentialInput = (typeof credentials)[number];
function insert(
  store: Store,
  credential: CredentialInput,
  name = credential.platform as string,
  revision = FIRST_REVISION,
  endedAt: number | null = null,
): string {
  const id = `${name}-${revision}`;
  const { nonce, ciphertext } = encrypt(
    ENVELOPE_KEY,
    id,
    credential.platform,
    credential.secret,
  );
  store.transaction(({ database }) =>
    database
      .prepare(
        "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        name,
        credential.platform,
        revision,
        nonce,
        ciphertext,
        credential.metadata === null
          ? null
          : JSON.stringify(credential.metadata),
        Date.now(),
        endedAt,
      ),
  );
  return id;
}

test("inventory snapshots one newest live revision per name, encodes names and excludes fully ended names", async (t) => {
  const { store, component } = fixture(t);
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: HttpStatus.OK }),
  );
  const credential = credentials[0]!;
  const name = "team/a key";
  insert(store, credential, name);
  const liveId = insert(store, credential, name, SECOND_REVISION);
  insert(store, credential, name, THIRD_REVISION, Date.now());
  insert(store, credential, "ended", FIRST_REVISION, Date.now());
  insert(store, credential, "ended", SECOND_REVISION, Date.now());
  const entries = store.transaction((tx) => component.resourceInventory(tx));
  assert.equal(fetch.mock.callCount(), NO_CALLS);
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      scope: HealthScope.Global,
      project: null,
      name: encodeURIComponent(name),
      target: `${TARGET_KIND_CREDENTIAL}:${liveId}`,
      capability: CAPABILITY_RATE_LIMIT_READ,
    },
  ]);
  store.close();
  assert.equal(await entries[0]!.check(background), ResourceStatus.Healthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
  assert.ok(!JSON.stringify(entries).includes(SECRET));
});

for (const credential of credentials) {
  test(`inventory captures ${credential.platform} metadata and dispatches its capability without store reads`, async (t) => {
    const { store, component } = fixture(t);
    const id = insert(store, credential);
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        options?: RequestInit,
      ) => {
        assert.equal(url, credential.url);
        assert.deepEqual(options?.headers, credential.headers);
        return new Response(null, { status: HttpStatus.OK });
      },
    );
    const send = t.mock.method(
      S3Client.prototype,
      "send",
      async (command: HeadBucketCommand) => {
        assert.deepEqual(command.input, { Bucket: BUCKET });
        return { $metadata: { httpStatusCode: HttpStatus.OK } };
      },
    );
    const destroy = t.mock.method(S3Client.prototype, "destroy", () => {});
    const entries = store.transaction((tx) => component.resourceInventory(tx));
    assert.equal(fetch.mock.callCount(), NO_CALLS);
    assert.equal(send.mock.callCount(), NO_CALLS);
    assert.equal(entries.length, ONE_CALL);
    assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
      {
        scope: HealthScope.Global,
        project: null,
        name: credential.platform,
        target: `${TARGET_KIND_CREDENTIAL}:${id}`,
        capability: credential.capability,
      },
    ]);
    store.database
      .prepare(
        "UPDATE credential SET metadata = ?, ciphertext = ?, ended_at = ?",
      )
      .run("{}", Buffer.alloc(1), Date.now());
    store.close();
    const result = await entries[0]!.check(background);
    assert.equal(result, ResourceStatus.Healthy);
    assert.equal(
      fetch.mock.callCount(),
      credential.platform === Platform.S3 ? NO_CALLS : ONE_CALL,
    );
    assert.equal(
      send.mock.callCount(),
      credential.platform === Platform.S3 ? ONE_CALL : NO_CALLS,
    );
    assert.equal(destroy.mock.callCount(), send.mock.callCount());
    assert.ok(!JSON.stringify({ entries, result }).includes(SECRET));
    assert.ok(!JSON.stringify({ entries, result }).includes(ACCESS_KEY_ID));
  });
}

test("inventory and model-list closures return unknown on corrupted ciphertext without leaking secrets", async (t) => {
  const { store, component } = fixture(t);
  const credential = credentials.find(
    ({ platform }) => platform === Platform.Anthropic,
  )!;
  insert(store, credential);
  store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from(SECRET));
  const entry = store.transaction((tx) => component.resourceInventory(tx))[0]!;
  const check = store.transaction((tx) =>
    component.modelListCheck(tx, credential.platform),
  );
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  store.close();
  assert.equal(await entry.check(background), ResourceStatus.Unknown);
  assert.equal(await check(background), ResourceStatus.Unknown);
  assert.equal(fetch.mock.callCount(), NO_CALLS);
  assert.ok(!JSON.stringify(entry).includes(SECRET));
});

test("model-list checks for absent, fully ended or unsupported credentials make no request", async (t) => {
  const { store, component } = fixture(t);
  for (const credential of credentials)
    insert(
      store,
      credential,
      credential.platform,
      FIRST_REVISION,
      credential.capability === CAPABILITY_MODEL_LIST_READ ? Date.now() : null,
    );
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const names = ["missing", ...credentials.map(({ platform }) => platform)];
  const checks = store.transaction((tx) =>
    names.map((name) => component.modelListCheck(tx, name)),
  );
  store.close();
  for (const check of checks)
    assert.equal(await check(background), ResourceStatus.Unknown);
  assert.equal(fetch.mock.callCount(), NO_CALLS);
});

for (const credential of credentials.filter(
  ({ capability }) => capability === CAPABILITY_MODEL_LIST_READ,
)) {
  test(`model-list check captures newest live ${credential.platform} revision and metadata`, async (t) => {
    const { store, component } = fixture(t);
    const older = {
      ...credential,
      secret: { key: "older-key" },
    } as CredentialInput;
    insert(store, older);
    insert(store, credential, credential.platform, SECOND_REVISION);
    insert(store, older, credential.platform, THIRD_REVISION, Date.now());
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        options?: RequestInit,
      ) => {
        assert.equal(url, credential.url);
        assert.deepEqual(options?.headers, credential.headers);
        return new Response(null, { status: HttpStatus.OK });
      },
    );
    const check = store.transaction((tx) =>
      component.modelListCheck(tx, credential.platform),
    );
    assert.equal(fetch.mock.callCount(), NO_CALLS);
    store.close();
    assert.equal(await check(background), ResourceStatus.Healthy);
    assert.equal(fetch.mock.callCount(), ONE_CALL);
    const context = new CancellationContext();
    context.cancel();
    assert.equal(await check(context), ResourceStatus.Unknown);
    assert.equal(fetch.mock.callCount(), ONE_CALL);
  });
}
