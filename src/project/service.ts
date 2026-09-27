import assert from "node:assert/strict";
import { isHumanIdentity, IdentityKind } from "../kernel/caller.ts";
import type { Store } from "../kernel/store.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import {
  BindingKind,
  INSTANCE_COUNT_MIN,
  projectOperations,
  workerConfigSchema,
  type ProjectBindings,
  type CreateMission,
  type LiveNodesPinning,
  type ValidateEntry,
  type CustodySuitability,
  type RepositoryConnector,
  type WorkerAgentsOfFn,
  type WorkerAgentViewFn,
} from "./contract.ts";
import {
  insertProject,
  listProjects,
  requireProject,
  renameProject,
  readBindingRevision,
  readLatestBinding,
  kindOf,
} from "./store.ts";
export interface Dependencies {
  config: Record<string, never>;
  operationalStore: Store;
  createMission: CreateMission;
  liveNodesPinning: LiveNodesPinning;
  validateEntry: ValidateEntry;
  custodySuitability: CustodySuitability;
  repositoryConnector: RepositoryConnector;
  workerAgentsOf: WorkerAgentsOfFn;
  workerAgentView: WorkerAgentViewFn;
  health?: HealthRegistry;
  bindings?: ProjectBindings;
}
export class ProjectService implements Service, ProjectBindings {
  private readonly bindings?: ProjectBindings;
  private readonly operationalStore: Store;
  private readonly createMission: CreateMission;
  private readonly liveNodesPinning: LiveNodesPinning;
  private readonly validateEntry: ValidateEntry;
  private readonly custodySuitability: CustodySuitability;
  private readonly repositoryConnector: RepositoryConnector;
  private readonly workerAgentsOf: WorkerAgentsOfFn;
  private readonly workerAgentView: WorkerAgentViewFn;
  constructor(dependencies: Dependencies) {
    this.bindings = dependencies.bindings;
    this.operationalStore = dependencies.operationalStore;
    this.createMission = dependencies.createMission;
    this.liveNodesPinning = dependencies.liveNodesPinning;
    this.validateEntry = dependencies.validateEntry;
    this.custodySuitability = dependencies.custodySuitability;
    this.repositoryConnector = dependencies.repositoryConnector;
    this.workerAgentsOf = dependencies.workerAgentsOf;
    this.workerAgentView = dependencies.workerAgentView;
    dependencies.health?.register("project", () => this.healthcheck());
  }
  declare(registry: OperationRegistry): void {
    registry.register(projectOperations.create, ({ body }, caller) =>
      caller.commit((tx) => {
        const identity = caller.identity;
        assert.ok(
          isHumanIdentity(identity),
          "Project creation requires a human identity.",
        );
        assert.ok(
          tx.database.isTransaction,
          "Mission creation must share the project transaction.",
        );
        const project = insertProject(tx, body.name);
        this.createMission(tx, project.id, {
          kind: IdentityKind.Human,
          account: identity.accountId,
          name: identity.name,
        });
        return project;
      }),
    );
    registry.register(projectOperations.list, ({ query }, caller) =>
      caller.commit((tx) => listProjects(tx, query)),
    );
    registry.register(projectOperations.get, ({ params }, caller) =>
      caller.commit((tx) => requireProject(tx, params.projectId)),
    );
    registry.register(projectOperations.rename, ({ params, body }, caller) =>
      caller.commit((tx) => renameProject(tx, params.projectId, body.name)),
    );
  }
  async resolveWorkerBinding(bindingId: string, context: Context) {
    throwIfCancelled(context);
    if (this.bindings)
      return this.bindings.resolveWorkerBinding(bindingId, context);
    return this.operationalStore.transaction((tx) => {
      const row = readBindingRevision(tx, bindingId);
      if (!row || row.removedAt !== null) return null;
      if (kindOf(row.resourceIdentity) !== BindingKind.Worker) return null;
      const latest = readLatestBinding(tx, row.projectId, row.resourceIdentity);
      assert.ok(latest, "A retained binding must have a latest revision.");
      assert.ok(
        latest.revision >= row.revision,
        "Latest revision cannot precede the pinned revision.",
      );
      if (latest.removedAt !== null) return null;
      const config = workerConfigSchema.parse(latest.config);
      if (config.instanceCount === INSTANCE_COUNT_MIN) return null;
      return { workerBindingId: row.id, projectId: row.projectId };
    });
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
          "project.lifecycle.stopped",
          "project: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
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
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      bindings:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
