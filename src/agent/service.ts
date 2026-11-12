import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthScope, type ResourceEntry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { getAgentDeclaration, workbenchAgentNames } from "./catalog.ts";
import type { AgentConfig } from "./config.ts";
import {
  chainConfigurations,
  chainIssues,
  checkFallbackDuplicates,
  configurationError,
  effectiveConfiguration,
  namesProvider,
  providerModels,
  tailOf,
  validateEffectiveConfig,
  validateProvider,
} from "./configuration.ts";
import {
  type AdvancingFailure,
  AGENT_PROVIDER_TARGET_KIND,
  agentCooldownSchema,
  type AgentDependentBinding,
  type AgentEnablement,
  agentEnablementSchema,
  type AgentEntry,
  AgentErrorCode,
  agentModelSchema,
  agentOperations,
  type AgentProviderItem,
  type AgentSelection,
  type AgentView,
  type ApprovedModelsFn,
  type CooldownChange,
  CooldownChangeKind,
  type CopyHeldFn,
  type CustodySuitability,
  type DefaultConfiguration,
  effectiveConfigurationSchema,
  type EntriesOfAgent,
  type HolderScope,
  type InstructionFileReader,
  InstructionFileState,
  LIST_LIMIT_DEFAULT,
  type PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptRecord,
  type PromptTemplates,
  PromptView,
  type ProviderCapabilityFn,
  type ProviderHealthCheckFn,
  type ToolDeclarationsFn,
} from "./contract.ts";
import {
  agentProvidersDependentOn,
  type EnablementRow,
  enablementsByModel,
  EnablementState,
  getEnablement,
  insertEnablementRevision,
  listEnablements,
  readEnablementRevision,
} from "./enablements.ts";
import { cooldownDuration } from "./cooldowns.ts";
import {
  type CredentialHold,
  type CredentialHolds,
  SERVER_HOLDER,
} from "../custody/contract.ts";
import {
  ProjectErrorCode,
  type RepositoryPolicy,
} from "../project/contract.ts";
import type { AttemptPromptStack } from "../mission/contract.ts";
import type { ExecutionTrace } from "../tracking/contract.ts";
import {
  isUnreachable,
  projectInstructionFileReader,
  withinPromptDeadline,
} from "./instruction-files.ts";
import { framingPart, resolveAgentPrompt } from "./prompt-files.ts";
import {
  bindingText,
  type PromptReaders,
  type ResolvedPrompt,
  resolvePrompt,
} from "./prompt-resolve.ts";
import {
  bindingParts,
  finalPrompt,
  type InstructionFilePart,
  PromptConsumer,
} from "./prompt-render.ts";
import {
  resolveTemplates,
  resolveTemplateSet,
  templateDirectory,
  type TemplateSet,
} from "./prompt-templates.ts";

const NO_ITEMS = 0;
const LAST_PROVIDER = 1;
const HEALTH_PAGE_SIZE = 100;
const FIRST_POSITION = 0;
const NO_STRIKES = 0;
const FIRST_STRIKE = 1;
const ENABLEMENT_SCOPE: HolderScope = { holders: [], claimant: SERVER_HOLDER };
const EXECUTION_NOT_FOUND = "scheduler.execution.not_found";

type RepositoryPrompts = Pick<
  RepositoryPolicy,
  "binding_id" | "name" | "prompts"
>;

interface StackTarget {
  binding_id: string;
  name: string;
  path: string;
  commit: string | null;
}

interface PromptStackQuery {
  node_id?: string | undefined;
  attempt?: number | undefined;
  binding_id?: string | undefined;
  project_id?: string | undefined;
}

function wireRecord(row: EnablementRow) {
  return agentEnablementSchema.parse({
    agent_name: row.agent_name,
    state: row.state,
    agent_providers: row.agent_providers,
    default_configuration: row.default_configuration,
    fallback_configurations: row.fallback_configurations,
    revision: row.revision,
  });
}

function requireAgent(agentName: string): void {
  if (!getAgentDeclaration(agentName))
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "Agent not found.",
      { agent_name: agentName },
    );
}

function requireEnablement(tx: Transaction, agentName: string): EnablementRow {
  const row = getEnablement(tx, agentName);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.NotFound,
      "Agent enablement not found.",
      { agent_name: agentName },
    );
  return row;
}

function checkRevision(
  tx: Transaction,
  agentName: string,
  expectedRevision: number | undefined,
): void {
  const latest = getEnablement(tx, agentName);
  if (expectedRevision !== latest?.revision)
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.RevisionConflict,
      "Agent enablement revision conflict.",
      { agent_name: agentName, revision: latest?.revision ?? null },
    );
}

function currentRevision(
  tx: Transaction,
  agentName: string,
  expectedRevision: number,
): EnablementRow {
  requireAgent(agentName);
  const current = requireEnablement(tx, agentName);
  checkRevision(tx, agentName, expectedRevision);
  return current;
}

function bindingIdentity({ binding_id, worker_name }: AgentDependentBinding) {
  return { binding_id, worker_name };
}

