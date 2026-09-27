import assert from "node:assert/strict";
import { isHumanIdentity, IdentityKind } from "../kernel/caller.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import {
  BindingKind,
  BindingState,
  EMPTY_LENGTH,
  INSTANCE_COUNT_MIN,
  INSTANCE_COUNT_MAX,
  LS_REMOTE_TIMEOUT_MS,
  PROJECT_PROMPT_MAX_BYTES,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
  STORAGE_PLATFORM,
  WorkerField,
  bindingEditSchema,
  bindingSetWriteInputSchema,
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
  deriveResourceIdentity,
  listBindings,
  listRevisions,
  readCurrentBindingSet,
  writeBindingSet,
  type StoredBinding,
} from "./store.ts";

const SSH_UNREACHABLE_STATUS = 422;
const UTF8_ENCODING = "utf8";
type BindingEdit = typeof bindingEditSchema._output;
type BindingSetWrite = typeof bindingSetWriteInputSchema._output;

function bindingRecord(binding: StoredBinding) {
  return { ...binding, kind: kindOf(binding.resourceIdentity) };
}

function requireBinding(tx: Transaction, projectId: string, bindingId: string) {
  const binding = readBindingRevision(tx, bindingId);
  if (!binding || binding.projectId !== projectId)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
      "Binding not found.",
    );
  return binding;
}

function uniqueSubmission(bindings: BindingSetWrite["bindings"]) {
  const submission = new Map(Object.entries(bindings));
  const identities = new Set<string>();
  for (const [name, binding] of submission) {
    const identity = deriveResourceIdentity(binding.kind, name, binding.config);
    if (identities.has(identity))
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.DuplicateResource,
        "Submitted bindings must identify distinct resources.",
      );
    identities.add(identity);
  }
  assert.equal(submission.size, identities.size);
  assert.equal(submission.size, Object.keys(bindings).length);
  return submission;
}

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
    registry.register(
      projectOperations["bindingSet.write"],
      ({ params, body }, caller) =>
        this.writeBindings(params.projectId, body, caller),
    );
    this.declareBindingReads(registry);
  }
  private declareBindingReads(registry: OperationRegistry): void {
    registry.register(
      projectOperations["bindingSet.get"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          const project = requireProject(tx, params.projectId);
          const bindings = Object.fromEntries(
            Array.from(
              readCurrentBindingSet(tx, project.id),
              ([name, binding]) => [
                name,
                bindingEditSchema.parse({
                  kind: kindOf(binding.resourceIdentity),
                  config: binding.config,
                }),
              ],
            ),
          );
          return { version: project.bindingSetVersion, bindings };
        }),
    );
    registry.register(
      projectOperations["binding.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => {
          requireProject(tx, params.projectId);
          const page = listBindings(tx, params.projectId, {
            ...query,
            state: query.state ?? BindingState.Current,
          });
          return { ...page, items: page.items.map(bindingRecord) };
        }),
    );
    registry.register(projectOperations["binding.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        bindingRecord(requireBinding(tx, params.projectId, params.bindingId)),
      ),
    );
    registry.register(
      projectOperations["bindingRevision.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => {
          requireBinding(tx, params.projectId, params.bindingId);
          const page = listRevisions(tx, params.bindingId, query);
          return { ...page, items: page.items.map(bindingRecord) };
        }),
    );
  }
  private async writeBindings(
    projectId: string,
    body: BindingSetWrite,
    caller: CallerContext,
  ) {
    const submission = uniqueSubmission(body.bindings);
    for (const binding of submission.values()) {
      if (binding.kind !== BindingKind.Repository) continue;
      await this.checkRepository(binding.config.address, caller.context);
    }
    throwIfCancelled(caller.context);
    return caller.commit((tx) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(submission.size, Object.keys(body.bindings).length);
      for (const [name, binding] of submission)
        this.validateBinding(tx, name, binding);
      const result = writeBindingSet(tx, projectId, body.version, submission);
      const bindings = Object.fromEntries(
        Array.from(readCurrentBindingSet(tx, projectId), ([name, binding]) => [
          name,
          bindingRecord(binding),
        ]),
      );
      return {
        projectId,
        bindingSetVersion: result.newVersion,
        bindings,
        changes: result.changes,
      };
    });
  }
  private async checkRepository(
    address: string,
    context: Context,
  ): Promise<void> {
    throwIfCancelled(context);
    try {
      await this.repositoryConnector.gitLsRemote(
        address,
        context,
        LS_REMOTE_TIMEOUT_MS,
      );
    } catch {
      throwIfCancelled(context);
      throw new OperationError(
        SSH_UNREACHABLE_STATUS,
        ProjectErrorCode.RepositorySshUnreachable,
        "Repository SSH read failed.",
      );
    }
    throwIfCancelled(context);
  }
  private validateBinding(
    tx: Transaction,
    name: string,
    binding: BindingEdit,
  ): void {
    if (binding.kind === BindingKind.Worker) {
      this.validateWorker(tx, name, binding.config);
      return;
    }
    if (
      binding.kind === BindingKind.Repository &&
      Buffer.byteLength(binding.config.projectPrompt ?? "", UTF8_ENCODING) >
        PROJECT_PROMPT_MAX_BYTES
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryPromptTooLarge,
        "Repository project prompt exceeds the UTF-8 byte limit.",
      );
    this.custodySuitability(tx, {
      credential: binding.config.credential,
      platform:
        binding.kind === BindingKind.Repository
          ? REPOSITORY_PLATFORM
          : STORAGE_PLATFORM,
    });
  }
  private validateWorker(
    tx: Transaction,
    name: string,
    config: typeof workerConfigSchema._output,
  ): void {
    if (
      config.instanceCount < INSTANCE_COUNT_MIN ||
      config.instanceCount > INSTANCE_COUNT_MAX
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerInstanceCountRange,
        "Worker instance count is out of range.",
      );
    const agents = this.workerAgentsOf(config.worker);
    if (agents.length === EMPTY_LENGTH) {
      this.validateEntry(tx, config.worker, null);
      for (const field of [WorkerField.Entries, WorkerField.ResourceBudget]) {
        if (config[field] === undefined) continue;
        throw new OperationError(
          HttpStatus.BadRequest,
          ProjectErrorCode.WorkerFieldForbidden,
          "External workers do not accept native configuration fields.",
          { binding: name, field },
        );
      }
      return;
    }
    const entries = new Map(
      (config.entries ?? []).map(({ agent, ...entry }) => [agent, entry]),
    );
    for (const agent of entries.keys()) {
      if (agents.includes(agent)) continue;
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerAgentUnknown,
        "Entry names an agent not declared by the worker.",
      );
    }
    for (const agent of agents)
      this.validateEntry(tx, config.worker, entries.get(agent) ?? null);
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
