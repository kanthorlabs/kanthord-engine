import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import {
  HealthScope,
  ResourceStatus,
  type ResourceCheck,
  type HealthRegistry,
  type ResourceEntry,
} from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import assert from "node:assert/strict";
import { isMachineIdentity } from "../kernel/caller.ts";
import { AccessPolicy } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  workerOperations,
  WORKER_SERVICE_NAME,
  AGENT_PROVIDER_CAPABILITY,
  AGENT_PROVIDER_TARGET_KIND,
  REGISTRATION_CAPABILITY,
  WorkerHost,
  type WorkerRegistrations,
  type WorkerBindingOf,
  type SchedulerClaims,
  type AgentEnablement,
  type AgentProviderItem,
  type AgentDependentBinding,
  type DefaultConfiguration,
  type WorkerEntry,
  type WorkerAgentView,
  type CustodySuitability,
  type CredentialMetadataFn,
  type EntriesOfAgent,
  type ModelListCheckFn,
  WorkerErrorCode,
  LIST_LIMIT_DEFAULT,
  agentEnablementSchema,
} from "./contract.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  agentsOfWorker,
  getAgentDeclaration,
  getWorkerDeclaration,
  listWorkerDeclarations,
  type WorkerDeclaration,
} from "./catalog.ts";
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
import {
  configurationError,
  configurationIssues,
  effectiveConfiguration,
  validateEffectiveConfig,
  validateProvider,
} from "./configuration.ts";
import { TableRegistrations } from "./registrations.ts";
import type { WorkerConfig } from "./config.ts";
import {
  HeartbeatClock,
  HEARTBEAT_SWEEP_INTERVAL_MS,
  MILLISECONDS_PER_SECOND,
} from "./heartbeat.ts";
import {
  readAllLive,
  endRegistration,
  endGroup,
  readRow,
} from "./instances.ts";

const NONE = 0;
const LAST_PROVIDER = 1;
const HEALTH_PAGE_SIZE = 100;

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
      WorkerErrorCode.AgentNotFound,
      "Agent not found.",
      { agentName },
    );
}

