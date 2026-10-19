import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { deriveClientSecret } from "../../gateway/auth/jwt.ts";
import {
  directories,
  configPath,
  loadConfig,
  type ServerConfig,
} from "../../config/index.ts";
import type { Logger } from "pino";
import {
  CustodyComponent,
  custodyMigrations,
  deriveEnvelopeKey,
  enforceMasterKey,
  grantFacts,
} from "../../custody/index.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import {
  executionTrace,
  SchedulerService,
  schedulerMigrations,
} from "../../scheduler/index.ts";
import {
  SCHEDULER_SERVICE_NAME,
  type WorkQueue,
} from "../../scheduler/contract.ts";
import { TrackingService, trackingMigrations } from "../../tracking/index.ts";
import {
  MISSION_PRODUCER,
  TRACKING_SERVICE_NAME,
} from "../../tracking/contract.ts";
import {
  MissionService,
  missionMigrations,
  uploadCheckSpan,
} from "../../mission/index.ts";
import {
  MISSION_SERVICE_NAME,
  missionOperations,
} from "../../mission/contract.ts";
import {
  RepositoryPlatform,
  projectOperations,
  type ProjectBindings,
  type RepositoryConnector,
} from "../../project/contract.ts";
import type { WorkerRegistrations } from "../../worker/contract.ts";
import { audit, ensureDirectory } from "../../kernel/files.ts";
import {
  Diagnostic,
  diagnostic,
  diagnosticFields,
  asError,
  OperationError,
} from "../../kernel/errors.ts";
import {
  healthy,
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../kernel/service.ts";
import { OperationalLog } from "../../kernel/log.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  Store,
  type Migrations,
  type Transaction,
} from "../../kernel/store.ts";
import {
  HealthRegistry,
  HealthScope,
  type ResourceEntry,
} from "../../kernel/health.ts";
import { GatewayService } from "../../gateway/index.ts";
import type { ResourceInventories } from "../../gateway/contract.ts";
import {
  gatewayMigrations,
  directClient,
  createInvocation,
  collectInventories,
} from "../../gateway/index.ts";
import { ProjectService, projectMigrations } from "../../project/index.ts";
import { IntakeService, intakeMigrations } from "../../intake/index.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  intakeOperations,
} from "../../intake/contract.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  WorkerService,
  workerMigrations,
  toolDeclarations,
} from "../../worker/index.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { WorkerPool } from "./worker-pool.ts";
import { AgentComponent, agentMigrations } from "../../agent/index.ts";
import {
  WorkbenchService,
  workbenchDirectory,
  workbenchMigrations,
  type WorkbenchModelRuntimeFactory,
} from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  RepositoryComponent,
  RepositoryCredentials,
  REPOSITORY_PLATFORMS,
  decodeGitHubEvent,
  platformImplementations,
  repositoryFiles,
  type GitWriter,
} from "../../repository/index.ts";
import { LlmComponent, LLM_PLATFORMS } from "../../llm/index.ts";
import {
  StorageComponent,
  STORAGE_PLATFORMS,
  storageImplementations,
} from "../../storage/index.ts";
import {
  OperationRegistry,
  OperationResultType,
  StoreName,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";

export type { RepositoryConnector } from "../../project/contract.ts";
export { enforceMasterKey, verifyMasterKey } from "../../custody/index.ts";

function resultOf<T>(result: OperationResult<T>): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new OperationError(
      result.status,
      result.error.error.code,
      result.error.error.message,
      result.error.error.details,
    );
  assert.equal(result.type, OperationResultType.Indeterminate);
  throw new OperationError(
    HttpStatus.InternalServerError,
    "system.operation.unknown",
    "Operation failed.",
  );
}

export function projectScopedIntakeInventory(
  intake: IntakeService,
  project: ProjectService,
): (tx: Transaction) => ResourceEntry[] {
  return (tx) => {
    assert.ok(tx.database.isTransaction);
    const entries = intake.resourceInventory(tx);
    const scoped = entries.map(({ project_id, ...entry }) => ({
      ...entry,
      scope: HealthScope.Project,
      project: project.projectNameOf(tx, project_id),
    }));
    assert.equal(scoped.length, entries.length);
    return scoped;
  };
}

