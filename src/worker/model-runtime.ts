import assert from "node:assert/strict";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  connectModel,
  type ModelConnectorInput,
} from "../llm/model-connector.ts";
import type { ExecutionSetup } from "./contract.ts";
import { loadPi } from "../agent/pi.ts";

export interface ModelRuntimeInput {
  credentials: CredentialStore;
  handoverItem: { credentialId: string; providerId: string };
  setup: ExecutionSetup;
  signal: AbortSignal;
}
export type ModelRuntimeFactory = (
  input: ModelRuntimeInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export function modelConnectorInput(
  input: ModelRuntimeInput,
): ModelConnectorInput {
  const { credentials, handoverItem, setup, signal } = input;
  return {
    credentials,
    handoverItem,
    credentialId: setup.credentialId,
    configuration: setup.effectiveConfiguration,
    metadata: setup.metadata,
    signal,
  };
}

export const defaultModelRuntimeFactory: ModelRuntimeFactory = async (
  input,
) => {
  assert.ok(input.setup);
  assert.ok(input.credentials);
  return connectModel(await loadPi(), modelConnectorInput(input));
};