function conflict(
  agentName: string,
  code: string,
  details: Record<string, NonNullable<OperationError["details"]>> = {},
): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    code,
    "Agent enablement change refused.",
    { agent_name: agentName, ...details },
  );
}

interface ProviderChange {
  agentName: string;
  current: ReturnType<typeof getEnablement>;
  agentProviders: EnablementRow["agent_providers"];
}

function assertProviderSet({
  agentName,
  agentProviders,
}: ProviderChange): void {
  if (agentProviders.length === NO_ITEMS)
    throw configurationError(agentName, AgentErrorCode.ProviderRequired);
  const names = new Set(agentProviders.map(({ name }) => name));
  if (names.size !== agentProviders.length)
    throw conflict(agentName, AgentErrorCode.ProviderNameConflict);
  const credentials = new Set(
    agentProviders.map(({ credential }) => credential),
  );
  if (credentials.size !== agentProviders.length)
    throw conflict(agentName, AgentErrorCode.ProviderCredentialConflict);
}

function assertProvidersFixed({
  agentName,
  current,
  agentProviders,
}: ProviderChange): void {
  if (
    current?.agent_providers.some((old) =>
      agentProviders.some(
        (item) => item.name === old.name && item.provider !== old.provider,
      ),
    )
  )
    throw conflict(agentName, AgentErrorCode.ProviderFixed);
}

function assertProvidersUnused(
  { agentName, current, agentProviders }: ProviderChange,
  entries: ReturnType<EntriesOfAgent>,
): void {
  const names = new Set(agentProviders.map(({ name }) => name));
  const omitted = new Set(
    current?.agent_providers
      .filter(({ name }) => !names.has(name))
      .map(({ name }) => name),
  );
  const bindings = entries
    .filter(
      ({ entry }) =>
        (entry?.agent_provider !== undefined &&
          omitted.has(entry.agent_provider)) ||
        namesProvider(entry?.fallback_configurations, omitted),
    )
    .map(bindingIdentity);
  if (bindings.length > NO_ITEMS)
    throw conflict(agentName, AgentErrorCode.ProviderInUse, { bindings });
}

function saveRevision(tx: Transaction, current: EnablementRow) {
  return wireRecord(
    insertEnablementRevision(
      tx,
      current.agent_name,
      current.state,
      current.agent_providers,
      current.default_configuration,
      current.fallback_configurations,
    ),
  );
}

function stackTargets(
  repositories: readonly RepositoryPrompts[],
  commitOf: (bindingId: string) => string | null,
): StackTarget[] {
  return repositories.flatMap(({ binding_id, name, prompts }) =>
    prompts.instruction_file === undefined
      ? []
      : [
          {
            binding_id,
            name,
            path: prompts.instruction_file,
            commit: commitOf(binding_id),
          },
        ],
  );
}

function headPrompts(repository: RepositoryPrompts): {
  repositories: RepositoryPrompts[];
  targets: StackTarget[];
} {
  return {
    repositories: [repository],
    targets: stackTargets([repository], () => null),
  };
}

export interface Dependencies {
  store: Store;
  config: AgentConfig;
  dataDirectory: string;
  custodySuitability: CustodySuitability;
  copyHeld: CopyHeldFn;
  credentialHolds: CredentialHolds;
  approvedModels: ApprovedModelsFn;
  entriesOfAgent: EntriesOfAgent;
  repositoryPromptsOf: (
    tx: Transaction,
    bindingId: string,
  ) => Pick<
    RepositoryPolicy,
    "binding_id" | "project_id" | "name" | "prompts"
  > | null;
  promptBase: {
    baseCommitOf(bindingId: string, context: Context): Promise<string>;
    instructionFileOf: InstructionFileReader;
  };
  attemptPromptStackOf(
    tx: Transaction,
    nodeId: string,
    attempt: number | null,
  ): AttemptPromptStack;
  promptRecords: {
    executionTraceOf(executionId: string): ExecutionTrace | null;
    promptRecordOf(
      trace: ExecutionTrace,
      agentName: string,
    ): PromptRecord | null;
  };
  providerHealthCheck: ProviderHealthCheckFn;
  providerCapability: ProviderCapabilityFn;
  toolDeclarations: ToolDeclarationsFn;
  logger: Logger;
  clock?: () => number;
}

export const SelectionKind = {
  Selected: "selected",
  Cooling: "cooling",
  Invalid: "invalid",
} as const;

export type AgentSelectionResult =
  | {
      kind: typeof SelectionKind.Selected;
      selection: AgentSelection;
      enablement_id: string;
    }
  | { kind: typeof SelectionKind.Cooling; available_at: number }
  | { kind: typeof SelectionKind.Invalid };

function uniqueCredentials(selections: readonly AgentSelection[]): string[] {
  return [...new Set(selections.map(({ credential }) => credential))];
}

