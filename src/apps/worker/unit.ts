import { registerBunOAuthFlows as registerOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationalLog, type LogConfig } from "../../kernel/log.ts";
import { directories } from "../../kernel/xdg.ts";
import {
  HealthStatus,
  lifecycle,
  type Healthcheck,
} from "../../kernel/service.ts";
import { isString } from "../../kernel/values.ts";
import { packageVersion } from "../../kernel/version.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { Backoff } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import {
  register,
  deregister,
  startHeartbeat,
  type Registration,
} from "./registration.ts";
import {
  installPiTools,
  defaultModelRuntimeFactory,
  WorkspaceRoot,
  type ModelRuntimeFactory,
  type RepositoryTransport,
} from "../../worker/unit/index.ts";
import { hostExecution } from "./execution.ts";
import { readServerVersion } from "../../gateway/client.ts";
import { homedir } from "node:os";
import { pullLoop } from "./pull-loop.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { fileTranscript } from "./transcript-file.ts";

const KEEPALIVE_INTERVAL_MS = 60000;
const READY_MESSAGE = "Worker application ready";
const ANSWER_INVALID = "gateway.client.answer_invalid";
const RESUME_PULL_WAIT_MS = 5000;

export interface WorkerUnitOptions {
  transport: WorkerTransport;
  client_secret: string;
  env: NodeJS.ProcessEnv;
  log: LogConfig["destination"] | ((message: string) => void);
  model_runtime_factory?: ModelRuntimeFactory;
  repository_transport?: RepositoryTransport;
  watchdog?: () => () => void;
  resume_pull_wait_ms?: number;
}

export class WorkerUnit {
  private readonly options: WorkerUnitOptions;
  private readonly shutdown = new CancellationContext();
  private readonly pulls = new CancellationContext(this.shutdown);
  private startTask?: Promise<Error | null>;
  private runTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private started = false;
  private keepalive?: NodeJS.Timeout;
  private operationalLog?: OperationalLog;
  private clientSecret?: Buffer;
  private repository?: RepositoryTransport;
  private workspaces?: WorkspaceRoot;
  private registration?: Registration;
  private heartbeat?: { stop(): void };
  private pulling?: Promise<unknown>;
  private registering?: Promise<Registration>;
  private execution?: {
    context: CancellationContext;
    task: Promise<Diagnostic | null>;
  };
  private executionLive = false;
  private registrationKept = false;
  private draining = false;
  private pullStarted = false;

