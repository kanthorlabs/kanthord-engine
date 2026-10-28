import type { Environment } from "../kernel/devcontainer.ts";
import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import {
  type CallerIdentity,
  IdentityKind,
  isHumanIdentity,
  type ServiceIdentity,
} from "../kernel/caller.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  DeadlineExceeded,
  reasonOf,
} from "../kernel/context.ts";
import { asError, Diagnostic, OperationError } from "../kernel/errors.ts";
import { ensureDirectory } from "../kernel/files.ts";
import { homeRelative } from "../kernel/xdg.ts";
import { canonicalJSON } from "../kernel/json.ts";
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
  ResourceFailureReason,
  ResourceStatus,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  isGitOnlyPlatform,
  isPlatformSshHost,
} from "../repository/platform.ts";
import { validateText } from "../agent/prompt-source.ts";
import { gitFailureReason } from "../repository/git-failure.ts";
import { tagSchema } from "../kernel/tag.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  type CredentialRecords,
  type Grant,
  type GrantFacts,
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
  type SshIdentitySubject,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import type { SshAccess, SshGrantFacts } from "../repository/index.ts";
import type {
  bindingEditSchema,
  bindingSetWriteInputSchema,
  workerConfigWriteSchema,
} from "./contract.ts";
import {
  type AgentDependentBinding,
  BINDING_CHECK_TIMEOUT_MS,
  BINDING_SET_INITIAL_VERSION,
  type BindingChange,
  bindingHolders,
  BindingKind,
  type BindingNaming,
  type BindingPrompts,
  type BindingRevisionResult,
  type BindingsChanged,
  bindingSchema,
  bindingScope,
  BindingState,
  ChangeKind,
  type CreateMission,
  type CurrentNodePins,
  type CustodySuitability,
  effectiveInstanceCount,
  EMPTY_LENGTH,
  type EndRegistrations,
  ENVIRONMENT_SECRET_PLATFORM,
  ENVIRONMENT_SECRET_VARIABLE,
  ENVIRONMENT_SECRETS_MAX,
  GitHubAction,
  INSTANCE_COUNT_MAX,
  INSTANCE_COUNT_MIN,
  type InstanceOf,
  Landing,
  LIST_LIMIT_MAX,
  type LiveNodesPinning,
  LS_REMOTE_TIMEOUT_MS,
  type ProjectBindings,
  ProjectErrorCode,
  projectOperations,
  REPOSITORY_PLATFORM,
  repositoryConfigSchema,
  type RepositoryConnector,
  type RepositoryFiles,
  type RepositoryPolicy,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  RESOURCE_TARGET_KIND_REPOSITORY,
  type SchedulerWakeup,
  SSH_CREDENTIAL_PLATFORM,
  type StalePin,
  STORAGE_PLATFORM,
  type StorageBinding,
  storageConfigSchema,
  type UnmatchedClaims,
  type ValidateEntry,
  type VerifyRepositoryCredential,
  type WorkerAgentsOfFn,
  type WorkerAgentViewFn,
  type WorkerBindingRow,
  workerConfigSchema,
  type WorkerEntry,
  WorkerField,
  workerInstancesSchema,
  WorkerPlacement,
  workerTagsSchema,
} from "./contract.ts";
import {
  deriveResourceIdentity,
  hasBindingTombstone,
  insertProject,
  kindOf,
  listBindings,
  listProjects,
  listRevisions,
  parseRepositoryAddress,
  pauseProject,
  readBindingRevision,
  readCredentialBindings,
  readCurrentBindingByName,
  readCurrentBindings,
  readCurrentBindingSet,
  readCurrentRepositories,
  readGeneration,
  readLatestBinding,
  readLatestTombstone,
  readOlderRevisions,
  readProjectIds,
  renameProject,
  requireProject,
  requireRepositoryBinding,
  resumeProject,
  type StoredBinding,
  type StoredProject,
  writeBindingSet,
} from "./store.ts";
import type { ProjectConfig } from "./config.ts";
import { ProjectEnvironments, refuseEnvironment } from "./environment.ts";
import type { EnvironmentAgent } from "./environment-agent.ts";
import { writeStoredEnvironment } from "./environment-agent-tools.ts";
import type { EnvironmentProbeRunner } from "./environment-probe-contract.ts";
import { EnvironmentSecretRoutes } from "./environment-secret.ts";
import { EnvironmentSecrets } from "./environment-secrets.ts";
import type { EnvironmentTelemetry } from "./environment-telemetry.ts";
import type { EnvironmentTarget } from "./environment-state.ts";
import {
  ENVIRONMENT_DIRECTORY,
  type EnvironmentRuntime,
  ProofFiles,
} from "./environment-state.ts";
import {
  type BindingFacts,
  type EnvironmentFailedInput,
  Onboarding,
  targetOf,
} from "./onboarding.ts";

const SSH_UNREACHABLE_STATUS = 422;
const PROJECTS_DIRECTORY = "projects";
const NO_GENERATION = 0;
const BEFORE = -1;
const SAME = 0;
const AFTER = 1;
const SINGLE_FORM = 1;

function refuseAddressForm(address: string): void {
  if (parseRepositoryAddress(address) === null)
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
      "Repository address must have the form git@<host>:<owner>/<repository>.git.",
    );
}

function refuseForeignHost(platform: string, address: string): void {
  const parsed = parseRepositoryAddress(address);
  if (parsed === null || !isPlatformSshHost(platform, parsed.host))
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
      "Repository address must name an SSH host of its platform.",
    );
}

type SshRelease = { identity: CallerIdentity; subject: SshIdentitySubject };
type ReleasedAccess = { address: string; ssh: SshAccess };

