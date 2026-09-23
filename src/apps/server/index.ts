import { join, dirname } from "node:path";
import { directories, configPath, loadConfig } from "../../config/index.ts";
import { audit, ensureDirectory } from "../../shared/files.ts";
import { Diagnostic, diagnostic, asError } from "../../shared/errors.ts";
import {
  healthy,
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../service.ts";
import { OperationalLog } from "../../log.ts";
import { Store } from "../../store.ts";
import { HealthRegistry } from "../../health.ts";
import { GatewayService } from "../../gateway/service.ts";
import { gatewayMigrations } from "../../gateway/migrations.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../context.ts";

export class Server implements Service {
  readonly health = new HealthRegistry();
  private readonly path: string;
  private log?: OperationalLog;
  private store?: Store;
  private gateway?: GatewayService;
  private readonly shutdown = new CancellationContext();
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
        { service: "gateway", migrations: gatewayMigrations },
      ]);
      throwIfCancelled(this.shutdown);
      this.gateway = new GatewayService({
        config,
        store: this.store,
        logger: this.log.logger,
        health: this.health,
      });
      this.releases.push(() => this.gateway!.stop());
      const error = await this.gateway.start();
      if (error) throw error;
      throwIfCancelled(this.shutdown);
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

  stop(): Promise<Error | null> {
    if (this.stopTask) return this.stopTask;
    this.shutdown.cancel();
    this.stopTask = lifecycle(async () => {
      const watchdog = setTimeout(() => process.exit(1), 10000);
      try {
        // Abort admission and waiting handlers before joining startup or drains.
        const gatewayError = await this.gateway?.stop();
        await this.startTask;
        const cleanup = await this.release();
        if (cleanup || gatewayError) throw cleanup ?? gatewayError;
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
