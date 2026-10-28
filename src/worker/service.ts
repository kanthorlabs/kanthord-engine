import { addAbortListener } from "node:events";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import { asError, Diagnostic } from "../kernel/errors.ts";
import {
  type Healthcheck,
  HealthStatus,
  type Service,
} from "../kernel/service.ts";
import {
  type HealthRegistry,
  HealthScope,
  type ResourceCheck,
  type ResourceEntry,
  ResourceStatus,
} from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import assert from "node:assert/strict";
import type { Environment, EnvironmentSource } from "../kernel/devcontainer.ts";
import type { Logger } from "pino";
import { isMachineIdentity } from "../kernel/caller.ts";
import { AccessPolicy } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { PoolPlacement } from "./contract.ts";
import {
  type AgentConfiguration,
  alwaysAvailable,
  type CredentialMetadataOf,
  type CustodyHandover,
  type EvidenceRequests,
  HANDOVER_REFRESH_WAIT_MS,
  type InstanceIssuer,
  InstancePlacement,
  type IntakeActions,
  type IntentOf,
  type MissionActions,
  type PinnedCredentialMetadataFn,
  type PlacementStatus,
  type PoolHost,
  REGISTRATION_CAPABILITY,
  REGISTRATION_TARGET_KIND,
  type RepositoryBindingIdsOf,
  type RepositoryPolicyOf,
  type SchedulerClaims,
  type SshHostKeysOf,
  WORKER_SERVICE_NAME,
  type WorkerAgentView,
  type WorkerBindingOf,
  type WorkerBindingRowOf,
  type WorkerBindingsOf,
  type WorkerEntry,
  WorkerErrorCode,
  WorkerHost,
  workerOperations,
  type WorkerRegistrations,
} from "./contract.ts";
import {
  AgentErrorCode,
  type ApprovedModelsFn,
  type HolderScope,
} from "../agent/contract.ts";
import { bindingHolders } from "../project/contract.ts";
import {
  CredentialRefreshInFlight,
  type HeldCopy,
  type InstanceKey,
  SERVER_HOLDER,
} from "../custody/contract.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { ActionPerformer } from "./action-performer.ts";
import { executionSetup } from "./execution-setup.ts";
import { clearedChangeRequests } from "./change-request.ts";
import { failedChecks } from "./failed-check.ts";
import { authorizeModelInference } from "./authorization.ts";
import { agentChoice, agentSelectionsAt, entryOf } from "./agent-selection.ts";
import type {
  AgentChoice,
  AgentPin,
  AgentSelection,
} from "../scheduler/contract.ts";
import {
  agentsOfWorker,
  getWorkerDeclaration,
  listWorkerDeclarations,
  type WorkerDeclaration,
} from "./catalog.ts";
import { resumeRegistration, TableRegistrations } from "./registrations.ts";
import { Pool } from "./pool.ts";
import {
  instanceDropped,
  listRegistrationRecords,
  registrationRecord,
} from "./registration-record.ts";
import type { PromptPartAnswer, PromptTemplates } from "../agent/contract.ts";
import type { WorkerConfig } from "./config.ts";
import {
  HEARTBEAT_SWEEP_INTERVAL_MS,
  HeartbeatClock,
  MILLISECONDS_PER_SECOND,
} from "./heartbeat.ts";
import {
  endGroup,
  endRegistration,
  readAllLive,
  readRow,
} from "./registration-rows.ts";
import {
  type CopyHealth,
  type LoginSessionEntry,
  NO_CREDENTIAL_VERSION,
} from "../llm/contract.ts";
import { unreportedHealth } from "../llm/copy-health.ts";
import { WorkerInstances } from "./instances.ts";
import {
  readInstanceById,
  readLiveInstance,
  readLiveInstances,
} from "./instance-rows.ts";
import { declareInstances } from "./instance-operations.ts";
import type { AgentPromptFacts } from "./prompt-telemetry.ts";

const NO_ITEMS = 0;