  constructor(options: WorkerUnitOptions) {
    registerOAuthFlows();
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
      installPiTools({ env: this.options.env });
      throwIfCancelled(this.shutdown);
      this.clientSecret = Buffer.from(this.options.client_secret, "base64");
      this.repository =
        this.options.repository_transport ?? new RepositoryComponent();
      throwIfCancelled(this.shutdown);
      const version = await readServerVersion(this.options.transport.gateway, {
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
          "worker: the package version differs from the server version.",
          {
            fields: [
              ["version", local],
              ["server_version", version],
            ],
          },
        );
      this.workspaces = WorkspaceRoot.open(directories(this.options.env).state);
      throwIfCancelled(this.shutdown);
      this.registration = await register(this.options.transport);
      if (this.shutdown.err()) return;
      this.openLog();
      if (this.operationalLog)
        this.operationalLog.logger.info(this.registration, READY_MESSAGE);
      else this.logRecord({ msg: READY_MESSAGE, ...this.registration });
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
      let disarm: (() => void) | undefined;
      try {
        const error = await this.quiesce();
        await this.startTask;
        await this.pulling;
        await this.registering;
        if (error) throw error;
        if (this.executionLive) {
          this.execution?.context.cancel();
          await this.execution?.task;
          throw new Diagnostic(
            "worker.stop.execution_live",
            "worker: stop during a live execution.",
          );
        }
        disarm = this.options.watchdog?.();
        if (this.registration && !this.registrationKept) {
          const failure = await deregister(
            this.options.transport,
            this.registration.runtime_identity,
          );
          if (failure) throw failure;
          this.registration = undefined;
        }
      } finally {
        this.started = false;
        this.clientSecret?.fill(0);
        this.clientSecret = undefined;
        clearInterval(this.keepalive);
        try {
          await this.operationalLog?.close();
        } finally {
          disarm?.();
        }
      }
    });
    return this.stopTask;
  }

  drain(): Promise<Error | null> {
    this.draining = true;
    if (this.pullStarted) this.pulls.cancel();
    return this.runTask ?? this.stop();
  }

  run(context: Context = background): Promise<Error | null> {
    this.runTask ??= this.runLoop(context);
    return this.runTask;
  }

  private async runLoop(context: Context): Promise<Error | null> {
    const stop = () => {
      void this.stop();
    };
    const unsubscribe = context.onCancel(stop);
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await (this.startTask ?? this.start());
      if (error) return (await this.stop()) ?? context.err() ?? error;
      const loopError = await lifecycle(async () => {
        if (!this.shutdown.err()) {
          this.heartbeat = startHeartbeat(this.options.transport, (record) =>
            this.logRecord(record, "warn"),
          );
          this.workspaces!.startSweeping();
        }
        const resume = this.draining
          ? new CancellationContext(
              this.pulls,
              Date.now() +
                (this.options.resume_pull_wait_ms ?? RESUME_PULL_WAIT_MS),
            )
          : undefined;
        const failure = await pullLoop({
          api: this.options.transport,
          registration: this.registration!,
          backoff: new Backoff(),
          shutdown: resume ?? this.pulls,
          pulling: (task) => {
            this.pulling = task;
            this.pullStarted = true;
            if (resume)
              void task.then(
                () => resume.cancel(),
                () => resume.cancel(),
              );
          },
          claimed: (claim) => this.beginExecution(claim),
          host: async () => this.execution!.task,
          register: async () => {
            this.registering = register(this.options.transport).then(
              (registration) => {
                this.registration = registration;
                this.logRecord({ msg: READY_MESSAGE, ...registration });
                return registration;
              },
            );
            return this.registering;
          },
        });
        if (failure?.code === ANSWER_INVALID) this.registrationKept = true;
        if (failure) throw failure;
      });
      const wasStopping = this.shutdown.err() !== null;
      const stopError = await this.stop();
      return (
        (wasStopping ? (stopError ?? loopError) : (loopError ?? stopError)) ??
        context.err()
      );
    } finally {
      unsubscribe();
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

  private openLog(): void {
    if (!isString(this.options.log)) return;
    this.operationalLog = new OperationalLog(
      { level: "info", destination: this.options.log },
      directories(this.options.env).state,
    );
  }

  private logRecord(
    record: Record<string, unknown>,
    level: "info" | "warn" = "info",
  ): void {
    if (isString(this.options.log))
      this.operationalLog!.logger[level](record, String(record.msg));
    else this.options.log(JSON.stringify(record));
  }

  private beginExecution(claim: ExecutionRecord): void {
    this.executionLive = true;
    const context = new CancellationContext(background, claim.expired_at);
    if (this.shutdown.err()) context.cancel();
    const task = this.execute(claim, context)
      .then((result) => {
        if (result === null) this.executionLive = false;
        return result;
      })
      .finally(() => context.cancel());
    this.execution = { context, task };
  }

  private async execute(
    claim: ExecutionRecord,
    context: Context,
  ): Promise<Diagnostic | null> {
    return hostExecution({
      claim,
      api: this.options.transport,
      clientSecret: this.clientSecret!.toString("base64"),
      workspaces: this.workspaces!,
      transport: this.repository!,
      modelRuntimeFactory:
        this.options.model_runtime_factory ?? defaultModelRuntimeFactory,
      hostHome: this.options.env.HOME ?? homedir(),
      env: this.options.env,
      context,
      transcript: fileTranscript(directories(this.options.env).state),
      log: (record) => this.logRecord(record),
    });
  }
}
