import assert from "node:assert/strict";
import { homedir } from "node:os";
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
  configurationError,
  configurationIssues,
  effectiveConfiguration,
  providerModels,
  validateEffectiveConfig,
  validateProvider,
} from "./configuration.ts";
import {
  agentOperations,
  agentEnablementSchema,
  promptSettingsSchema,
  PROMPT_TEXT_MAX_BYTES,
  PromptScope,
  type PromptSettings,
  agentModelSchema,
  effectiveConfigurationSchema,
  PromptView,
  type PromptLayerAnswer,
  AgentErrorCode,
  AGENT_PROVIDER_TARGET_KIND,
  LIST_LIMIT_DEFAULT,
  type AgentDependentBinding,
  type AgentEnablement,
  type AgentEntry,
  type AgentProviderItem,
  type AgentView,
  type ApprovedModelsFn,
  type CustodySuitability,
  type DefaultConfiguration,
  type EntriesOfAgent,
  type ProviderCapabilityFn,
  type ProviderHealthCheckFn,
  type RepositoryWorkingOf,
  type ToolDeclarationsFn,
} from "./contract.ts";
import {
  EnablementState,
  getEnablement,
  getLatestRevision,
  insertEnablementRevision,
  listEnablements,
  agentProvidersDependentOn,
  enablementsByModel,
  type EnablementRow,
} from "./enablements.ts";
import { promptSettings, savePromptSettings } from "./prompts.ts";
import { ProjectErrorCode } from "../project/contract.ts";
import {
  resolveLayers,
  type PromptSettingsSet,
  type RepositoryWorking,
  type ResolvedLayer,
} from "./prompt-layers.ts";
import { finalPrompt, PromptConsumer } from "./prompt-render.ts";

const NO_ITEMS = 0;
const LAST_PROVIDER = 1;
const HEALTH_PAGE_SIZE = 100;
const ABSENT_REVISION = 0;

function wireRecord(row: EnablementRow) {
  return agentEnablementSchema.parse({
    agentName: row.agentName,
    state: row.state,
    agentProviders: row.agentProviders,
    defaultConfiguration: row.defaultConfiguration,
    revision: row.revision,
  });
}

function requireAgent(agentName: string): void {
  if (!getAgentDeclaration(agentName))
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "Agent not found.",
      { agentName },
    );
}

function requireEnablement(tx: Transaction, agentName: string): EnablementRow {
  const row = getEnablement(tx, agentName);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.NotFound,
      "Agent enablement not found.",
      { agentName },
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
      { agentName, revision: latest?.revision ?? null },
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

function bindingIdentity({ bindingId, workerName }: AgentDependentBinding) {
  return { bindingId, workerName };
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
    { agentName, ...details },
  );
}

function saveRevision(tx: Transaction, current: EnablementRow) {
  return wireRecord(
    insertEnablementRevision(
      tx,
      current.agentName,
      current.state,
      current.agentProviders,
      current.defaultConfiguration,
    ),
  );
}

type PromptTarget = {
  scope: PromptScope;
  agentName?: string | undefined;
  expectedRevision?: number | undefined;
};

function currentPrompt(tx: Transaction, target: PromptTarget): PromptSettings {
  const agentName = target.agentName ?? "";
  if (target.scope !== PromptScope.System) requireAgent(agentName);
  const current = promptSettings(tx, target.scope, agentName);
  if ((target.expectedRevision ?? ABSENT_REVISION) !== current.revision)
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.PromptRevisionConflict,
      "Prompt settings revision conflict.",
      { scope: target.scope, agentName, current },
    );
  return current;
}

function putPrompt(
  tx: Transaction,
  body: PromptTarget & { customText: string },
): PromptSettings {
  const current = currentPrompt(tx, body);
  if (Buffer.byteLength(body.customText) > PROMPT_TEXT_MAX_BYTES)
    throw new OperationError(
      HttpStatus.BadRequest,
      AgentErrorCode.PromptTooLarge,
      "Custom prompt text is too large.",
      { scope: body.scope, maxBytes: PROMPT_TEXT_MAX_BYTES },
    );
  return promptSettingsSchema.parse(
    savePromptSettings(
      tx,
      { ...current, customText: body.customText },
      current.revision,
    ),
  );
}

