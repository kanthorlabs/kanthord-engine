import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthScope, type ResourceEntry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { getAgentDeclaration } from "./catalog.ts";
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
  agentOperations,
  agentEnablementSchema,
  promptSettingsSchema,
  PROMPT_TEXT_MAX_BYTES,
  PromptScope,
  SystemLayerOverride,
  type PromptSettings,
  type StoredPromptSettings,
  agentModelSchema,
  agentCooldownSchema,
  effectiveConfigurationSchema,
  PromptView,
  type PromptLayerAnswer,
  type PromptTemplates,
  AgentErrorCode,
  AGENT_PROVIDER_TARGET_KIND,
  LIST_LIMIT_DEFAULT,
  type AgentDependentBinding,
  type AgentEnablement,
  type AgentEntry,
  type AdvancingFailure,
  type AgentSelection,
  type AgentProviderItem,
  type AgentView,
  type ApprovedModelsFn,
  type CustodySuitability,
  type DefaultConfiguration,
  type EntriesOfAgent,
  type ProviderCapabilityFn,
  type ProviderHealthCheckFn,
  type ToolDeclarationsFn,
} from "./contract.ts";
import {
  EnablementState,
  getEnablement,
  getLatestRevision,
  insertEnablementRevision,
  listEnablements,
  readEnablementRevision,
  agentProvidersDependentOn,
  enablementsByModel,
  type EnablementRow,
} from "./enablements.ts";
import { promptSettings, savePromptSettings } from "./prompts.ts";
import { cooldownDuration } from "./cooldowns.ts";
import type { CredentialHolds } from "../custody/contract.ts";
import { applyLocks, lockedSwitches, withLocks } from "./prompt-locks.ts";
import {
  ProjectErrorCode,
  type RepositoryPolicy,
} from "../project/contract.ts";
import {
  resolveLayers,
  type PromptSettingsSet,
  type RepositoryLayerSource,
  type ResolvedLayer,
} from "./prompt-layers.ts";
import { finalPrompt, PromptConsumer } from "./prompt-render.ts";
import { resolveTemplates, templateDirectory } from "./prompt-templates.ts";

const NO_ITEMS = 0;
const LAST_PROVIDER = 1;
const HEALTH_PAGE_SIZE = 100;
const ABSENT_REVISION = 0;
const FIRST_POSITION = 0;
const NO_STRIKES = 0;
const FIRST_STRIKE = 1;

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
  const latest = getLatestRevision(tx, agentName);
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

type PromptTarget = {
  scope: PromptScope;
  agent_name?: string | undefined;
  expected_revision?: number | undefined;
};

function currentPrompt(
  tx: Transaction,
  target: PromptTarget,
  config: AgentConfig["prompt"],
): StoredPromptSettings {
  const agentName = target.agent_name ?? "";
  if (target.scope !== PromptScope.System) requireAgent(agentName);
  const current = promptSettings(tx, target.scope, agentName);
  if ((target.expected_revision ?? ABSENT_REVISION) !== current.revision)
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.PromptRevisionConflict,
      "Prompt settings revision conflict.",
      {
        scope: target.scope,
        agent_name: agentName,
        current: withLocks(current, config),
      },
    );
  return current;
}

function putPrompt(
  tx: Transaction,
  body: PromptTarget & { custom_text: string },
  config: AgentConfig["prompt"],
): PromptSettings {
  const current = currentPrompt(tx, body, config);
  if (Buffer.byteLength(body.custom_text) > PROMPT_TEXT_MAX_BYTES)
    throw new OperationError(
      HttpStatus.BadRequest,
      AgentErrorCode.PromptTooLarge,
      "Custom prompt text is too large.",
      { scope: body.scope, maxBytes: PROMPT_TEXT_MAX_BYTES },
    );
  return promptSettingsSchema.parse(
    withLocks(
      savePromptSettings(
        tx,
        { ...current, custom_text: body.custom_text },
        current.revision,
      ),
      config,
    ),
  );
}