export function composeServices(options: {
  config: ServerConfig;
  store: Store;
  trackingStore: Store;
  stateDirectory: string;
  logger: Logger;
  health: HealthRegistry;
  repositoryConnector?: RepositoryConnector;
  github?: { baseUrl: string; mergeabilityRetryDelayMs?: number };
  repositoryTransport?: GitWriter;
  oauthProviders?: ConstructorParameters<
    typeof LlmComponent
  >[0]["oauthProviders"];
  loadModelRuntime?: ConstructorParameters<
    typeof LlmComponent
  >[0]["loadModelRuntime"];
  registry?: OperationRegistry;
  bindings?: ProjectBindings;
  registrations?: WorkerRegistrations;
  workbenchModelRuntimeFactory?: WorkbenchModelRuntimeFactory;
  inventoryOverrides?: Partial<ResourceInventories>;
  intake?: { pendingEventLimit?: number; pollIntervalMs?: number };
}) {
  const repoConnector =
    options.repositoryConnector ??
    new RepositoryComponent({ health: options.health });
  const github = new platformImplementations.github(options.github);
  const s3 = new storageImplementations.s3();
  const gitWriter: GitWriter =
    options.repositoryTransport ??
    (repoConnector instanceof RepositoryComponent
      ? repoConnector
      : new RepositoryComponent());
  const envelopeKey = deriveEnvelopeKey(options.config.master_key);
  const registry = options.registry ?? new OperationRegistry();
  const invocation = createInvocation({
    registry,
    stores: {
      [StoreName.Operational]: options.store,
      [StoreName.Tracking]: options.trackingStore,
    },
    idempotencyTtl: options.config.gateway.idempotency_ttl,
    masterKey: options.config.master_key,
    authVersion: options.config.gateway.auth.version,
    lookups: {
      scheduler: {
        executionOf: (executionId) => scheduler.executionOf(executionId),
      },
      project: {
        resolveWorkerGroup: (projectId, resourceIdentity, issuedAt, context) =>
          project.resolveWorkerGroup(
            projectId,
            resourceIdentity,
            issuedAt,
            context,
          ),
      },
      worker: {
        findByClient: (client) => worker.registrations.findByClient(client),
        heartbeat: (runtimeIdentity) =>
          worker.registrations.heartbeat(runtimeIdentity),
      },
    },
  });
  const workerPool = new WorkerPool({
    invocation,
    masterKey: options.config.master_key,
    authVersion: options.config.gateway.auth.version,
    slotLimit: options.config.worker.server_slot_limit,
    stateDirectory: options.stateDirectory,
    logger: options.logger,
    runtimeIdentity: (clientId) =>
      worker.registrations.findByClient(clientId)?.runtime_identity,
  });
  const missionClient = directClient(missionOperations, invocation);
  const intakeClient = directClient(intakeOperations, invocation);
  const projectClient = directClient(projectOperations, invocation);
  const missionIdentity = mintServiceIdentity(MISSION_SERVICE_NAME);
  const scheduler: SchedulerService = new SchedulerService({
    config: options.config.scheduler,
    store: options.store,
    transitions: {
      claim: (...args: Parameters<MissionService["claim"]>) =>
        mission.claim(...args),
      release: (...args) => mission.release(...args),
      failure: (...args) => mission.failure(...args),
    },
    registrations: {
      clientAttributionOf: (tx, runtimeIdentity) =>
        worker.registrations.clientAttributionOf(tx, runtimeIdentity),
      instanceHealthcheck: (tx, runtimeIdentity) =>
        worker.instanceHealthcheck(tx, runtimeIdentity),
    },
    declarations: {
      declarationOf: (workerName) => worker.declarationOf(workerName),
    },
    bindings: {
      workerBindingOf: (tx, projectId, resourceIdentity) =>
        project.workerBindingOf(tx, projectId, resourceIdentity),
      workerBindingsOf: (tx, projectId) =>
        project.workerBindingsOf(tx, projectId),
    },
    facts: {
      claimFacts: (tx, nodeId) => mission.claimFacts(tx, nodeId),
      claimFactsOf: (tx, projectId) => mission.claimFactsOf(tx, projectId),
    },
    branches: {
      nodeBranchesOf: (tx, keys) => mission.nodeBranchesOf(tx, keys),
    },
    projects: {
      projectPaused: (tx, projectId) => project.projectPaused(tx, projectId),
    },
    agentChains: {
      select: (tx, workerBindingId) => worker.agentChoice(tx, workerBindingId),
      resolve: (tx, workerBindingId, pins) =>
        worker.agentSelectionsAt(tx, workerBindingId, pins),
      providerFailure: (tx, selections, code, executionId, now) =>
        agent.recordProviderFailure(tx, selections, code, executionId, now),
      success: (tx, selections, executionId) =>
        agent.recordSuccess(tx, selections, executionId),
      selected: (selections, executionId) => {
        agent.recordSelection(selections, executionId);
      },
      cooldownsChanged: (changes) => {
        agent.recordCooldowns(changes);
      },
    },
    traceIdentity: {
      mint: () => ({
        trace_id: randomBytes(16).toString("hex"),
        root_span_id: randomBytes(8).toString("hex"),
      }),
    },
    telemetry: {
      executionOpened: (trace, createdAt) =>
        tracking.executionOpened(trace, createdAt),
      executionEnded: (end) => tracking.executionEnded(end),
    },
    health: options.health,
  });
  const tracking = new TrackingService({
    store: options.trackingStore,
    executions: {
      traceOf: (executionId) => {
        const row = scheduler.executionOf(executionId);
        return row === undefined ? undefined : executionTrace(row);
      },
    },
    health: options.health,
  });
  const workQueue: WorkQueue = {
    insert: (tx, nodeId, projectId, priority) =>
      scheduler.insert(tx, nodeId, projectId, priority),
    delete: (tx, nodeId) => scheduler.delete(tx, nodeId),
    priorityUpdate: (tx, nodeId, priority) =>
      scheduler.priorityUpdate(tx, nodeId, priority),
  };
  const custody = new CustodyComponent({
    platforms: {
      ...LLM_PLATFORMS,
      ...REPOSITORY_PLATFORMS,
      ...STORAGE_PLATFORMS,
    },
    executions: {
      requireRunning: (...args) => scheduler.requireRunning(...args),
      pinCredential: (...args) => scheduler.pinCredential(...args),
      liveExecutionsPinning: (...args) =>
        scheduler.liveExecutionsPinning(...args),
    },
    authorization: {
      authorizeModelInference: (...args) =>
        worker.authorizeModelInference(...args),
    },
    missionAuthorization: {
      frozenAction: (...args) => mission.authorizeFrozenAction(...args),
      requestEvidence: (...args) => mission.authorizeRequestEvidence(...args),
      evidenceAsset: (...args) => mission.authorizeEvidenceAsset(...args),
      objectPut: (...args) => mission.authorizeObjectPut(...args),
    },
    clientSecret: (clientId) =>
      deriveClientSecret(
        options.config.master_key,
        options.config.gateway.auth.version,
        clientId,
      ),
    store: options.store,
    envelopeKey,
    logger: options.logger,
    health: options.health,
    agentProvidersDependentOn: (tx, name) =>
      agent.agentProvidersDependentOn(tx, name),
    bindingsNaming: (tx, name) => project.bindingsNaming(tx, name),
    inboundsNaming: (tx, name) => intake.inboundsNaming(tx, name),
    intakeServiceName: INTAKE_SERVICE_NAME,
  });
  const llm = new LlmComponent({
    records: custody,
    store: options.store,
    logger: options.logger,
    oauthProviders: options.oauthProviders,
    agentProvidersDependentOn: (tx, name) =>
      agent.agentProvidersDependentOn(tx, name),
    enablementsDependentOnModel: (tx, name, model) =>
      agent.enablementsDependentOnModel(tx, name, model),
    loadModelRuntime: options.loadModelRuntime ?? loadPi,
  });
  const agent: AgentComponent = new AgentComponent({
    store: options.store,
    config: options.config.agent,
    dataDirectory: directories(process.env).data,
    workbenchDirectory: (name) =>
      workbenchDirectory(options.stateDirectory, name),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    credentialHolds: {
      holdOf: (tx, name) => custody.holds.holdOf(tx, name),
      hold: (tx, name, availableAt, strikes) =>
        custody.holds.hold(tx, name, availableAt, strikes),
      release: (tx, name) => custody.holds.release(tx, name),
      listHolds: (tx) => custody.holds.listHolds(tx),
    },
    approvedModels: (tx, name) => llm.approvedModels(tx, name),
    providerHealthCheck: (tx, name) => llm.providerHealthCheck(tx, name),
    providerCapability: (tx, name) => llm.providerCapability(tx, name),
    entriesOfAgent: (tx, name) => project.entriesOfAgent(tx, name),
    repositoryWorkingOf: (tx, id) => project.repositoryPolicyOf(tx, id),
    toolDeclarations: (name) => toolDeclarations(name),
    logger: options.logger,
  });
  const repositoryCredentials = new RepositoryCredentials({
    store: options.store,
    records: custody,
    bindingsNaming: (tx, name) => project.bindingsNaming(tx, name),
    resolveSshIdentity: (host, context, deadlineMs) =>
      repoConnector.resolveSshIdentity(host, context, deadlineMs),
  });
  const storage = new StorageComponent({
    records: custody,
    bindingsNaming: (tx, name) => project.bindingsNaming(tx, name),
  });
  const worker: WorkerService = new WorkerService({
    missionActions: {
      authorizeRequest: (...args) => mission.authorizeRequest(...args),
      authorizeAction: (...args) => mission.authorizeAction(...args),
      actionContextOf: (...args) => mission.actionContextOf(...args),
    },
    evidenceRequests: {
      request: (input, options) =>
        missionClient["evidence.request"](input, options),
    },
    intakeActions: {
      perform: async (call, action, requestKey) =>
        resultOf(
          await intakeClient["action.perform"](
            {
              params: { execution_id: call.executionId },
              query: {},
              body: {
                key: action.key,
                commit: action.commit,
                reused_evidence_id: action.reusedEvidenceId,
                merge_evidence_id: action.mergeEvidenceId ?? null,
                request_key: requestKey,
              },
            },
            {
              identity: call.identity,
              context: call.context,
              idempotencyKey: ulid(),
            },
          ),
        ),
      read: async (call, method, evidenceId, page) =>
        resultOf(
          await intakeClient["action.read"](
            {
              params: {
                execution_id: call.executionId,
                evidence_id: evidenceId,
              },
              query: { method, ...page },
              body: null,
            },
            { identity: call.identity, context: call.context },
          ),
        ),
    },
    custodyHandover: {
      handover: (...args) => custody.handover(...args),
      report: (...args) => custody.report(...args),
    },
    config: options.config.worker,
    agentPrompt: {
      compose: (name, context) => agent.composePrompt(name, context),
      templates: (context) => agent.promptTemplates(context),
    },
    store: options.store,
    workerBindingOf: (tx, projectId, resourceIdentity) =>
      project.workerBindingOf(tx, projectId, resourceIdentity),
    workerBindingRowOf: (tx, id) => project.workerBindingRowOf(tx, id),
    repositoryPolicyOf: (tx, id) => project.repositoryPolicyOf(tx, id),
    repositoryBindingIdsOf: (tx, nodeId, revision) =>
      mission.repositoryBindingIdsOf(tx, nodeId, revision),
    intentOf: (tx, nodeId, revision) => mission.intentOf(tx, nodeId, revision),
    pinnedCredentialMetadata: (tx, execution, name, now) =>
      custody.pinnedCredentialMetadata(tx, execution, name, now),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    schedulerClaims: {
      requireRunning: (...args) => scheduler.requireRunning(...args),
      runningExecutionOfRuntime: (...args) =>
        scheduler.runningExecutionOfRuntime(...args),
      activityOf: (...args) => scheduler.activityOf(...args),
      agentSelectionsOf: (...args) => scheduler.agentSelectionsOf(...args),
    },
    health: options.health,
    registrations: options.registrations,
    pool: {
      host: workerPool,
      workerBindingsOf: (tx, projectId) =>
        project.workerBindingsOf(tx, projectId),
      logger: options.logger,
    },
    agentConfiguration: {
      validateEntry: (tx, name, entry) => agent.validateEntry(tx, name, entry),
      agentView: (tx, name, entry, models) =>
        agent.agentView(tx, name, entry, models),
      selectAgent: (tx, name, entry) => agent.selectAgent(tx, name, entry),
      selectionAt: (tx, name, enablementId, entry, position) =>
        agent.selectionAt(tx, name, enablementId, entry, position),
      selectionView: (tx, selection, models) =>
        agent.selectionView(tx, selection, models),
    },
  });
  const mission: MissionService = new MissionService({
    store: options.store,
    intakeStorage: {
      put: async (call, input) =>
        resultOf(
          await intakeClient["storage.put"](
            {
              params: { execution_id: call.executionId },
              query: {},
              body: {
                node_id: input.nodeId,
                asset_id: input.assetId,
                storage_binding_id: input.storageBindingId,
                size: input.size,
                sha256: input.sha256,
              },
            },
            { identity: call.identity, context: call.context },
          ),
        ),
      check: async (call, assetId) =>
        resultOf(
          await intakeClient["storage.check"](
            {
              params: { execution_id: call.executionId, asset_id: assetId },
              query: {},
              body: null,
            },
            { identity: call.identity, context: call.context },
          ),
        ),
      get: async (call, assetId) =>
        resultOf(
          await intakeClient["storage.get"](
            { params: { asset_id: assetId }, query: {}, body: null },
            { identity: call.identity, context: call.context },
          ),
        ),
      executionGet: async (call, assetId) =>
        resultOf(
          await intakeClient["execution.storage.get"](
            {
              params: { execution_id: call.executionId, asset_id: assetId },
              query: {},
              body: null,
            },
            { identity: call.identity, context: call.context },
          ),
        ),
      delete: async (call, assetId) => {
        resultOf(
          await intakeClient["storage.delete"](
            { params: { asset_id: assetId }, query: {}, body: null },
            {
              identity: call.identity,
              context: call.context,
              idempotencyKey: ulid(),
            },
          ),
        );
      },
    },
    decoder: {
      decode: ({ platform, resource, event, metadata }) =>
        platform === RepositoryPlatform.GitHub
          ? decodeGitHubEvent({ resource, event, metadata })
          : null,
    },
    intakeCheck: {
      check: async (context, evidenceId) =>
        resultOf(
          await intakeClient["action.check"](
            { params: {}, query: {}, body: { evidence_id: evidenceId } },
            { identity: missionIdentity, context },
          ),
        ),
    },
    config: options.config.mission,
    health: options.health,
    workQueue,
    schedulerClaims: {
      revoke: (...args) => scheduler.revoke(...args),
      settle: (...args) => scheduler.settle(...args),
      liveExecutionOf: (...args) => scheduler.liveExecutionOf(...args),
    },
    schedulerMatch: {
      unmatchedClaims: (tx, projectId) =>
        scheduler.unmatchedClaims(tx, projectId),
    },
    wakeup: { wake: (projectId) => scheduler.wake(projectId) },
    executionAttribution: {
      of: (...args) => scheduler.executionAttribution(...args),
    },
    telemetry: {
      uploadCheckFailed: (failure) => {
        const row = scheduler.executionOf(failure.execution_id);
        if (row === undefined) return;
        const trace = executionTrace(row);
        tracking.serverSpan(
          trace,
          MISSION_PRODUCER,
          uploadCheckSpan(trace, failure, randomBytes(8).toString("hex")),
        );
      },
    },
    logger: options.logger,
    bindings: {
      resolveBinding: (tx, pid, name) => project.resolveBinding(tx, pid, name),
      resolveBindingIdentity: (tx, pid, bid) =>
        project.resolveBindingIdentity(tx, pid, bid),
      getBindingRevision: (tx, bid) => project.getBindingRevision(tx, bid),
      repositoryPolicyOf: (tx, bid) => project.repositoryPolicyOf(tx, bid),
      storageBindingOf: (tx, bid) => project.storageBindingOf(tx, bid),
    },
  });
  const project: ProjectService = new ProjectService({
    config: {},
    operationalStore: options.store,
    stateDirectory: options.stateDirectory,
    wakeup: { wake: (projectId) => scheduler.wake(projectId) },
    endRegistrations: (tx, projectId, resourceIdentity, now) =>
      worker.endRegistrations(tx, projectId, resourceIdentity, now),
    bindingsChanged: (projectId) => worker.bindingsChanged(projectId),
    createMission: (tx, pid, actor) => mission.createMission(tx, pid, actor),
    liveNodesPinning: (tx, bid) => mission.liveNodesPinning(tx, bid),
    unmatchedClaims: (tx, projectId) =>
      scheduler.unmatchedClaims(tx, projectId),
    validateEntry: (tx, name, entry) => worker.validateEntry(tx, name, entry),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    repositoryConnector: repoConnector,
    repositoryFiles,
    verifyRepositoryCredential: (name, context) =>
      repositoryCredentials.verifyCredential(name, context),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    workerAgentsOf: (name) => worker.workerAgentsOf(name),
    workerAgentView: (tx, w, a, entry) =>
      worker.workerAgentView(tx, w, a, entry),
    health: options.health,
    bindings: options.bindings,
  });
  const intakeIdentity = mintServiceIdentity(INTAKE_SERVICE_NAME);
  const intake: IntakeService = new IntakeService({
    store: options.store,
    logger: options.logger,
    health: options.health,
    identity: intakeIdentity,
    custody: {
      authorizeOperation: (...args) => custody.authorizeOperation(...args),
      release: (...args) => custody.release(...args),
      consume: (...args) => custody.consume(...args),
      grantFacts,
      custodySuitability: (...args) => custody.custodySuitability(...args),
    },
    github,
    gitWriter,
    s3,
    masterKey: options.config.master_key,
    projects: { get: projectClient.get },
    consumers: {
      [Consumer.MissionDeliveryAdmit]: (input, consumerOptions) =>
        missionClient["delivery.admit"](
          { params: {}, query: {}, body: input },
          consumerOptions,
        ),
    },
    unresolvedRequests: (input, counterOptions) =>
      missionClient["delivery.unresolved_request.count"](
        { params: {}, query: {}, body: input },
        counterOptions,
      ),
    pendingEventLimit: options.intake?.pendingEventLimit,
    pollIntervalMs: options.intake?.pollIntervalMs,
  });
  const workbench = new WorkbenchService({
    store: options.store,
    stateDirectory: options.stateDirectory,
    agentPrompt: {
      compose: (name, context) => agent.composePrompt(name, context),
      templates: (context) => agent.promptTemplates(context),
    },
    agentConfiguration: {
      validateEntry: (tx, name, entry) => agent.validateEntry(tx, name, entry),
      agentView: (tx, name, entry) => agent.agentView(tx, name, entry),
    },
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    workbenchCredentials: (input) => custody.workbenchCredentials(input),
    modelRuntimeFactory: options.workbenchModelRuntimeFactory,
    operations: () => registry.all().map(({ operation }) => operation),
    invoke: (operation, input, clientOptions) =>
      directClient({ [operation.id]: operation }, invocation)[operation.id]!(
        input as never,
        clientOptions,
      ),
  });
  scheduler.declare(registry);
  tracking.declare(registry);
  llm.declare(registry);
  agent.declare(registry);
  repositoryCredentials.declare(registry);
  storage.declare(registry);
  worker.declare(registry);
  mission.declare(registry);
  project.declare(registry);
  intake.declare(registry);
  workbench.declare(registry);
  const gateway = new GatewayService({
    config: options.config.gateway,
    logger: options.logger,
    registry,
    invocation,
    health: options.health,
  });
  gateway.declare(
    registry,
    () =>
      options.store.transaction((tx) =>
        collectInventories(tx, {
          llm:
            options.inventoryOverrides?.llm ??
            ((tx) => llm.resourceInventory(tx)),
          agent:
            options.inventoryOverrides?.agent ??
            ((tx) => agent.resourceInventory(tx)),
          repository:
            options.inventoryOverrides?.repository ??
            ((tx) => repositoryCredentials.resourceInventory(tx)),
          storage:
            options.inventoryOverrides?.storage ??
            ((tx) => storage.resourceInventory(tx)),
          worker:
            options.inventoryOverrides?.worker ??
            ((tx) => worker.resourceInventory(tx)),
          project:
            options.inventoryOverrides?.project ??
            ((tx) => project.resourceInventory(tx)),
          intake:
            options.inventoryOverrides?.intake ??
            projectScopedIntakeInventory(intake, project),
        }),
      ),
    options.logger,
  );
  registry.seal({
    [StoreName.Operational]: options.store,
    [StoreName.Tracking]: options.trackingStore,
  });
  return {
    scheduler,
    tracking,
    workQueue,
    custody,
    llm,
    agent,
    repositoryCredentials,
    storage,
    mission,
    project,
    intake,
    worker,
    workbench,
    gateway,
    invocation,
    registry,
    workerPool,
    repoConnector,
    github,
    gitWriter,
    s3,
  };
}

