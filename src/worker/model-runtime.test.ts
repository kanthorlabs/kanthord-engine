import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { AgentProviderKind } from "./enablements.ts";
import {
  createModelRuntime,
  metadataEnv,
  resolveModel,
} from "./model-runtime.ts";
import {
  SetupRefusal,
  WorkerErrorCode,
  type ExecutionSetup,
} from "./contract.ts";

const setup: ExecutionSetup = {
  executionId: "execution",
  workerName: "general@1",
  agentName: "swe@1",
  credentialId: "credential",
  effectiveConfiguration: {
    agentProvider: "default",
    provider: "anthropic",
    credential: "anthro-1",
    modelIdentifier: "claude-sonnet-4-5",
    reasoningEffort: "off",
  },
  metadata: null,
  resourceBudget: { turns: 200, wallTimeMs: 7200000 },
  repositories: [],
  globalPrompt: { state: "absent" },
};
const handoverItem = {
  credentialId: setup.credentialId,
  providerId: "anthropic",
};

test("runtime pins credentials, resolves models, and rejects unsupported configuration without network", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test_environment-secret";
  t.after(() => {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_execution-secret",
  }));
  const input = {
    setup,
    handoverItem,
    credentials,
    signal: new AbortController().signal,
  };
  const runtime = await createModelRuntime(input);
  assert.equal(
    resolveModel(runtime, setup).id,
    setup.effectiveConfiguration.modelIdentifier,
  );
  assert.ok(
    JSON.stringify(await runtime.getAuth("anthropic")).includes(
      "test_execution-secret",
    ),
  );
  assert.ok(
    !JSON.stringify(await runtime.getAuth("anthropic")).includes(
      "test_environment-secret",
    ),
  );
  for (const [patch, reason] of [
    [{ modelIdentifier: "unknown" }, SetupRefusal.ModelUnknown],
    [
      { reasoningEffort: "max" as const },
      SetupRefusal.ReasoningEffortUnsupported,
    ],
  ] as const) {
    assert.throws(
      () =>
        resolveModel(runtime, {
          ...setup,
          effectiveConfiguration: { ...setup.effectiveConfiguration, ...patch },
        }),
      { code: WorkerErrorCode.RuntimeSetupRefused, details: { reason } },
    );
  }
  await assert.rejects(
    createModelRuntime({
      ...input,
      handoverItem: { ...handoverItem, providerId: "foreign" },
    }),
    { details: { reason: SetupRefusal.CredentialAbsent } },
  );
  await assert.rejects(
    createModelRuntime({
      ...input,
      handoverItem: { ...handoverItem, credentialId: "foreign" },
    }),
    { details: { reason: SetupRefusal.CredentialRevisionMismatch } },
  );
});

test("compatible models retain metadata and exact supported reasoning levels", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const compatible: ExecutionSetup = {
    ...setup,
    effectiveConfiguration: {
      ...setup.effectiveConfiguration,
      provider: "openai-compatible",
      modelIdentifier: "basic",
    },
    metadata: {
      baseUrl: "https://example.invalid/v1",
      models: [
        { id: "basic" },
        {
          id: "reasoner",
          contextWindow: 50000,
          maxTokens: 2000,
          reasoningLevels: ["off", "high", "max"],
        },
      ],
    },
  };
  const runtime = await createModelRuntime({
    setup: compatible,
    handoverItem: { ...handoverItem, providerId: "openai-compatible" },
    credentials: new InMemoryCredentialStore(),
    signal: new AbortController().signal,
  });
  const models = runtime.getModels("openai-compatible");
  assert.deepEqual(
    models.map(({ id }) => id),
    ["basic", "reasoner"],
  );
  assert.deepEqual(models.map(getSupportedThinkingLevels), [
    ["off"],
    ["off", "high", "max"],
  ]);
  assert.deepEqual(
    models.map(({ contextWindow, maxTokens }) => [contextWindow, maxTokens]),
    [
      [128000, 16384],
      [50000, 2000],
    ],
  );
  for (const model of models) {
    assert.equal(model.baseUrl, compatible.metadata!.baseUrl);
    assert.deepEqual(model.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
});

test("openrouter runs with the built-in pi provider and its credential", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const openrouter: ExecutionSetup = {
    ...setup,
    effectiveConfiguration: {
      ...setup.effectiveConfiguration,
      provider: "openrouter",
      modelIdentifier: "anthropic/claude-3-haiku",
    },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openrouter", async () => ({
    type: "api_key",
    key: "test_execution-secret",
  }));
  const runtime = await createModelRuntime({
    setup: openrouter,
    handoverItem: { ...handoverItem, providerId: "openrouter" },
    credentials,
    signal: new AbortController().signal,
  });
  const model = resolveModel(runtime, openrouter);
  assert.equal(model.provider, AgentProviderKind.Openrouter);
  assert.ok(
    JSON.stringify(await runtime.getAuth("openrouter")).includes(
      "test_execution-secret",
    ),
  );
  assert.throws(
    () =>
      resolveModel(runtime, {
        ...openrouter,
        effectiveConfiguration: {
          ...openrouter.effectiveConfiguration,
          modelIdentifier: "unknown",
        },
      }),
    {
      code: WorkerErrorCode.RuntimeSetupRefused,
      details: { reason: SetupRefusal.ModelUnknown },
    },
  );
});