function requireEnablement(tx: Transaction, agentName: string): EnablementRow {
  const row = getEnablement(tx, agentName);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      WorkerErrorCode.NotFound,
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
      WorkerErrorCode.RevisionConflict,
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
export interface Dependencies {
  config: WorkerConfig;
  store: Store;
  workerBindingOf: WorkerBindingOf;
  monotonicNow?: () => number;
  schedulerClaims: SchedulerClaims;
  custodySuitability: CustodySuitability;
  credentialMetadata: CredentialMetadataFn;
  entriesOfAgent: EntriesOfAgent;
  modelListCheck: ModelListCheckFn;
  health?: HealthRegistry;
  registrations?: WorkerRegistrations;
}
export class WorkerService implements Service {
  readonly registrations: WorkerRegistrations;
  readonly heartbeatClock: HeartbeatClock;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.heartbeatClock = new HeartbeatClock(dependencies.monotonicNow);
    this.registrations =
      dependencies.registrations ??
      new TableRegistrations(
        dependencies.store,
        dependencies.workerBindingOf,
        this.heartbeatClock,
      );
    dependencies.health?.register("worker", () => this.healthcheck());
  }
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "worker.lifecycle.stopped",
          "worker: a stopped service cannot start again.",
        ),
      );
    if (!this.startTask) {
      const live = this.dependencies.store.transaction(readAllLive);
      for (let index = 0; index < live.length; index++)
        this.heartbeatClock.set(live[index]!.runtimeIdentity);
      this.startTask = Promise.resolve(null);
    }
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
    void this.quiesce();
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= Promise.resolve(null);
    return this.stopTask;
  }
  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      this.heartbeatTimer ??= setInterval(
        () => this.sweepRegistrations(),
        HEARTBEAT_SWEEP_INTERVAL_MS,
      ).unref();
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      registrations:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  sweepRegistrations(): void {
    const expired = this.heartbeatClock.expired(
      this.dependencies.config.heartbeatWindow,
    );
    const ended = this.dependencies.store.transaction((tx) => {
      const now = Date.now();
      assert.ok(tx.database.isTransaction);
      assert.ok(Number.isSafeInteger(now));
      for (let index = 0; index < expired.length; index++)
        endRegistration(tx, expired[index]!, now);
      return this.heartbeatClock
        .identities()
        .filter((identity) => readRow(tx, identity)?.endedAt !== null);
    });
    for (let index = 0; index < ended.length; index++)
      this.heartbeatClock.drop(ended[index]!);
  }

  endRegistrations(
    tx: Transaction,
    projectId: string,
    resourceIdentity: string,
    now: number,
  ): void {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    endGroup(tx, projectId, resourceIdentity, now);
  }

  instanceHealthcheck(tx: Transaction, runtimeIdentity: string): boolean {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    const registration = this.registrations.liveRegistrationOf(
      tx,
      runtimeIdentity,
    );
    if (!registration) return false;
    const binding = this.dependencies.workerBindingOf(
      tx,
      registration.projectId,
      registration.resourceIdentity,
    );
    if (!binding || binding.tombstone || binding.instanceCount === NONE)
      return false;
    const declaration = getWorkerDeclaration(binding.workerName);
    assert.ok(declaration);
    if (declaration.host === WorkerHost.ExternalHarness) return true;
    const agents = agentsOfWorker(binding.workerName);
    assert.ok(agents.length > NONE);
    for (let index = 0; index < agents.length; index++) {
      const agent = agents[index]!;
      const entry = binding.entries.find((item) => item.agent === agent);
      const view = this.workerAgentView(
        tx,
        binding.workerName,
        agent,
        entry ?? null,
      );
      assert.ok(view);
      if (!view.valid) return false;
    }
    return true;
  }

  registrationChecks(tx: Transaction): Array<{
    projectId: string;
    resourceIdentity: string;
    runtimeIdentity: string;
    capability: typeof REGISTRATION_CAPABILITY;
    check: ResourceCheck;
  }> {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    return readAllLive(tx).map(
      ({ projectId, resourceIdentity, runtimeIdentity }) => ({
        projectId,
        resourceIdentity,
        runtimeIdentity,
        capability: REGISTRATION_CAPABILITY,
        check: async (context) => {
          throwIfCancelled(context);
          const window = this.dependencies.config.heartbeatWindow;
          assert.ok(Number.isSafeInteger(window) && window > NONE);
          assert.ok(runtimeIdentity);
          const age = this.heartbeatClock.ageMs(runtimeIdentity);
          return age !== null && age <= window * MILLISECONDS_PER_SECOND
            ? ResourceStatus.Healthy
            : ResourceStatus.Unhealthy;
        },
      }),
    );
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
    if (bindings.length > NONE)
      throw conflict(agentName, WorkerErrorCode.InvalidatesBindings, {
        bindings,
      });
  }

  private putEnablement(
    tx: Transaction,
    agentName: string,
    body: (typeof workerOperations)["agent.enablement.put"]["input"]["_output"]["body"],
  ) {
    requireAgent(agentName);
    checkRevision(tx, agentName, body.expectedRevision);
    const current = getEnablement(tx, agentName);
    const { agentProviders, defaultConfiguration } = body;
    if (agentProviders.length === NONE)
      throw configurationError(agentName, WorkerErrorCode.ProviderRequired);
    const names = new Set(agentProviders.map(({ name }) => name));
    if (names.size !== agentProviders.length)
      throw conflict(agentName, WorkerErrorCode.ProviderNameConflict);
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
      throw conflict(agentName, WorkerErrorCode.ProviderFixed);
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
    if (bindings.length > NONE)
      throw conflict(agentName, WorkerErrorCode.ProviderInUse, { bindings });
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
    if (bindings.length > NONE)
      throw conflict(agentName, WorkerErrorCode.InUse, { bindings });
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
    body: (typeof workerOperations)["agent.enablement.provider.add"]["input"]["_output"]["body"],
  ) {
    const current = currentRevision(tx, agentName, body.expectedRevision);
    const { name, provider, credential } = body;
    if (current.agentProviders.some((item) => item.name === name))
      throw conflict(agentName, WorkerErrorCode.ProviderNameConflict);
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
      throw configurationError(agentName, WorkerErrorCode.ProviderNotFound);
    if (current.agentProviders.length === LAST_PROVIDER)
      throw configurationError(agentName, WorkerErrorCode.ProviderRequired);
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
    if (dependents.length > NONE)
      throw conflict(agentName, WorkerErrorCode.ProviderInUse, { dependents });
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
    workerName: string,
    entry: WorkerEntry | null,
  ): void {
    if (!getWorkerDeclaration(workerName))
      throw configurationError(
        workerName,
        WorkerErrorCode.InvalidConfiguration,
      );
    const agents = agentsOfWorker(workerName);
    if (agents.length === NONE && entry !== null)
      throw configurationError(
        workerName,
        WorkerErrorCode.InvalidConfiguration,
      );
    for (const agentName of agents) {
      const current = getEnablement(tx, agentName);
      if (!current || current.state === EnablementState.Disabled)
        throw configurationError(agentName, WorkerErrorCode.Unavailable);
      this.validateEntryForm(agentName, entry);
      this.validateEffectiveConfig(
        tx,
        agentName,
        current.agentProviders,
        effectiveConfiguration(current.defaultConfiguration, entry),
      );
    }
  }

  private validateEntryForm(
    agentName: string,
    entry: WorkerEntry | null,
  ): void {
    if (entry === null) return;
    const declaration = getAgentDeclaration(agentName);
    assert.ok(declaration);
    if (
      Object.keys(entry).some(
        (key) => !declaration.overridableFields.includes(key),
      )
    )
      throw configurationError(agentName, WorkerErrorCode.OverrideNotAllowed);
    if (
      Object.keys(entry).length === NONE ||
      (entry.agentProvider !== undefined &&
        (entry.modelIdentifier === undefined ||
          entry.reasoningEffort === undefined))
    )
      throw configurationError(agentName, WorkerErrorCode.InvalidConfiguration);
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
            capability: AGENT_PROVIDER_CAPABILITY,
            check: this.dependencies.modelListCheck(tx, item.credential),
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

  workerAgentsOf(workerName: string): string[] {
    return agentsOfWorker(workerName);
  }

  workerAgentView(
    tx: Transaction,
    workerName: string,
    agentName: string,
    entry: WorkerEntry | null,
  ): WorkerAgentView | null {
    if (
      !getWorkerDeclaration(workerName) ||
      !getAgentDeclaration(agentName) ||
      !agentsOfWorker(workerName).includes(agentName)
    )
      return null;
    const current = getEnablement(tx, agentName);
    if (!current || current.state === EnablementState.Disabled)
      return {
        defaults: null,
        effective: null,
        valid: false,
        issues: [{ path: [], code: WorkerErrorCode.Unavailable }],
      };
    const defaults = current.defaultConfiguration;
    const config = effectiveConfiguration(defaults, entry);
    const issues = configurationIssues(
      this.dependencies,
      tx,
      agentName,
      current.agentProviders,
      config,
    );
    if (issues.length > NONE)
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

  private declareEnablements(registry: OperationRegistry): void {
    registry.register(
      workerOperations["agent.enablement.list"],
      ({ query }, caller) =>
        caller.commit((tx) => {
          const page = listEnablements(tx, query.limit, query.cursor ?? null);
          return {
            items: page.items.map(wireRecord),
            nextCursor: page.nextCursor,
          };
        }),
    );
    registry.register(
      workerOperations["agent.enablement.get"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          wireRecord(requireEnablement(tx, params.agentName)),
        ),
    );
    registry.register(
      workerOperations["agent.enablement.put"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.putEnablement(tx, params.agentName, body)),
    );
    registry.register(
      workerOperations["agent.enablement.enable"],
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
      workerOperations["agent.enablement.disable"],
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
      workerOperations["agent.enablement.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          this.removeEnablement(tx, params.agentName, body.expectedRevision),
        ),
    );
    registry.register(
      workerOperations["agent.enablement.provider.add"],
      ({ params, body }, caller) =>
        caller.commit((tx) => this.addProvider(tx, params.agentName, body)),
    );
    registry.register(
      workerOperations["agent.enablement.provider.remove"],
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
  }

  declarationOf(workerName: string): WorkerDeclaration | null {
    const declaration = getWorkerDeclaration(workerName) ?? null;
    assert.ok(declaration === null || declaration.name === workerName);
    assert.ok(
      declaration === null || declaration.resourceBudget.wallTimeMs > NONE,
    );
    return declaration;
  }

  private declareCatalog(registry: OperationRegistry): void {
    assert.equal(workerOperations["catalog.list"].access, AccessPolicy.Human);
    assert.equal(workerOperations["catalog.get"].mutation, false);
    registry.register(workerOperations["catalog.list"], ({ query }, caller) =>
      caller.commit(() =>
        listWorkerDeclarations(query.limit, query.cursor ?? null),
      ),
    );
    registry.register(workerOperations["catalog.get"], ({ params }, caller) =>
      caller.commit(() => {
        const declaration = this.declarationOf(params.workerName);
        if (declaration === null)
          throw new OperationError(
            HttpStatus.NotFound,
            WorkerErrorCode.CatalogNotFound,
            "Worker not found.",
          );
        return workerOperations["catalog.get"].output.parse(declaration);
      }),
    );
  }

  private declareDeregister(registry: OperationRegistry): void {
    assert.equal(
      workerOperations["instance.deregister"].access,
      AccessPolicy.Client,
    );
    assert.equal(
      workerOperations["instance.deregister"].requiresRegistration,
      false,
    );
    registry.register(
      workerOperations["instance.deregister"],
      ({ params }, caller) => {
        const identity = caller.identity;
        assert.ok(isMachineIdentity(identity));
        const { runtimeIdentity } = params;
        const result = caller.commit((tx) => {
          const now = Date.now();
          const row = this.registrations.liveRegistrationOf(
            tx,
            runtimeIdentity,
          );
          if (
            !row ||
            row.clientId !== identity.clientId ||
            row.projectId !== identity.projectId ||
            row.resourceIdentity !== identity.resourceIdentity
          )
            throw new OperationError(
              HttpStatus.NotFound,
              WorkerErrorCode.InstanceNotFound,
              "Instance not found.",
            );
          this.registrations.deregister(tx, runtimeIdentity, now);
          return { runtimeIdentity, registered: false as const };
        });
        this.heartbeatClock.drop(runtimeIdentity);
        return result;
      },
    );
  }

  declare(registry: OperationRegistry): void {
    this.declareDeregister(registry);
    registry.register(workerOperations.heartbeat, (_input, caller) =>
      caller.commit(() => null),
    );
    this.declareCatalog(registry);
    this.declareEnablements(registry);
    const worker = this.registrations;
    assert.equal(workerOperations.register.service, WORKER_SERVICE_NAME);
    assert.equal(workerOperations.register.access, AccessPolicy.Client);
    registry.register(
      {
        ...workerOperations.register,
        replayGuard: (recorded, identity) => {
          if (!isMachineIdentity(identity)) return false;
          const result = workerOperations.register.output.safeParse(recorded);
          return (
            result.success &&
            worker.findByClient(identity.clientId)?.runtimeIdentity ===
              result.data.runtimeIdentity
          );
        },
      },
      (_input, caller) => {
        const identity = caller.identity;
        if (!isMachineIdentity(identity))
          throw new OperationError(
            HttpStatus.Unauthorized,
            "gateway.authentication.unauthorized",
            "Authentication required.",
          );
        const result = caller.commit((transaction) => {
          const registration = worker.register(
            transaction,
            identity,
            Date.now(),
          );
          assert.equal(registration.clientId, identity.clientId);
          assert.equal(registration.name, identity.name);
          assert.equal(registration.projectId, identity.projectId);
          assert.equal(
            registration.resourceIdentity,
            identity.resourceIdentity,
          );
          const runtimeIdentity = registration.runtimeIdentity;
          assert.ok(
            runtimeIdentity,
            "Registration must return a runtime identity.",
          );
          return { runtimeIdentity };
        });
        this.heartbeatClock.set(result.runtimeIdentity);
        return result;
      },
    );
  }
}
