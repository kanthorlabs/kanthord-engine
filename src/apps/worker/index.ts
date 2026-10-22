import { addAbortListener } from "node:events";
import { hostname } from "node:os";
import type { Provider } from "@earendil-works/pi-ai";
import type { LlmProvider } from "../../llm/provider.ts";
import { join } from "node:path";
import { PI_DIRECTORY_NAME } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import {
  background,
  CancellationContext,
  type Context,
  ContextCancelled,
  reasonOf,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { LogDestination, OperationalLog } from "../../kernel/log.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../../kernel/service.ts";
import { packageVersion } from "../../kernel/version.ts";
import { isString } from "../../kernel/values.ts";
import type {
  ModelRuntimeFactory,
  RepositoryTransport,
} from "../../worker/unit/index.ts";
import { validateClientEndpoint } from "../../gateway/client.ts";
import {
  BindingEntryState,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  INSTANCE_LOGIN_HEARTBEAT_INTERVAL_MS,
  INSTANCE_RENEWAL_INTERVAL_MS,
  INSTANCE_SUPERSEDED_CODE,
  WorkerErrorCode,
} from "../../worker/contract.ts";
import { WorkerUnit, type UnitBinding } from "./unit.ts";
import { httpTransport, observedTransport } from "./transport.ts";
import {
  instanceDirectories,
  resolveInstanceConfiguration,
} from "./instance-config.ts";
import {
  refuseInsecureEndpoint,
  type AddressLookup,
} from "./endpoint-check.ts";
import {
  EXCHANGE_UNAVAILABLE,
  ExchangeFailure,
  InstanceExchange,
  type Connection,
  type ConnectionEntry,
} from "./instance-exchange.ts";
import { instanceCopyKey } from "./instance-credential.ts";
import { InstanceLogins } from "./instance-login.ts";
import { CopyChecks } from "./copy-checks.ts";

const WORKER_STOP_WATCHDOG_MS = 10000;
const WORKER_STOP_EXIT_FAILURE = 1;
const READY_MESSAGE = "Worker instance ready";
const GATEWAY_CODE = "gateway.";
const CONNECTION_SUPERSEDED = "gateway.jwt.connection_superseded";
const SECRET_CHANGED_CODE = "worker.instance.secret_changed";
const VERSION_MISMATCH_CODE = "worker.version.mismatch";

function ignoreHangup(): void {}

function armWatchdog(): () => void {
  const timer = setTimeout(
    () => process.exit(WORKER_STOP_EXIT_FAILURE),
    WORKER_STOP_WATCHDOG_MS,
  );
  return () => clearTimeout(timer);
}

export interface WorkerOptions {
  instance?: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  context?: Context;
  log?: (message: string) => void;
  modelRuntimeFactory?: ModelRuntimeFactory;
  repositoryTransport?: RepositoryTransport;
  connectionName?: string;
  heartbeatIntervalMs?: number;
  renewalIntervalMs?: number;
  addressLookup?: AddressLookup;
  oauthProviders?: () => readonly Provider[];
  llmProviders?: Readonly<Partial<Record<string, LlmProvider>>>;
}

interface Hosted {
  entry: ConnectionEntry;
  binding: UnitBinding;
  removing?: Promise<void>;
}

function versionMismatch(serverVersion: string): Diagnostic {
  return new Diagnostic(
    VERSION_MISMATCH_CODE,
    "worker: the package version differs from the server version.",
    {
      fields: [
        ["version", packageVersion()],
        ["server_version", serverVersion],
      ],
    },
  );
}

function superseded(connectionName: unknown): Diagnostic {
  return new Diagnostic(
    INSTANCE_SUPERSEDED_CODE,
    "worker: another process holds the connection of this instance.",
    {
      fields: [
        ["connection_name", isString(connectionName) ? connectionName : null],
      ],
    },
  );
}

export class Worker implements Service {
  private readonly options: WorkerOptions;
  private readonly shutdown = new CancellationContext();
  private readonly ended = Promise.withResolvers<Diagnostic | null>();
  private endReason?: Diagnostic;
  private readonly hosted = new Map<string, Hosted>();
  private unit?: WorkerUnit;
  private exchange?: InstanceExchange;
  private endpoint?: string;
  private connection?: Connection;
  private logins?: InstanceLogins;
  private copyChecks?: CopyChecks;
  private connectionName = "";
  private operationalLog?: OperationalLog;
  private heartbeatTimer?: NodeJS.Timeout;
  private renewalTimer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private startTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;

  constructor(options: WorkerOptions = {}) {
    this.options = options;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Diagnostic(
          "worker.lifecycle.stopped",
          "worker: a stopped application cannot start again.",
        ),
      );
    this.startTask ??= lifecycle(async () => {
      const env = this.options.env ?? process.env;
      this.shutdown.signal.throwIfAborted();
      const { configuration, source } = resolveInstanceConfiguration(
        { instance: this.options.instance },
        env,
      );
      const endpoint =
        this.options.endpoint ??
        env.KANTHORD_ENDPOINT ??
        configuration.endpoint;
      validateClientEndpoint(endpoint);
      await refuseInsecureEndpoint(endpoint, this.options.addressLookup);
      const directories = instanceDirectories(env, configuration.name);
      installPiTools({
        env,
        directory: join(directories.data, PI_DIRECTORY_NAME),
      });
      this.shutdown.signal.throwIfAborted();
      this.endpoint = endpoint;
      const exchange = new InstanceExchange(configuration, endpoint);
      this.exchange = exchange;
      const instanceKey = instanceCopyKey(configuration);
      this.logins = new InstanceLogins({
        key: instanceKey,
        providers: this.options.oauthProviders,
        report: (sessionId, body, idempotencyKey) =>
          exchange.loginReport(sessionId, body, idempotencyKey, this.shutdown),
        log: (record) => this.logRecord(record),
      });
      this.copyChecks = new CopyChecks({
        key: instanceKey,
        exchange,
        context: this.shutdown,
        providers: this.options.llmProviders,
        log: (record) => this.logRecord(record),
      });
      const token = await this.takeToken();
      this.shutdown.signal.throwIfAborted();
      this.connectionName = this.options.connectionName ?? hostname();
      this.logRecord({
        msg: READY_MESSAGE,
        instance: configuration.name,
        worker: token.payload.worker,
        fingerprint: token.payload.fingerprint,
        connection_name: this.connectionName,
        config_source: source,
      });
      this.connection = await this.exchange.connect(this.connectionName);
      this.shutdown.signal.throwIfAborted();
      const bindings = this.connection.bindings.map((entry) =>
        this.host(entry),
      );
      this.unit = new WorkerUnit({
        bindings,
        directories,
        env,
        log: this.options.log ?? LogDestination.StandardError,
        model_runtime_factory: this.options.modelRuntimeFactory,
        repository_transport: this.options.repositoryTransport,
        watchdog: armWatchdog,
        refused: (binding) => this.bindingRefused(binding),
        instance_key: instanceKey,
      });
      const error = await this.unit.start();
      if (error) throw error;
    });
    return this.startTask;
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      this.shutdown.cancel();
      clearTimeout(this.heartbeatTimer);
      clearTimeout(this.renewalTimer);
      this.logins?.stop();
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
      try {
        await this.operationalLog?.close();
      } finally {
        this.operationalLog = undefined;
      }
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
    using cancellation = addAbortListener(context.signal, stop);
    try {
      if (context.signal.aborted)
        return (await this.stop()) ?? reasonOf(context.signal);
      const error = await this.start();
      if (error) {
        const stopRequested =
          error instanceof ContextCancelled && this.shutdown.signal.aborted;
        return (
          (await this.stop()) ??
          reasonOf(context.signal) ??
          (stopRequested ? null : error)
        );
      }
      this.startExchangeLoops();
      for (const hosted of [...this.hosted.values()])
        if (hosted.entry.state === BindingEntryState.Draining)
          this.removeHosted(hosted);
      const running = this.unit!.run(context);
      const outcome = await Promise.race([
        running.then((result) => ({ result, ended: null })),
        this.ended.promise.then((ended) => ({ result: null, ended })),
      ]);
      if (outcome.ended) return await this.end(outcome.ended, running);
      return (await this.exchangeVerdict(outcome.result)) ?? outcome.result;
    } finally {
      clearTimeout(this.heartbeatTimer);
      clearTimeout(this.renewalTimer);
      this.logins?.stop();
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

  private async end(
    reason: Diagnostic,
    running: Promise<Error | null>,
  ): Promise<Error | null> {
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.renewalTimer);
    this.logins?.stop();
    if (reason.code === VERSION_MISMATCH_CODE) await this.unit!.stop();
    else await this.unit!.abandon();
    await running;
    this.shutdown.cancel();
    await this.operationalLog?.close();
    this.operationalLog = undefined;
    return reason;
  }

  private finish(reason: Diagnostic): void {
    this.endReason ??= reason;
    this.ended.resolve(reason);
  }

  private async exchangeVerdict(
    result: Error | null,
  ): Promise<Diagnostic | undefined> {
    if (
      !(result instanceof Diagnostic) ||
      !result.code.startsWith(GATEWAY_CODE)
    )
      return undefined;
    await this.check();
    return this.endReason;
  }

  private async takeToken() {
    let token;
    try {
      token = await this.exchange!.token(this.shutdown);
    } catch (error) {
      if (
        error instanceof ExchangeFailure &&
        error.code === EXCHANGE_UNAVAILABLE
      )
        throw new Diagnostic(
          "worker.version.unavailable",
          "worker: cannot read the server package version.",
        );
      throw error;
    }
    if (token.server_version !== packageVersion())
      throw versionMismatch(token.server_version);
    return token;
  }

  private bearerOf(clientId: string): string | undefined {
    return this.hosted.get(clientId)?.entry.token;
  }

  private host(entry: ConnectionEntry): UnitBinding {
    const transport = observedTransport(
      httpTransport(this.endpoint!, () => this.bearerOf(entry.client_id)),
      (result) => this.observe(result),
    );
    const binding = { transport, client_secret: entry.client_secret };
    this.hosted.set(entry.client_id, { entry, binding });
    return binding;
  }

  private observe(result: OperationResult<unknown>): void {
    if (
      result.type === OperationResultType.Failure &&
      result.status === HttpStatus.Unauthorized &&
      result.error.error.code === CONNECTION_SUPERSEDED
    )
      void this.check();
  }

  private startExchangeLoops(): void {
    void this.check().finally(() => this.armHeartbeat());
    this.armRenewal();
  }

  private armHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    if (this.shutdown.signal.aborted) return;
    const interval =
      this.options.heartbeatIntervalMs ?? INSTANCE_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setTimeout(
      () => void this.check().finally(() => this.armHeartbeat()),
      this.logins?.pending()
        ? Math.min(interval, INSTANCE_LOGIN_HEARTBEAT_INTERVAL_MS)
        : interval,
    );
  }

  private armRenewal(): void {
    clearTimeout(this.renewalTimer);
    if (this.shutdown.signal.aborted) return;
    this.renewalTimer = setTimeout(
      () => void this.serialize(() => this.renew()),
      this.options.renewalIntervalMs ?? INSTANCE_RENEWAL_INTERVAL_MS,
    );
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const next = (this.checking ?? Promise.resolve()).then(task, task);
    this.checking = next;
    return next;
  }

  private check(): Promise<void> {
    return this.serialize(() => this.heartbeat());
  }

  private async heartbeat(): Promise<void> {
    if (this.shutdown.signal.aborted || !this.connection) return;
    try {
      const answer = await this.exchange!.heartbeat(
        this.connection.connection_id,
        this.connectionName,
        this.shutdown,
      );
      if (answer.server_version !== packageVersion())
        return this.finish(versionMismatch(answer.server_version));
      this.logins!.sync(answer.login_sessions);
      this.copyChecks!.observe(answer.credential_version);
      if (answer.binding_version !== this.connection.binding_version)
        await this.reconnect();
    } catch (error) {
      await this.refused(error);
    }
  }

  private async renew(): Promise<void> {
    if (this.shutdown.signal.aborted || !this.connection) return;
    try {
      await this.takeToken();
      await this.reconnect();
    } catch (error) {
      await this.refused(error);
    }
  }

  private async refused(error: unknown): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    if (!(error instanceof Diagnostic)) throw error;
    if (error.code === WorkerErrorCode.InstanceConnectionSuperseded)
      return this.finish(
        superseded(
          error instanceof ExchangeFailure
            ? (error.details as Record<string, unknown> | null)?.connection_name
            : null,
        ),
      );
    if (error.code === VERSION_MISMATCH_CODE) return this.finish(error);
    if (
      error instanceof ExchangeFailure &&
      error.status === HttpStatus.Unauthorized
    ) {
      try {
        await this.takeToken();
        await this.reconnect();
        return;
      } catch (retry) {
        if (retry instanceof Diagnostic && retry.code !== error.code)
          return this.refused(retry);
        if (retry instanceof Diagnostic) return this.finish(retry);
        throw retry;
      }
    }
    if (
      error instanceof ExchangeFailure &&
      error.status === HttpStatus.NotFound
    )
      return this.finish(error);
    this.logRecord({
      msg: "Worker instance exchange failed",
      code: error.code,
    });
  }

  private async reconnect(): Promise<void> {
    const connection = await this.exchange!.connect(
      this.connectionName,
      this.connection!.connection_id,
      this.shutdown,
    );
    for (const entry of connection.bindings) {
      const hosted = this.hosted.get(entry.client_id);
      if (hosted && hosted.entry.client_secret !== entry.client_secret)
        return this.finish(
          new Diagnostic(
            SECRET_CHANGED_CODE,
            "worker: the client secret of a binding changed. Restart the instance.",
          ),
        );
    }
    this.connection = connection;
    this.armRenewal();
    const listed = new Set(connection.bindings.map((entry) => entry.client_id));
    for (const entry of connection.bindings) {
      const hosted = this.hosted.get(entry.client_id);
      if (!hosted) {
        const binding = this.host(entry);
        if (entry.state === BindingEntryState.Draining)
          this.removeHosted(this.hosted.get(entry.client_id)!);
        else void this.added(binding);
        continue;
      }
      hosted.entry = entry;
      if (entry.state === BindingEntryState.Draining) this.removeHosted(hosted);
    }
    for (const hosted of this.hosted.values())
      if (!listed.has(hosted.entry.client_id)) this.removeHosted(hosted);
  }

  private bindingRefused(binding: UnitBinding): void {
    void this.check().then(() => this.resumeRefused(binding));
  }

  private async resumeRefused(binding: UnitBinding): Promise<void> {
    if (this.shutdown.signal.aborted || this.endReason) return;
    const hosted = [...this.hosted.values()].find(
      (item) => item.binding === binding,
    );
    if (!hosted || hosted.removing) return;
    const error = await this.unit!.restart(binding);
    if (error)
      this.logRecord({
        msg: "Worker instance binding failed",
        code: error instanceof Diagnostic ? error.code : null,
      });
  }

  private async added(binding: UnitBinding): Promise<void> {
    const error = await this.unit!.add(binding);
    if (error)
      this.logRecord({
        msg: "Worker instance binding failed",
        code: error instanceof Diagnostic ? error.code : null,
      });
  }

  private removeHosted(hosted: Hosted): void {
    if (hosted.removing) return;
    hosted.removing = this.unit!.remove(hosted.binding).then((error) => {
      if (error)
        this.logRecord({
          msg: "Worker instance binding failed",
          code: error instanceof Diagnostic ? error.code : null,
        });
      else this.hosted.delete(hosted.entry.client_id);
    });
  }

  private logRecord(record: Record<string, unknown>): void {
    if (this.options.log) {
      this.options.log(JSON.stringify(record));
      return;
    }
    this.operationalLog ??= new OperationalLog(
      { level: "info", destination: LogDestination.StandardError },
      "",
    );
    const { msg, ...fields } = record;
    this.operationalLog.logger.info(fields, String(msg));
  }
}

export function runWorker(options: WorkerOptions = {}): Promise<Error | null> {
  return new Worker(options).run();
}

export {
  instanceCredentialAccess,
  instanceSecret,
  type InstanceCredentialAccess,
} from "./instance-credential.ts";
