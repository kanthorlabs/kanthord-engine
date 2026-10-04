import assert from "node:assert/strict";
import { z } from "zod";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  WorkerErrorCode,
  reasoningEffortSchema,
  type AgentProviderItem,
  type CredentialMetadataFn,
  type CustodySuitability,
  type DefaultConfiguration,
  type WorkerAgentView,
  type WorkerEntry,
} from "./contract.ts";
import { AgentProviderKind } from "./enablements.ts";

const metadataModelsSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      id: z.string(),
      reasoningLevels: z.array(z.string()).optional(),
    }),
  ),
});
const DEFAULT_REASONING_LEVELS = ["off"];
const issueFields: Readonly<Record<string, string>> = {
  [WorkerErrorCode.ProviderNotFound]: "agentProvider",
  [WorkerErrorCode.CredentialUnsuitable]: "agentProvider",
  [WorkerErrorCode.ModelUnknown]: "modelIdentifier",
  [WorkerErrorCode.ReasoningUnsupported]: "reasoningEffort",
};

export type ConfigurationDependencies = {
  custodySuitability: CustodySuitability;
  credentialMetadata: CredentialMetadataFn;
};

export function configurationError(
  agentName: string,
  code: string,
): OperationError {
  const status =
    code === WorkerErrorCode.ProviderNotFound
      ? HttpStatus.NotFound
      : HttpStatus.BadRequest;
  return new OperationError(
    status,
    code,
    "Agent configuration is unavailable or invalid.",
    { agentName },
  );
}

export function effectiveConfiguration(
  defaults: DefaultConfiguration,
  entry: WorkerEntry | null,
): DefaultConfiguration {
  return {
    agentProvider: entry?.agentProvider ?? defaults.agentProvider,
    modelIdentifier: entry?.modelIdentifier ?? defaults.modelIdentifier,
    reasoningEffort: entry?.reasoningEffort ?? defaults.reasoningEffort,
  };
}

export function validateProvider(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  item: AgentProviderItem,
): void {
  try {
    dependencies.custodySuitability(tx, {
      credential: item.credential,
      platform: item.provider,
    });
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    throw configurationError(agentName, WorkerErrorCode.CredentialUnsuitable);
  }
}

function modelLevels(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  item: AgentProviderItem,
  modelIdentifier: string,
): readonly string[] {
  if (item.provider === AgentProviderKind.OpenaiCompatible) {
    const record = dependencies.credentialMetadata(tx, item.credential);
    const metadata = record?.metadata;
    if (metadata == null)
      throw configurationError(agentName, WorkerErrorCode.ModelUnknown);
    const parsed = metadataModelsSchema.safeParse(metadata);
    assert.ok(parsed.success, "Custody returned malformed model metadata.");
    const model = parsed.data.models.find(({ id }) => id === modelIdentifier);
    if (!model)
      throw configurationError(agentName, WorkerErrorCode.ModelUnknown);
    return model.reasoningLevels ?? DEFAULT_REASONING_LEVELS;
  }
  assert.ok(
    item.provider === AgentProviderKind.Anthropic ||
      item.provider === AgentProviderKind.GithubCopilot ||
      item.provider === AgentProviderKind.OpenaiCodex ||
      item.provider === AgentProviderKind.Openrouter,
    "Unknown stored agent provider kind.",
  );
  const model = getBuiltinModels(item.provider).find(
    ({ id }) => id === modelIdentifier,
  );
  if (!model) throw configurationError(agentName, WorkerErrorCode.ModelUnknown);
  return getSupportedThinkingLevels(model);
}

export function validateEffectiveConfig(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  agentProviders: AgentProviderItem[],
  config: DefaultConfiguration,
): void {
  const item = agentProviders.find(({ name }) => name === config.agentProvider);
  if (!item)
    throw configurationError(agentName, WorkerErrorCode.ProviderNotFound);
  validateProvider(dependencies, tx, agentName, item);
  const levels = modelLevels(
    dependencies,
    tx,
    agentName,
    item,
    config.modelIdentifier,
  );
  if (
    !reasoningEffortSchema.safeParse(config.reasoningEffort).success ||
    !levels.includes(config.reasoningEffort)
  )
    throw configurationError(agentName, WorkerErrorCode.ReasoningUnsupported);
}

export function configurationIssues(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  agentProviders: AgentProviderItem[],
  config: DefaultConfiguration,
): WorkerAgentView["issues"] {
  try {
    validateEffectiveConfig(
      dependencies,
      tx,
      agentName,
      agentProviders,
      config,
    );
    return [];
  } catch (error) {
    if (
      !(error instanceof OperationError) ||
      !Object.hasOwn(issueFields, error.code)
    )
      throw error;
    return [{ path: [issueFields[error.code]!], code: error.code }];
  }
}
