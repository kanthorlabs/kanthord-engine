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
  ChainLevel,
  type DefaultConfiguration,
  type AgentView,
  type AgentEntry,
} from "./contract.ts";
import { AgentProviderKind } from "./enablements.ts";

const issueFields: Readonly<Record<string, string>> = {
  [AgentErrorCode.ProviderNotFound]: "agent_provider",
  [AgentErrorCode.CredentialUnsuitable]: "agent_provider",
  [AgentErrorCode.ModelUnknown]: "model_identifier",
  [AgentErrorCode.ReasoningUnsupported]: "reasoning_effort",
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
    { agent_name: agentName },
  );
}

export function effectiveConfiguration(
  defaults: DefaultConfiguration,
  entry: AgentEntry | null,
): DefaultConfiguration {
  return {
    agent_provider: entry?.agent_provider ?? defaults.agent_provider,
    model_identifier: entry?.model_identifier ?? defaults.model_identifier,
    reasoning_effort: entry?.reasoning_effort ?? defaults.reasoning_effort,
  };
}

export type ChainConfiguration = DefaultConfiguration & { level: ChainLevel };

const FALLBACK_FIELD = "fallback_configurations";
const HEAD_FIELDS: readonly (keyof DefaultConfiguration)[] = [
  "agent_provider",
  "model_identifier",
  "reasoning_effort",
];

function sameModel(
  left: DefaultConfiguration,
  right: DefaultConfiguration,
): boolean {
  return (
    left.agent_provider === right.agent_provider &&
    left.model_identifier === right.model_identifier
  );
}

export function tailOf(
  enablementTail: readonly DefaultConfiguration[],
  entry: AgentEntry | null,
): readonly DefaultConfiguration[] {
  return entry?.fallback_configurations ?? enablementTail;
}

export function chainConfigurations(
  defaults: DefaultConfiguration,
  enablementTail: readonly DefaultConfiguration[],
  entry: AgentEntry | null,
): ChainConfiguration[] {
  const headLevel = HEAD_FIELDS.some((field) => entry?.[field] !== undefined)
    ? ChainLevel.Binding
    : ChainLevel.Enablement;
  const named = entry?.fallback_configurations;
  const tailLevel =
    named === undefined ? ChainLevel.Enablement : ChainLevel.Binding;
  const chain: ChainConfiguration[] = [
    { ...effectiveConfiguration(defaults, entry), level: headLevel },
  ];
  for (const config of tailOf(enablementTail, entry))
    if (!chain.some((kept) => sameModel(kept, config)))
      chain.push({ ...config, level: tailLevel });
  return chain;
}

export function checkFallbackDuplicates(
  agentName: string,
  head: DefaultConfiguration,
  tail: readonly DefaultConfiguration[],
): void {
  const duplicate = tail.some(
    (config, index) =>
      sameModel(config, head) ||
      tail.findIndex((other) => sameModel(other, config)) !== index,
  );
  if (duplicate)
    throw configurationError(agentName, AgentErrorCode.FallbackDuplicate);
}

export function namesProvider(
  configurations: readonly DefaultConfiguration[] | undefined,
  providerNames: ReadonlySet<string>,
): boolean {
  return (configurations ?? []).some(({ agent_provider }) =>
    providerNames.has(agent_provider),
  );
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
  const item = agentProviders.find(
    ({ name }) => name === config.agent_provider,
  );
  if (!item)
    throw configurationError(agentName, AgentErrorCode.ProviderNotFound);
  validateProvider(dependencies, tx, agentName, item);
  const levels = modelLevels(
    dependencies,
    tx,
    agentName,
    item,
    config.model_identifier,
  );
  if (
    !reasoningEffortSchema.safeParse(config.reasoning_effort).success ||
    !levels.includes(config.reasoning_effort)
  )
    throw configurationError(agentName, AgentErrorCode.ReasoningUnsupported);
}

export function configurationIssues(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  agentProviders: AgentProviderItem[],
  config: DefaultConfiguration,
  prefix: readonly string[] = [],
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
    return [{ path: [...prefix, issueFields[error.code]!], code: error.code }];
  }
}

export function chainIssues(
  dependencies: ConfigurationDependencies,
  tx: Transaction,
  agentName: string,
  agentProviders: AgentProviderItem[],
  head: DefaultConfiguration,
  tail: readonly DefaultConfiguration[],
): AgentView["issues"] {
  return [
    ...configurationIssues(dependencies, tx, agentName, agentProviders, head),
    ...tail.flatMap((config, index) =>
      configurationIssues(dependencies, tx, agentName, agentProviders, config, [
        FALLBACK_FIELD,
        String(index),
      ]),
    ),
  ];
}