export const serverMigrations: Migrations = [
  { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
  { service: "gateway", migrations: gatewayMigrations },
  { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
  { service: "worker", migrations: workerMigrations },
  { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  { service: "project", migrations: projectMigrations },
  { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
];

export const DATABASE_FILE = "kanthord.db";
export const TRACKING_DATABASE_FILE = "tracking.db";
export const trackingDatabaseMigrations: Migrations = [
  { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
];

function openStore(path: string, migrations: Migrations): Store {
  const store = new Store(path);
  try {
    const plan = store.plan(migrations);
    if (!plan.fresh && plan.pending.length)
      throw new Diagnostic(
        "system.database.migration.pending",
        "the database has pending migrations; run the command",
        {
          fields: [
            ["path", store.path],
            ["command", "kanthord upgrade"],
          ],
        },
      );
    store.migrate(migrations);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

export class Server implements Service {
  readonly health = new HealthRegistry();
  private readonly path: string;
  private log?: OperationalLog;
  private store?: Store;
  private gateway?: GatewayService;
  private worker?: WorkerService;
  private readonly shutdown = new CancellationContext();
  private readonly serviceContext = new CancellationContext();
  private services: Service[] = [];
  private runs: Promise<Error | null>[] = [];
  private invocation?: ReturnType<typeof createInvocation>;
  private quiesceTask?: Promise<Error | null>;
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly stopped = Promise.withResolvers<Error | null>();
  private readonly releases: Array<() => void | Promise<void | Error | null>> =
    [];
  private runError: Error | null = null;

  constructor(path = configPath()) {
    this.path = path;
    this.health.register("server", () => this.healthcheck());
  }
  logDescriptor(): number {
    return this.log?.descriptor() ?? 2;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "system.lifecycle.stopped",
          "server: a stopped server cannot start again.",
        ),
      );
    this.startTask ??= lifecycle(() => this.open());
    return this.startTask;
  }

  private async open(): Promise<void> {
    process.umask(0o077);
    try {
      const config = loadConfig(this.path);
      const paths = directories();
      audit(dirname(this.path), "directory");
      ensureDirectory(paths.config);
      ensureDirectory(paths.data);
      ensureDirectory(paths.state);
      installPiTools();
      // Validate all files owned by this implementation, including inactive logs.
      audit(join(paths.state, "kanthord.log"), "file", true);
      this.log = new OperationalLog(config.log, paths.state);
      this.releases.push(() => this.log!.close());
      this.store = openStore(join(paths.data, DATABASE_FILE), serverMigrations);
      this.releases.push(() => this.store!.close());
      const trackingStore = openStore(
        join(paths.data, TRACKING_DATABASE_FILE),
        trackingDatabaseMigrations,
      );
      this.releases.push(() => trackingStore.close());
      enforceMasterKey(this.store, config.master_key, this.path);
      throwIfCancelled(this.shutdown);
      const {
        scheduler,
        tracking,
        custody,
        llm,
        worker,
        mission,
        project,
        intake,
        workbench,
        gateway,
        invocation,
      } = composeServices({
        config,
        store: this.store,
        trackingStore,
        stateDirectory: paths.state,
        logger: this.log.logger,
        health: this.health,
      });
      this.gateway = gateway;
      this.worker = worker;
      this.invocation = invocation;
      this.releases.push(() => invocation.stop());
      const services = [
        tracking,
        scheduler,
        custody,
        llm,
        worker,
        mission,
        project,
        intake,
        workbench,
        gateway,
      ];
      this.services = services;
      for (const service of services) this.releases.push(() => service.stop());
      for (const service of services) {
        const error = await service.start();
        if (error) throw error;
        throwIfCancelled(this.shutdown);
      }
      this.runs = services.map((service) =>
        service.run(this.serviceContext).then((error) => {
          if (error && error !== this.serviceContext.err()) {
            this.runError ??= error;
            void this.stop();
          }
          return error;
        }),
      );
      throwIfCancelled(this.shutdown);
      worker.startPool();
    } catch (error) {
      const cleanup = await this.release();
      if (cleanup)
        throw new AggregateError(
          [asError(error), cleanup],
          "Server start and cleanup failed.",
        );
      throw error;
    }
  }

  private async release(): Promise<Error | null> {
    const failures: Error[] = [];
    while (this.releases.length) {
      try {
        const error = await this.releases.pop()!();
        if (error) failures.push(error);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    return failures.length
      ? new AggregateError(failures, "Server resource cleanup failed.")
      : null;
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      const results = await Promise.all(
        this.services.map((service) => service.quiesce()),
      );
      const failures = results.filter((error) => error !== null);
      if (failures.length)
        throw new AggregateError(failures, "Server quiescence failed.");
    });
    return this.quiesceTask;
  }

  stop(): Promise<Error | null> {
    if (this.stopTask) return this.stopTask;
    this.shutdown.cancel();
    this.stopTask = lifecycle(async () => {
      const watchdog = setTimeout(() => process.exit(1), 10000);
      try {
        await this.worker?.stopPool();
        const quiesceError = await this.quiesce();
        await this.startTask;
        const drainError = await lifecycle(async () => {
          await Promise.all(this.services.map((service) => service.drain?.()));
        });
        const invocationError = await this.invocation?.stop();
        const cleanup = await this.release();
        this.serviceContext.cancel();
        await Promise.all(this.runs);
        if (cleanup || invocationError || drainError || quiesceError)
          throw cleanup ?? invocationError ?? drainError ?? quiesceError;
      } finally {
        clearTimeout(watchdog);
      }
    }).then((error) => {
      this.stopped.resolve(error);
      return error;
    });
    return this.stopTask;
  }

  async run(context: Context = background): Promise<Error | null> {
    const stop = () => {
      void this.stop();
    };
    const reopen = () => {
      try {
        this.log?.reopen();
      } catch (error) {
        this.log?.logger.error(
          { reason: diagnostic(error), fields: diagnosticFields(error) },
          "Log reopen failed",
        );
        this.runError = asError(error);
        void this.stop();
      }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", reopen);
    const unsubscribe = context.onCancel(stop);
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) {
        const cleanup = await this.stop();
        return cleanup
          ? new AggregateError(
              [error, cleanup],
              "Server start and cleanup failed.",
            )
          : error;
      }
      return (await this.stopped.promise) ?? this.runError ?? context.err();
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", reopen);
      unsubscribe();
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      gateway:
        this.gateway && healthy(await this.gateway.healthcheck())
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
      store: this.store?.healthcheck()
        ? HealthStatus.Healthy
        : HealthStatus.Unavailable,
      log: this.log?.healthcheck()
        ? HealthStatus.Healthy
        : HealthStatus.Unavailable,
    };
  }
}
