import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { LogDestination, OperationalLog } from "../../kernel/log.ts";
import { directories } from "../../kernel/xdg.ts";
import {
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../kernel/service.ts";
import { packageVersion } from "../../kernel/version.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { WorkspaceRoot } from "../../worker/index.ts";
import { workerApi, type WorkerApi } from "./api.ts";
import { register, startHeartbeat, type Registration } from "./registration.ts";
import type {
  ModelRuntimeFactory,
  RepositoryTransport,
} from "../../worker/index.ts";
import {
  readServerVersion,
  resolveClient,
  type ClientConfiguration,
} from "../../gateway/client.ts";

const KEEPALIVE_INTERVAL_MS = 60000;
const CLIENT_SECRET_BYTES = 32;
const WORKER_STOP_WATCHDOG_MS = 10000;
const WORKER_STOP_EXIT_FAILURE = 1;

function ignoreHangup(): void {}

export interface WorkerOptions extends Partial<
  Omit<ClientConfiguration, "clientSecret">
> {
  env?: NodeJS.ProcessEnv;
  context?: Context;
  log?: (message: string) => void;
  modelRuntimeFactory?: ModelRuntimeFactory;
  repositoryTransport?: RepositoryTransport;
}

export class Worker implements Service {
  private readonly options: WorkerOptions;
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private started = false;
  private keepalive?: NodeJS.Timeout;
  private operationalLog?: OperationalLog;
  private clientSecret?: Buffer;
  private api?: WorkerApi;
  private transport?: RepositoryTransport;
  private workspaces?: WorkspaceRoot;
  private registration?: Registration;
  private heartbeat?: { stop(): void };

  constructor(options: WorkerOptions = {}) {
    this.options = options;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "worker.lifecycle.stopped",
          "worker: a stopped application cannot start again.",
        ),
      );
    this.startTask ??= lifecycle(async () => {
      const config = resolveClient(this.options, this.options.env);
      if (config.clientSecret === undefined)
        throw new Diagnostic(
          "worker.start.client_secret_absent",
          "worker: clientSecret is required in cli.yaml.",
        );
      const secret = Buffer.from(config.clientSecret, "base64");
      if (
        secret.length !== CLIENT_SECRET_BYTES ||
        secret.toString("base64") !== config.clientSecret
      )
        throw new Diagnostic(
          "worker.start.client_secret_invalid",
          "worker: clientSecret must be a base64 encoding of exactly 32 bytes.",
        );
      this.clientSecret = secret;
      throwIfCancelled(this.shutdown);
      const { checkAgentTools, WorkspaceRoot } =
        await import("../../worker/index.ts");
      throwIfCancelled(this.shutdown);
      checkAgentTools();
      throwIfCancelled(this.shutdown);
      this.transport =
        this.options.repositoryTransport ?? new RepositoryComponent();
      throwIfCancelled(this.shutdown);
      this.api = workerApi(config.endpoint, config.token);
      const version = await readServerVersion(this.api.gateway, {
        context: this.shutdown,
      });
      throwIfCancelled(this.shutdown);
      if (version instanceof Diagnostic)
        throw new Diagnostic(
          "worker.version.unavailable",
          "worker: cannot read the server package version.",
        );
      const local = packageVersion();
      if (version !== local)
        throw new Diagnostic(
          "worker.version.mismatch",
          `worker: package version ${local} differs from server version ${version}.`,
        );
      this.workspaces = WorkspaceRoot.open(directories(this.options.env).state);
      throwIfCancelled(this.shutdown);
      this.registration = await register(this.api);
      if (this.shutdown.err()) return;
      if (this.options.log) {
        this.options.log(
          JSON.stringify({
            msg: "Worker application ready",
            ...this.registration,
          }),
        );
      } else {
        this.operationalLog = new OperationalLog(
          { level: "info", destination: LogDestination.StandardError },
          directories(this.options.env).state,
        );
        this.operationalLog.logger.info(
          this.registration,
          "Worker application ready",
        );
      }
      this.started = true;
      this.keepalive = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
    });
    return this.startTask;
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      this.shutdown.cancel();
      this.heartbeat?.stop();
      this.workspaces?.stopSweeping();
    });
    return this.quiesceTask;
  }

  stop(): Promise<Error | null> {
    this.stopTask ??= lifecycle(async () => {
      const watchdog = setTimeout(
        () => process.exit(WORKER_STOP_EXIT_FAILURE),
        WORKER_STOP_WATCHDOG_MS,
      );
      try {
        const error = await this.quiesce();
        await this.startTask;
        if (error) throw error;
      } finally {
        this.started = false;
        this.clientSecret?.fill(0);
        this.clientSecret = undefined;
        clearInterval(this.keepalive);
        try {
          await this.operationalLog?.close();
        } finally {
          clearTimeout(watchdog);
        }
      }
    });
    return this.stopTask;
  }

  async run(
    context: Context = this.options.context ?? background,
  ): Promise<Error | null> {
    const stop = () => {
      void this.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", ignoreHangup);
    const unsubscribe = context.onCancel(stop);
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return (await this.stop()) ?? context.err() ?? error;
      if (!this.shutdown.err()) {
        this.heartbeat = startHeartbeat(this.api!, (record) => {
          if (this.options.log) this.options.log(JSON.stringify(record));
          else this.operationalLog!.logger.warn(record, record.msg);
        });
        this.workspaces!.startSweeping();
      }
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", ignoreHangup);
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      client:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

export function runWorker(options: WorkerOptions = {}): Promise<Error | null> {
  return new Worker(options).run();
}
