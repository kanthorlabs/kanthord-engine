import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AgentErrorCode,
  agentProviderKindSchema,
  reasoningEffortSchema,
  type AgentProviderItem,
  type ApprovedModel,
  type ApprovedModelsFn,
  type CustodySuitability,
  type DefaultConfiguration,
  type AgentView,
  type AgentEntry,
} from "./contract.ts";
import { AgentProviderKind } from "./enablements.ts";

const issueFields: Readonly<Record<string, string>> = {
  [AgentErrorCode.ProviderNotFound]: "agentProvider",
  [AgentErrorCode.CredentialUnsuitable]: "agentProvider",
  [AgentErrorCode.ModelUnknown]: "modelIdentifier",
  [AgentErrorCode.ReasoningUnsupported]: "reasoningEffort",
};

export type ConfigurationDependencies = {
  custodySuitability: CustodySuitability;
  approvedModels: ApprovedModelsFn;
};

export function configurationError(
  agentName: string,
  code: string,
): OperationError {
  const status =
    code === AgentErrorCode.ProviderNotFound
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
  entry: AgentEntry | null,
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
    throw configurationError(agentName, AgentErrorCode.CredentialUnsuitable);
  }
}

export function providerModels(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  item: Pick<AgentProviderItem, "provider" | "credential">,
): ApprovedModel[] {
  if (item.provider === AgentProviderKind.OpenaiCompatible)
    return [...(dependencies.approvedModels(tx, item.credential) ?? [])];
  const provider = agentProviderKindSchema
    .exclude([AgentProviderKind.OpenaiCompatible])
    .parse(item.provider);
  return getBuiltinModels(provider).map((model) => ({
    id: model.id,
    reasoning_levels: getSupportedThinkingLevels(model),
  }));
}

function modelLevels(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  item: AgentProviderItem,
  modelIdentifier: string,
): readonly string[] {
  const model = providerModels(dependencies, tx, item).find(
    ({ id }) => id === modelIdentifier,
  );
  if (!model) throw configurationError(agentName, AgentErrorCode.ModelUnknown);
  return model.reasoning_levels;
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
    throw configurationError(agentName, AgentErrorCode.ProviderNotFound);
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
    throw configurationError(agentName, AgentErrorCode.ReasoningUnsupported);
}

export function configurationIssues(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  agentProviders: AgentProviderItem[],
  config: DefaultConfiguration,
): AgentView["issues"] {
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