function switchPrompt(
  tx: Transaction,
  body: PromptTarget & {
    switch?: string | undefined;
    enabled?: boolean | undefined;
    system_layer?: SystemLayerOverride | undefined;
  },
  config: AgentConfig["prompt"],
): PromptSettings {
  const current = currentPrompt(tx, body, config);
  if (body.system_layer !== undefined)
    return promptSettingsSchema.parse(
      withLocks(
        savePromptSettings(
          tx,
          { ...current, system_layer: body.system_layer },
          current.revision,
        ),
        config,
      ),
    );
  assert.ok(body.switch !== undefined && body.enabled !== undefined);
  if (lockedSwitches(body.scope, config).includes(body.switch))
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.PromptSwitchLocked,
      "The configuration locks this prompt switch.",
      { scope: body.scope, switch: body.switch },
    );
  const switches = { ...current.switches, [body.switch]: body.enabled };
  if (
    body.scope === PromptScope.Agent &&
    Object.values(switches).every((enabled) => !enabled)
  )
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.PromptAgentLayerEmpty,
      "An agent prompt layer needs one source.",
      {
        scope: body.scope,
        agent_name: current.agent_name,
        switch: body.switch,
      },
    );
  return promptSettingsSchema.parse(
    withLocks(
      savePromptSettings(tx, { ...current, switches }, current.revision),
      config,
    ),
  );
}

function layerAnswer(layer: ResolvedLayer): PromptLayerAnswer {
  return {
    layer: layer.layer,
    enabled: layer.enabled,
    sources: layer.sources.map((source) => ({
      source: source.source,
      origin: source.origin,
      path: source.path,
      enabled: source.enabled,
      state: source.state,
      digest: source.digest,
      text: source.text,
    })),
  };
}

