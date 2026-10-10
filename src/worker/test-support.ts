import assert from "node:assert/strict";
import type { AgentSetup, ExecutionSetup, HostTools } from "./contract.ts";

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
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
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
      model: resolveModel(runtime, input.agent.effective_configuration),
    };
  };
}

export const SETUP_PROMPT = "setup prompt";
export const WORKING_LAYER_ALL_ON = {
  agents_md: true,
  agents_local_md: true,
  claude_md: true,
  claude_local_md: true,
  project_prompt: true,
};

export function anthropicAgent(
  overrides: Partial<AgentSetup> = {},
): AgentSetup {
  return {
    agent_name: "swe@1",
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    effective_configuration: {
      agent_provider: "default",
      provider: "anthropic",
      credential: "anthro-1",
      model_identifier: "claude-sonnet-4-5",
      reasoning_effort: "off",
    },
    metadata: null,
    prompt: { final: SETUP_PROMPT },
    ...overrides,
  };
}

export function anthropicSetup(
  overrides: Partial<ExecutionSetup> = {},
): ExecutionSetup {
  const setup: ExecutionSetup = {
    execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    worker_name: "general@1",
    agents: [anthropicAgent()],
    templates: SHIPPED_TEMPLATES,
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    repositories: [],
    ...overrides,
  };
  assert.ok(setup.agents.length);
  assert.ok(setup.execution_id);
  return setup;
}
