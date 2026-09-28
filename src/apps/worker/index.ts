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
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  httpClient,
  readServerVersion,
  resolveClient,
  type ClientConfiguration,
} from "../../gateway/client.ts";

const KEEPALIVE_INTERVAL_MS = 60000;
const MASTER_KEY_BYTES = 32;
const WORKER_STOP_WATCHDOG_MS = 10000;
const WORKER_STOP_EXIT_FAILURE = 1;

function ignoreHangup(): void {}

export interface WorkerOptions extends Partial<
  Omit<ClientConfiguration, "masterKey">
> {
  env?: NodeJS.ProcessEnv;
  context?: Context;
  log?: (message: string) => void;
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
      if (config.masterKey === undefined)
        throw new Diagnostic(
          "worker.start.master_key_absent",
          "worker: masterKey is required in cli.yaml.",
        );
      const key = Buffer.from(config.masterKey, "base64");
      if (
        key.length !== MASTER_KEY_BYTES ||
        key.toString("base64") !== config.masterKey
      )
        throw new Diagnostic(
          "worker.start.master_key_invalid",
          "worker: masterKey must be a base64 encoding of exactly 32 bytes.",
        );
      const client = httpClient(
        gatewayOperations,
        config.endpoint,
        config.token,
      );
      const version = await readServerVersion(client, {
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
      if (this.options.log) {
        this.options.log("Worker application started");
      } else {
        this.operationalLog = new OperationalLog(
          { level: "info", destination: LogDestination.StandardError },
          directories(this.options.env).state,
        );
        this.operationalLog.logger.info("Worker application started");
      }
      this.started = true;
      this.keepalive = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
    });
    return this.startTask;
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      this.shutdown.cancel();
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