function repositoryFailureReason(error: unknown): ResourceFailureReason {
  return error instanceof OperationError &&
    error.code === ProjectErrorCode.RepositoryAddressInvalid
    ? ResourceFailureReason.AddressInvalid
    : gitFailureReason(error);
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
const ENVIRONMENT_KEY = "environment";
function withoutEnvironment(config: unknown): unknown {
  if (!isObject(config)) return config;
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== ENVIRONMENT_KEY),
  );
}
function bindingUnchanged(
  name: string,
  binding: BindingEdit,
  saved: StoredBinding | undefined,
): boolean {
  return (
    saved !== undefined &&
    saved.resource_identity ===
      deriveResourceIdentity(binding.kind, name, binding.config) &&
    canonicalJSON(withoutEnvironment(saved.config)) ===
      canonicalJSON(withoutEnvironment(binding.config))
  );
}
function callerIdentity(caller: CallerContext): CallerIdentity {
  assert.ok(caller.identity !== undefined);
  return caller.identity;
}
function draftSubject(
  projectId: string,
  config: typeof repositoryConfigSchema._output,
): SshIdentitySubject {
  return {
    kind: SshIdentitySubjectKind.Draft,
    project_id: projectId,
    credential: config.ssh_credential,
    address: config.address,
  };
}
function unmatchedKey(pair: { node_id: string; claim: string }): string {
  return JSON.stringify([pair.node_id, pair.claim]);
}

function refuseAddedUnmatched(
  before: ReadonlySet<string>,
  after: ReturnType<UnmatchedClaims>,
): void {
  const nodeIds = new Set(
    after
      .filter((pair) => !before.has(unmatchedKey(pair)))
      .map(({ node_id }) => node_id),
  );
  if (nodeIds.size === EMPTY_LENGTH) return;
  throw new OperationError(
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerNodeUnmatched,
    "The binding set leaves a node and claimable state pair that no worker binding covers.",
    { node_ids: [...nodeIds].sort() },
  );
}

function refuseInvalidTags(name: string, tags: unknown): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags))
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerTagsInvalid,
      "Worker tags must be a list of unique tags.",
      { binding: name, tag: null },
    );
  const seen = new Set<unknown>();
  for (const tag of tags) {
    if (tagSchema.safeParse(tag).success && !seen.has(tag)) {
      seen.add(tag);
      continue;
    }
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerTagsInvalid,
      "Worker tags must be a list of unique tags.",
      { binding: name, tag: isString(tag) ? tag : null },
    );
  }
  assert.ok(workerTagsSchema.safeParse(tags).success);
}
function refuseInstanceCount(config: { instance_count?: number }): void {
  if (
    config.instance_count === undefined ||
    config.instance_count < INSTANCE_COUNT_MIN ||
    config.instance_count > INSTANCE_COUNT_MAX
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerInstanceCountRange,
      "Worker instance count is out of range.",
    );
}
function refuseInvalidInstances(name: string, instances: unknown): string[] {
  const refuse = (instance: string | null) =>
    new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerInstancesInvalid,
      "Worker instances must be a list of at most 64 unique instance names.",
      { binding: name, instance },
    );
  if (!Array.isArray(instances) || instances.length > INSTANCE_COUNT_MAX)
    throw refuse(null);
  const seen = new Set<string>();
  for (const instance of instances) {
    if (!isString(instance) || seen.has(instance))
      throw refuse(isString(instance) ? instance : null);
    seen.add(instance);
  }
  assert.ok(workerInstancesSchema.safeParse(instances).success);
  return [...seen];
}
const UTF8_ENCODING = "utf8";
const CURSOR_ENCODING = "base64url";
const PAGE_EXTRA = 1;
const FIRST_INDEX = 0;
const LAST_INDEX = 1;
const MINIMUM_LIMIT = 1;
const EMPTY_IDENTITY_LENGTH = 0;
const BINDING_INDEX = 1;
const SINGLE_REPOSITORY = 1;
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

function listedInstances(
  tx: Transaction,
  instanceOf: InstanceOf,
  config: { worker_instances?: readonly string[] },
) {
  return (config.worker_instances ?? []).flatMap(
    (name) => instanceOf(tx, name) ?? [],
  );
}

function listsContainer(
  tx: Transaction,
  instanceOf: InstanceOf,
  config: { worker_instances?: readonly string[] },
): boolean {
  return listedInstances(tx, instanceOf, config).some(
    ({ placement }) => placement === WorkerPlacement.Container,
  );
}

function endsGroup(config: {
  instance_count?: number;
  worker_instances?: readonly string[];
}): boolean {
  return (
    config.worker_instances === undefined &&
    effectiveInstanceCount(config) === INSTANCE_COUNT_MIN
  );
}

function resolveEnvironment(
  tx: Transaction,
  instanceOf: InstanceOf,
  config: { worker_instances?: readonly string[]; environment?: string },
  projectId: string,
): string | null {
  if (!listsContainer(tx, instanceOf, config)) return null;
  const repositories = Array.from(
    readCurrentBindingSet(tx, projectId).entries(),
  ).filter(
    ([, binding]) =>
      kindOf(binding.resource_identity) === BindingKind.Repository,
  );
  if (config.environment !== undefined)
    return (
      repositories.find(([name]) => name === config.environment)?.[
        BINDING_INDEX
      ].resource_identity ?? null
    );
  if (repositories.length !== SINGLE_REPOSITORY) return null;
  return repositories[FIRST_INDEX]![BINDING_INDEX].resource_identity;
}

