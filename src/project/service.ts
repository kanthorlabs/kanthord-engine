import assert from "node:assert/strict";
import { join } from "node:path";
import { isHumanIdentity, IdentityKind } from "../kernel/caller.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { ensureDirectory } from "../kernel/files.ts";
import { homeRelative } from "../kernel/xdg.ts";
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
  type ResourceStatusValue,
} from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import {
  isGitOnlyPlatform,
  isPlatformSshHost,
} from "../repository/platform.ts";
import { WORKING_FILES } from "../agent/prompt-layers.ts";
import { InvalidReason, validateText } from "../agent/prompt-source.ts";
import { RepositoryFileState } from "../repository/contract.ts";
import {
  assertPinned,
  sshPinSchema,
  type SshPin,
} from "../repository/ssh-identity.ts";
import {
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  ChangeKind,
  BINDING_CHECK_TIMEOUT_MS,
  EMPTY_LENGTH,
  LIST_LIMIT_MAX,
  INSTANCE_COUNT_MIN,
  INSTANCE_COUNT_MAX,
  LS_REMOTE_TIMEOUT_MS,
  PROJECT_PROMPT_MAX_BYTES,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
  GitHubAction,
  InstructionFileState,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  SSH_CREDENTIAL_PLATFORM,
  RESOURCE_TARGET_KIND_REPOSITORY,
  STORAGE_PLATFORM,
  WorkerField,
  bindingEditSchema,
  bindingSetWriteInputSchema,
  projectOperations,
  repositoryConfigSchema,
  storageConfigSchema,
  workerConfigSchema,
  type ProjectBindings,
  type AgentDependentBinding,
  type BindingNaming,
  type BindingRevisionResult,
  type CreateMission,
  type LiveNodesPinning,
  type ValidateEntry,
  type CustodySuitability,
  type CredentialMetadataOf,
  type RepositoryConnector,
  type RepositoryFiles,
  type RepositoryPolicy,
  type StorageBinding,
  type WorkerAgentsOfFn,
  type WorkerAgentViewFn,
  type WorkerEntry,
  type WorkerBindingRow,
  type EndRegistrations,
  type BindingChange,
  type SchedulerWakeup,
  type VerifyRepositoryCredential,
} from "./contract.ts";
import {
  insertProject,
  listProjects,
  requireProject,
  renameProject,
  readBindingRevision,
  readLatestBinding,
  readLatestTombstone,
  kindOf,
  deriveResourceIdentity,
  parseRepositoryAddress,
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
  type StoredProject,
} from "./store.ts";

const SSH_UNREACHABLE_STATUS = 422;
const PROJECTS_DIRECTORY = "projects";

function refuseSshHost(address: string, pin: SshPin): void {
  const parsed = parseRepositoryAddress(address);
  if (!parsed)
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
      "Repository address must have the form git@<host>:<owner>/<repository>.git.",
    );
  if (parsed.host !== pin.host)
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositorySshHostMismatch,
      "The repository address host differs from the host of the SSH credential.",
    );
}

function refuseRepositoryAction(
  config: typeof repositoryConfigSchema._output,
): void {
  const pullRequest = config.strategy.action?.name === GitHubAction.PullRequest;
  if (
    isGitOnlyPlatform(config.platform) &&
    (pullRequest || config.credential !== undefined)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryActionUnsupported,
      "A git-only platform takes no credential and no pull_request action.",
    );
  if (pullRequest && config.credential === undefined)
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryCredentialRequired,
      "The pull_request action requires a credential.",
    );
}
const UTF8_ENCODING = "utf8";
const CURSOR_ENCODING = "base64url";
const PAGE_EXTRA = 1;
const FIRST_INDEX = 0;
const LAST_INDEX = 1;
const MINIMUM_LIMIT = 1;
type InstructionFilesAnswer = {
  commit: string;
  read_at: number;
  files: ReturnType<typeof instructionFileEntry>[];
};
type BindingEdit = typeof bindingEditSchema._output;
type BindingSetWrite = typeof bindingSetWriteInputSchema._output;

function bindingRecord(binding: StoredBinding) {
  return { ...binding, kind: kindOf(binding.resource_identity) };
}

