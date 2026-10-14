import assert from "node:assert/strict";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import { loadPi } from "../../agent/pi.ts";
import type { ScriptedProvider } from "../../agent/test-support.ts";
import {
  modelConnectorInput,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
export {
  scriptedProvider,
  type ScriptedProvider,
} from "../../agent/test-support.ts";
export {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";
export * from "../test-support.ts";

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