function refuseWorkerEnvironments(
  tx: Transaction,
  instanceOf: InstanceOf,
  submission: ReadonlyMap<string, BindingEdit>,
): void {
  const repositories = Array.from(submission.values()).filter(
    (binding) => binding.kind === BindingKind.Repository,
  ).length;
  for (const [name, binding] of submission) {
    if (binding.kind !== BindingKind.Worker) continue;
    const { environment } = binding.config;
    const worker_instances = workerInstancesSchema.parse(
      binding.config.worker_instances ?? [],
    );
    if (
      environment === undefined &&
      repositories > SINGLE_REPOSITORY &&
      listsContainer(tx, instanceOf, { worker_instances })
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerEnvironmentRequired,
        "A worker binding that lists a container instance names one repository binding when the project holds several.",
        { binding: name },
      );
    if (
      environment !== undefined &&
      submission.get(environment)?.kind !== BindingKind.Repository
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerEnvironmentUnknown,
        "The environment names no repository binding of the project.",
        { binding: name, environment },
      );
  }
}

function containerInstancesOf(
  tx: Transaction,
  instanceOf: InstanceOf,
  config: { worker_instances?: readonly string[] },
): string[] {
  return listedInstances(tx, instanceOf, config)
    .filter(({ placement }) => placement === WorkerPlacement.Container)
    .map(({ name }) => name);
}

function refuseSharedContainerInstances(
  tx: Transaction,
  instanceOf: InstanceOf,
  projectId: string,
  submission: ReadonlyMap<string, BindingEdit>,
): void {
  const listedBy = new Map<string, { project_id: string; binding: string }>();
  for (const stored of readCurrentBindings(tx)) {
    if (
      stored.project_id === projectId ||
      kindOf(stored.resource_identity) !== BindingKind.Worker
    )
      continue;
    const config = workerConfigSchema.parse(stored.config);
    for (const instance of containerInstancesOf(tx, instanceOf, config))
      listedBy.set(instance, {
        project_id: stored.project_id,
        binding: stored.name,
      });
  }
  for (const [name, binding] of submission) {
    if (binding.kind !== BindingKind.Worker) continue;
    const worker_instances = workerInstancesSchema.parse(
      binding.config.worker_instances ?? [],
    );
    for (const instance of containerInstancesOf(tx, instanceOf, {
      worker_instances,
    })) {
      const listed = listedBy.get(instance);
      if (listed)
        throw new OperationError(
          HttpStatus.Conflict,
          ProjectErrorCode.WorkerInstanceShared,
          "A container instance is listed by one worker binding only.",
          { binding: name, instance, listed_by: listed },
        );
      listedBy.set(instance, { project_id: projectId, binding: name });
    }
  }
}

