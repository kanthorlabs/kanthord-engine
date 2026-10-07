import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveClientSecret } from "../../gateway/local.ts";
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
} from "../../custody/index.ts";
import {
  CUSTODY_SERVICE_NAME,
  type InboundsNamingFn,
} from "../../custody/contract.ts";
import {
  SchedulerService,
  schedulerMigrations,
} from "../../scheduler/index.ts";
import {
  SCHEDULER_SERVICE_NAME,
  type WorkQueue,
} from "../../scheduler/contract.ts";
import { MissionService, missionMigrations } from "../../mission/index.ts";
import {
  MISSION_SERVICE_NAME,
  missionOperations,
  type IntakeStorage,
  type IntakeCheck,
} from "../../mission/contract.ts";
import { unwired } from "./unwired.ts";
import type {
  ProjectBindings,
  RepositoryConnector,
} from "../../project/contract.ts";
import type {
  WorkerRegistrations,
  IntakeActions,
} from "../../worker/contract.ts";
import { audit, ensureDirectory } from "../../kernel/files.ts";
import { Diagnostic, diagnostic, asError } from "../../kernel/errors.ts";
import {
  healthy,
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../kernel/service.ts";
import { OperationalLog } from "../../kernel/log.ts";
import { Store } from "../../kernel/store.ts";
import { HealthRegistry } from "../../kernel/health.ts";
import { GatewayService } from "../../gateway/index.ts";
import type { ResourceInventories } from "../../gateway/contract.ts";
import {
  gatewayMigrations,
  directClient,
  createInvocation,
  collectInventories,
} from "../../gateway/index.ts";
import { ProjectService, projectMigrations } from "../../project/index.ts";
import {
  WorkerService,
  workerMigrations,
  toolDeclarations,
} from "../../worker/index.ts";
import { AgentComponent, agentMigrations } from "../../agent/index.ts";
import {
  WorkbenchService,
  workbenchDirectory,
  workbenchMigrations,
  type WorkbenchModelRuntimeFactory,
} from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import {
  RepositoryComponent,
  RepositoryCredentials,
  REPOSITORY_PLATFORMS,
} from "../../repository/index.ts";
import { LlmComponent, LLM_PLATFORMS } from "../../llm/index.ts";
import { StorageComponent, STORAGE_PLATFORMS } from "../../storage/index.ts";
import { OperationRegistry, StoreName } from "../../kernel/operation.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";

export type { RepositoryConnector } from "../../project/contract.ts";

export function composeServices(options: {
  config: ServerConfig;
  store: Store;
  stateDirectory: string;
  logger: Logger;
  health: HealthRegistry;
  repositoryConnector?: RepositoryConnector;
  oauthProviders?: ConstructorParameters<
    typeof LlmComponent
  >[0]["oauthProviders"];
  registry?: OperationRegistry;
  bindings?: ProjectBindings;
  registrations?: WorkerRegistrations;
  workbenchModelRuntimeFactory?: WorkbenchModelRuntimeFactory;
  inventoryOverrides?: Partial<ResourceInventories>;
  standIns?: {
    intakeStorage?: IntakeStorage;
    intakeCheck?: IntakeCheck;
    intakeActions?: IntakeActions;
    inboundsNaming?: InboundsNamingFn;
  };
}) {
  const repoConnector =
    options.repositoryConnector ??
    new RepositoryComponent({ health: options.health });
  const envelopeKey = deriveEnvelopeKey(options.config.master_key);
  const registry = options.registry ?? new OperationRegistry();
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: options.store },
    idempotencyTtl: options.config.gateway.idempotency_ttl,
    masterKey: options.config.master_key,
    tokenLifetime: options.config.gateway.token_lifetime,
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
  const missionClient = directClient(missionOperations, invocation);
  const scheduler: SchedulerService = new SchedulerService({
    config: options.config.scheduler,
    store: options.store,
    transitions: {
      claim: (...args: Parameters<MissionService["claim"]>) =>
        mission.claim(...args),
      release: (...args) => mission.release(...args),
      loss: (...args) => mission.loss(...args),
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
    },
    traceIdentity: {
      mint: () => ({
        traceId: randomBytes(16).toString("hex"),
        rootSpanId: randomBytes(8).toString("hex"),
      }),
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
      requireRunning: (...args) => {
        const row = scheduler.requireRunning(...args);
        return {
          execution_id: row.executionId,
          project_id: row.projectId,
          worker_binding_id: row.workerBindingId,
          resource_identity: row.resourceIdentity,
          runtime_identity: row.runtimeIdentity,
          credentials: row.credentials,
        };
      },
      pinCredential: (...args) => scheduler.pinCredential(...args),
      liveExecutionsPinning: (...args) =>
        scheduler.liveExecutionsPinning(...args),
    },
    authorization: {
      authorizeModelInference: (...args) =>
        worker.authorizeModelInference(...args),
    },
    clientSecret: (clientId) =>
      deriveClientSecret(options.config.master_key, clientId),
    store: options.store,
    envelopeKey,
    logger: options.logger,
    health: options.health,
    agentProvidersDependentOn: (tx, name) =>
      agent.agentProvidersDependentOn(tx, name),
    bindingsNaming: (tx, name) => project.bindingsNaming(tx, name),
    inboundsNaming: options.standIns?.inboundsNaming ?? (() => []),
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
  });
  const agent: AgentComponent = new AgentComponent({
    store: options.store,
    config: options.config.agent,
    dataDirectory: directories(process.env).data,
    workbenchDirectory: (name) =>
      workbenchDirectory(options.stateDirectory, name),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    approvedModels: (tx, name) => llm.approvedModels(tx, name),
    providerHealthCheck: (tx, name) => llm.providerHealthCheck(tx, name),
    providerCapability: (tx, name) => llm.providerCapability(tx, name),
    entriesOfAgent: (tx, name) => project.entriesOfAgent(tx, name),
    repositoryWorkingOf: (tx, id) => project.repositoryPolicyOf(tx, id),
    toolDeclarations: (name) => toolDeclarations(name),
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
    intakeActions: options.standIns?.intakeActions ?? {
      perform: unwired("IntakeActions.perform"),
      read: unwired("IntakeActions.read"),
    },
    custodyHandover: {
      handover: (...args) => custody.handover(...args),
      report: (...args) => custody.report(...args),
    },
    config: options.config.worker,
    agentPrompt: {
      compose: (name, context) => agent.composePrompt(name, context),
    },
    store: options.store,
    workerBindingOf: (tx, projectId, resourceIdentity) =>
      project.workerBindingOf(tx, projectId, resourceIdentity),
    workerBindingRowOf: (tx, id) => project.workerBindingRowOf(tx, id),
    repositoryPolicyOf: (tx, id) => project.repositoryPolicyOf(tx, id),
    repositoryBindingIdsOf: (tx, nodeId, revision) =>
      mission.repositoryBindingIdsOf(tx, nodeId, revision),
    pinnedCredentialMetadata: (tx, execution, name, now) =>
      custody.pinnedCredentialMetadata(tx, execution, name, now),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    schedulerClaims: {
      requireRunning: (...args) => scheduler.requireRunning(...args),
      runningExecutionOfRuntime: (...args) =>
        scheduler.runningExecutionOfRuntime(...args),
      activityOf: (...args) => scheduler.activityOf(...args),
    },
    health: options.health,
    registrations: options.registrations,
    agentConfiguration: {
      validateEntry: (tx, name, entry) => agent.validateEntry(tx, name, entry),
      agentView: (tx, name, entry, models) =>
        agent.agentView(tx, name, entry, models),
    },
  });
  const mission: MissionService = new MissionService({
    store: options.store,
    intakeStorage: options.standIns?.intakeStorage ?? {
      put: unwired("IntakeStorage.put"),
      check: unwired("IntakeStorage.check"),
      get: unwired("IntakeStorage.get"),
      executionGet: unwired("IntakeStorage.executionGet"),
      delete: unwired("IntakeStorage.delete"),
    },
    intakeCheck: options.standIns?.intakeCheck ?? {
      check: unwired("IntakeCheck.check"),
    },
    config: options.config.mission,
    health: options.health,
    workQueue,
    schedulerClaims: {
      revoke: (...args) => scheduler.revoke(...args),
      settle: (...args) => scheduler.settle(...args),
      liveExecutionOf: (...args) => scheduler.liveExecutionOf(...args),
    },
    wakeup: { wake: (projectId) => scheduler.wake(projectId) },
    executionAttribution: {
      of: (...args) => scheduler.executionAttribution(...args),
    },
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
    createMission: (tx, pid, actor) => mission.createMission(tx, pid, actor),
    liveNodesPinning: (tx, bid) => mission.liveNodesPinning(tx, bid),
    validateEntry: (tx, name, entry) => worker.validateEntry(tx, name, entry),
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    repositoryConnector: repoConnector,
    verifyRepositoryCredential: (name, context) =>
      repositoryCredentials.verifyCredential(name, context),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    workerAgentsOf: (name) => worker.workerAgentsOf(name),
    workerAgentView: (tx, w, a, entry) =>
      worker.workerAgentView(tx, w, a, entry),
    health: options.health,
    bindings: options.bindings,
  });
  const workbench = new WorkbenchService({
    store: options.store,
    stateDirectory: options.stateDirectory,
    agentPrompt: {
      compose: (name, context) => agent.composePrompt(name, context),
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
  llm.declare(registry);
  agent.declare(registry);
  repositoryCredentials.declare(registry);
  storage.declare(registry);
  worker.declare(registry);
  mission.declare(registry);
  project.declare(registry);
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
        }),
      ),
    options.logger,
  );
  registry.seal({ [StoreName.Operational]: options.store });
  return {
    scheduler,
    workQueue,
    custody,
    llm,
    agent,
    repositoryCredentials,
    storage,
    mission,
    project,
    worker,
    workbench,
    gateway,
    invocation,
    registry,
    repoConnector,
  };
}

