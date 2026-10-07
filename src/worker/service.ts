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
  type WorkerRegistrations,
  type WorkerBindingOf,
  type WorkerBindingRowOf,
  type RepositoryPolicyOf,
  type RepositoryBindingIdsOf,
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
import { authorizeModelInference } from "./authorization.ts";
import {
  agentsOfWorker,
  getWorkerDeclaration,
  listWorkerDeclarations,
  type WorkerDeclaration,
} from "./catalog.ts";
import { resumeRegistration, TableRegistrations } from "./registrations.ts";
import { instanceRecord, listInstanceRecords } from "./instance-record.ts";
import type { ResolvedLayer } from "../agent/prompt-layers.ts";
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
    { agentName: workerName },
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
  };
  store: Store;
  workerBindingOf: WorkerBindingOf;
  workerBindingRowOf: WorkerBindingRowOf;
  repositoryPolicyOf: RepositoryPolicyOf;
  repositoryBindingIdsOf: RepositoryBindingIdsOf;
  pinnedCredentialMetadata: PinnedCredentialMetadataFn;
  credentialMetadata: CredentialMetadataOf;
  monotonicNow?: () => number;
  schedulerClaims: SchedulerClaims;
  agentConfiguration: AgentConfiguration;
  health?: HealthRegistry;
  registrations?: WorkerRegistrations;
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
  readonly registrations: WorkerRegistrations;
  readonly heartbeatClock: HeartbeatClock;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private quiesced = false;
  private runError: Error | null = null;
  private readonly dependencies: Dependencies;
  private readonly performer: ActionPerformer;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.performer = new ActionPerformer(dependencies);
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
    if (!binding || binding.tombstone || binding.instanceCount === NO_ITEMS)
      return false;
    const declaration = getWorkerDeclaration(binding.workerName);
    assert.ok(declaration);
    if (declaration.host === WorkerHost.ExternalHarness) return true;
    const agents = agentsOfWorker(binding.workerName);
    assert.ok(agents.length > NO_ITEMS);
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
          assert.ok(Number.isSafeInteger(window) && window > NO_ITEMS);
          assert.ok(runtimeIdentity);
          const age = this.heartbeatClock.ageMs(runtimeIdentity);
          return age !== null && age <= window * MILLISECONDS_PER_SECOND
            ? ResourceStatus.Healthy
            : ResourceStatus.Unhealthy;
        },
      }),
    );
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
        project: binding.projectName,
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
      declaration === null || declaration.resourceBudget.wallTimeMs > NO_ITEMS,
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

  private declareInstanceReads(registry: OperationRegistry): void {
    assert.equal(workerOperations["instance.list"].mutation, false);
    assert.equal(workerOperations["instance.get"].access, AccessPolicy.Human);
    registry.register(workerOperations["instance.list"], ({ query }, caller) =>
      caller.commit((tx) =>
        listInstanceRecords(tx, this.dependencies, query, Date.now()),
      ),
    );
    registry.register(workerOperations["instance.get"], ({ params }, caller) =>
      caller.commit((tx) => {
        const row = this.registrations.liveRegistrationOf(
          tx,
          params.runtimeIdentity,
        );
        if (!row)
          throw new OperationError(
            HttpStatus.NotFound,
            WorkerErrorCode.InstanceNotFound,
            "Instance not found.",
          );
        return instanceRecord(tx, this.dependencies, row, Date.now());
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
    this.declareHandover(registry);
    this.declareInstanceReads(registry);
    this.declareDeregister(registry);
    registry.register(
      workerOperations["instance.resume"],
      ({ params }, caller) => {
        const { runtimeIdentity } = params;
        let reopened = false;
        const result = caller.commit((tx) => {
          reopened = resumeRegistration(
            tx,
            runtimeIdentity,
            Date.now(),
            this.dependencies.schedulerClaims,
            this.dependencies.workerBindingOf,
          );
          return { runtimeIdentity, registered: true as const };
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
          return {
            runtimeIdentity,
            resourceIdentity: identity.resourceIdentity,
            workerName: registration.workerName,
          };
        });
        this.heartbeatClock.set(result.runtimeIdentity);
        return result;
      },
    );
  }
}