function switchPrompt(
  tx: Transaction,
  body: PromptTarget & { switch: string; enabled: boolean },
): PromptSettings {
  const current = currentPrompt(tx, body);
  const switches = { ...current.switches, [body.switch]: body.enabled };
  if (
    body.scope === PromptScope.Agent &&
    Object.values(switches).every((enabled) => !enabled)
  )
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.PromptAgentLayerEmpty,
      "An agent prompt layer needs one source.",
      { scope: body.scope, agentName: current.agentName, switch: body.switch },
    );
  return promptSettingsSchema.parse(
    savePromptSettings(tx, { ...current, switches }, current.revision),
  );
}

function layerAnswer(layer: ResolvedLayer): PromptLayerAnswer {
  return {
    layer: layer.layer,
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
  approvedModels: ApprovedModelsFn;
  entriesOfAgent: EntriesOfAgent;
  repositoryWorkingOf: RepositoryWorkingOf;
  providerHealthCheck: ProviderHealthCheckFn;
  providerCapability: ProviderCapabilityFn;
  toolDeclarations: ToolDeclarationsFn;
}

export class AgentComponent {
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
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

  private validateBindings(
    tx: Transaction,
    agentName: string,
    agentProviders: AgentProviderItem[],
    defaults: DefaultConfiguration,
    entries: AgentDependentBinding[],
  ): void {
    const bindings = entries.flatMap((binding) =>
      configurationIssues(
        this.dependencies,
        tx,
        agentName,
        agentProviders,
        effectiveConfiguration(defaults, binding.entry),
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
    checkRevision(tx, agentName, body.expectedRevision);
    const current = getEnablement(tx, agentName);
    const { agentProviders, defaultConfiguration } = body;
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
    this.validateEffectiveConfig(
      tx,
      agentName,
      agentProviders,
      defaultConfiguration,
    );
    if (
      current?.agentProviders.some((old) =>
        agentProviders.some(
          (item) => item.name === old.name && item.provider !== old.provider,
        ),
      )
    )
      throw conflict(agentName, AgentErrorCode.ProviderFixed);
    const entries = this.dependencies.entriesOfAgent(tx, agentName);
    const omitted = new Set(
      current?.agentProviders
        .filter(({ name }) => !names.has(name))
        .map(({ name }) => name),
    );
    const bindings = entries
      .filter(
        ({ entry }) =>
          entry?.agentProvider !== undefined &&
          omitted.has(entry.agentProvider),
      )
      .map(bindingIdentity);
    if (bindings.length > NO_ITEMS)
      throw conflict(agentName, AgentErrorCode.ProviderInUse, { bindings });
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      defaultConfiguration,
      entries,
    );
    return wireRecord(
      insertEnablementRevision(
        tx,
        agentName,
        current?.state ?? EnablementState.Enabled,
        agentProviders,
        defaultConfiguration,
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
      this.validateEffectiveConfig(
        tx,
        agentName,
        current.agentProviders,
        current.defaultConfiguration,
      );
      this.validateBindings(
        tx,
        agentName,
        current.agentProviders,
        current.defaultConfiguration,
        this.dependencies.entriesOfAgent(tx, agentName),
      );
    }
    return saveRevision(tx, { ...current, state });
  }

  private removeEnablement(
    tx: Transaction,
    agentName: string,
    expectedRevision: number,
  ): { agentName: string; removed: true } {
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
      current.agentProviders,
      current.defaultConfiguration,
      Date.now(),
    );
    return { agentName, removed: true };
  }

  private addProvider(
    tx: Transaction,
    agentName: string,
    body: (typeof agentOperations)["enablement.provider.add"]["input"]["_output"]["body"],
  ) {
    const current = currentRevision(tx, agentName, body.expectedRevision);
    const { name, provider, credential } = body;
    if (current.agentProviders.some((item) => item.name === name))
      throw conflict(agentName, AgentErrorCode.ProviderNameConflict);
    const holder = current.agentProviders.find(
      (item) => item.credential === credential,
    );
    if (holder)
      throw conflict(agentName, AgentErrorCode.ProviderCredentialConflict, {
        credential,
        agentProvider: holder.name,
      });
    const item = { name, provider, credential };
    validateProvider(this.dependencies, tx, agentName, item);
    const agentProviders = [...current.agentProviders, item];
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      current.defaultConfiguration,
      this.dependencies.entriesOfAgent(tx, agentName),
    );
    return saveRevision(tx, { ...current, agentProviders });
  }

  private removeProvider(
    tx: Transaction,
    agentName: string,
    providerName: string,
    expectedRevision: number,
  ) {
    const current = currentRevision(tx, agentName, expectedRevision);
    if (!current.agentProviders.some(({ name }) => name === providerName))
      throw configurationError(agentName, AgentErrorCode.ProviderNotFound);
    if (current.agentProviders.length === LAST_PROVIDER)
      throw configurationError(agentName, AgentErrorCode.ProviderRequired);
    const entries = this.dependencies.entriesOfAgent(tx, agentName);
    const dependents: Array<
      { kind: string } | ReturnType<typeof bindingIdentity>
    > = [];
    if (current.defaultConfiguration.agentProvider === providerName)
      dependents.push({ kind: "defaultConfiguration" });
    dependents.push(
      ...entries
        .filter(({ entry }) => entry?.agentProvider === providerName)
        .map(bindingIdentity),
    );
    if (dependents.length > NO_ITEMS)
      throw conflict(agentName, AgentErrorCode.ProviderInUse, { dependents });
    const agentProviders = current.agentProviders.filter(
      ({ name }) => name !== providerName,
    );
    this.validateBindings(
      tx,
      agentName,
      agentProviders,
      current.defaultConfiguration,
      entries,
    );
    return saveRevision(tx, { ...current, agentProviders });
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
    this.validateEffectiveConfig(
      tx,
      agentName,
      current.agentProviders,
      effectiveConfiguration(current.defaultConfiguration, entry),
    );
  }

  private validateEntryForm(agentName: string, entry: AgentEntry | null): void {
    if (entry === null) return;
    const declaration = getAgentDeclaration(agentName);
    assert.ok(declaration);
    if (
      Object.keys(entry).some(
        (key) => !declaration.overridableFields.includes(key),
      )
    )
      throw configurationError(agentName, AgentErrorCode.OverrideNotAllowed);
    if (
      Object.keys(entry).length === NO_ITEMS ||
      (entry.agentProvider !== undefined &&
        (entry.modelIdentifier === undefined ||
          entry.reasoningEffort === undefined))
    )
      throw configurationError(agentName, AgentErrorCode.InvalidConfiguration);
  }

  private listModels(tx: Transaction, agentName: string, providerName: string) {
    requireAgent(agentName);
    const current = requireEnablement(tx, agentName);
    const item = current.agentProviders.find(
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
        ({ id, reasoningLevels }) =>
          agentModelSchema.parse({
            modelIdentifier: id,
            reasoningEfforts: reasoningLevels,
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
        valid: false,
        issues: [{ path: [], code: AgentErrorCode.Unavailable }],
      };
    const defaults = current.defaultConfiguration;
    const config = effectiveConfiguration(defaults, entry);
    const issues = configurationIssues(
      {
        custodySuitability: this.dependencies.custodySuitability,
        approvedModels,
      },
      tx,
      agentName,
      current.agentProviders,
      config,
    );
    if (issues.length > NO_ITEMS)
      return { defaults, effective: null, valid: false, issues };
    const item = current.agentProviders.find(
      ({ name }) => name === config.agentProvider,
    );
    assert.ok(item, "Validated configuration must resolve a provider.");
    return {
      defaults,
      effective: {
        ...config,
        provider: item.provider,
        credential: item.credential,
      },
      valid: true,
      issues,
    };
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = listEnablements(tx, HEALTH_PAGE_SIZE, cursor);
      for (const row of page.items) {
        entries.push(
          ...row.agentProviders.map((item) => ({
            scope: HealthScope.Global,
            project: null,
            name: `${encodeURIComponent(row.agentName)}/${encodeURIComponent(item.name)}`,
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
        page.nextCursor,
        cursor === null ? undefined : cursor,
        "Enablement pagination must advance.",
      );
      cursor = page.nextCursor;
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
        row.agentName,
        wireRecord(row),
      ]),
    );
    let cursor: string | null = null;
    do {
      const page = listEnablements(tx, LIST_LIMIT_DEFAULT, cursor);
      for (const row of page.items) {
        const dependent = this.dependencies
          .entriesOfAgent(tx, row.agentName)
          .some(({ entry }) => {
            if (entry === null) return false;
            const effective = effectiveConfiguration(
              row.defaultConfiguration,
              entry,
            );
            return (
              effective.modelIdentifier === modelId &&
              row.agentProviders.some(
                (item) =>
                  item.name === effective.agentProvider &&
                  item.credential === credentialName,
              )
            );
          });
        if (dependent) matches.set(row.agentName, wireRecord(row));
      }
      assert.notEqual(
        page.nextCursor,
        cursor === null ? undefined : cursor,
        "Enablement pagination must advance.",
      );
      cursor = page.nextCursor;
    } while (cursor !== null);
    return [...matches.values()];
  }

  private repositoryWorking(
    projectId: string,
    bindingId: string,
  ): RepositoryWorking {
    const repository = this.dependencies.store.transaction((tx) =>
      this.dependencies.repositoryWorkingOf(tx, bindingId),
    );
    if (repository?.projectId !== projectId)
      throw new OperationError(
        HttpStatus.NotFound,
        ProjectErrorCode.BindingNotFound,
        "Repository binding not found.",
        { projectId, bindingId },
      );
    return repository;
  }

  composePrompt(
    agentName: string,
    context: Context,
    repository: RepositoryWorking | null = null,
  ): Promise<ResolvedLayer[]> {
    const agent = getAgentDeclaration(agentName);
    assert.ok(agent);
    const settings: PromptSettingsSet = this.dependencies.store.transaction(
      (tx) => ({
        system: promptSettings(tx, PromptScope.System),
        agent: promptSettings(tx, PromptScope.Agent, agentName),
        working: promptSettings(tx, PromptScope.Workbench, agentName),
      }),
    );
    const { config, dataDirectory, workbenchDirectory } = this.dependencies;
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

  declare(registry: OperationRegistry): void {
    registry.register(agentOperations["enablement.list"], ({ query }, caller) =>
      caller.commit((tx) => {
        const page = listEnablements(tx, query.limit, query.cursor ?? null);
        return {
          items: page.items.map(wireRecord),
          nextCursor: page.nextCursor,
        };
      }),
    );
    registry.register(agentOperations["model.list"], ({ query }, caller) =>
      caller.commit((tx) => this.listCredentialModels(tx, query)),
    );
    registry.register(
      agentOperations.get,
      async ({ params, query }, caller) => {
        requireAgent(params.agentName);
        const declaration = getAgentDeclaration(params.agentName);
        assert.ok(declaration);
        const tools = await this.dependencies.toolDeclarations(
          params.agentName,
        );
        assert.equal(declaration.agentName, params.agentName);
        const repository =
          query.bindingId === undefined || query.projectId === undefined
            ? null
            : this.repositoryWorking(query.projectId, query.bindingId);
        const layers = await this.composePrompt(
          params.agentName,
          caller.context,
          repository,
        );
        const final = finalPrompt(
          layers,
          repository ? PromptConsumer.Worker : PromptConsumer.Workbench,
        );
        return caller.commit((tx) => {
          const row = getEnablement(tx, params.agentName);
          return {
            agentName: declaration.agentName,
            configurationSchema: z.toJSONSchema(effectiveConfigurationSchema),
            overridableFields: [...declaration.overridableFields],
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
        wireRecord(requireEnablement(tx, params.agentName)),
      ),
    );
    registry.register(
      agentOperations["enablement.put"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.putEnablement(tx, params.agentName, body)),
    );
    registry.register(
      agentOperations["enablement.enable"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.setEnablementState(
            tx,
            params.agentName,
            body.expectedRevision,
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
            params.agentName,
            body.expectedRevision,
            EnablementState.Disabled,
          ),
        ),
    );
    registry.register(
      agentOperations["enablement.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.removeEnablement(tx, params.agentName, body.expectedRevision),
        ),
    );
    registry.register(
      agentOperations["enablement.provider.add"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.addProvider(tx, params.agentName, body)),
    );
    registry.register(
      agentOperations["enablement.provider.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.removeProvider(
            tx,
            params.agentName,
            params.providerName,
            body.expectedRevision,
          ),
        ),
    );
    registry.register(agentOperations["prompt.put"], ({ body }, caller) =>
      caller.commit((tx) => putPrompt(tx, body)),
    );
    registry.register(agentOperations["prompt.switch"], ({ body }, caller) =>
      caller.commit((tx) => switchPrompt(tx, body)),
    );
    registry.register(
      agentOperations["enablement.provider.model.list"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          this.listModels(tx, params.agentName, params.providerName),
        ),
    );
  }
}