test("openai-codex resolves a built-in model against its OAuth credential", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const codex: ExecutionSetup = {
    ...setup,
    effectiveConfiguration: {
      ...setup.effectiveConfiguration,
      provider: "openai-codex",
      modelIdentifier: "gpt-5.5",
    },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    refresh: "test_refresh",
    access: "test_access",
    expires: Date.now() + 3600000,
  }));
  const runtime = await createModelRuntime({
    setup: codex,
    handoverItem: { ...handoverItem, providerId: "openai-codex" },
    credentials,
    signal: new AbortController().signal,
  });
  const model = resolveModel(runtime, codex);
  assert.equal(model.provider, AgentProviderKind.OpenaiCodex);
  assert.ok(
    JSON.stringify(await runtime.getAuth("openai-codex")).includes(
      "test_access",
    ),
  );
});

const GROQ = "groq";
const BEDROCK = "amazon-bedrock";
const BEDROCK_REGION = "eu-west-1";
const EXECUTION_SECRET = "test_execution-secret";

test("groq runs with the built-in pi provider and no metadata", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const groq: ExecutionSetup = {
    ...setup,
    effectiveConfiguration: {
      ...setup.effectiveConfiguration,
      provider: "groq",
      modelIdentifier: "llama-3.1-8b-instant",
    },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("groq", async () => ({
    type: "api_key",
    key: "test_execution-secret",
  }));
  const runtime = await createModelRuntime({
    setup: groq,
    handoverItem: { ...handoverItem, providerId: "groq" },
    credentials,
    signal: new AbortController().signal,
  });
  assert.equal(resolveModel(runtime, groq).provider, GROQ);
  assert.deepEqual(metadataEnv(groq), {});
});

test("amazon-bedrock receives its metadata region as the credential env", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const bedrock: ExecutionSetup = {
    ...setup,
    effectiveConfiguration: {
      ...setup.effectiveConfiguration,
      provider: "amazon-bedrock",
      modelIdentifier: "amazon.nova-2-lite-v1:0",
    },
    metadata: { region: BEDROCK_REGION },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("amazon-bedrock", async () => ({
    type: "api_key",
    key: "test_execution-secret",
  }));
  const runtime = await createModelRuntime({
    setup: bedrock,
    handoverItem: { ...handoverItem, providerId: "amazon-bedrock" },
    credentials,
    signal: new AbortController().signal,
  });
  assert.equal(resolveModel(runtime, bedrock).provider, BEDROCK);
  const auth = await runtime.getAuth(BEDROCK);
  assert.equal(auth?.env?.AWS_REGION, BEDROCK_REGION);
  assert.equal(auth?.auth.apiKey, EXECUTION_SECRET);
  assert.deepEqual(await credentials.read("amazon-bedrock"), {
    type: "api_key",
    key: "test_execution-secret",
  });
});

test("metadata env maps every metadata field of the five platforms", () => {
  const of = (provider: string, metadata: Record<string, string>) =>
    metadataEnv({
      ...setup,
      effectiveConfiguration: {
        ...setup.effectiveConfiguration,
        provider:
          provider as ExecutionSetup["effectiveConfiguration"]["provider"],
      },
      metadata,
    });
  assert.deepEqual(of("google-vertex", { project: "p", location: "l" }), {
    GOOGLE_CLOUD_PROJECT: "p",
    GOOGLE_CLOUD_LOCATION: "l",
  });
  assert.deepEqual(of("azure-openai-responses", { resource_name: "r" }), {
    AZURE_OPENAI_RESOURCE_NAME: "r",
  });
  assert.deepEqual(of("cloudflare-workers-ai", { account_id: "a" }), {
    CLOUDFLARE_ACCOUNT_ID: "a",
  });
  assert.deepEqual(
    of("cloudflare-ai-gateway", { account_id: "a", gateway_id: "g" }),
    { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_GATEWAY_ID: "g" },
  );
});
