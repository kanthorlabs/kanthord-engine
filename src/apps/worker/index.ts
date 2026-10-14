import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { LogDestination } from "../../kernel/log.ts";
import {
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../kernel/service.ts";
import {
  installPiTools,
  type ModelRuntimeFactory,
  type RepositoryTransport,
} from "../../worker/unit/index.ts";
import {
  resolveClient,
  type ClientConfiguration,
} from "../../gateway/client.ts";
import { WorkerUnit } from "./unit.ts";
import { httpTransport } from "./transport.ts";

const CLIENT_SECRET_BYTES = 32;
const WORKER_STOP_WATCHDOG_MS = 10000;
const WORKER_STOP_EXIT_FAILURE = 1;

function ignoreHangup(): void {}

function armWatchdog(): () => void {
  const timer = setTimeout(
    () => process.exit(WORKER_STOP_EXIT_FAILURE),
    WORKER_STOP_WATCHDOG_MS,
  );
  return () => clearTimeout(timer);
}

export interface WorkerOptions extends Partial<
  Omit<ClientConfiguration, "client_secret">
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
  private unit?: WorkerUnit;
  private startTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;

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
      const env = this.options.env ?? process.env;
      installPiTools({ env });
      throwIfCancelled(this.shutdown);
      const config = resolveClient(this.options, env);
      if (config.client_secret === undefined)
        throw new Diagnostic(
          "worker.start.client_secret_absent",
          "worker: client_secret is required in cli.yaml.",
        );
      const secret = Buffer.from(config.client_secret, "base64");
      if (
        secret.length !== CLIENT_SECRET_BYTES ||
        secret.toString("base64") !== config.client_secret
      )
        throw new Diagnostic(
          "worker.start.client_secret_invalid",
          "worker: client_secret must be a base64 encoding of exactly 32 bytes.",
        );
      this.unit = new WorkerUnit({
        transport: httpTransport(config.endpoint, config.token),
        client_secret: config.client_secret,
        env,
        log: this.options.log ?? LogDestination.StandardError,
        model_runtime_factory: this.options.modelRuntimeFactory,
        repository_transport: this.options.repositoryTransport,
        watchdog: armWatchdog,
      });
      const error = await this.unit.start();
      if (error) throw error;
    });
    return this.startTask;
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      this.shutdown.cancel();
      const error = await this.unit?.quiesce();
      if (error) throw error;
    });
    return this.quiesceTask;
  }

  stop(): Promise<Error | null> {
    this.stopTask ??= lifecycle(async () => {
      const error = await this.quiesce();
      await this.startTask;
      const stopped = await this.unit?.stop();
      if (error) throw error;
      if (stopped) throw stopped;
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
      return await this.unit!.run(context);
    } finally {
      unsubscribe();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", ignoreHangup);
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    return (
      (await this.unit?.healthcheck()) ?? {
        client: HealthStatus.Unavailable,
      }
    );
  }
}

export function runWorker(options: WorkerOptions = {}): Promise<Error | null> {
  return new Worker(options).run();
}
