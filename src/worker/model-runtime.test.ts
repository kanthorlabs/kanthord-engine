import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { createModelRuntime, resolveModel } from "./model-runtime.ts";
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
