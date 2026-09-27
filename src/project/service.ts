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
import {
  HealthScope,
  ResourceStatus,
  type HealthRegistry,
  type ResourceCheck,
  type ResourceEntry,
} from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import {
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  EMPTY_LENGTH,
  LIST_LIMIT_MAX,
  INSTANCE_COUNT_MIN,
  INSTANCE_COUNT_MAX,
  LS_REMOTE_TIMEOUT_MS,
  PROJECT_PROMPT_MAX_BYTES,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  RESOURCE_TARGET_KIND_REPOSITORY,
  STORAGE_PLATFORM,
  WorkerField,
  bindingEditSchema,
  bindingSetWriteInputSchema,
  projectOperations,
  workerConfigSchema,
  type ProjectBindings,
  type AgentDependentBinding,
  type BindingRevision,
  type BindingRevisionResult,
  type CreateMission,
  type LiveNodesPinning,
  type ValidateEntry,
  type CustodySuitability,
  type RepositoryConnector,
  type WorkerAgentsOfFn,
  type WorkerAgentViewFn,
  type WorkerEntry,
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
  readCurrentBindings,
  readCurrentRepositories,
  readCurrentBindingByName,
  readCredentialBindings,
  hasBindingTombstone,
  writeBindingSet,
  type StoredBinding,
} from "./store.ts";

const SSH_UNREACHABLE_STATUS = 422;
const UTF8_ENCODING = "utf8";
const CURSOR_ENCODING = "base64url";
const PAGE_EXTRA = 1;
const FIRST_INDEX = 0;
const LAST_INDEX = 1;
const MINIMUM_LIMIT = 1;
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

function requireWorkerBinding(
  tx: Transaction,
  projectId: string,
  bindingId: string,
) {
  const project = requireProject(tx, projectId);
  const binding = requireBinding(tx, projectId, bindingId);
  if (kindOf(binding.resourceIdentity) !== BindingKind.Worker)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
      "Binding not found.",
    );
  return { project, config: workerConfigSchema.parse(binding.config) };
}