export interface Dependencies {
  store: Store;
  config: AgentConfig;
  dataDirectory: string;
  hostHome?: string;
  workbenchDirectory: (agentName: string) => string;
  custodySuitability: CustodySuitability;
  credentialHolds: CredentialHolds;
  approvedModels: ApprovedModelsFn;
  entriesOfAgent: EntriesOfAgent;
  repositoryWorkingOf: (
    tx: Transaction,
    bindingId: string,
  ) => Pick<
    RepositoryPolicy,
    "project_id" | "name" | "project_prompt" | "working_layer"
  > | null;
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

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
    this.now = dependencies.clock ?? Date.now;
  }

  private validateEffectiveConfig(
    tx: Transaction,
    agentName: string,
    agentProviders: AgentProviderItem[],
    config: DefaultConfiguration,
  ): void {
    validateEffectiveConfig(
      this.dependencies,
      tx,
      agentName,
      agentProviders,
      config,
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
      this.validateEffectiveConfig(tx, agentName, agentProviders, config);
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
    for (const item of agentProviders)
      validateProvider(this.dependencies, tx, agentName, item);
    this.validateChain(
      tx,
      agentName,
      agentProviders,
      defaultConfiguration,
      fallbackConfigurations,
    );
    if (
      current?.agent_providers.some((old) =>
        agentProviders.some(
          (item) => item.name === old.name && item.provider !== old.provider,
        ),
      )
    )
      throw conflict(agentName, AgentErrorCode.ProviderFixed);
    const entries = this.dependencies.entriesOfAgent(tx, agentName);
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
        approvedModels,
      },
      tx,
      agentName,
      current.agent_providers,
      config,
      tailOf(current.fallback_configurations, entry),
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
      const cooldown = this.dependencies.credentialHolds.holdOf(
        tx,
        provider.credential,
      );
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

  selectAgent(
    tx: Transaction,
    agentName: string,
    entry: AgentEntry | null,
  ): AgentSelectionResult {
    const view = this.agentView(tx, agentName, entry);
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
    code: AdvancingFailure,
    executionId: string,
    now: number,
  ): void {
    const { credentialHolds, config } = this.dependencies;
    for (const credential of uniqueCredentials(selections)) {
      const strikes =
        (credentialHolds.holdOf(tx, credential)?.strikes ?? NO_STRIKES) +
        FIRST_STRIKE;
      const availableAt =
        now + cooldownDuration(config.cooldown, code, strikes);
      credentialHolds.hold(tx, credential, availableAt, strikes);
      this.logger.info(
        {
          execution_id: executionId,
          credential_name: credential,
          code,
          strikes,
          available_at: availableAt,
        },
        "agent.fallback.cooldown_started",
      );
    }
  }

  recordSuccess(
    tx: Transaction,
    selections: readonly AgentSelection[],
    executionId: string,
  ): void {
    for (const credential of uniqueCredentials(selections))
      if (this.dependencies.credentialHolds.release(tx, credential))
        this.logger.info(
          { execution_id: executionId, credential_name: credential },
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

  private repositoryWorking(
    projectId: string,
    bindingId: string,
  ): RepositoryLayerSource {
    const repository = this.dependencies.store.transaction((tx) =>
      this.dependencies.repositoryWorkingOf(tx, bindingId),
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

  composePrompt(
    agentName: string,
    context: Context,
    repository: RepositoryLayerSource | null = null,
  ): Promise<ResolvedLayer[]> {
    const agent = getAgentDeclaration(agentName);
    assert.ok(agent);
    const { config, dataDirectory, workbenchDirectory } = this.dependencies;
    const settings: PromptSettingsSet = this.dependencies.store.transaction(
      (tx) => ({
        system: applyLocks(
          promptSettings(tx, PromptScope.System),
          config.prompt,
        ),
        agent: promptSettings(tx, PromptScope.Agent, agentName),
        working: promptSettings(tx, PromptScope.Workbench, agentName),
      }),
    );
    return resolveLayers({
      agent,
      settings,
      systemFile: config.prompt.system_file,
      agentDirectory: config.prompt.agent_directory,
      dataDirectory,
      hostHome: this.dependencies.hostHome ?? homedir(),
      workingDirectory: workbenchDirectory(agentName),
      repository,
      context,
    });
  }

  promptTemplates(context: Context): Promise<PromptTemplates> {
    const { config, dataDirectory } = this.dependencies;
    const agentDirectory = config.prompt.agent_directory
      ? resolve(dataDirectory, config.prompt.agent_directory)
      : null;
    return resolveTemplates(templateDirectory(agentDirectory), context);
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
    registry.register(agentOperations["cooldown.clear"], ({ params }, caller) =>
      caller.commit((tx) => {
        if (!this.dependencies.credentialHolds.release(tx, params.credential))
          throw new OperationError(
            HttpStatus.NotFound,
            AgentErrorCode.CooldownNotFound,
            "Agent cooldown not found.",
            { credential: params.credential },
          );
        this.logger.info(
          { credential_name: params.credential },
          "agent.fallback.cooldown_cleared",
        );
        return null;
      }),
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
        const repository =
          query.binding_id === undefined || query.project_id === undefined
            ? null
            : this.repositoryWorking(query.project_id, query.binding_id);
        const layers = await this.composePrompt(
          params.agent_name,
          caller.context,
          repository,
        );
        const final = finalPrompt(
          layers,
          repository ? PromptConsumer.Worker : PromptConsumer.Workbench,
          await this.promptTemplates(caller.context),
        );
        return caller.commit((tx) => {
          const row = getEnablement(tx, params.agent_name);
          return {
            agent_name: declaration.agent_name,
            configuration_schema: z.toJSONSchema(effectiveConfigurationSchema),
            overridable_fields: [...declaration.overridable_fields],
            prompt:
              query.view === PromptView.Final
                ? { final }
                : { layers: layers.map(layerAnswer), final },
            tools,
            enablement: row ? wireRecord(row) : null,
          };
        });
      },
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
    registry.register(agentOperations["prompt.put"], ({ body }, caller) =>
      caller.commit((tx) =>
        putPrompt(tx, body, this.dependencies.config.prompt),
      ),
    );
    registry.register(agentOperations["prompt.switch"], ({ body }, caller) =>
      caller.commit((tx) =>
        switchPrompt(tx, body, this.dependencies.config.prompt),
      ),
    );
    registry.register(agentOperations["prompt.get"], ({ query }, caller) =>
      caller.commit((tx) => {
        const agentName = query.agent_name ?? "";
        if (query.scope !== PromptScope.System) requireAgent(agentName);
        return promptSettingsSchema.parse(
          withLocks(
            promptSettings(tx, query.scope, agentName),
            this.dependencies.config.prompt,
          ),
        );
      }),
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