function invalidWorkerConfiguration(workerName: string): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    AgentErrorCode.InvalidConfiguration,
    "Agent configuration is unavailable or invalid.",
    { agent_name: workerName },
  );
}

export interface Dependencies {
  handoverRefreshWaitMs?: number;
  missionActions: MissionActions;
  intakeActions: IntakeActions;
  evidenceRequests: EvidenceRequests;
  custodyHandover: CustodyHandover;
  config: WorkerConfig;
  agentPrompt: {
    compose(agentName: string, context: Context): Promise<PromptPartAnswer[]>;
    templates(context: Context): Promise<PromptTemplates>;
  };
  promptTelemetry: {
    agentPrompted(executionId: string, facts: AgentPromptFacts): void;
  };
  store: Store;
  workerBindingOf: WorkerBindingOf;
  workerBindingsOf: WorkerBindingsOf;
  environmentClaimed(projectId: string, resourceIdentity: string): void;
  environmentDigestOf(
    projectId: string,
    resourceIdentity: string,
  ): string | null;
  environmentOf(
    projectId: string,
    resourceIdentity: string,
  ): { source: EnvironmentSource; document: Environment } | null;
  instanceIssuer: InstanceIssuer;
  workerBindingRowOf: WorkerBindingRowOf;
  repositoryPolicyOf: RepositoryPolicyOf;
  repositoryBindingIdsOf: RepositoryBindingIdsOf;
  intentOf: IntentOf;
  pinnedCredentialMetadata: PinnedCredentialMetadataFn;
  credentialMetadata: CredentialMetadataOf;
  sshHostKeysOf: SshHostKeysOf;
  monotonicNow?: () => number;
  schedulerClaims: SchedulerClaims;
  agentConfiguration: AgentConfiguration;
  instanceCopies?: {
    archiveHeld(tx: Transaction, holder: string, now: number): void;
    heldCopies(tx: Transaction, holder: string): HeldCopy[];
  };
  loginSessionsOf?: (holder: string) => LoginSessionEntry[];
  credentialVersionOf?: (holder: string) => number;
  copyHealthOf?: (holder: string, copy: HeldCopy) => CopyHealth;
  health?: HealthRegistry;
  registrations?: WorkerRegistrations;
  pool?: {
    host: PoolHost;
    workerBindingsOf: WorkerBindingsOf;
    logger: Logger;
  };
}
function instanceOfRegistration(tx: Transaction, runtimeIdentity: string) {
  const instanceId = readRow(tx, runtimeIdentity)?.instance_id;
  return instanceId ? readInstanceById(tx, instanceId) : null;
}

function claimantOf(tx: Transaction, runtimeIdentity: string): string {
  const instance = instanceOfRegistration(tx, runtimeIdentity);
  if (instance?.placement !== InstancePlacement.Worker) return SERVER_HOLDER;
  return instance.name;
}

function refreshInFlight(): OperationError {
  return new OperationError(
    HttpStatus.ServiceUnavailable,
    WorkerErrorCode.HandoverRefreshInFlight,
    "A credential refresh is in flight; retry the handover.",
  );
}

async function settledBefore(
  settled: Promise<void>,
  deadline: number,
  context: Context,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
  });
  try {
    const timedOut = await Promise.race([
      settled.then(() => false),
      expired,
      cancelled(context.signal).then(() => false),
    ]);
    context.signal.throwIfAborted();
    if (timedOut) throw refreshInFlight();
  } finally {
    clearTimeout(timer);
  }
}