function agentCursor(cursor: string): string {
  const name = Buffer.from(cursor, CURSOR_ENCODING).toString(UTF8_ENCODING);
  if (
    name.length === EMPTY_LENGTH ||
    Buffer.from(name, UTF8_ENCODING).toString(CURSOR_ENCODING) !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.CursorInvalid,
      "Cursor is invalid.",
    );
  return name;
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
    this.declareAgentReads(registry);
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
  private agentItem(
    tx: Transaction,
    project: ReturnType<typeof requireProject>,
    bindingId: string,
    config: typeof workerConfigSchema._output,
    agent: string,
  ) {
    const selected = config.entries?.find((item) => item.agent === agent);
    const entry: WorkerEntry | null = selected
      ? (({ agent: selectedAgent, ...fields }) => {
          assert.equal(selectedAgent, agent);
          return fields;
        })(selected)
      : null;
    const view = this.workerAgentView(tx, config.worker, agent, entry);
    assert.ok(view, "Declared agents must have a worker view.");
    assert.ok(project.bindingSetVersion >= BINDING_SET_INITIAL_VERSION);
    return {
      agent,
      worker: config.worker,
      workerBindingId: bindingId,
      bindingSetVersion: project.bindingSetVersion,
      defaults: view.defaults,
      entry,
      effective: view.effective,
      valid: view.valid,
      issues: view.issues,
    };
  }
  private declareAgentReads(registry: OperationRegistry): void {
    registry.register(
      projectOperations["agentConfiguration.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => {
          const { project, config } = requireWorkerBinding(
            tx,
            params.projectId,
            params.bindingId,
          );
          assert.ok(Number.isInteger(query.limit));
          assert.ok(
            query.limit >= MINIMUM_LIMIT && query.limit <= LIST_LIMIT_MAX,
          );
          const cursor =
            query.cursor === undefined ? null : agentCursor(query.cursor);
          const names = this.workerAgentsOf(config.worker)
            .filter((name) => cursor === null || name > cursor)
            .sort();
          const selected = names.slice(FIRST_INDEX, query.limit + PAGE_EXTRA);
          const page = selected.slice(FIRST_INDEX, query.limit);
          const last = page.at(-LAST_INDEX);
          return {
            items: page.map((name) =>
              this.agentItem(tx, project, params.bindingId, config, name),
            ),
            nextCursor:
              selected.length > query.limit && last
                ? Buffer.from(last, UTF8_ENCODING).toString(CURSOR_ENCODING)
                : null,
          };
        }),
    );
    registry.register(
      projectOperations["agentConfiguration.get"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          const { project, config } = requireWorkerBinding(
            tx,
            params.projectId,
            params.bindingId,
          );
          if (!this.workerAgentsOf(config.worker).includes(params.agentName))
            throw new OperationError(
              HttpStatus.NotFound,
              ProjectErrorCode.BindingNotFound,
              "Binding not found.",
            );
          return this.agentItem(
            tx,
            project,
            params.bindingId,
            config,
            params.agentName,
          );
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
  entriesOfAgent(tx: Transaction, agentName: string): AgentDependentBinding[] {
    assert.ok(tx.database.isTransaction);
    return readCurrentBindings(tx).flatMap(
      (binding): AgentDependentBinding[] => {
        assert.equal(binding.removedAt, null);
        if (kindOf(binding.resourceIdentity) !== BindingKind.Worker) return [];
        const config = workerConfigSchema.parse(binding.config);
        if (!this.workerAgentsOf(config.worker).includes(agentName)) return [];
        const entries = new Map(
          (config.entries ?? []).map(({ agent, ...entry }) => [agent, entry]),
        );
        return [
          {
            bindingId: binding.id,
            workerName: config.worker,
            entry: entries.get(agentName) ?? null,
          },
        ];
      },
    );
  }
  bindingsNaming(tx: Transaction, credentialName: string): BindingRevision[] {
    assert.ok(tx.database.isTransaction);
    const dependents = readCredentialBindings(tx, credentialName)
      .filter(
        ({ binding, current }) =>
          current ||
          this.liveNodesPinning(tx, binding.id).length > EMPTY_LENGTH,
      )
      .map(({ binding }) => ({
        bindingId: binding.id,
        projectId: binding.projectId,
      }));
    assert.equal(
      new Set(dependents.map(({ bindingId }) => bindingId)).size,
      dependents.length,
    );
    return dependents;
  }
  resolveBinding(
    tx: Transaction,
    projectId: string,
    bindingName: string,
  ): { bindingId: string; resourceIdentity: string } | null {
    const binding = readCurrentBindingByName(tx, projectId, bindingName);
    if (!binding) return null;
    assert.equal(binding.removedAt, null);
    assert.equal(binding.projectId, projectId);
    return {
      bindingId: binding.id,
      resourceIdentity: binding.resourceIdentity,
    };
  }
  getBindingRevision(
    tx: Transaction,
    bindingId: string,
  ): BindingRevisionResult | null {
    const binding = readBindingRevision(tx, bindingId);
    if (!binding) return null;
    const latest = readLatestBinding(
      tx,
      binding.projectId,
      binding.resourceIdentity,
    );
    assert.ok(latest, "A retained binding must have a latest revision.");
    assert.ok(latest.revision >= binding.revision);
    const current = bindingEditSchema.parse({
      kind: kindOf(latest.resourceIdentity),
      config: latest.config,
    });
    const disabled =
      current.kind === BindingKind.Worker
        ? current.config.instanceCount === INSTANCE_COUNT_MIN
        : current.config.available === false;
    return {
      bindingId: binding.id,
      name: binding.name,
      resourceIdentity: binding.resourceIdentity,
      revision: binding.revision,
      tombstone: hasBindingTombstone(tx, binding),
      disabled,
    };
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
  resourceInventory(tx: Transaction): ResourceEntry[] {
    return readCurrentRepositories(tx).map(({ projectName, name, address }) => {
      const check: ResourceCheck = async (context) => {
        try {
          const deadline = context.deadline();
          assert.ok(deadline !== null);
          await this.repositoryConnector.gitLsRemote(
            address,
            context,
            deadline - Date.now(),
          );
          return ResourceStatus.Healthy;
        } catch {
          return context.err()
            ? ResourceStatus.Unknown
            : ResourceStatus.Unhealthy;
        }
      };
      return {
        scope: HealthScope.Project,
        project: projectName,
        name: encodeURIComponent(name),
        target: `${RESOURCE_TARGET_KIND_REPOSITORY}:${address}`,
        capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
        check,
      };
    });
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