export class AgentComponent {
  private readonly dependencies: Dependencies;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly instructionFileRead: PromptReaders["instructionFileOf"];

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
    this.now = dependencies.clock ?? Date.now;
    this.instructionFileRead = projectInstructionFileReader(
      dependencies.promptBase,
    );
  }

  private validateEffectiveConfig(
    tx: Transaction,
    agentName: string,
    agentProviders: AgentProviderItem[],
    config: DefaultConfiguration,
    holders: readonly string[],
  ): void {
    validateEffectiveConfig(
      this.dependencies,
      tx,
      agentName,
      agentProviders,
      config,
      holders,
    );
  }

  private validateChain(
    tx: Transaction,
    agentName: string,
    agentProviders: AgentProviderItem[],
    head: DefaultConfiguration,
    tail: readonly DefaultConfiguration[],
  ): void {
    checkFallbackDuplicates(agentName, head, tail);
    for (const config of [head, ...tail])
      this.validateEffectiveConfig(tx, agentName, agentProviders, config, []);
  }

  private validateBindings(
    tx: Transaction,
    agentName: string,
    agentProviders: AgentProviderItem[],
    defaults: DefaultConfiguration,
    fallbackConfigurations: readonly DefaultConfiguration[],
    entries: AgentDependentBinding[],
  ): void {
    const bindings = entries.flatMap((binding) =>
      chainIssues(
        this.dependencies,
        tx,
        agentName,
        agentProviders,
        effectiveConfiguration(defaults, binding.entry),
        tailOf(fallbackConfigurations, binding.entry),
        binding.holders,
      ).map(({ code }) => ({ ...bindingIdentity(binding), code })),
    );
    if (bindings.length > NO_ITEMS)
      throw conflict(agentName, AgentErrorCode.InvalidatesBindings, {
        bindings,
      });
  }

  private putEnablement(
    tx: Transaction,
    agentName: string,
    body: (typeof agentOperations)["enablement.put"]["input"]["_output"]["body"],
  ) {
    requireAgent(agentName);
    checkRevision(tx, agentName, body.expected_revision);
    const current = getEnablement(tx, agentName);
    const {
      agent_providers: agentProviders,
      default_configuration: defaultConfiguration,
      fallback_configurations: fallbackConfigurations,
    } = body;
    const change = { agentName, current, agentProviders };
    assertProviderSet(change);
    for (const item of agentProviders)
      validateProvider(this.dependencies, tx, agentName, item);
    this.validateChain(
      tx,
      agentName,
      agentProviders,
      defaultConfiguration,
      fallbackConfigurations,
    );
    assertProvidersFixed(change);
    const entries = this.dependencies.entriesOfAgent(tx, agentName);
    assertProvidersUnused(change, entries);
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      defaultConfiguration,
      fallbackConfigurations,
      entries,
    );
    return wireRecord(
      insertEnablementRevision(
        tx,
        agentName,
        current?.state ?? EnablementState.Enabled,
        agentProviders,
        defaultConfiguration,
        fallbackConfigurations,
      ),
    );
  }

  private setEnablementState(
    tx: Transaction,
    agentName: string,
    expectedRevision: number,
    state: EnablementState,
  ) {
    const current = currentRevision(tx, agentName, expectedRevision);
    if (state === EnablementState.Enabled) {
      this.validateChain(
        tx,
        agentName,
        current.agent_providers,
        current.default_configuration,
        current.fallback_configurations,
      );
      this.validateBindings(
        tx,
        agentName,
        current.agent_providers,
        current.default_configuration,
        current.fallback_configurations,
        this.dependencies.entriesOfAgent(tx, agentName),
      );
    }
    return saveRevision(tx, { ...current, state });
  }

  private removeEnablement(
    tx: Transaction,
    agentName: string,
    expectedRevision: number,
  ): { agent_name: string; removed: true } {
    const current = currentRevision(tx, agentName, expectedRevision);
    const bindings = this.dependencies
      .entriesOfAgent(tx, agentName)
      .map(bindingIdentity);
    if (bindings.length > NO_ITEMS)
      throw conflict(agentName, AgentErrorCode.InUse, { bindings });
    insertEnablementRevision(
      tx,
      agentName,
      current.state,
      current.agent_providers,
      current.default_configuration,
      current.fallback_configurations,
      Date.now(),
    );
    return { agent_name: agentName, removed: true };
  }

  private addProvider(
    tx: Transaction,
    agentName: string,
    body: (typeof agentOperations)["enablement.provider.add"]["input"]["_output"]["body"],
  ) {
    const current = currentRevision(tx, agentName, body.expected_revision);
    const { name, provider, credential } = body;
    if (current.agent_providers.some((item) => item.name === name))
      throw conflict(agentName, AgentErrorCode.ProviderNameConflict);
    const holder = current.agent_providers.find(
      (item) => item.credential === credential,
    );
    if (holder)
      throw conflict(agentName, AgentErrorCode.ProviderCredentialConflict, {
        credential,
        agent_provider: holder.name,
      });
    const item = { name, provider, credential };
    validateProvider(this.dependencies, tx, agentName, item);
    const agentProviders = [...current.agent_providers, item];
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      current.default_configuration,
      current.fallback_configurations,
      this.dependencies.entriesOfAgent(tx, agentName),
    );
    return saveRevision(tx, { ...current, agent_providers: agentProviders });
  }

  private removeProvider(
    tx: Transaction,
    agentName: string,
    providerName: string,
    expectedRevision: number,
  ) {
    const current = currentRevision(tx, agentName, expectedRevision);
    if (!current.agent_providers.some(({ name }) => name === providerName))
      throw configurationError(agentName, AgentErrorCode.ProviderNotFound);
    if (current.agent_providers.length === LAST_PROVIDER)
      throw configurationError(agentName, AgentErrorCode.ProviderRequired);
    const entries = this.dependencies.entriesOfAgent(tx, agentName);
    const dependents: Array<
      { kind: string } | ReturnType<typeof bindingIdentity>
    > = [];
    const removed = new Set([providerName]);
    if (current.default_configuration.agent_provider === providerName)
      dependents.push({ kind: "default_configuration" });
    if (namesProvider(current.fallback_configurations, removed))
      dependents.push({ kind: "fallback_configurations" });
    dependents.push(
      ...entries
        .filter(
          ({ entry }) =>
            entry?.agent_provider === providerName ||
            namesProvider(entry?.fallback_configurations, removed),
        )
        .map(bindingIdentity),
    );
    if (dependents.length > NO_ITEMS)
      throw conflict(agentName, AgentErrorCode.ProviderInUse, { dependents });
    const agentProviders = current.agent_providers.filter(
      ({ name }) => name !== providerName,
    );
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      current.default_configuration,
      current.fallback_configurations,
      entries,
    );
    return saveRevision(tx, { ...current, agent_providers: agentProviders });
  }

  validateEntry(
    tx: Transaction,
    agentName: string,
    entry: AgentEntry | null,
    holders: readonly string[],
  ): void {
    const current = getEnablement(tx, agentName);
    if (!current || current.state === EnablementState.Disabled)
      throw configurationError(agentName, AgentErrorCode.Unavailable);
    this.validateEntryForm(agentName, entry);
    const head = effectiveConfiguration(current.default_configuration, entry);
    if (entry?.fallback_configurations !== undefined)
      checkFallbackDuplicates(agentName, head, entry.fallback_configurations);
    for (const config of [
      head,
      ...tailOf(current.fallback_configurations, entry),
    ])
      this.validateEffectiveConfig(
        tx,
        agentName,
        current.agent_providers,
        config,
        holders,
      );
  }

  private validateEntryForm(agentName: string, entry: AgentEntry | null): void {
    if (entry === null) return;
    const declaration = getAgentDeclaration(agentName);
    assert.ok(declaration);
    if (
      Object.keys(entry).some(
        (key) => !declaration.overridable_fields.includes(key),
      )
    )
      throw configurationError(agentName, AgentErrorCode.OverrideNotAllowed);
    if (
      Object.keys(entry).length === NO_ITEMS ||
      (entry.agent_provider !== undefined &&
        (entry.model_identifier === undefined ||
          entry.reasoning_effort === undefined))
    )
      throw configurationError(agentName, AgentErrorCode.InvalidConfiguration);
  }

  private listModels(tx: Transaction, agentName: string, providerName: string) {
    requireAgent(agentName);
    const current = requireEnablement(tx, agentName);
    const item = current.agent_providers.find(
      ({ name }) => name === providerName,
    );
    if (!item)
      throw configurationError(agentName, AgentErrorCode.ProviderNotFound);
    return this.modelItems(tx, item);
  }

  private listCredentialModels(
    tx: Transaction,
    item: { provider: string; credential: string },
  ) {
    try {
      this.dependencies.custodySuitability(tx, {
        credential: item.credential,
        platform: item.provider,
      });
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      throw new OperationError(
        HttpStatus.BadRequest,
        AgentErrorCode.CredentialUnsuitable,
        "The credential does not suit the agent provider kind.",
        { provider: item.provider, credential: item.credential },
      );
    }
    return this.modelItems(tx, item);
  }

  private modelItems(
    tx: Transaction,
    item: { provider: string; credential: string },
  ) {
    return {
      items: providerModels(this.dependencies, tx, item).map(
        ({ id, reasoning_levels }) =>
          agentModelSchema.parse({
            model_identifier: id,
            reasoning_efforts: reasoning_levels,
          }),
      ),
    };
  }

  agentView(
    tx: Transaction,
    agentName: string,
    entry: AgentEntry | null,
    scope: HolderScope,
    approvedModels: ApprovedModelsFn = this.dependencies.approvedModels,
  ): AgentView | null {
    if (!getAgentDeclaration(agentName)) return null;
    const current = getEnablement(tx, agentName);
    if (!current || current.state === EnablementState.Disabled)
      return {
        defaults: null,
        effective: null,
        chain: [],
        active_position: null,
        cooling: null,
        valid: false,
        issues: [{ path: [], code: AgentErrorCode.Unavailable }],
      };
    const defaults = current.default_configuration;
    const config = effectiveConfiguration(defaults, entry);
    const issues = chainIssues(
      {
        custodySuitability: this.dependencies.custodySuitability,
        copyHeld: this.dependencies.copyHeld,
        approvedModels,
      },
      tx,
      agentName,
      current.agent_providers,
      config,
      tailOf(current.fallback_configurations, entry),
      scope.holders,
    );
    if (issues.length > NO_ITEMS)
      return {
        defaults,
        effective: null,
        chain: [],
        active_position: null,
        cooling: null,
        valid: false,
        issues,
      };
    const now = this.now();
    const chain = chainConfigurations(
      defaults,
      current.fallback_configurations,
      entry,
    ).map(({ level, ...item }, position) => {
      const provider = current.agent_providers.find(
        ({ name }) => name === item.agent_provider,
      );
      assert.ok(provider, "Validated configuration must resolve a provider.");
      const cooldown = this.cooldownOf(tx, provider.credential, scope);
      return {
        position,
        level,
        ...item,
        provider: provider.provider,
        credential: provider.credential,
        cooldown,
      };
    });
    const head = chain[FIRST_POSITION];
    assert.ok(head);
    const active = chain.find(
      ({ cooldown }) => cooldown === null || cooldown.available_at <= now,
    );
    return {
      defaults,
      effective: {
        ...config,
        provider: head.provider,
        credential: head.credential,
      },
      chain,
      active_position: active?.position ?? null,
      cooling: active
        ? null
        : {
            code: AgentErrorCode.ChainCooling,
            available_at: Math.min(
              ...chain.map(({ cooldown }) => cooldown?.available_at ?? now),
            ),
          },
      valid: true,
      issues,
    };
  }

  private cooldownOf(
    tx: Transaction,
    credential: string,
    scope: HolderScope,
  ): CredentialHold | null {
    const { credentialHolds } = this.dependencies;
    if (scope.claimant !== null)
      return credentialHolds.holdOf(tx, credential, scope.claimant);
    return scope.holders
      .map((holder) => credentialHolds.holdOf(tx, credential, holder))
      .reduce<CredentialHold | null>(
        (latest, hold) =>
          hold !== null &&
          (latest === null || hold.available_at > latest.available_at)
            ? hold
            : latest,
        null,
      );
  }

  selectAgent(
    tx: Transaction,
    agentName: string,
    entry: AgentEntry | null,
    scope: HolderScope,
  ): AgentSelectionResult {
    const view = this.agentView(tx, agentName, entry, scope);
    if (!view?.valid) return { kind: SelectionKind.Invalid };
    if (view.active_position === null) {
      assert.ok(view.cooling);
      return {
        kind: SelectionKind.Cooling,
        available_at: view.cooling.available_at,
      };
    }
    const entryOfChain = view.chain[view.active_position];
    assert.ok(entryOfChain);
    const current = getEnablement(tx, agentName);
    assert.ok(current);
    return {
      kind: SelectionKind.Selected,
      enablement_id: current.id,
      selection: {
        agent_name: agentName,
        position: entryOfChain.position,
        level: entryOfChain.level,
        agent_provider: entryOfChain.agent_provider,
        provider: entryOfChain.provider,
        credential: entryOfChain.credential,
        model_identifier: entryOfChain.model_identifier,
        reasoning_effort: entryOfChain.reasoning_effort,
      },
    };
  }

  selectionView(
    tx: Transaction,
    selection: AgentSelection,
    approvedModels: ApprovedModelsFn = this.dependencies.approvedModels,
  ): Pick<AgentView, "effective" | "valid" | "issues"> {
    const current = getEnablement(tx, selection.agent_name);
    if (!current || current.state === EnablementState.Disabled)
      return {
        effective: null,
        valid: false,
        issues: [{ path: [], code: AgentErrorCode.Unavailable }],
      };
    const configuration = {
      agent_provider: selection.agent_provider,
      model_identifier: selection.model_identifier,
      reasoning_effort: selection.reasoning_effort,
    };
    const issues = chainIssues(
      {
        custodySuitability: this.dependencies.custodySuitability,
        copyHeld: this.dependencies.copyHeld,
        approvedModels,
      },
      tx,
      selection.agent_name,
      [
        {
          name: selection.agent_provider,
          provider: selection.provider,
          credential: selection.credential,
        },
      ],
      configuration,
      [],
      [],
    );
    if (issues.length > NO_ITEMS)
      return { effective: null, valid: false, issues };
    return {
      effective: {
        ...configuration,
        provider: selection.provider,
        credential: selection.credential,
      },
      valid: true,
      issues,
    };
  }

  selectionAt(
    tx: Transaction,
    agentName: string,
    enablementId: string,
    entry: AgentEntry | null,
    position: number,
  ): AgentSelection {
    const revision = readEnablementRevision(tx, enablementId);
    assert.ok(revision, "A pinned enablement revision must exist.");
    assert.equal(revision.agent_name, agentName);
    const item = chainConfigurations(
      revision.default_configuration,
      revision.fallback_configurations,
      entry,
    )[position];
    assert.ok(item, "A pinned chain position must exist.");
    const provider = revision.agent_providers.find(
      ({ name }) => name === item.agent_provider,
    );
    assert.ok(provider, "A pinned chain entry must resolve a provider.");
    return {
      agent_name: agentName,
      position,
      level: item.level,
      agent_provider: item.agent_provider,
      provider: provider.provider,
      credential: provider.credential,
      model_identifier: item.model_identifier,
      reasoning_effort: item.reasoning_effort,
    };
  }

  recordProviderFailure(
    tx: Transaction,
    selections: readonly AgentSelection[],
    holder: string,
    code: AdvancingFailure,
    executionId: string,
    now: number,
  ): CooldownChange[] {
    const { credentialHolds, config } = this.dependencies;
    const changes: CooldownChange[] = [];
    for (const credential of uniqueCredentials(selections)) {
      const strikes =
        (credentialHolds.holdOf(tx, credential, holder)?.strikes ??
          NO_STRIKES) + FIRST_STRIKE;
      const availableAt =
        now + cooldownDuration(config.cooldown, code, strikes);
      credentialHolds.hold(tx, credential, holder, availableAt, strikes);
      changes.push({
        kind: CooldownChangeKind.Started,
        execution_id: executionId,
        credential,
        holder,
        code,
        strikes,
        available_at: availableAt,
      });
    }
    return changes;
  }

  recordSuccess(
    tx: Transaction,
    selections: readonly AgentSelection[],
    holder: string,
    executionId: string,
  ): CooldownChange[] {
    const changes: CooldownChange[] = [];
    for (const credential of uniqueCredentials(selections))
      if (this.dependencies.credentialHolds.release(tx, credential, holder))
        changes.push({
          kind: CooldownChangeKind.Cleared,
          execution_id: executionId,
          credential,
          holder,
        });
    return changes;
  }

  recordCooldowns(changes: readonly CooldownChange[]): void {
    for (const change of changes)
      if (change.kind === CooldownChangeKind.Started)
        this.logger.info(
          {
            execution_id: change.execution_id,
            credential_name: change.credential,
            holder: change.holder,
            code: change.code,
            strikes: change.strikes,
            available_at: change.available_at,
          },
          "agent.fallback.cooldown_started",
        );
      else
        this.logger.info(
          {
            execution_id: change.execution_id,
            credential_name: change.credential,
            holder: change.holder,
          },
          "agent.fallback.cooldown_cleared",
        );
  }

  recordSelection(
    selections: readonly AgentSelection[],
    executionId: string,
  ): void {
    for (const selection of selections)
      this.logger.info(
        {
          execution_id: executionId,
          agent_name: selection.agent_name,
          chain_position: selection.position,
          chain_level: selection.level,
          agent_provider: selection.agent_provider,
          provider: selection.provider,
          model_identifier: selection.model_identifier,
          credential_name: selection.credential,
        },
        "agent.fallback.selected",
      );
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = listEnablements(tx, HEALTH_PAGE_SIZE, cursor);
      for (const row of page.items) {
        entries.push(
          ...row.agent_providers.map((item) => ({
            scope: HealthScope.Global,
            project: null,
            name: `${encodeURIComponent(row.agent_name)}/${encodeURIComponent(item.name)}`,
            target: `${AGENT_PROVIDER_TARGET_KIND}:${item.credential}`,
            capability: this.dependencies.providerCapability(
              tx,
              item.credential,
            ),
            check: this.dependencies.providerHealthCheck(tx, item.credential),
          })),
        );
      }
      assert.notEqual(
        page.next_cursor,
        cursor === null ? undefined : cursor,
        "Enablement pagination must advance.",
      );
      cursor = page.next_cursor;
    } while (cursor !== null);
    return entries;
  }

  agentProvidersDependentOn(tx: Transaction, credentialName: string) {
    return agentProvidersDependentOn(tx, credentialName);
  }

  enablementsDependentOnModel(
    tx: Transaction,
    credentialName: string,
    modelId: string,
  ): AgentEnablement[] {
    const matches = new Map(
      enablementsByModel(tx, credentialName, modelId).map((row) => [
        row.agent_name,
        wireRecord(row),
      ]),
    );
    let cursor: string | null = null;
    do {
      const page = listEnablements(tx, LIST_LIMIT_DEFAULT, cursor);
      for (const row of page.items) {
        const dependent = this.dependencies
          .entriesOfAgent(tx, row.agent_name)
          .some(({ entry }) => {
            if (entry === null) return false;
            return chainConfigurations(
              row.default_configuration,
              row.fallback_configurations,
              entry,
            ).some(
              (config) =>
                config.model_identifier === modelId &&
                row.agent_providers.some(
                  (item) =>
                    item.name === config.agent_provider &&
                    item.credential === credentialName,
                ),
            );
          });
        if (dependent) matches.set(row.agent_name, wireRecord(row));
      }
      assert.notEqual(
        page.next_cursor,
        cursor === null ? undefined : cursor,
        "Enablement pagination must advance.",
      );
      cursor = page.next_cursor;
    } while (cursor !== null);
    return [...matches.values()];
  }

  private promptStackOf(query: PromptStackQuery) {
    if (query.node_id !== undefined)
      return this.nodePrompts(query.node_id, query.attempt ?? null);
    if (query.binding_id === undefined || query.project_id === undefined)
      return null;
    return headPrompts(
      this.repositoryPrompts(query.project_id, query.binding_id),
    );
  }

  private repositoryPrompts(
    projectId: string,
    bindingId: string,
  ): Pick<RepositoryPolicy, "binding_id" | "name" | "prompts"> {
    const repository = this.dependencies.store.transaction((tx) =>
      this.dependencies.repositoryPromptsOf(tx, bindingId),
    );
    if (repository?.project_id !== projectId)
      throw new OperationError(
        HttpStatus.NotFound,
        ProjectErrorCode.BindingNotFound,
        "Repository binding not found.",
        { project_id: projectId, binding_id: bindingId },
      );
    return repository;
  }

  private nodePrompts(
    nodeId: string,
    attempt: number | null,
  ): { repositories: RepositoryPrompts[]; targets: StackTarget[] } {
    return this.dependencies.store.transaction((tx) => {
      const stack = this.dependencies.attemptPromptStackOf(tx, nodeId, attempt);
      const repositories = stack.binding_ids.map((bindingId) => {
        const repository = this.dependencies.repositoryPromptsOf(tx, bindingId);
        assert.ok(repository);
        return repository;
      });
      return {
        repositories,
        targets: stackTargets(
          repositories,
          (bindingId) =>
            stack.prompt_commits?.find(
              (entry) => entry.binding_id === bindingId,
            )?.commit ?? null,
        ),
      };
    });
  }

  private async instructionFilePartOf(
    target: StackTarget,
    context: Context,
  ): Promise<InstructionFilePart | null> {
    let commit = target.commit;
    try {
      commit ??= await this.dependencies.promptBase.baseCommitOf(
        target.binding_id,
        context,
      );
    } catch (error) {
      if (isUnreachable(error))
        return {
          state: PromptPartState.Unreachable,
          path: target.path,
          commit,
        };
      throw error;
    }
    const file = await this.instructionFileRead(
      target.binding_id,
      commit,
      target.path,
      context,
    );
    if (file.state === InstructionFileState.Absent) return null;
    if (file.state === InstructionFileState.Present)
      return {
        state: PromptPartState.Resolved,
        path: target.path,
        commit,
        text: file.text,
      };
    return {
      state:
        file.state === InstructionFileState.Invalid
          ? PromptPartState.Invalid
          : PromptPartState.Unreachable,
      path: target.path,
      commit,
    };
  }

  private instructionFilesOf(
    targets: readonly StackTarget[],
    context: Context,
  ): Promise<Map<string, InstructionFilePart>> {
    return withinPromptDeadline(context, async (deadline) => {
      const parts = new Map<string, InstructionFilePart>();
      const read = await Promise.all(
        targets.map(
          async (target) =>
            [
              target.binding_id,
              await this.instructionFilePartOf(target, deadline),
            ] as const,
        ),
      );
      for (const [bindingId, part] of read)
        if (part !== null) parts.set(bindingId, part);
      return parts;
    });
  }

  private bindingTextOf(
    bindingId: string,
    part: PromptPart,
    agentName: string,
  ): string | null {
    return bindingText(
      this.dependencies.store.transaction(
        (tx) => this.dependencies.repositoryPromptsOf(tx, bindingId)?.prompts,
      ),
      part,
      agentName,
    );
  }

  private async resolveRecordedPrompt(
    executionId: string,
    agentName: string,
    context: Context,
  ): Promise<ResolvedPrompt & { engine_version: string }> {
    const { promptRecords } = this.dependencies;
    const trace = promptRecords.executionTraceOf(executionId);
    if (trace === null)
      throw new OperationError(
        HttpStatus.NotFound,
        EXECUTION_NOT_FOUND,
        "Execution not found.",
        { execution_id: executionId },
      );
    const record = promptRecords.promptRecordOf(trace, agentName);
    if (record === null)
      throw new OperationError(
        HttpStatus.NotFound,
        AgentErrorCode.PromptRecordAbsent,
        "The trace of the execution holds no prompt record of the agent.",
        { execution_id: executionId, agent_name: agentName },
      );
    const resolved = await withinPromptDeadline(context, (deadline) =>
      resolvePrompt(record.sources, {
        agentName,
        bindingTextOf: (bindingId, part, name) =>
          this.bindingTextOf(bindingId, part, name),
        instructionFileOf: this.instructionFileRead,
        context: deadline,
      }),
    );
    return { ...resolved, engine_version: record.engine_version };
  }

  composePrompt(
    agentName: string,
    consumer: PromptConsumer,
    context: Context,
  ): Promise<PromptPartAnswer[]> {
    const agent = getAgentDeclaration(agentName);
    assert.ok(agent);
    return resolveAgentPrompt({
      agent,
      directory: this.agentDirectory(),
      workbench: consumer === PromptConsumer.Workbench,
      context,
    });
  }

  private agentDirectory(): string | null {
    const { config, dataDirectory } = this.dependencies;
    return config.prompt.agent_directory
      ? resolve(dataDirectory, config.prompt.agent_directory)
      : null;
  }

  async promptFraming(
    consumer: PromptConsumer,
    context: Context,
  ): Promise<PromptPartAnswer> {
    return framingPart(
      await this.templateSet(context),
      consumer,
      this.agentDirectory(),
    );
  }

  promptTemplates(context: Context): Promise<PromptTemplates> {
    return resolveTemplates(templateDirectory(this.agentDirectory()), context);
  }

  private templateSet(context: Context): Promise<TemplateSet> {
    return resolveTemplateSet(
      templateDirectory(this.agentDirectory()),
      context,
    );
  }

  declare(registry: OperationRegistry): void {
    registry.register(agentOperations["enablement.list"], ({ query }, caller) =>
      caller.commit((tx) => {
        const page = listEnablements(tx, query.limit, query.cursor ?? null);
        return {
          items: page.items.map(wireRecord),
          next_cursor: page.next_cursor,
        };
      }),
    );
    registry.register(agentOperations["cooldown.list"], (_input, caller) =>
      caller.commit((tx) => ({
        items: this.dependencies.credentialHolds
          .listHolds(tx)
          .map((row) => agentCooldownSchema.parse(row)),
      })),
    );
    registry.register(
      agentOperations["cooldown.clear"],
      ({ params, query }, caller) => {
        const answer = caller.commit((tx) => {
          if (
            !this.dependencies.credentialHolds.release(
              tx,
              params.credential,
              query.holder,
            )
          )
            throw new OperationError(
              HttpStatus.NotFound,
              AgentErrorCode.CooldownNotFound,
              "Agent cooldown not found.",
              { credential: params.credential, holder: query.holder },
            );
          return null;
        });
        this.logger.info(
          { credential_name: params.credential, holder: query.holder },
          "agent.fallback.cooldown_cleared",
        );
        return answer;
      },
    );
    registry.register(agentOperations["model.list"], ({ query }, caller) =>
      caller.commit((tx) => this.listCredentialModels(tx, query)),
    );
    registry.register(
      agentOperations.get,
      async ({ params, query }, caller) => {
        requireAgent(params.agent_name);
        const declaration = getAgentDeclaration(params.agent_name);
        assert.ok(declaration);
        const tools = await this.dependencies.toolDeclarations(
          params.agent_name,
        );
        assert.equal(declaration.agent_name, params.agent_name);
        const stack = this.promptStackOf(query);
        const consumer =
          stack === null &&
          workbenchAgentNames().includes(declaration.agent_name)
            ? PromptConsumer.Workbench
            : PromptConsumer.Worker;
        const files = await this.instructionFilesOf(
          stack?.targets ?? [],
          caller.context,
        );
        const parts = [
          ...(await this.composePrompt(
            params.agent_name,
            consumer,
            caller.context,
          )),
          ...bindingParts(stack?.repositories ?? [], params.agent_name, files),
          await this.promptFraming(consumer, caller.context),
        ];
        const final = finalPrompt(parts);
        return caller.commit((tx) => {
          const row = getEnablement(tx, params.agent_name);
          const view = this.agentView(
            tx,
            params.agent_name,
            null,
            ENABLEMENT_SCOPE,
          );
          assert.ok(view);
          return {
            agent_name: declaration.agent_name,
            configuration_schema: z.toJSONSchema(effectiveConfigurationSchema),
            overridable_fields: [...declaration.overridable_fields],
            prompt:
              query.view === PromptView.Final ? { final } : { parts, final },
            tools,
            enablement: row ? wireRecord(row) : null,
            chain: view.chain,
            active_position: view.active_position,
            cooling: view.cooling,
          };
        });
      },
    );
    registry.register(agentOperations["prompt.resolve"], ({ query }, caller) =>
      this.resolveRecordedPrompt(
        query.execution_id,
        query.agent_name,
        caller.context,
      ),
    );
    registry.register(agentOperations["enablement.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        wireRecord(requireEnablement(tx, params.agent_name)),
      ),
    );
    registry.register(
      agentOperations["enablement.put"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.putEnablement(tx, params.agent_name, body)),
    );
    registry.register(
      agentOperations["enablement.enable"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.setEnablementState(
            tx,
            params.agent_name,
            body.expected_revision,
            EnablementState.Enabled,
          ),
        ),
    );
    registry.register(
      agentOperations["enablement.disable"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.setEnablementState(
            tx,
            params.agent_name,
            body.expected_revision,
            EnablementState.Disabled,
          ),
        ),
    );
    registry.register(
      agentOperations["enablement.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.removeEnablement(tx, params.agent_name, body.expected_revision),
        ),
    );
    registry.register(
      agentOperations["enablement.provider.add"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.addProvider(tx, params.agent_name, body)),
    );
    registry.register(
      agentOperations["enablement.provider.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.removeProvider(
            tx,
            params.agent_name,
            params.provider_name,
            body.expected_revision,
          ),
        ),
    );
    registry.register(
      agentOperations["enablement.provider.model.list"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          this.listModels(tx, params.agent_name, params.provider_name),
        ),
    );
  }
}
