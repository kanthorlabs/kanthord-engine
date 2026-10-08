import assert from "node:assert/strict";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  connectModel,
  type ModelConnectorInput,
} from "../llm/model-connector.ts";
import type { AgentSetup } from "./contract.ts";
import { loadPi } from "../agent/pi.ts";

export interface ExecutionCredential {
  credential_id: string;
  provider_id: string;
  store: CredentialStore;
}
export interface ModelRuntimeInput {
  credential: ExecutionCredential;
  agent: AgentSetup;
  signal: AbortSignal;
}
export type ModelRuntimeFactory = (
  input: ModelRuntimeInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export function modelConnectorInput(
  input: ModelRuntimeInput,
): ModelConnectorInput {
  const { credential, agent, signal } = input;
  return {
    credentials: credential.store,
    handoverItem: {
      credential_id: credential.credential_id,
      provider_id: credential.provider_id,
    },
    credentialId: agent.credential_id,
    configuration: agent.effective_configuration,
    metadata: agent.metadata,
    signal,
  };
}

export const defaultModelRuntimeFactory: ModelRuntimeFactory = async (
  input,
) => {
  assert.ok(input.agent);
  assert.ok(input.credential);
  return connectModel(await loadPi(), modelConnectorInput(input));
};
