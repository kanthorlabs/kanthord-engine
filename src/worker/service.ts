import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { asError, Diagnostic } from "../kernel/errors.ts";
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
import type { Logger } from "pino";
import { isMachineIdentity } from "../kernel/caller.ts";
import { AccessPolicy } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  workerOperations,
  WORKER_SERVICE_NAME,
  REGISTRATION_CAPABILITY,
  REGISTRATION_TARGET_KIND,
  WorkerHost,
  InstanceActivity,
  InstancePlacement,
  type WorkerRegistrations,
  type WorkerBindingOf,
  type WorkerBindingsOf,
  type WorkerBindingRowOf,
  type PoolHost,
  type RepositoryPolicyOf,
  type RepositoryBindingIdsOf,
  type IntentOf,
  type PinnedCredentialMetadataFn,
  type CredentialMetadataOf,
  type SchedulerClaims,
  type CustodyHandover,
  type MissionActions,
  type IntakeActions,
  type EvidenceRequests,
  type AgentConfiguration,
  type WorkerEntry,
  type WorkerAgentView,
  WorkerErrorCode,
} from "./contract.ts";
import { AgentErrorCode, type ApprovedModelsFn } from "../agent/contract.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { ActionPerformer } from "./action-performer.ts";
import { executionSetup } from "./execution-setup.ts";
import { clearedChangeRequests } from "./change-request.ts";
import { authorizeModelInference } from "./authorization.ts";
import { agentChoice, agentSelectionsAt } from "./agent-selection.ts";
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
import { instanceRecord, listInstanceRecords } from "./instance-record.ts";
import type { ResolvedLayer } from "../agent/prompt-layers.ts";
import type { PromptTemplates } from "../agent/contract.ts";
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
  missionActions: MissionActions;
  intakeActions: IntakeActions;
  evidenceRequests: EvidenceRequests;
  custodyHandover: CustodyHandover;
  config: WorkerConfig;
  agentPrompt: {
    compose(agentName: string, context: Context): Promise<ResolvedLayer[]>;
    templates(context: Context): Promise<PromptTemplates>;
  };
  store: Store;
  workerBindingOf: WorkerBindingOf;
  workerBindingRowOf: WorkerBindingRowOf;
  repositoryPolicyOf: RepositoryPolicyOf;
  repositoryBindingIdsOf: RepositoryBindingIdsOf;
  intentOf: IntentOf;
  pinnedCredentialMetadata: PinnedCredentialMetadataFn;
  credentialMetadata: CredentialMetadataOf;
  monotonicNow?: () => number;
  schedulerClaims: SchedulerClaims;
  agentConfiguration: AgentConfiguration;
  health?: HealthRegistry;
  registrations?: WorkerRegistrations;
  pool?: {
    host: PoolHost;
    workerBindingsOf: WorkerBindingsOf;
    logger: Logger;
  };
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
  agentChoice(tx: Transaction, workerBindingId: string): AgentChoice {
    return agentChoice(this.dependencies, this, tx, workerBindingId);
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
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
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
        this.heartbeatClock.set(live[index]!.runtime_identity);
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
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
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
      await this.shutdown.done();
      return (await this.stop()) ?? this.runError ?? context.err();
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

  startPool(): void {
    if (!this.pool || this.poolStarted) return;
    this.poolStarted = true;
    this.reconcile(null, true);
  }

  async stopPool(): Promise<void> {
    this.poolStarted = false;
    await this.dependencies.pool?.host.stop();
  }

  bindingsChanged(projectId: string): void {
    if (!this.poolStarted) return;
    setImmediate(() => {
      if (!this.poolStarted) return;
      try {
        this.reconcile(projectId, false);
      } catch (error) {
        this.dependencies.pool?.logger.error(
          { err: asError(error), project_id: projectId },
          "worker.pool.reconcile_failed",
        );
      }
    });
  }

  private reconcile(projectId: string | null, restore: boolean): void {
    const pool = this.pool!;
    const effects = this.dependencies.store.transaction((tx) => {
      const now = Date.now();
      const targets = this.dependencies
        .pool!.workerBindingsOf(tx, projectId)
        .filter(({ placement }) => placement === InstancePlacement.Server)
        .map((binding) => ({
          project_id: binding.project_id,
          resource_identity: binding.resource_identity,
          generation: binding.generation,
          count: binding.instance_count,
        }));
      return pool.reconcile(
        projectId,
        targets,
        {
          busy: (clientId) => {
            const registration = this.registrations.findByClient(clientId);
            return (
              registration !== undefined &&
              this.dependencies.schedulerClaims.activityOf(
                tx,
                registration.runtime_identity,
                now,
              ).activity === InstanceActivity.Executing
            );
          },
          live: (clientId) =>
            this.registrations.findByClient(clientId) !== undefined,
        },
        restore,
      );
    });
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

  instanceHealthcheck(tx: Transaction, runtimeIdentity: string): boolean {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.dependencies.store.database);
    const registration = this.registrations.liveRegistrationOf(
      tx,
      runtimeIdentity,
    );
    if (!registration || this.pool?.draining(registration.client_id))
      return false;
    const binding = this.dependencies.workerBindingOf(
      tx,
      registration.project_id,
      registration.resource_identity,
    );
    if (!binding || binding.tombstone || binding.instance_count === NO_ITEMS)
      return false;
    const declaration = getWorkerDeclaration(binding.worker_name);
    assert.ok(declaration);
    if (declaration.host === WorkerHost.ExternalHarness) return true;
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
        throwIfCancelled(context);
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
  ): void {
    if (!getWorkerDeclaration(workerName))
      throw invalidWorkerConfiguration(workerName);
    const agents = agentsOfWorker(workerName);
    if (agents.length === NO_ITEMS && entry !== null)
      throw invalidWorkerConfiguration(workerName);
    for (const agentName of agents)
      this.dependencies.agentConfiguration.validateEntry(tx, agentName, entry);
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
      draining: (clientId: string) => this.pool?.draining(clientId) ?? false,
    };
  }

  private requirePoolSlot(
    tx: Transaction,
    identity: { clientId: string; projectId: string; resourceIdentity: string },
  ): void {
    const binding = this.dependencies.workerBindingOf(
      tx,
      identity.projectId,
      identity.resourceIdentity,
    );
    if (
      !binding ||
      binding.tombstone ||
      binding.placement !== InstancePlacement.Server ||
      this.pool?.isSlot(
        identity.projectId,
        identity.resourceIdentity,
        binding.generation,
        identity.clientId,
      )
    )
      return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.PlacementMismatch,
      "Worker binding accepts a registration only from a pool slot.",
    );
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
              WorkerErrorCode.InstanceNotFound,
              "Instance not found.",
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

  private declareInstanceReads(registry: OperationRegistry): void {
    assert.equal(workerOperations["instance.list"].mutation, false);
    assert.equal(workerOperations["instance.get"].access, AccessPolicy.Human);
    registry.register(workerOperations["instance.list"], ({ query }, caller) =>
      caller.commit((tx) =>
        listInstanceRecords(tx, this.recordDependencies(), query, Date.now()),
      ),
    );
    registry.register(workerOperations["instance.get"], ({ params }, caller) =>
      caller.commit((tx) => {
        const row = this.registrations.liveRegistrationOf(
          tx,
          params.runtime_identity,
        );
        if (!row)
          throw new OperationError(
            HttpStatus.NotFound,
            WorkerErrorCode.InstanceNotFound,
            "Instance not found.",
          );
        return instanceRecord(tx, this.recordDependencies(), row, Date.now());
      }),
    );
  }

  private declareHandover(registry: OperationRegistry): void {
    registry.register(workerOperations.handover, (_input, caller) => {
      const identity = caller.identity;
      assert(isMachineIdentity(identity));
      const execution = caller.execution;
      assert(execution);
      return caller.commit((tx) =>
        this.dependencies.custodyHandover.handover(
          tx,
          identity,
          execution,
          Date.now(),
        ),
      );
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
    this.declareHandover(registry);
    this.declareInstanceReads(registry);
    this.declareDeregister(registry);
    registry.register(
      workerOperations["instance.resume"],
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
          this.requirePoolSlot(transaction, identity);
          const registration = worker.register(
            transaction,
            {
              client_id: identity.clientId,
              name: identity.name,
              resource_identity: identity.resourceIdentity,
              project_id: identity.projectId,
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
