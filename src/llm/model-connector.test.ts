import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSetup,
  SetupRefusal,
  WorkerErrorCode,
} from "../worker/contract.ts";
import {
  resolveModel as connectorModel,
  createModelRuntime as connectorRuntime,
} from "./model-connector.ts";
import { loadPi } from "../agent/pi.ts";
import { piProviderId, Platform, ReasoningLevel } from "./platforms.ts";
import { ANTHROPIC_SUBSCRIPTION_CHECK_MODEL } from "./probes.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const SUBSCRIPTION_LIFETIME_MS = 3600000;

async function createModelRuntime(input: {
  setup: AgentSetup;
  handoverItem: { credential_id: string; provider_id: string };
  credentials: CredentialStore;
  signal: AbortSignal;
}) {
  return connectorRuntime(await loadPi(), {
    credentials: input.credentials,
    handoverItem: input.handoverItem,
    credentialId: input.setup.credential_id,
    configuration: input.setup.effective_configuration,
    metadata: input.setup.metadata,
    signal: input.signal,
  });
}

function resolveModel(
  runtime: Awaited<ReturnType<typeof createModelRuntime>>,
  setup: AgentSetup,
) {
  return connectorModel(runtime, setup.effective_configuration);
}

const setup: AgentSetup = {
  agent_name: "swe@1",
  enablement_id: null,
  worker_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
  credential_id: "credential",
  effective_configuration: {
    agent_provider: "default",
    provider: "anthropic",
    credential: "anthro-1",
    model_identifier: "claude-sonnet-4-5",
    reasoning_effort: "off",
  },
  position: 0,
  level: "enablement",
  metadata: null,
  prompt: { final: "setup prompt", sources: [] },
};
const handoverItem = {
  credential_id: setup.credential_id,
  provider_id: "anthropic",
};

test("runtime pins credentials, resolves models, and rejects unsupported configuration without network", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test_environment-secret";
  stopAfter(t, () => {
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
    setup.effective_configuration.model_identifier,
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
    [{ model_identifier: "unknown" }, SetupRefusal.ModelUnknown],
    [
      { reasoning_effort: "max" as const },
      SetupRefusal.ReasoningEffortUnsupported,
    ],
  ] as const) {
    assert.throws(
      () =>
        resolveModel(runtime, {
          ...setup,
          effective_configuration: {
            ...setup.effective_configuration,
            ...patch,
          },
        }),
      { code: WorkerErrorCode.RuntimeSetupRefused, details: { reason } },
    );
  }
  await assert.rejects(
    createModelRuntime({
      ...input,
      handoverItem: { ...handoverItem, provider_id: "foreign" },
    }),
    { details: { reason: SetupRefusal.CredentialAbsent } },
  );
  await assert.rejects(
    createModelRuntime({
      ...input,
      handoverItem: { ...handoverItem, credential_id: "foreign" },
    }),
    { details: { reason: SetupRefusal.CredentialRevisionMismatch } },
  );
});

test("an anthropic-subscription credential resolves its model under the anthropic pi provider", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const subscription: AgentSetup = {
    ...setup,
    effective_configuration: {
      ...setup.effective_configuration,
      provider: Platform.AnthropicSubscription,
      model_identifier: ANTHROPIC_SUBSCRIPTION_CHECK_MODEL,
      reasoning_effort: ReasoningLevel.Low,
    },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    piProviderId(Platform.AnthropicSubscription),
    async () => ({
      type: "oauth",
      refresh: "test_refresh-secret",
      access: "test_access-secret",
      expires: Date.now() + SUBSCRIPTION_LIFETIME_MS,
    }),
  );
  const input = {
    setup: subscription,
    handoverItem: {
      credential_id: subscription.credential_id,
      provider_id: piProviderId(Platform.AnthropicSubscription),
    },
    credentials,
    signal: new AbortController().signal,
  };
  const runtime = await createModelRuntime(input);
  const model = resolveModel(runtime, subscription);
  assert.equal(model.id, ANTHROPIC_SUBSCRIPTION_CHECK_MODEL);
  assert.equal(model.provider, piProviderId(Platform.AnthropicSubscription));
  await assert.rejects(
    createModelRuntime({
      ...input,
      handoverItem: {
        ...input.handoverItem,
        provider_id: Platform.AnthropicSubscription,
      },
    }),
    { details: { reason: SetupRefusal.CredentialAbsent } },
  );
});

test("compatible models retain metadata and exact supported reasoning levels", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const compatible: AgentSetup = {
    ...setup,
    effective_configuration: {
      ...setup.effective_configuration,
      provider: "openai-compatible",
      model_identifier: "basic",
    },
    metadata: {
      base_url: "https://example.invalid/v1",
      models: [
        { id: "basic" },
        {
          id: "reasoner",
          context_window: 50000,
          max_tokens: 2000,
          reasoning_levels: ["off", "high", "max"],
        },
      ],
    },
  };
  const runtime = await createModelRuntime({
    setup: compatible,
    handoverItem: { ...handoverItem, provider_id: "openai-compatible" },
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
    assert.equal(model.baseUrl, compatible.metadata!.base_url);
    assert.deepEqual(model.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
});

const BEDROCK = "amazon-bedrock";
const BEDROCK_REGION = "eu-west-1";
const EXECUTION_SECRET = "test_execution-secret";

test("amazon-bedrock receives its metadata region as the credential env", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const bedrock: AgentSetup = {
    ...setup,
    effective_configuration: {
      ...setup.effective_configuration,
      provider: "amazon-bedrock",
      model_identifier: "amazon.nova-2-lite-v1:0",
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
    handoverItem: { ...handoverItem, provider_id: "amazon-bedrock" },
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