function requireBinding(tx: Transaction, projectId: string, bindingId: string) {
  const binding = readBindingRevision(tx, bindingId);
  if (!binding || binding.project_id !== projectId)
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
  if (kindOf(binding.resource_identity) !== BindingKind.Worker)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
      "Binding not found.",
    );
  return { project, config: workerConfigSchema.parse(binding.config) };
}

function requireRepositoryBinding(
  tx: Transaction,
  params: { project_id: string; binding_id: string },
) {
  requireProject(tx, params.project_id);
  const binding = readBindingRevision(tx, params.binding_id);
  if (
    !binding ||
    binding.project_id !== params.project_id ||
    hasBindingTombstone(tx, binding) ||
    kindOf(binding.resource_identity) !== BindingKind.Repository
  )
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
      "Binding not found.",
    );
  return {
    id: binding.id,
    config: repositoryConfigSchema.parse(binding.config),
  };
}

const INVALID_REASON_OF_FILE_STATE: Record<string, InvalidReason> = {
  [RepositoryFileState.NotRegularFile]: InvalidReason.NotRegularFile,
  [RepositoryFileState.OutsideRoot]: InvalidReason.OutsideWorkspace,
  [RepositoryFileState.Unreadable]: InvalidReason.Unreadable,
};

function instructionFileEntry(
  source: (typeof WORKING_FILES)[number][0],
  read: { path: string; state: string; text: string | null },
) {
  const { path, text } = read;
  if (read.state === RepositoryFileState.Absent)
    return {
      source,
      path,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    };
  let reason: InvalidReason | null | undefined;
  if (read.state === RepositoryFileState.Present) {
    assert.ok(text !== null);
    reason = validateText(text);
  } else reason = INVALID_REASON_OF_FILE_STATE[read.state];
  assert.ok(reason !== undefined);
  return reason === null
    ? { source, path, state: InstructionFileState.Present, reason, text }
    : { source, path, state: InstructionFileState.Invalid, reason, text: null };
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
  stateDirectory: string;
  hostHome?: string;
  createMission: CreateMission;
  liveNodesPinning: LiveNodesPinning;
  validateEntry: ValidateEntry;
  custodySuitability: CustodySuitability;
  repositoryConnector: RepositoryConnector;
  repositoryFiles: RepositoryFiles;
  verifyRepositoryCredential: VerifyRepositoryCredential;
  credentialMetadata: CredentialMetadataOf;
  workerAgentsOf: WorkerAgentsOfFn;
  workerAgentView: WorkerAgentViewFn;
  endRegistrations: EndRegistrations;
  wakeup: SchedulerWakeup;
  health?: HealthRegistry;
  bindings?: ProjectBindings;
}
export class ProjectService implements Service, ProjectBindings {
  private readonly bindings?: ProjectBindings;
  private readonly operationalStore: Store;
  private readonly stateDirectory: string;
  private readonly hostHome?: string;
  private readonly createMission: CreateMission;
  private readonly liveNodesPinning: LiveNodesPinning;
  private readonly validateEntry: ValidateEntry;
  private readonly custodySuitability: CustodySuitability;
  private readonly repositoryConnector: RepositoryConnector;
  private readonly repositoryFiles: RepositoryFiles;
  private readonly instructionFiles = new Map<
    string,
    { commit: string; answer: InstructionFilesAnswer }
  >();
  private readonly verifyRepositoryCredential: VerifyRepositoryCredential;
  private readonly credentialMetadata: CredentialMetadataOf;
  private readonly workerAgentsOf: WorkerAgentsOfFn;
  private readonly workerAgentView: WorkerAgentViewFn;
  private readonly endRegistrations: EndRegistrations;
  private readonly wakeup: SchedulerWakeup;
  constructor(dependencies: Dependencies) {
    this.bindings = dependencies.bindings;
    this.operationalStore = dependencies.operationalStore;
    this.stateDirectory = dependencies.stateDirectory;
    this.hostHome = dependencies.hostHome;
    this.createMission = dependencies.createMission;
    this.liveNodesPinning = dependencies.liveNodesPinning;
    this.validateEntry = dependencies.validateEntry;
    this.custodySuitability = dependencies.custodySuitability;
    this.repositoryConnector = dependencies.repositoryConnector;
    this.repositoryFiles = dependencies.repositoryFiles;
    this.verifyRepositoryCredential = dependencies.verifyRepositoryCredential;
    this.credentialMetadata = dependencies.credentialMetadata;
    this.workerAgentsOf = dependencies.workerAgentsOf;
    this.workerAgentView = dependencies.workerAgentView;
    this.endRegistrations = dependencies.endRegistrations;
    this.wakeup = dependencies.wakeup;
    dependencies.health?.register("project", () => this.healthcheck());
  }
  declare(registry: OperationRegistry): void {
    registry.register(projectOperations.create, ({ body }, caller) => {
      const record = caller.commit((tx) => {
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
        return this.projectRecord(project);
      });
      try {
        ensureDirectory(this.workspaceDirectoryOf(record.id));
      } catch (error) {
        if (!(error instanceof Diagnostic)) throw error;
      }
      return record;
    });
    registry.register(projectOperations.list, ({ query }, caller) =>
      caller.commit((tx) => {
        const { items, next_cursor: nextCursor } = listProjects(tx, query);
        return {
          items: items.map((project) => this.projectRecord(project)),
          next_cursor: nextCursor,
        };
      }),
    );
    registry.register(projectOperations.get, ({ params }, caller) =>
      caller.commit((tx) =>
        this.projectRecord(requireProject(tx, params.project_id)),
      ),
    );
    registry.register(projectOperations.rename, ({ params, body }, caller) =>
      caller.commit((tx) =>
        this.projectRecord(renameProject(tx, params.project_id, body.name)),
      ),
    );
    registry.register(
      projectOperations["bindingSet.write"],
      ({ params, body }, caller) =>
        this.writeBindings(params.project_id, body, caller),
    );
    this.declareBindingReads(registry);
    this.declareAgentReads(registry);
  }
  private declareBindingReads(registry: OperationRegistry): void {
    registry.register(
      projectOperations["bindingSet.get"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          const project = requireProject(tx, params.project_id);
          const bindings = Object.fromEntries(
            Array.from(
              readCurrentBindingSet(tx, project.id),
              ([name, binding]) => [
                name,
                bindingEditSchema.parse({
                  kind: kindOf(binding.resource_identity),
                  config: binding.config,
                }),
              ],
            ),
          );
          return { version: project.binding_set_version, bindings };
        }),
    );
    registry.register(
      projectOperations["binding.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => {
          requireProject(tx, params.project_id);
          const page = listBindings(tx, params.project_id, {
            ...query,
            state: query.state ?? BindingState.Current,
          });
          return { ...page, items: page.items.map(bindingRecord) };
        }),
    );
    registry.register(projectOperations["binding.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        bindingRecord(requireBinding(tx, params.project_id, params.binding_id)),
      ),
    );
    registry.register(
      projectOperations["bindingRevision.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => {
          requireBinding(tx, params.project_id, params.binding_id);
          const page = listRevisions(tx, params.binding_id, query);
          return { ...page, items: page.items.map(bindingRecord) };
        }),
    );
    registry.register(
      projectOperations["binding.verify"],
      ({ params }, caller) => this.verifyBinding(params, caller),
    );
    registry.register(
      projectOperations["binding.instruction_files.get"],
      ({ params }, caller) => this.readInstructionFiles(params, caller),
    );
    registry.register(
      projectOperations["binding.check"],
      ({ params, body }, caller) =>
        this.checkBinding(params, body.config, caller),
    );
  }
  private async verifyBinding(
    params: { project_id: string; binding_id: string },
    caller: CallerContext,
  ) {
    const { config } = this.operationalStore.transaction((tx) =>
      requireRepositoryBinding(tx, params),
    );
    throwIfCancelled(caller.context);
    const health = await this.bindingHealth(config, caller.context);
    return caller.commit(() => health);
  }
  private async readInstructionFiles(
    params: { project_id: string; binding_id: string },
    caller: CallerContext,
  ) {
    const { id, config } = this.operationalStore.transaction((tx) =>
      requireRepositoryBinding(tx, params),
    );
    throwIfCancelled(caller.context);
    const deadline = new CancellationContext(
      caller.context,
      Date.now() + BINDING_CHECK_TIMEOUT_MS,
    );
    const end = Date.now() + BINDING_CHECK_TIMEOUT_MS;
    try {
      const commit = await this.refuseUnreadable(caller.context, async () => {
        await this.proveRepositoryHost(
          config.platform,
          config.address,
          deadline,
          BINDING_CHECK_TIMEOUT_MS,
        );
        return this.repositoryFiles.resolveBranchCommit(
          config.address,
          config.strategy.base_branch,
          deadline,
          end - Date.now(),
        );
      });
      if (commit === null)
        throw new OperationError(
          SSH_UNREACHABLE_STATUS,
          ProjectErrorCode.RepositoryBaseBranchAbsent,
          "The base branch is absent on the remote.",
        );
      const cached = this.instructionFiles.get(id);
      if (cached?.commit === commit) return caller.commit(() => cached.answer);
      const files = await this.refuseUnreadable(caller.context, () =>
        this.repositoryFiles.readFilesAtCommit(
          config.address,
          commit,
          WORKING_FILES.map(([, path]) => path),
          deadline,
          end - Date.now(),
        ),
      );
      throwIfCancelled(caller.context);
      assert.equal(files.length, WORKING_FILES.length);
      const answer = {
        commit,
        read_at: Date.now(),
        files: WORKING_FILES.map(([source, path], index) => {
          assert.equal(files[index]!.path, path);
          return instructionFileEntry(source, files[index]!);
        }),
      };
      this.instructionFiles.set(id, { commit, answer });
      return caller.commit(() => answer);
    } finally {
      deadline.cancel();
    }
  }
  private async refuseUnreadable<T>(
    context: Context,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch {
      throwIfCancelled(context);
      throw new OperationError(
        SSH_UNREACHABLE_STATUS,
        ProjectErrorCode.RepositorySshUnreachable,
        "Repository SSH read failed.",
      );
    }
  }
  private async checkBinding(
    params: { project_id: string },
    config: typeof repositoryConfigSchema._output,
    caller: CallerContext,
  ) {
    refuseRepositoryAction(config);
    const pin = this.operationalStore.transaction((tx) => {
      requireProject(tx, params.project_id);
      if (config.credential !== undefined)
        this.custodySuitability(tx, {
          credential: config.credential,
          platform: REPOSITORY_PLATFORM,
        });
      return this.sshPinOf(tx, config.ssh_credential);
    });
    refuseSshHost(config.address, pin);
    throwIfCancelled(caller.context);
    const health = await this.bindingHealth(config, caller.context);
    return caller.commit(() => health);
  }
  private async bindingHealth(
    config: typeof repositoryConfigSchema._output,
    context: Context,
  ) {
    const addressEntry = await this.checkBindingAddress(
      config.platform,
      config.address,
      context,
    );
    const sshCredentialEntry = await this.verifyRepositoryCredential(
      config.ssh_credential,
      context,
    );
    const credentialEntry =
      config.credential === undefined
        ? null
        : await this.verifyRepositoryCredential(config.credential, context);
    throwIfCancelled(context);
    return {
      address: addressEntry,
      ssh_credential: sshCredentialEntry,
      credential: credentialEntry,
    };
  }
  private async checkBindingAddress(
    platform: string,
    address: string,
    context: Context,
  ) {
    const deadline = new CancellationContext(
      context,
      Date.now() + BINDING_CHECK_TIMEOUT_MS,
    );
    const entry = (status: ResourceStatusValue) => ({
      status,
      capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    });
    try {
      const end = Date.now() + BINDING_CHECK_TIMEOUT_MS;
      await this.proveRepositoryHost(
        platform,
        address,
        deadline,
        BINDING_CHECK_TIMEOUT_MS,
      );
      await this.repositoryConnector.gitLsRemote(
        address,
        deadline,
        end - Date.now(),
      );
      return entry(ResourceStatus.Healthy);
    } catch {
      return entry(
        deadline.err() ? ResourceStatus.Unknown : ResourceStatus.Unhealthy,
      );
    } finally {
      deadline.cancel();
    }
  }
  private workspaceDirectoryOf(projectId: string): string {
    return join(this.stateDirectory, PROJECTS_DIRECTORY, projectId);
  }
  private projectRecord(project: StoredProject) {
    return {
      ...project,
      workspace_directory: homeRelative(
        this.workspaceDirectoryOf(project.id),
        this.hostHome,
      ),
    };
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
    assert.ok(project.binding_set_version >= BINDING_SET_INITIAL_VERSION);
    return {
      agent,
      worker: config.worker,
      worker_binding_id: bindingId,
      binding_set_version: project.binding_set_version,
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
            params.project_id,
            params.binding_id,
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
              this.agentItem(tx, project, params.binding_id, config, name),
            ),
            next_cursor:
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
            params.project_id,
            params.binding_id,
          );
          if (!this.workerAgentsOf(config.worker).includes(params.agent_name))
            throw new OperationError(
              HttpStatus.NotFound,
              ProjectErrorCode.BindingNotFound,
              "Binding not found.",
            );
          return this.agentItem(
            tx,
            project,
            params.binding_id,
            config,
            params.agent_name,
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
      refuseRepositoryAction(binding.config);
      const pin = this.operationalStore.transaction((tx) =>
        this.sshPinOf(tx, binding.config.ssh_credential),
      );
      await this.checkRepository(binding.config, pin, caller.context);
    }
    throwIfCancelled(caller.context);
    const answer = caller.commit((tx) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(submission.size, Object.keys(body.bindings).length);
      for (const [name, binding] of submission)
        this.validateBinding(tx, name, binding);
      const result = writeBindingSet(tx, projectId, body.version, submission);
      this.endUnavailableRegistrations(tx, result.changes, Date.now());
      const bindings = Object.fromEntries(
        Array.from(readCurrentBindingSet(tx, projectId), ([name, binding]) => [
          name,
          bindingRecord(binding),
        ]),
      );
      return {
        project_id: projectId,
        binding_set_version: result.newVersion,
        bindings,
        changes: result.changes,
      };
    });
    this.wakeup.wake(projectId);
    return answer;
  }
  private sshPinOf(tx: Transaction, credentialName: string): SshPin {
    this.custodySuitability(tx, {
      credential: credentialName,
      platform: SSH_CREDENTIAL_PLATFORM,
    });
    const record = this.credentialMetadata(tx, credentialName);
    assert.ok(record && record.platform === SSH_CREDENTIAL_PLATFORM);
    return sshPinSchema.parse(record.metadata);
  }
  private async proveRepositoryHost(
    platform: string,
    address: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    const parsed = parseRepositoryAddress(address);
    let hostname: string | null = null;
    if (parsed)
      try {
        hostname = (
          await this.repositoryConnector.resolveSshIdentity(
            parsed.host,
            context,
            deadlineMs,
          )
        ).hostname;
      } catch {
        throwIfCancelled(context);
      }
    throwIfCancelled(context);
    if (hostname === null || !isPlatformSshHost(platform, hostname))
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryAddressInvalid,
        "Repository address must resolve to an SSH host of its platform.",
      );
  }
  private async proveSshPin(
    pin: SshPin,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    let identity;
    try {
      identity = await this.repositoryConnector.resolveSshIdentity(
        pin.host,
        context,
        deadlineMs,
      );
    } catch {
      throwIfCancelled(context);
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryAddressInvalid,
        "Repository address must resolve to an SSH host of its platform.",
      );
    }
    throwIfCancelled(context);
    assertPinned(pin, identity);
  }
  private async checkRepository(
    config: typeof repositoryConfigSchema._output,
    pin: SshPin,
    context: Context,
  ): Promise<void> {
    throwIfCancelled(context);
    const { address, platform } = config;
    refuseSshHost(address, pin);
    const end = Date.now() + LS_REMOTE_TIMEOUT_MS;
    await this.proveSshPin(pin, context, LS_REMOTE_TIMEOUT_MS);
    if (!isPlatformSshHost(platform, pin.hostname))
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryAddressInvalid,
        "Repository address must resolve to an SSH host of its platform.",
      );
    try {
      await this.repositoryConnector.gitLsRemote(
        address,
        context,
        end - Date.now(),
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
  private endUnavailableRegistrations(
    tx: Transaction,
    changes: BindingChange[],
    now: number,
  ): void {
    assert.ok(tx.database.isTransaction);
    assert.ok(Number.isSafeInteger(now));
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]!;
      if (
        change.kind !== ChangeKind.Removed &&
        change.kind !== ChangeKind.Revised
      )
        continue;
      const row = readBindingRevision(tx, change.binding_id);
      assert.ok(row);
      if (kindOf(row.resource_identity) !== BindingKind.Worker) continue;
      const latest = readLatestBinding(
        tx,
        row.project_id,
        row.resource_identity,
      );
      assert.ok(latest);
      if (
        latest.removed_at !== null ||
        workerConfigSchema.parse(latest.config).instance_count ===
          INSTANCE_COUNT_MIN
      )
        this.endRegistrations(tx, row.project_id, row.resource_identity, now);
    }
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
      Buffer.byteLength(binding.config.project_prompt ?? "", UTF8_ENCODING) >
        PROJECT_PROMPT_MAX_BYTES
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryPromptTooLarge,
        "Repository project prompt exceeds the UTF-8 byte limit.",
      );
    if (binding.kind === BindingKind.Storage) {
      this.custodySuitability(tx, {
        credential: binding.config.credential,
        platform: STORAGE_PLATFORM,
      });
      return;
    }
    this.custodySuitability(tx, {
      credential: binding.config.ssh_credential,
      platform: SSH_CREDENTIAL_PLATFORM,
    });
    if (binding.config.credential !== undefined)
      this.custodySuitability(tx, {
        credential: binding.config.credential,
        platform: REPOSITORY_PLATFORM,
      });
  }
  private validateWorker(
    tx: Transaction,
    name: string,
    config: typeof workerConfigSchema._output,
  ): void {
    if (
      config.instance_count < INSTANCE_COUNT_MIN ||
      config.instance_count > INSTANCE_COUNT_MAX
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
        assert.equal(binding.removed_at, null);
        if (kindOf(binding.resource_identity) !== BindingKind.Worker) return [];
        const config = workerConfigSchema.parse(binding.config);
        if (!this.workerAgentsOf(config.worker).includes(agentName)) return [];
        const entries = new Map(
          (config.entries ?? []).map(({ agent, ...entry }) => [agent, entry]),
        );
        return [
          {
            binding_id: binding.id,
            worker_name: config.worker,
            entry: entries.get(agentName) ?? null,
          },
        ];
      },
    );
  }
  bindingsNaming(tx: Transaction, credentialName: string): BindingNaming[] {
    assert.ok(tx.database.isTransaction);
    const dependents = readCredentialBindings(tx, credentialName)
      .filter(
        ({ binding, current }) =>
          current ||
          this.liveNodesPinning(tx, binding.id).length > EMPTY_LENGTH,
      )
      .map(({ binding }) => ({
        binding_id: binding.id,
        project_id: binding.project_id,
        project_name: requireProject(tx, binding.project_id).name,
        name: binding.name,
      }));
    assert.equal(
      new Set(dependents.map(({ binding_id }) => binding_id)).size,
      dependents.length,
    );
    return dependents;
  }
  resolveBinding(
    tx: Transaction,
    projectId: string,
    bindingName: string,
  ): { binding_id: string; resource_identity: string } | null {
    const binding = readCurrentBindingByName(tx, projectId, bindingName);
    if (!binding) return null;
    assert.equal(binding.removed_at, null);
    assert.equal(binding.project_id, projectId);
    return {
      binding_id: binding.id,
      resource_identity: binding.resource_identity,
    };
  }
  resolveBindingIdentity(
    tx: Transaction,
    projectId: string,
    bindingId: string,
  ): { binding_id: string; resource_identity: string } | null {
    const binding = readBindingRevision(tx, bindingId);
    if (!binding || binding.project_id !== projectId) return null;
    if (hasBindingTombstone(tx, binding)) return null;
    const latest = readLatestBinding(tx, projectId, binding.resource_identity);
    assert.ok(latest, "A retained binding must have a latest revision.");
    assert.equal(latest.removed_at, null);
    return {
      binding_id: latest.id,
      resource_identity: latest.resource_identity,
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
      binding.project_id,
      binding.resource_identity,
    );
    assert.ok(latest, "A retained binding must have a latest revision.");
    assert.ok(latest.revision >= binding.revision);
    const current = bindingEditSchema.parse({
      kind: kindOf(latest.resource_identity),
      config: latest.config,
    });
    const disabled =
      current.kind === BindingKind.Worker
        ? current.config.instance_count === INSTANCE_COUNT_MIN
        : current.config.available === false;
    return {
      project_id: binding.project_id,
      binding_id: binding.id,
      name: binding.name,
      resource_identity: binding.resource_identity,
      revision: binding.revision,
      tombstone: hasBindingTombstone(tx, binding),
      disabled,
    };
  }
  workerBindingRowOf(tx: Transaction, bindingId: string) {
    assert.ok(tx.database.isTransaction);
    const binding = readBindingRevision(tx, bindingId);
    if (!binding || kindOf(binding.resource_identity) !== BindingKind.Worker)
      return null;
    const config = workerConfigSchema.parse(binding.config);
    const resolution = this.getBindingRevision(tx, bindingId);
    assert.ok(resolution);
    return {
      binding_id: binding.id,
      project_id: binding.project_id,
      worker_name: config.worker,
      resource_identity: binding.resource_identity,
      tombstone: resolution.tombstone,
      disabled: resolution.disabled,
      entries: config.entries ?? [],
      resource_budget: config.resource_budget ?? null,
    };
  }
  storageBindingOf(tx: Transaction, bindingId: string): StorageBinding | null {
    assert.ok(tx.database.isTransaction);
    const binding = readBindingRevision(tx, bindingId);
    if (!binding || kindOf(binding.resource_identity) !== BindingKind.Storage)
      return null;
    assert.equal(binding.id, bindingId);
    return {
      binding_id: binding.id,
      project_id: binding.project_id,
      ...storageConfigSchema.parse(binding.config),
    };
  }
  repositoryPolicyOf(
    tx: Transaction,
    bindingId: string,
  ): RepositoryPolicy | null {
    assert.ok(tx.database.isTransaction);
    const binding = readBindingRevision(tx, bindingId);
    if (
      !binding ||
      kindOf(binding.resource_identity) !== BindingKind.Repository
    )
      return null;
    assert.equal(binding.id, bindingId);
    const config = repositoryConfigSchema.parse(binding.config);
    return {
      binding_id: binding.id,
      project_id: binding.project_id,
      name: binding.name,
      address: config.address,
      platform: config.platform,
      ssh_credential: config.ssh_credential,
      credential: config.credential ?? null,
      base_branch: config.strategy.base_branch,
      action: config.strategy.action?.name ?? null,
      project_prompt: config.project_prompt ?? null,
      working_layer: config.working_layer,
    };
  }
  workerBindingOf(
    tx: Transaction,
    projectId: string,
    resourceIdentity: string,
  ): WorkerBindingRow | null {
    assert.ok(tx.database.isTransaction);
    const row = readLatestBinding(tx, projectId, resourceIdentity);
    if (!row || kindOf(row.resource_identity) !== BindingKind.Worker)
      return null;
    assert.equal(row.project_id, projectId);
    const config = workerConfigSchema.parse(row.config);
    return {
      binding_id: row.id,
      name: row.name,
      project_name: requireProject(tx, projectId).name,
      revision: row.revision,
      worker_name: config.worker,
      instance_count: config.instance_count,
      resource_budget: config.resource_budget ?? null,
      entries: config.entries ?? [],
      tombstone: row.removed_at !== null,
    };
  }
  async resolveWorkerGroup(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ) {
    throwIfCancelled(context);
    if (this.bindings)
      return this.bindings.resolveWorkerGroup(
        projectId,
        resourceIdentity,
        issuedAt,
        context,
      );
    return this.operationalStore.transaction((tx) => {
      const row = readLatestBinding(tx, projectId, resourceIdentity);
      if (
        !row ||
        kindOf(row.resource_identity) !== BindingKind.Worker ||
        row.removed_at !== null
      )
        return null;
      assert.equal(row.project_id, projectId);
      assert.equal(row.resource_identity, resourceIdentity);
      if (
        workerConfigSchema.parse(row.config).instance_count ===
        INSTANCE_COUNT_MIN
      )
        return null;
      const tombstone = readLatestTombstone(tx, projectId, resourceIdentity);
      if (tombstone && tombstone.created_at > issuedAt) return null;
      return { project_id: projectId, resource_identity: resourceIdentity };
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
    return readCurrentRepositories(tx).map(
      ({ project_name: projectName, name, address, platform }) => {
        const check: ResourceCheck = async (context, observe) => {
          try {
            const deadline = context.deadline();
            assert.ok(deadline !== null);
            try {
              await this.proveRepositoryHost(
                platform,
                address,
                context,
                deadline - Date.now(),
              );
            } catch (error) {
              if (error instanceof OperationError) observe?.(error.code);
              throw error;
            }
            try {
              await this.repositoryConnector.gitLsRemote(
                address,
                context,
                deadline - Date.now(),
              );
            } catch (error) {
              observe?.(ProjectErrorCode.RepositorySshUnreachable);
              throw error;
            }
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
      },
    );
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
