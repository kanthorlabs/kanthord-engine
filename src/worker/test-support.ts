import assert from "node:assert/strict";
import type { ExecutionSetup, HostTools } from "./contract.ts";

export const unusedHostTools: HostTools = {
  evidenceUpload: () =>
    Promise.reject(new Error("Unexpected evidence upload in fixture")),
};
import { createModelRuntime, resolveModel } from "../llm/model-connector.ts";
import {
  modelConnectorInput,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
import { loadPi } from "../agent/pi.ts";
import type { ScriptedProvider } from "../agent/test-support.ts";
export {
  scriptedProvider,
  type ScriptedProvider,
} from "../agent/test-support.ts";
export {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";

export function scriptedModelRuntime(
  provider: ScriptedProvider,
): ModelRuntimeFactory {
  assert.ok(provider.provider);
  assert.ok(provider.calls);
  return async (input) => {
    const runtime = await createModelRuntime(
      await loadPi(),
      modelConnectorInput(input),
    );
    runtime.registerNativeProvider(provider.provider);
    return {
      runtime,
      model: resolveModel(runtime, input.setup.effectiveConfiguration),
    };
  };
}

export function anthropicSetup(
  overrides: Partial<ExecutionSetup> = {},
): ExecutionSetup {
  const setup: ExecutionSetup = {
    executionId: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    workerName: "general@1",
    agentName: "swe@1",
    credentialId: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
    ...overrides,
  };
  assert.ok(setup.credentialId);
  assert.ok(setup.executionId);
  return setup;
}