function workerRowOf(
  tx: Transaction,
  instanceOf: InstanceOf,
  row: StoredBinding,
  projectName: string,
): WorkerBindingRow {
  const config = workerConfigSchema.parse(row.config);
  return {
    binding_id: row.id,
    name: row.name,
    project_name: projectName,
    revision: row.revision,
    worker_name: config.worker,
    instance_count: effectiveInstanceCount(config),
    worker_instances: config.worker_instances ?? [],
    environment: resolveEnvironment(tx, instanceOf, config, row.project_id),
    generation:
      readGeneration(tx, row.project_id, row.resource_identity) ??
      NO_GENERATION,
    resource_budget: config.resource_budget ?? null,
    entries: config.entries ?? [],
    tags: config.tags ?? [],
    tombstone: row.removed_at !== null,
  };
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

function validatePrompts(prompts: BindingPrompts): void {
  for (const [agentName, text] of Object.entries(prompts)) {
    if (text === undefined) continue;
    const reason = validateText(text);
    if (reason !== null)
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryPromptInvalid,
        "Repository binding prompt is invalid.",
        { agent_name: agentName, reason },
      );
  }
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

export interface ProjectCustody {
  authorizeOperation<R extends GrantRequest>(
    tx: Transaction,
    request: R,
    now: number,
  ): GrantOf<R["kind"]>;
  release(tx: Transaction, grant: Grant, now: number): Material;
  grantFacts<G extends Grant>(grant: G): GrantFacts<G>;
}
export type SshAccessOf = (
  tx: Transaction,
  granted: SshGrantFacts,
  material: Material,
) => SshAccess;

export interface Dependencies {
  config: ProjectConfig;
  operationalStore: Store;
  stateDirectory: string;
  hostHome?: string;
  createMission: CreateMission;
  liveNodesPinning: LiveNodesPinning;
  currentNodePins: CurrentNodePins;
  unmatchedClaims: UnmatchedClaims;
  validateEntry: ValidateEntry;
  custodySuitability: CustodySuitability;
  repositoryConnector: RepositoryConnector;
  repositoryFiles: RepositoryFiles;
  verifyRepositoryCredential: VerifyRepositoryCredential;
  identity: ServiceIdentity;
  custody: ProjectCustody;
  credentialRecords: CredentialRecords;
  sshAccessOf: SshAccessOf;
  workerAgentsOf: WorkerAgentsOfFn;
  workerAgentView: WorkerAgentViewFn;
  endRegistrations: EndRegistrations;
  bindingsChanged: BindingsChanged;
  instanceOf: InstanceOf;
  wakeup: SchedulerWakeup;
  environmentRuntime: EnvironmentRuntime;
  environmentAgent: Pick<EnvironmentAgent, "enabled" | "run">;
  environmentProbe: EnvironmentProbeRunner;
  telemetry: EnvironmentTelemetry;
  slotImage: string;
  version: string;
  environmentReady(
    projectId: string,
    resourceIdentity: string,
    tag: string,
  ): void | Promise<void>;
  logger?: Logger;
  health?: HealthRegistry;
  bindings?: ProjectBindings;
}
function currentEnvironmentOf(
  tx: Transaction,
  binding: { project_id: string; resource_identity: string },
): Environment | null {
  const current = Array.from(
    readCurrentBindingSet(tx, binding.project_id).values(),
  ).find((entry) => entry.resource_identity === binding.resource_identity);
  if (!current) return null;
  return repositoryConfigSchema.parse(current.config).environment ?? null;
}

function byNodeThenName(left: StalePin, right: StalePin): number {
  if (left.node_id !== right.node_id)
    return left.node_id < right.node_id ? BEFORE : AFTER;
  if (left.binding_name === right.binding_name) return SAME;
  return left.binding_name < right.binding_name ? BEFORE : AFTER;
}

function noStoredEnvironment(tx: Transaction, projectId: string): boolean {
  return Array.from(readCurrentBindingSet(tx, projectId).values()).every(
    (entry) =>
      kindOf(entry.resource_identity) !== BindingKind.Repository ||
      repositoryConfigSchema.parse(entry.config).environment === undefined,
  );
}

export class ProjectService implements Service, ProjectBindings {
  private readonly bindings?: ProjectBindings;
  private readonly operationalStore: Store;
  private readonly stateDirectory: string;
  private readonly hostHome?: string;
  private readonly createMission: CreateMission;
  private readonly liveNodesPinning: LiveNodesPinning;
  private readonly currentNodePins: CurrentNodePins;
  private readonly unmatchedClaims: UnmatchedClaims;
  private readonly validateEntry: ValidateEntry;
  private readonly custodySuitability: CustodySuitability;
  private readonly repositoryConnector: RepositoryConnector;
  private readonly verifyRepositoryCredential: VerifyRepositoryCredential;
  private readonly identity: ServiceIdentity;
  private readonly custody: ProjectCustody;
  private readonly credentialRecords: CredentialRecords;
  private readonly sshAccessOf: SshAccessOf;
  private readonly workerAgentsOf: WorkerAgentsOfFn;
  private readonly workerAgentView: WorkerAgentViewFn;
  private readonly endRegistrations: EndRegistrations;
  private readonly bindingsChanged: BindingsChanged;
  private readonly instanceOf: InstanceOf;
  private readonly wakeup: SchedulerWakeup;
  private readonly environments: ProjectEnvironments;
  private readonly onboarding: Onboarding;
  private readonly logger: Logger;
  constructor(dependencies: Dependencies) {
    this.logger = dependencies.logger ?? pino({ level: "silent" });
    this.bindings = dependencies.bindings;
    this.operationalStore = dependencies.operationalStore;
    this.stateDirectory = dependencies.stateDirectory;
    this.hostHome = dependencies.hostHome;
    this.createMission = dependencies.createMission;
    this.liveNodesPinning = dependencies.liveNodesPinning;
    this.currentNodePins = dependencies.currentNodePins;
    this.unmatchedClaims = dependencies.unmatchedClaims;
    this.validateEntry = dependencies.validateEntry;
    this.custodySuitability = dependencies.custodySuitability;
    this.repositoryConnector = dependencies.repositoryConnector;
    this.verifyRepositoryCredential = dependencies.verifyRepositoryCredential;
    this.identity = dependencies.identity;
    this.custody = dependencies.custody;
    this.credentialRecords = dependencies.credentialRecords;
    this.sshAccessOf = dependencies.sshAccessOf;
    this.workerAgentsOf = dependencies.workerAgentsOf;
    this.workerAgentView = dependencies.workerAgentView;
    this.endRegistrations = dependencies.endRegistrations;
    this.bindingsChanged = dependencies.bindingsChanged;
    this.instanceOf = dependencies.instanceOf;
    this.wakeup = dependencies.wakeup;
    this.environments = new ProjectEnvironments({
      store: dependencies.operationalStore,
      repositoryFiles: dependencies.repositoryFiles,
      identity: dependencies.identity,
      targetOf: (projectId, bindingId) =>
        this.targetOfBinding(projectId, bindingId),
      sshAccess: (platform, release) => this.sshAccess(platform, release),
      writeBindings: (projectId, body, caller) =>
        this.writeBindings(projectId, body, caller),
    });
    this.onboarding = new Onboarding({
      bindingsOf: (projectId) => this.bindingFactsOf(projectId),
      workerEnvironmentOf: (projectId, resourceIdentity) =>
        this.workerEnvironmentOf(projectId, resourceIdentity),
      projectIds: () =>
        this.operationalStore.transaction((tx) => readProjectIds(tx)),
      resolveGroup: (bindingId, target, context) =>
        this.environments.resolveGroup(bindingId, target, context),
      baseCommitOf: (bindingId, context) =>
        this.environments.baseCommitOf(bindingId, context),
      runtime: dependencies.environmentRuntime,
      proofs: new ProofFiles(join(this.stateDirectory, ENVIRONMENT_DIRECTORY)),
      secrets: new EnvironmentSecrets({
        root: join(this.stateDirectory, ENVIRONMENT_DIRECTORY),
        transaction: (write) => this.operationalStore.transaction(write),
        identity: this.identity,
        custody: this.custody,
        records: this.credentialRecords,
        now: () => Date.now(),
      }),
      slotImage: dependencies.slotImage,
      version: dependencies.version,
      wake: (projectId) => this.wakeup.wake(projectId),
      environmentAgent: dependencies.environmentAgent,
      probe: dependencies.environmentProbe,
      writeEnvironment: (projectId, bindingId, environment, context) =>
        writeStoredEnvironment({
          environments: this.environments,
          store: this.operationalStore,
          identity: this.identity,
          project_id: projectId,
          binding_id: bindingId,
          environment,
          context,
        }),
      environmentReady: async (projectId, resourceIdentity, tag) =>
        dependencies.environmentReady(projectId, resourceIdentity, tag),
      logger: this.logger,
      now: () => Date.now(),
      runId: () => randomUUID(),
      environmentBuildTimeoutMs:
        dependencies.config.environment_build_timeout_ms,
      telemetry: dependencies.telemetry,
    });
    dependencies.health?.register("project", () => this.healthcheck());
  }
  declare(registry: OperationRegistry): void {
    new EnvironmentSecretRoutes({
      records: this.credentialRecords,
      bindingsNaming: (tx, name) => this.bindingsNaming(tx, name),
    }).declare(registry);
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
    registry.register(projectOperations.pause, ({ params }, caller) =>
      caller.commit((tx) =>
        this.projectRecord(pauseProject(tx, params.project_id)),
      ),
    );
    registry.register(projectOperations.resume, ({ params }, caller) => {
      const record = caller.commit((tx) =>
        this.projectRecord(resumeProject(tx, params.project_id)),
      );
      this.wakeup.wake(record.id);
      return record;
    });
    registry.register(
      projectOperations["bindingSet.write"],
      ({ params, body }, caller) =>
        this.writeBindings(params.project_id, body, caller),
    );
    registry.register(
      projectOperations["binding.environment.set"],
      ({ params, body }, caller) =>
        this.environments.write(params, body.environment, caller),
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
                bindingSchema.parse({
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
      projectOperations["binding.environment.get"],
      ({ params }, caller) => this.environments.read(params, caller),
    );
    registry.register(
      projectOperations["environment.list"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          requireProject(tx, params.project_id);
          return { items: this.environmentStates(params.project_id) };
        }),
    );
    registry.register(
      projectOperations["binding.environment.rebuild"],
      async ({ params }, caller) => {
        this.operationalStore.transaction((tx) =>
          requireRepositoryBinding(tx, params),
        );
        const state = await this.rebuildEnvironment(
          params.project_id,
          params.binding_id,
        );
        return caller.commit(() => state);
      },
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
    const { id, config } = this.operationalStore.transaction((tx) =>
      requireRepositoryBinding(tx, params),
    );
    caller.context.signal.throwIfAborted();
    const health = await this.bindingHealth(
      config,
      {
        identity: callerIdentity(caller),
        subject: { kind: SshIdentitySubjectKind.Binding, binding_id: id },
      },
      caller.context,
    );
    return caller.commit(() => health);
  }
  private async checkBinding(
    params: { project_id: string },
    config: typeof repositoryConfigSchema._output,
    caller: CallerContext,
  ) {
    refuseRepositoryAction(config);
    refuseAddressForm(config.address);
    this.operationalStore.transaction((tx) => {
      requireProject(tx, params.project_id);
      if (config.credential !== undefined)
        this.custodySuitability(tx, {
          credential: config.credential,
          platform: REPOSITORY_PLATFORM,
        });
      this.custodySuitability(tx, {
        credential: config.ssh_credential,
        platform: SSH_CREDENTIAL_PLATFORM,
      });
    });
    caller.context.signal.throwIfAborted();
    const health = await this.bindingHealth(
      config,
      {
        identity: callerIdentity(caller),
        subject: draftSubject(params.project_id, config),
      },
      caller.context,
    );
    return caller.commit(() => health);
  }
  private async bindingHealth(
    config: typeof repositoryConfigSchema._output,
    release: SshRelease,
    context: Context,
  ) {
    const addressEntry = await this.checkBindingAddress(
      config.platform,
      release,
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
    context.signal.throwIfAborted();
    return {
      address: addressEntry,
      ssh_credential: sshCredentialEntry,
      credential: credentialEntry,
    };
  }
  private async checkBindingAddress(
    platform: string,
    release: SshRelease,
    context: Context,
  ) {
    const deadline = new CancellationContext(
      context,
      Date.now() + BINDING_CHECK_TIMEOUT_MS,
    );
    const entry = (
      status: ResourceStatusValue,
      failureReason: ResourceFailureReason | null,
    ) => ({
      status,
      capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
      failure_reason: failureReason,
    });
    try {
      const access = this.sshAccess(platform, release);
      await this.repositoryConnector.gitLsRemote(
        access.address,
        deadline,
        BINDING_CHECK_TIMEOUT_MS,
        access.ssh,
      );
      return entry(ResourceStatus.Healthy, null);
    } catch (error) {
      return entry(
        deadline.signal.aborted
          ? ResourceStatus.Unknown
          : ResourceStatus.Unhealthy,
        repositoryFailureReason(error),
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
    const view = this.workerAgentView(
      tx,
      config.worker,
      agent,
      entry,
      bindingScope(listedInstances(tx, this.instanceOf, config)),
    );
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
      chain: view.chain,
      active_position: view.active_position,
      cooling: view.cooling,
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
    const saved = this.savedBindingSet(projectId, body.version);
    for (const [name, binding] of submission) {
      if (binding.kind !== BindingKind.Repository) continue;
      refuseRepositoryAction(binding.config);
      refuseEnvironment(binding.config.environment);
      if (bindingUnchanged(name, binding, saved.get(name))) continue;
      await this.checkRepository(projectId, binding.config, caller);
    }
    caller.context.signal.throwIfAborted();
    const answer = caller.commit((tx) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(submission.size, Object.keys(body.bindings).length);
      for (const [name, binding] of submission)
        this.validateBinding(tx, name, binding);
      refuseWorkerEnvironments(tx, this.instanceOf, submission);
      refuseSharedContainerInstances(
        tx,
        this.instanceOf,
        projectId,
        submission,
      );
      const before = new Set(
        this.unmatchedClaims(tx, projectId).map(unmatchedKey),
      );
      const result = writeBindingSet(tx, projectId, body.version, submission);
      this.endUnavailableRegistrations(tx, result.changes, Date.now());
      refuseAddedUnmatched(before, this.unmatchedClaims(tx, projectId));
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
        stale_pins: this.stalePins(tx, projectId, result.changes),
      };
    });
    this.onboarding.bindingsChanged(projectId);
    this.bindingsChanged(projectId);
    this.wakeup.wake(projectId);
    return answer;
  }
  private stalePins(
    tx: Transaction,
    projectId: string,
    changes: readonly BindingChange[],
  ): StalePin[] {
    const older = new Map<
      string,
      { name: string; pinned: number; current: number }
    >();
    for (const change of changes) {
      if (change.kind !== ChangeKind.Revised) continue;
      const current = readBindingRevision(tx, change.binding_id);
      assert.ok(current && current.removed_at === null);
      for (const revision of readOlderRevisions(tx, current))
        older.set(revision.id, {
          name: current.name,
          pinned: revision.revision,
          current: current.revision,
        });
    }
    if (older.size === EMPTY_LENGTH) return [];
    return this.currentNodePins(tx, projectId, Array.from(older.keys()))
      .map(({ node_id, binding_id }) => {
        const revision = older.get(binding_id);
        assert.ok(revision);
        return {
          node_id,
          binding_name: revision.name,
          pinned_revision: revision.pinned,
          current_revision: revision.current,
        };
      })
      .sort(byNodeThenName);
  }
  private savedBindingSet(
    projectId: string,
    version: number,
  ): Map<string, StoredBinding> {
    return this.operationalStore.transaction((tx) =>
      requireProject(tx, projectId).binding_set_version === version
        ? readCurrentBindingSet(tx, projectId)
        : new Map(),
    );
  }
  private sshAccess(platform: string, release: SshRelease): ReleasedAccess {
    return this.operationalStore.transaction((tx) => {
      const now = Date.now();
      const grant = this.custody.authorizeOperation(
        tx,
        { kind: GrantKind.SshIdentity, ...release, claim: null },
        now,
      );
      const granted = this.custody.grantFacts(grant);
      refuseForeignHost(platform, granted.facts.address);
      const material = this.custody.release(tx, grant, now);
      const ssh = this.sshAccessOf(tx, granted, material);
      return { address: granted.facts.address, ssh };
    });
  }
  private async checkRepository(
    projectId: string,
    config: typeof repositoryConfigSchema._output,
    caller: CallerContext,
  ): Promise<void> {
    const { context } = caller;
    context.signal.throwIfAborted();
    const { address, ssh } = this.sshAccess(config.platform, {
      identity: callerIdentity(caller),
      subject: draftSubject(projectId, config),
    });
    try {
      await this.repositoryConnector.gitLsRemote(
        address,
        context,
        LS_REMOTE_TIMEOUT_MS,
        ssh,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      throw new OperationError(
        SSH_UNREACHABLE_STATUS,
        ProjectErrorCode.RepositorySshUnreachable,
        "Repository SSH read failed.",
        { failure_reason: gitFailureReason(error) },
      );
    }
    context.signal.throwIfAborted();
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
        endsGroup(workerConfigSchema.parse(latest.config))
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
    if (binding.kind === BindingKind.Repository)
      validatePrompts(binding.config.prompts ?? {});
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
    this.validateEnvironmentSecrets(
      tx,
      name,
      binding.config.environment_secrets ?? {},
    );
  }
  private validateEnvironmentSecrets(
    tx: Transaction,
    name: string,
    secrets: Record<string, string>,
  ): void {
    Object.entries(secrets).forEach(([variable, credential], index) => {
      const refuse = () =>
        new OperationError(
          HttpStatus.BadRequest,
          ProjectErrorCode.EnvironmentSecretInvalid,
          "The environment secret is not valid.",
          { binding: name, variable, credential },
        );
      if (
        index >= ENVIRONMENT_SECRETS_MAX ||
        !ENVIRONMENT_SECRET_VARIABLE.test(variable)
      )
        throw refuse();
      try {
        this.custodySuitability(tx, {
          credential,
          platform: ENVIRONMENT_SECRET_PLATFORM,
        });
      } catch (error) {
        if (error instanceof OperationError) throw refuse();
        throw error;
      }
    });
  }
  private validateWorker(
    tx: Transaction,
    name: string,
    config: typeof workerConfigWriteSchema._output,
  ): void {
    refuseInvalidTags(name, config.tags);
    const agents = this.workerAgentsOf(config.worker);
    if (agents.length === EMPTY_LENGTH) {
      this.validateEntry(tx, config.worker, null, []);
      for (const field of [
        WorkerField.Entries,
        WorkerField.ResourceBudget,
        WorkerField.Placement,
        WorkerField.WorkerInstances,
        WorkerField.Environment,
      ]) {
        if (config[field] === undefined) continue;
        throw new OperationError(
          HttpStatus.BadRequest,
          ProjectErrorCode.WorkerFieldForbidden,
          "External workers do not accept native configuration fields.",
          { binding: name, field },
        );
      }
      refuseInstanceCount(config);
      return;
    }
    for (const field of [WorkerField.Placement, WorkerField.InstanceCount]) {
      if (config[field] === undefined) continue;
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerFieldForbidden,
        "A native worker binding lists worker_instances and states no placement and no instance_count.",
        { binding: name, field },
      );
    }
    const instances = this.validateWorkerInstances(tx, name, config);
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
      this.validateEntry(
        tx,
        config.worker,
        entries.get(agent) ?? null,
        bindingHolders(
          listedInstances(tx, this.instanceOf, {
            worker_instances: instances,
          }),
        ),
      );
  }
  private validateWorkerInstances(
    tx: Transaction,
    name: string,
    config: typeof workerConfigWriteSchema._output,
  ): string[] {
    if (config.worker_instances === undefined)
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.WorkerInstancesRequired,
        "A native worker binding lists its worker instances.",
        { binding: name },
      );
    const instances = refuseInvalidInstances(name, config.worker_instances);
    for (const instance of instances) {
      const record = this.instanceOf(tx, instance);
      if (!record)
        throw new OperationError(
          HttpStatus.BadRequest,
          ProjectErrorCode.WorkerInstanceUnknown,
          "The binding lists an unknown or archived worker instance.",
          { binding: name, instance },
        );
      if (record.worker !== config.worker)
        throw new OperationError(
          HttpStatus.BadRequest,
          ProjectErrorCode.WorkerInstanceWorkerMismatch,
          "The binding lists a worker instance of another worker.",
          { binding: name, instance, worker: record.worker },
        );
    }
    return instances;
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
            holders: bindingHolders(
              listedInstances(tx, this.instanceOf, config),
            ),
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
    const current = bindingSchema.parse({
      kind: kindOf(latest.resource_identity),
      config: latest.config,
    });
    const disabled =
      current.kind === BindingKind.Worker
        ? effectiveInstanceCount(current.config) === INSTANCE_COUNT_MIN
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
      worker_instances: config.worker_instances ?? [],
      environment: resolveEnvironment(
        tx,
        this.instanceOf,
        config,
        binding.project_id,
      ),
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
      resource_identity: binding.resource_identity,
      project_id: binding.project_id,
      name: binding.name,
      address: config.address,
      platform: config.platform,
      ssh_credential: config.ssh_credential,
      credential: config.credential ?? null,
      base_branch: config.strategy.base_branch,
      action: config.strategy.action?.name ?? null,
      landing: config.strategy.action?.landing ?? Landing.Human,
      prompts: config.prompts ?? {},
      environment: currentEnvironmentOf(tx, binding),
      repository_environment: noStoredEnvironment(tx, binding.project_id),
    };
  }
  private targetOfBinding(
    projectId: string,
    bindingId: string,
  ): EnvironmentTarget {
    const binding = this.operationalStore.transaction((tx) =>
      readBindingRevision(tx, bindingId),
    );
    assert.ok(binding);
    const recorded = this.onboarding
      .states(projectId)
      .find((state) => state.resource_identity === binding.resource_identity);
    if (recorded !== undefined) return recorded.target;
    const facts = this.bindingFactsOf(projectId);
    const group = facts.repositories.find(
      (candidate) => candidate.resource_identity === binding.resource_identity,
    );
    assert.ok(group, "A readable binding belongs to the current binding set.");
    return targetOf(group, facts);
  }
  private bindingFactsOf(projectId: string): BindingFacts {
    return this.operationalStore.transaction((tx) => {
      const bindings = Array.from(
        readCurrentBindingSet(tx, projectId).values(),
      );
      return {
        repositories: bindings
          .filter(
            (binding) =>
              kindOf(binding.resource_identity) === BindingKind.Repository,
          )
          .map((binding) => ({
            binding_id: binding.id,
            binding_name: binding.name,
            resource_identity: binding.resource_identity,
            environment_secrets:
              repositoryConfigSchema.parse(binding.config)
                .environment_secrets ?? {},
          })),
        workers: bindings
          .filter(
            (binding) =>
              kindOf(binding.resource_identity) === BindingKind.Worker,
          )
          .map((binding) => {
            const config = workerConfigSchema.parse(binding.config);
            return {
              placements: listedInstances(tx, this.instanceOf, config).map(
                ({ placement }) => placement,
              ),
              external: config.worker_instances === undefined,
              environment: config.environment ?? null,
            };
          }),
      };
    });
  }
  private workerEnvironmentOf(
    projectId: string,
    resourceIdentity: string,
  ): string | null {
    const binding = this.operationalStore.transaction((tx) =>
      Array.from(readCurrentBindingSet(tx, projectId).values()).find(
        (entry) => entry.resource_identity === resourceIdentity,
      ),
    );
    if (binding === undefined) return null;
    return workerConfigSchema.parse(binding.config).environment ?? null;
  }
  environmentsClaimable(
    projectId: string,
    resourceIdentities: readonly string[],
  ): boolean {
    return this.onboarding.environmentsClaimable(projectId, resourceIdentities);
  }
  slotImage(
    projectId: string,
    workerResourceIdentity: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.onboarding.slotImage(projectId, workerResourceIdentity, signal);
  }
  slotCacheGroupOf(
    projectId: string,
    workerResourceIdentity: string,
    image: string,
  ): string | null {
    return this.onboarding.slotCacheGroupOf(
      projectId,
      workerResourceIdentity,
      image,
    );
  }
  environmentClaimed(projectId: string, resourceIdentity: string): void {
    this.onboarding.environmentClaimed(projectId, resourceIdentity);
  }
  environmentDigestOf(
    projectId: string,
    resourceIdentity: string,
  ): string | null {
    return this.onboarding.environmentDigestOf(projectId, resourceIdentity);
  }
  environmentOf(projectId: string, resourceIdentity: string) {
    return this.onboarding.environmentOf(projectId, resourceIdentity);
  }
  environmentFailed(input: EnvironmentFailedInput): void {
    this.onboarding.environmentFailed(input);
  }
  environmentStates(projectId: string) {
    return this.onboarding.states(projectId);
  }
  rebuildEnvironment(projectId: string, bindingId: string) {
    return this.onboarding.rebuild(projectId, bindingId);
  }
  exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void> {
    return this.environments.exportRepository(
      bindingId,
      commit,
      directory,
      context,
    );
  }
  projectNameOf(tx: Transaction, projectId: string): string {
    assert.ok(tx.database.isTransaction);
    assert.ok(
      projectId.length > EMPTY_IDENTITY_LENGTH,
      "A project identity is required.",
    );
    const project = requireProject(tx, projectId);
    assert.equal(project.id, projectId);
    return project.name;
  }
  projectPaused(tx: Transaction, projectId: string): boolean {
    assert.ok(tx.database.isTransaction);
    return requireProject(tx, projectId).paused_at !== null;
  }
  environmentsMixed(
    tx: Transaction,
    projectId: string,
    resourceIdentities: readonly string[],
  ): boolean {
    assert.ok(tx.database.isTransaction);
    const current = Array.from(readCurrentBindingSet(tx, projectId).values());
    const atContainer = current.some(
      (entry) =>
        kindOf(entry.resource_identity) === BindingKind.Worker &&
        listsContainer(
          tx,
          this.instanceOf,
          workerConfigSchema.parse(entry.config),
        ),
    );
    if (!atContainer) return false;
    const forms = new Set(
      current
        .filter(
          (entry) =>
            kindOf(entry.resource_identity) === BindingKind.Repository &&
            resourceIdentities.includes(entry.resource_identity),
        )
        .flatMap((entry) => {
          const { environment } = repositoryConfigSchema.parse(entry.config);
          return environment === undefined ? [] : [canonicalJSON(environment)];
        }),
    );
    return forms.size > SINGLE_FORM;
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
    return workerRowOf(
      tx,
      this.instanceOf,
      row,
      requireProject(tx, projectId).name,
    );
  }
  workerBindingsOf(
    tx: Transaction,
    projectId: string | null,
  ): Array<
    WorkerBindingRow & { project_id: string; resource_identity: string }
  > {
    assert.ok(tx.database.isTransaction);
    const rows =
      projectId === null
        ? readCurrentBindings(tx)
        : Array.from(readCurrentBindingSet(tx, projectId).values());
    const projectNames = new Map<string, string>();
    return rows.flatMap((row) => {
      if (kindOf(row.resource_identity) !== BindingKind.Worker) return [];
      const projectName =
        projectNames.get(row.project_id) ??
        requireProject(tx, row.project_id).name;
      projectNames.set(row.project_id, projectName);
      return [
        {
          ...workerRowOf(tx, this.instanceOf, row, projectName),
          project_id: row.project_id,
          resource_identity: row.resource_identity,
        },
      ];
    });
  }
  async resolveWorkerGroup(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ) {
    context.signal.throwIfAborted();
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
      const config = workerConfigSchema.parse(row.config);
      if (endsGroup(config)) return null;
      const tombstone = readLatestTombstone(tx, projectId, resourceIdentity);
      if (tombstone && tombstone.created_at > issuedAt) return null;
      return {
        project_id: projectId,
        resource_identity: resourceIdentity,
        ...(config.worker_instances === undefined
          ? {}
          : { worker_instances: config.worker_instances }),
      };
    });
  }
  async workerGroupEnded(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ): Promise<boolean> {
    context.signal.throwIfAborted();
    if (this.bindings)
      return this.bindings.workerGroupEnded(
        projectId,
        resourceIdentity,
        issuedAt,
        context,
      );
    return this.operationalStore.transaction((tx) => {
      const row = readLatestBinding(tx, projectId, resourceIdentity);
      if (!row || kindOf(row.resource_identity) !== BindingKind.Worker)
        return false;
      if (row.removed_at !== null) return true;
      const config = workerConfigSchema.parse(row.config);
      if (endsGroup(config)) return true;
      const tombstone = readLatestTombstone(tx, projectId, resourceIdentity);
      return tombstone !== null && tombstone.created_at > issuedAt;
    });
  }
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private async startOnboarding(): Promise<Error | null> {
    try {
      ensureDirectory(join(this.stateDirectory, ENVIRONMENT_DIRECTORY));
      await this.onboarding.start();
      return null;
    } catch (error) {
      return asError(error);
    }
  }
  private async stopOnboarding(): Promise<Error | null> {
    try {
      await this.onboarding.stop();
      return null;
    } catch (error) {
      return asError(error);
    }
  }
  cancelEnvironmentRuns(): void {
    this.onboarding.cancel();
  }
  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Diagnostic(
          "project.lifecycle.stopped",
          "project: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= this.startOnboarding();
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= this.stopOnboarding();
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
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
  }
  resourceInventory(tx: Transaction): ResourceEntry[] {
    return readCurrentRepositories(tx).map(
      ({
        project_name: projectName,
        binding_id: bindingId,
        name,
        address,
        platform,
      }) => {
        const check: ResourceCheck = async (context, observe) => {
          try {
            const deadline = context.deadline;
            assert.ok(deadline !== null);
            context.signal.throwIfAborted();
            let access: ReleasedAccess;
            try {
              access = this.sshAccess(platform, {
                identity: this.identity,
                subject: {
                  kind: SshIdentitySubjectKind.Binding,
                  binding_id: bindingId,
                },
              });
            } catch (error) {
              if (error instanceof OperationError)
                observe?.(error.code, repositoryFailureReason(error));
              throw error;
            }
            const expired = () =>
              context.signal.reason instanceof DeadlineExceeded;
            try {
              using deadlineObserver = addAbortListener(context.signal, () => {
                if (expired())
                  observe?.(
                    ProjectErrorCode.RepositorySshUnreachable,
                    ResourceFailureReason.DeadlineExceeded,
                  );
              });
              await this.repositoryConnector.gitLsRemote(
                access.address,
                context,
                deadline - Date.now(),
                access.ssh,
              );
            } catch (error) {
              if (!expired())
                observe?.(
                  ProjectErrorCode.RepositorySshUnreachable,
                  gitFailureReason(error),
                );
              throw error;
            }
            return ResourceStatus.Healthy;
          } catch {
            return context.signal.aborted
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
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