export class WorkerService implements Service {
  authorizeModelInference(
    tx: Transaction,
    identity: Parameters<typeof authorizeModelInference>[3],
    execution: Parameters<typeof authorizeModelInference>[4],
  ) {
    return authorizeModelInference(
      this.dependencies,
      this,
      tx,
      identity,
      execution,
    );
  }
  agentChoice(
    tx: Transaction,
    workerBindingId: string,
    runtimeIdentity: string,
  ): AgentChoice {
    return agentChoice(
      this.dependencies,
      this,
      tx,
      workerBindingId,
      this.claimantHolder(tx, runtimeIdentity),
    );
  }
  claimantHolder(tx: Transaction, runtimeIdentity: string): string {
    return claimantOf(tx, runtimeIdentity);
  }
  placementOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): InstancePlacement | null {
    assert.ok(tx.database.isTransaction);
    return instanceOfRegistration(tx, runtimeIdentity)?.placement ?? null;
  }
  bindingsListingInstance(
    tx: Transaction,
    instanceName: string,
    agentNames: readonly string[],
  ): Array<{ binding_id: string; project_id: string }> {
    return this.instances
      .bindingsListing(tx, instanceName)
      .filter((binding) =>
        agentsOfWorker(binding.worker_name).some((agent) =>
          agentNames.includes(agent),
        ),
      )
      .map(({ binding_id, project_id }) => ({ binding_id, project_id }));
  }
  instanceKeyOf(tx: Transaction, name: string): InstanceKey | null {
    const instance = readLiveInstance(tx, name);
    if (!instance?.public_key || !instance.fingerprint) return null;
    return {
      name: instance.name,
      public_key: instance.public_key,
      fingerprint: instance.fingerprint,
    };
  }
  instanceConnected(name: string): boolean {
    return this.instances.connected(name);
  }
  instanceNameOf(tx: Transaction, instanceId: string): string | null {
    const instance = readInstanceById(tx, instanceId);
    return instance?.ended_at === null ? instance.name : null;
  }
  holderMismatch(
    tx: Transaction,
    instanceName: string,
    bindings: ReadonlyArray<{
      worker_name: string;
      entries: Array<WorkerEntry & { agent: string }>;
    }>,
  ): boolean {
    return bindings.some((binding) =>
      agentsOfWorker(binding.worker_name).some((agent) =>
        this.workerAgentView(
          tx,
          binding.worker_name,
          agent,
          entryOf(binding.entries, agent),
          { holders: [instanceName], claimant: null },
        )?.issues.some(
          ({ code }) => code === AgentErrorCode.CredentialHolderMismatch,
        ),
      ),
    );
  }
  agentSelectionsAt(
    tx: Transaction,
    workerBindingId: string,
    pins: readonly AgentPin[],
  ): AgentSelection[] {
    return agentSelectionsAt(this.dependencies, tx, workerBindingId, pins);
  }
  readonly registrations: WorkerRegistrations;
  readonly heartbeatClock: HeartbeatClock;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private quiesced = false;
  private runError: Error | null = null;
  private readonly dependencies: Dependencies;
  private readonly performer: ActionPerformer;
  private readonly pool?: Pool;
  private poolStarted = false;
  readonly instances: WorkerInstances;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.instances = new WorkerInstances({
      store: dependencies.store,
      serverInstanceLimit: dependencies.config.server_instance_limit,
      placementStatus: (placement) => this.placementStatus(placement),
      issuer: dependencies.instanceIssuer,
      workerBindingsOf: dependencies.workerBindingsOf,
      unendedExecutionOf: (tx, runtimeIdentity) =>
        dependencies.schedulerClaims.unendedExecutionOf(tx, runtimeIdentity),
      archiveHeld: (tx, holder, now) =>
        dependencies.instanceCopies?.archiveHeld(tx, holder, now),
      holderMismatch: (tx, instanceName, bindings) =>
        this.holderMismatch(tx, instanceName, bindings),
      loginSessionsOf: (holder) => dependencies.loginSessionsOf?.(holder) ?? [],
      credentialVersionOf: (holder) =>
        dependencies.credentialVersionOf?.(holder) ?? NO_CREDENTIAL_VERSION,
    });
    if (dependencies.pool) this.pool = new Pool(dependencies.pool.host);
    this.performer = new ActionPerformer({
      store: dependencies.store,
      schedulerClaims: dependencies.schedulerClaims,
      missionActions: dependencies.missionActions,
      intakeActions: dependencies.intakeActions,
      evidenceRequests: dependencies.evidenceRequests,
      logger: dependencies.pool?.logger ?? null,
    });
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
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Diagnostic(
          "worker.lifecycle.stopped",
          "worker: a stopped service cannot start again.",
        ),
      );
    if (!this.startTask) {
      const live = this.dependencies.store.transaction(readAllLive);
      for (let index = 0; index < live.length; index++)
        this.heartbeatClock.set(live[index]!.runtime_identity);
      this.dependencies.store.transaction((tx) => this.instances.start(tx));
      this.startTask = Promise.resolve(null);
    }
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    this.quiesced = true;
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
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await this.start();
    if (error) return error;
    if (!this.quiesced)
      this.heartbeatTimer ??= setInterval(() => {
        try {
          this.sweepRegistrations();
        } catch (failure) {
          this.runError = asError(failure);
          void this.stop();
        }
      }, HEARTBEAT_SWEEP_INTERVAL_MS).unref();
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? this.runError ?? reasonOf(context.signal);
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      registrations:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  startPool(): void {
    if (!this.pool || this.poolStarted) return;
    this.poolStarted = true;
    const host = this.dependencies.pool!.host;
    host.prepare();
    void host.sweep(this.liveInstanceNames());
    this.reconcile();
    void this.logUnavailableContainerDriver();
  }

  async placementStatus(
    placement: InstancePlacement,
  ): Promise<PlacementStatus> {
    const host = this.dependencies.pool?.host;
    if (!host || placement !== InstancePlacement.Container)
      return alwaysAvailable(placement);
    return host.placementStatus(placement);
  }

  private liveInstanceNames(): Set<string> {
    return new Set(
      this.dependencies.store
        .transaction((tx) => this.instances.liveServerInstances(tx))
        .map(({ name }) => name),
    );
  }

  private async logUnavailableContainerDriver(): Promise<void> {
    const live = this.dependencies.store
      .transaction((tx) => this.instances.liveServerInstances(tx))
      .some(({ placement }) => placement === InstancePlacement.Container);
    if (!live) return;
    const status = await this.placementStatus(InstancePlacement.Container);
    if (status.available) return;
    this.dependencies.pool!.logger.error(
      {
        placement: status.placement,
        reason: status.reason,
        detail: status.detail,
      },
      "worker.pool.driver_unavailable",
    );
  }

  async stopPool(): Promise<void> {
    this.poolStarted = false;
    await this.dependencies.pool?.host.stop();
  }

  bindingsChanged(projectId: string): void {
    this.dependencies.store.transaction((tx) =>
      this.instances.bindingsChanged(tx, projectId),
    );
    this.scheduleReconcile({ project_id: projectId });
  }

  instancesChanged(): void {
    this.scheduleReconcile({});
  }

  private scheduleReconcile(fields: { project_id?: string }): void {
    if (!this.poolStarted) return;
    setImmediate(() => {
      if (!this.poolStarted) return;
      try {
        this.reconcile();
      } catch (error) {
        this.dependencies.pool?.logger.error(
          { err: asError(error), ...fields },
          "worker.pool.reconcile_failed",
        );
      }
    });
  }

  environmentReady(
    projectId: string,
    resourceIdentity: string,
    tag: string,
  ): void {
    const pool = this.pool;
    if (!pool) return;
    const { host, workerBindingsOf } = this.dependencies.pool!;
    const names = this.dependencies.store.transaction((tx) =>
      workerBindingsOf(tx, projectId)
        .filter((binding) => binding.environment === resourceIdentity)
        .flatMap((binding) => binding.worker_instances ?? []),
    );
    for (const instance of pool.instances())
      if (
        instance.placement === InstancePlacement.Container &&
        names.includes(instance.name) &&
        host.imageOf(instance) !== tag
      )
        pool.restart(instance);
  }

  private reconcile(): void {
    const pool = this.pool!;
    const effects = this.dependencies.store.transaction((tx) =>
      pool.reconcile(
        this.instances.liveServerInstances(tx).map((instance) => ({
          instance: {
            id: instance.id,
            name: instance.name,
            placement: instance.placement as PoolPlacement,
            created_at: instance.created_at,
          },
          entries: this.instances.entriesOf(tx, instance),
        })),
      ),
    );
    pool.execute(effects);
  }

  sweepRegistrations(): void {
    const expired = this.heartbeatClock.expired(
      this.dependencies.config.heartbeat_window,
    );
    const ended = this.dependencies.store.transaction((tx) => {
      const now = Date.now();
      assert.ok(tx.database.isTransaction);
      assert.ok(Number.isSafeInteger(now));
      for (let index = 0; index < expired.length; index++)
        endRegistration(tx, expired[index]!, now);
      return this.heartbeatClock
        .identities()
        .filter((identity) => readRow(tx, identity)?.ended_at !== null);
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

  registrationHealthcheck(tx: Transaction, runtimeIdentity: string): boolean {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    const registration = this.registrations.liveRegistrationOf(
      tx,
      runtimeIdentity,
    );
    if (!registration) return false;
    const binding = this.dependencies.workerBindingOf(
      tx,
      registration.project_id,
      registration.resource_identity,
    );
    if (!binding || binding.tombstone || binding.instance_count === NO_ITEMS)
      return false;
    if (
      instanceDropped(binding, registration, (instanceId) =>
        this.instanceNameOf(tx, instanceId),
      )
    )
      return false;
    const declaration = getWorkerDeclaration(binding.worker_name);
    assert.ok(declaration);
    if (declaration.host === WorkerHost.ExternalHarness) return true;
    const scope = {
      holders: bindingHolders(
        readLiveInstances(tx, binding.worker_instances ?? []),
      ),
      claimant: claimantOf(tx, runtimeIdentity),
    };
    const agents = agentsOfWorker(binding.worker_name);
    assert.ok(agents.length > NO_ITEMS);
    for (let index = 0; index < agents.length; index++) {
      const agent = agents[index]!;
      const entry = binding.entries.find((item) => item.agent === agent);
      const view = this.workerAgentView(
        tx,
        binding.worker_name,
        agent,
        entry ?? null,
        scope,
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
    return readAllLive(tx).map((row) => ({
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      runtimeIdentity: row.runtime_identity,
      capability: REGISTRATION_CAPABILITY,
      check: async (context) => {
        context.signal.throwIfAborted();
        const window = this.dependencies.config.heartbeat_window;
        assert.ok(Number.isSafeInteger(window) && window > NO_ITEMS);
        assert.ok(row.runtime_identity);
        const age = this.heartbeatClock.ageMs(row.runtime_identity);
        return age !== null && age <= window * MILLISECONDS_PER_SECOND
          ? ResourceStatus.Healthy
          : ResourceStatus.Unhealthy;
      },
    }));
  }

  validateEntry(
    tx: Transaction,
    workerName: string,
    entry: WorkerEntry | null,
    holders: readonly string[],
  ): void {
    if (!getWorkerDeclaration(workerName))
      throw invalidWorkerConfiguration(workerName);
    const agents = agentsOfWorker(workerName);
    if (agents.length === NO_ITEMS && entry !== null)
      throw invalidWorkerConfiguration(workerName);
    for (const agentName of agents)
      this.dependencies.agentConfiguration.validateEntry(
        tx,
        agentName,
        entry,
        holders,
      );
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    for (const item of this.registrationChecks(tx)) {
      const binding = this.dependencies.workerBindingOf(
        tx,
        item.projectId,
        item.resourceIdentity,
      );
      assert.ok(binding);
      assert.equal(binding.tombstone, false);
      entries.push({
        scope: HealthScope.Project,
        project: binding.project_name,
        name: `${encodeURIComponent(binding.name)}/${encodeURIComponent(item.runtimeIdentity)}`,
        target: `${REGISTRATION_TARGET_KIND}:${item.runtimeIdentity}`,
        capability: item.capability,
        check: item.check,
      });
    }
    return entries;
  }

  workerAgentsOf(workerName: string): string[] {
    return agentsOfWorker(workerName);
  }

  workerAgentView(
    tx: Transaction,
    workerName: string,
    agentName: string,
    entry: WorkerEntry | null,
    scope: HolderScope,
    approvedModels?: ApprovedModelsFn,
  ): WorkerAgentView | null {
    if (
      !getWorkerDeclaration(workerName) ||
      !agentsOfWorker(workerName).includes(agentName)
    )
      return null;
    return this.dependencies.agentConfiguration.agentView(
      tx,
      agentName,
      entry,
      scope,
      approvedModels,
    );
  }

  pinnedAgentView(
    tx: Transaction,
    workerName: string,
    selection: AgentSelection,
    approvedModels?: ApprovedModelsFn,
  ): Pick<WorkerAgentView, "effective" | "valid" | "issues"> | null {
    if (
      !getWorkerDeclaration(workerName) ||
      !agentsOfWorker(workerName).includes(selection.agent_name)
    )
      return null;
    return this.dependencies.agentConfiguration.selectionView(
      tx,
      selection,
      approvedModels,
    );
  }

  declarationOf(workerName: string): WorkerDeclaration | null {
    const declaration = getWorkerDeclaration(workerName) ?? null;
    assert.ok(declaration === null || declaration.name === workerName);
    assert.ok(
      declaration === null ||
        declaration.resource_budget.wall_time_ms > NO_ITEMS,
    );
    return declaration;
  }

  private recordDependencies() {
    return {
      ...this.dependencies,
      instanceNameOf: (tx: Transaction, instanceId: string) =>
        readInstanceById(tx, instanceId)?.name ?? null,
      instancePlacementOf: (tx: Transaction, instanceId: string) =>
        readInstanceById(tx, instanceId)?.placement ?? null,
    };
  }

  instanceOf(
    tx: Transaction,
    name: string,
  ): { name: string; worker: string; placement: InstancePlacement } | null {
    assert.ok(tx.database.isTransaction);
    const instance = readLiveInstance(tx, name);
    return instance
      ? {
          name: instance.name,
          worker: instance.worker,
          placement: instance.placement,
        }
      : null;
  }

  registrationsOfInstance(tx: Transaction, runtimeIdentity: string): string[] {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    return this.instances.registrationsOfInstance(tx, runtimeIdentity);
  }

  private requireListedInstance(
    tx: Transaction,
    identity: {
      clientId: string;
      projectId: string;
      resourceIdentity: string;
      instanceId?: string;
    },
    binding: NonNullable<ReturnType<WorkerBindingOf>>,
  ): void {
    const instance =
      identity.instanceId === undefined
        ? null
        : readInstanceById(tx, identity.instanceId);
    if (
      instance &&
      instance.ended_at === null &&
      this.dependencies.instanceIssuer.clientIdentity(
        instance.id,
        identity.projectId,
        identity.resourceIdentity,
        binding.generation,
      ) === identity.clientId &&
      ((binding.worker_instances ?? []).includes(instance.name) ||
        this.registrations.findByClient(identity.clientId) !== undefined)
    )
      return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.PlacementMismatch,
      "Worker binding accepts a registration only from a listed worker instance.",
    );
  }

  private requireNativeInstance(
    tx: Transaction,
    identity: {
      clientId: string;
      projectId: string;
      resourceIdentity: string;
      instanceId?: string;
    },
  ): void {
    const binding = this.dependencies.workerBindingOf(
      tx,
      identity.projectId,
      identity.resourceIdentity,
    );
    if (!binding || binding.tombstone) return;
    if (getWorkerDeclaration(binding.worker_name)?.host !== WorkerHost.Kanthord)
      return;
    this.requireListedInstance(tx, identity, binding);
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
        const declaration = this.declarationOf(params.worker_name);
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
      workerOperations["registration.deregister"].access,
      AccessPolicy.Client,
    );
    assert.equal(
      workerOperations["registration.deregister"].requiresRegistration,
      false,
    );
    registry.register(
      workerOperations["registration.deregister"],
      ({ params }, caller) => {
        const identity = caller.identity;
        assert.ok(isMachineIdentity(identity));
        const { runtime_identity: runtimeIdentity } = params;
        const result = caller.commit((tx) => {
          const now = Date.now();
          const row = this.registrations.liveRegistrationOf(
            tx,
            runtimeIdentity,
          );
          if (
            !row ||
            row.client_id !== identity.clientId ||
            row.project_id !== identity.projectId ||
            row.resource_identity !== identity.resourceIdentity
          )
            throw new OperationError(
              HttpStatus.NotFound,
              WorkerErrorCode.RegistrationNotFound,
              "Registration not found.",
            );
          this.registrations.deregister(tx, runtimeIdentity, now);
          return {
            runtime_identity: runtimeIdentity,
            registered: false as const,
          };
        });
        this.heartbeatClock.drop(runtimeIdentity);
        return result;
      },
    );
  }

  private declarePlacementRead(registry: OperationRegistry): void {
    assert.equal(workerOperations["placement.list"].mutation, false);
    registry.register(workerOperations["placement.list"], async () => ({
      items: await Promise.all(
        Object.values(InstancePlacement).map((placement) =>
          this.placementStatus(placement),
        ),
      ),
    }));
  }

  private declareRegistrationReads(registry: OperationRegistry): void {
    assert.equal(workerOperations["registration.list"].mutation, false);
    assert.equal(
      workerOperations["registration.get"].access,
      AccessPolicy.Human,
    );
    registry.register(
      workerOperations["registration.list"],
      ({ query }, caller) =>
        caller.commit((tx) =>
          listRegistrationRecords(
            tx,
            this.recordDependencies(),
            query,
            Date.now(),
          ),
        ),
    );
    registry.register(
      workerOperations["registration.get"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          const row = this.registrations.liveRegistrationOf(
            tx,
            params.runtime_identity,
          );
          if (!row)
            throw new OperationError(
              HttpStatus.NotFound,
              WorkerErrorCode.RegistrationNotFound,
              "Registration not found.",
            );
          return registrationRecord(
            tx,
            this.recordDependencies(),
            row,
            Date.now(),
          );
        }),
    );
  }

  private declareHandover(registry: OperationRegistry): void {
    registry.register(workerOperations.handover, async (_input, caller) => {
      const identity = caller.identity;
      assert(isMachineIdentity(identity));
      const execution = caller.execution;
      assert(execution);
      const deadline =
        Date.now() +
        (this.dependencies.handoverRefreshWaitMs ?? HANDOVER_REFRESH_WAIT_MS);
      while (Date.now() < deadline) {
        try {
          return caller.commit((tx) =>
            this.dependencies.custodyHandover.handover(
              tx,
              identity,
              execution,
              this.placementOf(tx, execution.runtimeIdentity),
              this.dependencies.repositoryBindingIdsOf(
                tx,
                execution.nodeId,
                execution.pinnedRevision,
              ),
              Date.now(),
            ),
          );
        } catch (error) {
          if (!(error instanceof CredentialRefreshInFlight)) throw error;
          await settledBefore(error.settled, deadline, caller.context);
        }
      }
      throw refreshInFlight();
    });
    registry.register(workerOperations.credential, ({ body }, caller) => {
      const identity = caller.identity;
      assert(isMachineIdentity(identity));
      const execution = caller.execution;
      assert(execution);
      return caller.commit((tx) => {
        this.dependencies.custodyHandover.report(
          tx,
          identity,
          execution,
          { nonce: body.nonce, ciphertext: body.ciphertext },
          Date.now(),
        );
        return null;
      });
    });
    registry.register(workerOperations["ssh.sign"], ({ body }, caller) => {
      const identity = caller.identity;
      assert(isMachineIdentity(identity));
      const execution = caller.execution;
      assert(execution);
      return caller.commit((tx) =>
        this.dependencies.custodyHandover.sshSign(
          tx,
          identity,
          execution,
          this.placementOf(tx, execution.runtimeIdentity),
          { nonce: body.nonce, ciphertext: body.ciphertext },
          Date.now(),
        ),
      );
    });
  }

  declare(registry: OperationRegistry): void {
    registry.register(
      workerOperations["execution.setup.get"],
      (_input, caller) => executionSetup(this.dependencies, this, caller),
    );
    registry.register(
      workerOperations["action.request"],
      async (_input, caller) => {
        const identity = caller.identity;
        assert.ok(isMachineIdentity(identity));
        assert.ok(caller.execution);
        const answer = await this.performer.perform(
          { context: caller.context, identity },
          caller.execution,
        );
        return caller.commit(() => answer);
      },
    );
    registry.register(
      workerOperations["execution.change_request.get"],
      async (_input, caller) => {
        const identity = caller.identity;
        assert.ok(isMachineIdentity(identity));
        assert.ok(caller.execution);
        const answer = await clearedChangeRequests(
          this.dependencies,
          {
            context: caller.context,
            identity,
            executionId: caller.execution.executionId,
          },
          caller.execution,
        );
        return caller.commit(() => answer);
      },
    );
    registry.register(
      workerOperations["execution.failed_check.get"],
      async (_input, caller) => {
        const identity = caller.identity;
        assert.ok(isMachineIdentity(identity));
        assert.ok(caller.execution);
        const answer = await failedChecks(
          this.dependencies,
          {
            context: caller.context,
            identity,
            executionId: caller.execution.executionId,
          },
          caller.execution,
        );
        return caller.commit(() => answer);
      },
    );
    this.declareHandover(registry);
    this.declarePlacementRead(registry);
    this.declareRegistrationReads(registry);
    this.declareDeregister(registry);
    registry.register(
      workerOperations["registration.resume"],
      ({ params }, caller) => {
        const { runtime_identity: runtimeIdentity } = params;
        let reopened = false;
        const result = caller.commit((tx) => {
          reopened = resumeRegistration(
            tx,
            runtimeIdentity,
            Date.now(),
            this.dependencies.schedulerClaims,
            this.dependencies.workerBindingOf,
          );
          return {
            runtime_identity: runtimeIdentity,
            registered: true as const,
          };
        });
        if (reopened) this.heartbeatClock.set(runtimeIdentity);
        return result;
      },
    );
    registry.register(workerOperations.heartbeat, (_input, caller) =>
      caller.commit(() => null),
    );
    this.declareCatalog(registry);
    declareInstances(registry, {
      instances: this.instances,
      heartbeatClock: this.heartbeatClock,
      instancesChanged: () => this.instancesChanged(),
      registrationRecordOf: (tx, row) =>
        registrationRecord(tx, this.recordDependencies(), row, Date.now()),
      heldCopies: (tx, holder) =>
        (this.dependencies.instanceCopies?.heldCopies(tx, holder) ?? []).map(
          (copy) => ({
            ...copy,
            health:
              this.dependencies.copyHealthOf?.(holder, copy) ??
              unreportedHealth(copy.platform),
          }),
        ),
    });
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
            worker.findByClient(identity.clientId)?.runtime_identity ===
              result.data.runtime_identity
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
          this.requireNativeInstance(transaction, identity);
          const registration = worker.register(
            transaction,
            {
              client_id: identity.clientId,
              name: identity.name,
              resource_identity: identity.resourceIdentity,
              project_id: identity.projectId,
              instance_id: identity.instanceId ?? null,
            },
            Date.now(),
          );
          assert.equal(registration.client_id, identity.clientId);
          assert.equal(registration.name, identity.name);
          assert.equal(registration.project_id, identity.projectId);
          assert.equal(
            registration.resource_identity,
            identity.resourceIdentity,
          );
          const runtimeIdentity = registration.runtime_identity;
          assert.ok(
            runtimeIdentity,
            "Registration must return a runtime identity.",
          );
          return {
            runtime_identity: runtimeIdentity,
            resource_identity: identity.resourceIdentity,
            worker_name: registration.worker_name,
          };
        });
        this.heartbeatClock.set(result.runtime_identity);
        return result;
      },
    );
  }
}
