import { join, dirname } from "node:path";
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
  type BindingsNamingFn,
} from "../../custody/index.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import {
  SchedulerService,
  schedulerMigrations,
} from "../../scheduler/index.ts";
import {
  SCHEDULER_SERVICE_NAME,
  type WorkQueue,
} from "../../scheduler/contract.ts";
import { unwired } from "./unwired.ts";
import type { ProjectBindings } from "../../project/contract.ts";
import type {
  EntriesOfAgent,
  WorkerRegistrations,
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
import { gatewayMigrations, createInvocation } from "../../gateway/index.ts";
import { ProjectService, projectMigrations } from "../../project/index.ts";
import { WorkerService, workerMigrations } from "../../worker/index.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { OperationRegistry, StoreName } from "../../kernel/operation.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";

export type RepositoryConnector = {
  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void>;
};

export function composeServices(options: {
  config: ServerConfig;
  store: Store;
  logger: Logger;
  health: HealthRegistry;
  repositoryConnector?: RepositoryConnector;
  registry?: OperationRegistry;
  bindings?: ProjectBindings;
  registrations?: WorkerRegistrations;
  standIns?: {
    entriesOfAgent?: EntriesOfAgent;
    bindingsNaming?: BindingsNamingFn;
  };
}) {
  const repoConnector =
    options.repositoryConnector ??
    new RepositoryComponent({ health: options.health });
  const envelopeKey = deriveEnvelopeKey(options.config.masterKey);
  const registry = options.registry ?? new OperationRegistry();
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: options.store },
    idempotencyTtl: options.config.gateway.idempotencyTtl,
    masterKey: options.config.masterKey,
    tokenLifetime: options.config.gateway.tokenLifetime,
    lookups: {
      project: {
        resolveWorkerBinding: (binding, context) =>
          project.resolveWorkerBinding(binding, context),
      },
      worker: {
        findByClient: (client) => worker.registrations.findByClient(client),
      },
    },
  });
  const scheduler = new SchedulerService({
    config: {},
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
    store: options.store,
    envelopeKey,
    logger: options.logger,
    health: options.health,
    agentProvidersDependentOn: (tx, name) =>
      worker.agentProvidersDependentOn(tx, name),
    enablementsDependentOnModel: (tx, name, model) =>
      worker.enablementsDependentOnModel(tx, name, model),
    bindingsNaming:
      options.standIns?.bindingsNaming ?? (() => unwired("bindingsNaming")()),
  });
  const worker: WorkerService = new WorkerService({
    config: {},
    health: options.health,
    registrations: options.registrations,
    custodySuitability: (tx, req) => custody.custodySuitability(tx, req),
    credentialMetadata: (tx, name) => custody.credentialMetadata(tx, name),
    modelListCheck: (tx, name) => custody.modelListCheck(tx, name),
    entriesOfAgent:
      options.standIns?.entriesOfAgent ?? (() => unwired("entriesOfAgent")()),
  });
  const project: ProjectService = new ProjectService({
    config: {},
    operationalStore: options.store,
    createMission: () => unwired("createMission")(),
    liveNodesPinning: () => unwired("liveNodesPinning")(),
    validateEntry: () => unwired("validateEntry")(),
    custodySuitability: () => unwired("custodySuitability")(),
    repositoryConnector: {
      gitLsRemote: () => unwired("repositoryConnector")(),
    },
    workerAgentsOf: () => unwired("workerAgentsOf")(),
    workerAgentView: () => unwired("workerAgentView")(),
    health: options.health,
    bindings: options.bindings,
  });
  scheduler.declare(registry);
  custody.declare(registry);
  worker.declare(registry);
  project.declare(registry);
  const gateway = new GatewayService({
    config: options.config.gateway,
    logger: options.logger,
    registry,
    invocation,
    health: options.health,
  });
  gateway.declare(registry);
  registry.seal({ [StoreName.Operational]: options.store });
  return {
    scheduler,
    workQueue,
    custody,
    project,
    worker,
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
        { service: "worker", migrations: workerMigrations },
        { service: "project", migrations: projectMigrations },
      ]);
      throwIfCancelled(this.shutdown);
      const { scheduler, custody, project, worker, gateway, invocation } =
        composeServices({
          config,
          store: this.store,
          logger: this.log.logger,
          health: this.health,
        });
      this.gateway = gateway;
      this.invocation = invocation;
      this.releases.push(() => invocation.stop());
      const services = [scheduler, custody, worker, project, gateway];
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