export class Server implements Service {
  readonly health = new HealthRegistry();
  private readonly path: string;
  private log?: OperationalLog;
  private store?: Store;
  private gateway?: GatewayService;
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
      // Validate all files owned by this implementation, including inactive logs.
      audit(join(paths.state, "kanthord.log"), "file", true);
      this.log = new OperationalLog(config.log, paths.state);
      this.releases.push(() => this.log!.close());
      this.store = new Store(join(paths.data, "kanthord.db"));
      this.releases.push(() => this.store!.close());
      this.store.migrate([
        { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
        { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
        { service: "gateway", migrations: gatewayMigrations },
        { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
        { service: "worker", migrations: workerMigrations },
        { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
        { service: "project", migrations: projectMigrations },
        { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
      ]);
      throwIfCancelled(this.shutdown);
      const {
        scheduler,
        custody,
        llm,
        worker,
        mission,
        project,
        workbench,
        gateway,
        invocation,
      } = composeServices({
        config,
        store: this.store,
        stateDirectory: paths.state,
        logger: this.log.logger,
        health: this.health,
      });
      this.gateway = gateway;
      this.invocation = invocation;
      this.releases.push(() => invocation.stop());
      const services = [
        scheduler,
        custody,
        llm,
        worker,
        mission,
        project,
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
          { reason: diagnostic(error) },
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
