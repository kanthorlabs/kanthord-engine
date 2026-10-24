import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
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
import { CUSTODY_SERVICE_NAME, SERVER_HOLDER } from "../../custody/contract.ts";
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
  PROJECT_PRODUCER,
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
  PROJECT_SERVICE_NAME,
  RepositoryPlatform,
  projectOperations,
  type ProjectBindings,
  type RepositoryConnector,
  type RepositoryFiles,
} from "../../project/contract.ts";
import type {
  PoolPlacement,
  WorkerRegistrations,
} from "../../worker/contract.ts";
import type { SlotDriver } from "./slot-driver.ts";
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
import {
  ProjectService,
  ENVIRONMENT_SECRET_PLATFORMS,
  enforceBindingPlacements,
  projectMigrations,
  projectSshIdentityAuthorization,
} from "../../project/index.ts";
import { IntakeService, intakeMigrations } from "../../intake/index.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  intakeOperations,
} from "../../intake/contract.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  WorkerService,
  isHostedWorker,
  workerMigrations,
  toolDeclarations,
} from "../../worker/index.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { ThreadDriver } from "./thread-driver.ts";
import { ContainerDriver } from "./container-driver.ts";
import { EnvironmentImages } from "./environment-image.ts";
import { HostProofs } from "./environment-host-proof.ts";
import type { EnvironmentRuntime } from "../../project/environment-state.ts";
import { COMMAND_LIMIT_MS } from "../../worker/unit/budget.ts";
import {
  containerOwner,
  systemRuntimeHost,
  type RuntimeHost,
} from "./container-runtime.ts";
import { packageVersion } from "../../kernel/version.ts";
import { WorkerPool } from "./worker-pool.ts";
import { instanceIssuer } from "./instance-issuer.ts";
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
  checkServerRepositoryTools,
  RepositoryCredentials,
  RepositoryHostKeys,
  REPOSITORY_PLATFORMS,
  decodeGitHubEvent,
  platformImplementations,
  repositoryFiles,
  repositoryMigrations,
  type GitWriter,
  type HostKeySources,
} from "../../repository/index.ts";
import { REPOSITORY_COMPONENT_NAME } from "../../repository/contract.ts";
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
  type Context,
  reasonOf,
} from "../../kernel/context.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

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
  hostKeySources?: HostKeySources;
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
  serverSlotDriver?: SlotDriver;
  environmentRuntime?: EnvironmentRuntime;
  containerRuntimeHost?: RuntimeHost;
  environmentDevcontainerCli?: () => string;
  containerSlotDriver?: (driver: SlotDriver) => SlotDriver;
  repositoryFiles?: RepositoryFiles;
}) {
  const repoConnector =
    options.repositoryConnector ??
    new RepositoryComponent({
      health: options.health,
      checkTools: checkServerRepositoryTools,
    });
  const github = new platformImplementations.github(options.github);
  const s3 = new storageImplementations.s3();
  const repositoryComponent =
    repoConnector instanceof RepositoryComponent
      ? repoConnector
      : new RepositoryComponent();
  const gitWriter: GitWriter =
    options.repositoryTransport ?? repositoryComponent;
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
      instances: {
        liveInstance: (instanceId) => worker.instances.liveInstance(instanceId),
        holdConnection: (instanceId, connectionId) =>
          worker.instances.holdConnection(instanceId, connectionId),
      },
    },
  });
  const threadDriver = new ThreadDriver();
  const containerImage = `${options.config.worker.container_image}:${packageVersion()}`;
  const containerHost =
    options.containerRuntimeHost ?? systemRuntimeHost(process.env);
  const environmentImages = new EnvironmentImages({
    host: containerHost,
    owner: containerOwner(options.config.master_key),
    kanthordImage: containerImage,
    version: packageVersion(),
    stateDirectory: options.stateDirectory,
    devcontainerCli: options.environmentDevcontainerCli,
    buildTimeoutMs: options.config.project.environment_build_timeout_ms,
    environmentMemoryMb: options.config.project.environment_memory_mb,
    exportRepository: (bindingId, commit, directory, context) =>
      project.exportRepository(bindingId, commit, directory, context),
  });
  const containerDriver = new ContainerDriver({
    masterKey: options.config.master_key,
    image: containerImage,
    host: containerHost,
    imageFor: (_runtime, slot, signal) =>
      project.slotImage(slot.project_id, slot.resource_identity, signal),
    cacheGroupOf: (slot, image) =>
      project.slotCacheGroupOf(slot.project_id, slot.resource_identity, image),
  });
  const hostProofs = new HostProofs({
    stateDirectory: options.stateDirectory,
    source: process.env,
    commandLimitMs: COMMAND_LIMIT_MS,
    exportRepository: (bindingId, commit, directory, context) =>
      project.exportRepository(bindingId, commit, directory, context),
  });
  const environmentRuntime: EnvironmentRuntime = options.environmentRuntime ?? {
    get runtimeName() {
      return environmentImages.runtimeName;
    },
    imageId: (reference, signal) =>
      environmentImages.imageId(reference, signal),
    pullImage: (reference, signal) =>
      environmentImages.pullImage(reference, signal),
    imageExists: (tag) => environmentImages.imageExists(tag),
    build: (input, signal) => environmentImages.build(input, signal),
    prove: (input, signal) => environmentImages.prove(input, signal),
    proveOnHost: (input, signal) => hostProofs.proveOnHost(input, signal),
    tagProved: (tag) => environmentImages.tagProved(tag),
    removeTags: (tags) => environmentImages.removeTags(tags),
    collect: (identityPath, keepDigest) =>
      environmentImages.collect(identityPath, keepDigest),
    removeStaleRuns: () => environmentImages.removeStaleRuns(),
    cacheVolumes: () => environmentImages.cacheVolumes(),
    removeCacheVolume: (projectId, resourceIdentity) =>
      environmentImages.removeCacheVolume(projectId, resourceIdentity),
  };
  const containerSlotDriver =
    options.containerSlotDriver?.(containerDriver) ?? containerDriver;
  const serverSlotDriver = options.serverSlotDriver ?? threadDriver;
  const workerPool = new WorkerPool({
    drivers: new Map<PoolPlacement, SlotDriver>([
      [serverSlotDriver.placement, serverSlotDriver],
      [containerDriver.placement, containerSlotDriver],
    ]),
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
      registrationHealthcheck: (tx, runtimeIdentity) =>
        worker.registrationHealthcheck(tx, runtimeIdentity),
      registrationsOfInstance: (tx, runtimeIdentity) =>
        worker.registrationsOfInstance(tx, runtimeIdentity),
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
    environments: {
      environmentsClaimable: (projectId, ids) =>
        project.environmentsClaimable(projectId, ids),
      environmentFailed: (input) =>
        project.environmentFailed({
          ...input,
          stop: { ...input.stop, detail: input.stop.detail ?? "" },
        }),
    },
    branches: {
      nodeBranchesOf: (tx, keys) => mission.nodeBranchesOf(tx, keys),
    },
    projects: {
      projectPaused: (tx, projectId) => project.projectPaused(tx, projectId),
    },
    agentChains: {
      select: (tx, workerBindingId, runtimeIdentity) =>
        worker.agentChoice(tx, workerBindingId, runtimeIdentity),
      resolve: (tx, workerBindingId, pins) =>
        worker.agentSelectionsAt(tx, workerBindingId, pins),
      providerFailure: (tx, claimant, selections, code, executionId, now) =>
        agent.recordProviderFailure(
          tx,
          selections,
          worker.claimantHolder(
            tx,
            claimant.worker_binding_id,
            claimant.runtime_identity,
          ),
          code,
          executionId,
          now,
        ),
      success: (tx, claimant, selections, executionId) =>
        agent.recordSuccess(
          tx,
          selections,
          worker.claimantHolder(
            tx,
            claimant.worker_binding_id,
            claimant.runtime_identity,
          ),
          executionId,
        ),
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
    retentionDays: options.config.tracking.retention_days,
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
    instanceCopyRefreshed: (holder) => llm.raiseCredentialVersion(holder),
    platforms: {
      ...LLM_PLATFORMS,
      ...REPOSITORY_PLATFORMS,
      ...STORAGE_PLATFORMS,
      ...ENVIRONMENT_SECRET_PLATFORMS,
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
    bindingsListingInstance: (tx, instance, name) =>
      worker.bindingsListingInstance(
        tx,
        instance,
        agent
          .agentProvidersDependentOn(tx, name)
          .map(({ agent_name }) => agent_name),
      ),
    instanceKeys: {
      keyOf: (tx, name) => worker.instanceKeyOf(tx, name),
      nameOf: (tx, instanceId) => worker.instanceNameOf(tx, instanceId),
    },
    intakeServiceName: INTAKE_SERVICE_NAME,
    projectServiceName: PROJECT_SERVICE_NAME,
    sshIdentityAuthorization: projectSshIdentityAuthorization({
      custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
      repositoryBindingIdsOf: (tx, nodeId, revision) =>
        mission.repositoryBindingIdsOf(tx, nodeId, revision),
      requestEvidenceBindingOf: (tx, identity, evidenceId) =>
        mission.authorizeRequestEvidence(tx, identity, evidenceId, null).facts
          .repository.binding_id,
    }),
    sshAccessOf: (tx, granted, material) =>
      repositoryComponent.sshAccessOf(tx, granted, material),
    sshSignatureOf: (tx, granted, public_key, data, release) =>
      repositoryComponent.sshSignatureOf(
        tx,
        granted,
        public_key,
        data,
        release,
      ),
  });
  const llm: LlmComponent = new LlmComponent({
    records: custody,
    store: options.store,
    logger: options.logger,
    oauthProviders: options.oauthProviders,
    agentProvidersDependentOn: (tx, name) =>
      agent.agentProvidersDependentOn(tx, name),
    enablementsDependentOnModel: (tx, name, model) =>
      agent.enablementsDependentOnModel(tx, name, model),
    loadModelRuntime: options.loadModelRuntime ?? loadPi,
    instanceKeys: {
      keyOf: (tx, name) => worker.instanceKeyOf(tx, name),
      nameOf: (tx, instanceId) => worker.instanceNameOf(tx, instanceId),
    },
    instanceConnected: (holder) => worker.instanceConnected(holder),
  });
  const agent: AgentComponent = new AgentComponent({
    store: options.store,
    config: options.config.agent,
    dataDirectory: directories(process.env).data,
    workbenchDirectory: (name) =>
      workbenchDirectory(options.stateDirectory, name),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    copyHeld: (tx, name, holder) => custody.copyHeld(tx, name, holder),
    credentialHolds: {
      holdOf: (tx, name, holder) => custody.holds.holdOf(tx, name, holder),
      hold: (tx, name, holder, availableAt, strikes) =>
        custody.holds.hold(tx, name, holder, availableAt, strikes),
      release: (tx, name, holder) => custody.holds.release(tx, name, holder),
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
  });
  const repositoryHostKeys = new RepositoryHostKeys({
    logger: options.logger,
    sources: options.hostKeySources,
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
              idempotencyKey: createIdempotencyKey(),
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
      sshSign: (...args) => custody.sshSign(...args),
      sshPublicKeyOf: (...args) => custody.sshPublicKeyOf(...args),
    },
    config: options.config.worker,
    agentPrompt: {
      compose: (name, context) => agent.composePrompt(name, context),
      templates: (context) => agent.promptTemplates(context),
    },
    store: options.store,
    workerBindingOf: (tx, projectId, resourceIdentity) =>
      project.workerBindingOf(tx, projectId, resourceIdentity),
    workerBindingsOf: (tx, projectId) =>
      project.workerBindingsOf(tx, projectId),
    instanceIssuer: instanceIssuer(
      options.config.master_key,
      options.config.gateway.auth.version,
    ),
    environmentClaimed: (projectId, resourceIdentity) =>
      project.environmentClaimed(projectId, resourceIdentity),
    environmentDigestOf: (projectId, resourceIdentity) =>
      project.environmentDigestOf(projectId, resourceIdentity),
    environmentOf: (projectId, resourceIdentity) =>
      project.environmentOf(projectId, resourceIdentity),
    workerBindingRowOf: (tx, id) => project.workerBindingRowOf(tx, id),
    repositoryPolicyOf: (tx, id) => project.repositoryPolicyOf(tx, id),
    repositoryBindingIdsOf: (tx, nodeId, revision) =>
      mission.repositoryBindingIdsOf(tx, nodeId, revision),
    intentOf: (tx, nodeId, revision) => mission.intentOf(tx, nodeId, revision),
    pinnedCredentialMetadata: (tx, execution, name, now) =>
      custody.pinnedCredentialMetadata(tx, execution, name, now),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    sshHostKeysOf: (tx, platform, address) =>
      repositoryComponent.sshHostKeysOf(tx, platform, address),
    schedulerClaims: {
      requireRunning: (...args) => scheduler.requireRunning(...args),
      runningExecutionOfRuntime: (...args) =>
        scheduler.runningExecutionOfRuntime(...args),
      unendedExecutionOf: (...args) => scheduler.unendedExecutionOf(...args),
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
    instanceCopies: {
      archiveHeld: (tx, holder, now) => {
        custody.archiveHeld(tx, holder, now);
      },
      heldCopies: (tx, holder) => custody.heldCopies(tx, holder),
    },
    loginSessionsOf: (holder) => llm.loginSessionsOf(holder),
    credentialVersionOf: (holder) => llm.credentialVersionOf(holder),
    copyHealthOf: (holder, copy) => llm.copyHealthOf(holder, copy),
    agentConfiguration: {
      validateEntry: (tx, name, entry, holders) =>
        agent.validateEntry(tx, name, entry, holders),
      agentView: (tx, name, entry, scope, models) =>
        agent.agentView(tx, name, entry, scope, models),
      selectAgent: (tx, name, entry, scope) =>
        agent.selectAgent(tx, name, entry, scope),
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
              idempotencyKey: createIdempotencyKey(),
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
    environments: {
      environmentsMixed: (tx, projectId, identities) =>
        project.environmentsMixed(tx, projectId, identities),
    },
  });
  const project: ProjectService = new ProjectService({
    config: options.config.project,
    operationalStore: options.store,
    stateDirectory: options.stateDirectory,
    wakeup: { wake: (projectId) => scheduler.wake(projectId) },
    endRegistrations: (tx, projectId, resourceIdentity, now) =>
      worker.endRegistrations(tx, projectId, resourceIdentity, now),
    bindingsChanged: (projectId) => worker.bindingsChanged(projectId),
    placementStatus: (placement) => worker.placementStatus(placement),
    instanceOf: (tx, name) => worker.instanceOf(tx, name),
    createMission: (tx, pid, actor) => mission.createMission(tx, pid, actor),
    liveNodesPinning: (tx, bid) => mission.liveNodesPinning(tx, bid),
    unmatchedClaims: (tx, projectId) =>
      scheduler.unmatchedClaims(tx, projectId),
    validateEntry: (tx, name, entry, holders) =>
      worker.validateEntry(tx, name, entry, holders),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    repositoryConnector: repoConnector,
    repositoryFiles: options.repositoryFiles ?? repositoryFiles,
    verifyRepositoryCredential: (name, context) =>
      repositoryCredentials.verifyCredential(name, context),
    identity: mintServiceIdentity(PROJECT_SERVICE_NAME),
    credentialRecords: custody,
    custody: {
      authorizeOperation: (...args) => custody.authorizeOperation(...args),
      release: (...args) => custody.release(...args),
      grantFacts,
    },
    sshAccessOf: (tx, granted, material) =>
      repositoryComponent.sshAccessOf(tx, granted, material),
    workerAgentsOf: (name) => worker.workerAgentsOf(name),
    workerAgentView: (tx, w, a, entry, scope) =>
      worker.workerAgentView(tx, w, a, entry, scope),
    environmentRuntime,
    telemetry: {
      span: (trace, contribution) =>
        tracking.serverTraceSpan(trace, PROJECT_PRODUCER, contribution),
    },
    slotImage: containerImage,
    version: packageVersion(),
    environmentReady: (projectId, resourceIdentity, tag) =>
      worker.environmentReady(projectId, resourceIdentity, tag),
    logger: options.logger,
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
      validateEntry: (tx, name, entry) =>
        agent.validateEntry(tx, name, entry, [SERVER_HOLDER]),
      agentView: (tx, name, entry) =>
        agent.agentView(tx, name, entry, {
          holders: [SERVER_HOLDER],
          claimant: SERVER_HOLDER,
        }),
    },
    credentialMetadata: (tx, name) =>
      custody.credentialMetadata(tx, name, SERVER_HOLDER),
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
  repositoryHostKeys.declare(registry);
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
    repositoryHostKeys,
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
    threadDriver,
    containerDriver,
    environmentImages,
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
  { service: REPOSITORY_COMPONENT_NAME, migrations: repositoryMigrations },
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
  private environmentImages?: EnvironmentImages;
  private project?: ProjectService;
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
    if (this.shutdown.signal.aborted)
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
      enforceBindingPlacements(this.store, isHostedWorker);
      enforceMasterKey(this.store, config.master_key, this.path);
      this.shutdown.signal.throwIfAborted();
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
        environmentImages,
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
      this.environmentImages = environmentImages;
      this.project = project;
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
        this.shutdown.signal.throwIfAborted();
      }
      this.runs = services.map((service) =>
        service.run(this.serviceContext).then((error) => {
          if (error && error !== this.serviceContext.signal.reason) {
            this.runError ??= error;
            void this.stop();
          }
          return error;
        }),
      );
      this.shutdown.signal.throwIfAborted();
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
    this.project?.cancelEnvironmentRuns();
    this.environmentImages?.stop();
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
    using cancellation = addAbortListener(context.signal, stop);
    try {
      if (context.signal.aborted)
        return (await this.stop()) ?? reasonOf(context.signal);
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
      return (
        (await this.stopped.promise) ??
        this.runError ??
        reasonOf(context.signal)
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", reopen);
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
