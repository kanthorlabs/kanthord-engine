import { addAbortListener } from "node:events";
import { registerBunOAuthFlows as registerOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { type LogConfig, OperationalLog } from "../../kernel/log.ts";
import {
  type Healthcheck,
  HealthStatus,
  lifecycle,
} from "../../kernel/service.ts";
import { isString } from "../../kernel/values.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { FOOTPRINT_MEASURE_INTERVAL_MS } from "../../footprint/contract.ts";
import {
  type FootprintMeasurement,
  type FootprintOrder,
  type FootprintResult,
  WorkerErrorCode,
} from "../../worker/contract.ts";
import { packageVersion } from "../../kernel/version.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { Backoff } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import {
  deregister,
  register,
  type Registration,
  startHeartbeat,
} from "./registration.ts";
import {
  defaultModelRuntimeFactory,
  executionSessionRoot,
  installPiTools,
  type ModelRuntimeFactory,
  type RepositoryTransport,
  UnitFootprint,
  WorkspaceRoot,
} from "../../worker/unit/index.ts";
import { hostExecution } from "./execution.ts";
import type { CopyKeys } from "./copy-keys.ts";
import { readServerVersion } from "../../gateway/client.ts";
import { homedir } from "node:os";
import { pullLoop, SETUP_UNAVAILABLE } from "./pull-loop.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";

const KEEPALIVE_INTERVAL_MS = 60000;
const READY_MESSAGE = "Worker application ready";
const GATEWAY_CODE = "gateway.";
const GATEWAY_CLIENT_CODE = "gateway.client.";
const ANSWER_INVALID = "gateway.client.answer_invalid";
const RESUME_PULL_WAIT_MS = 5000;
const FOOTPRINT_REPORT_FAILED = "Worker footprint report failed";
const FOOTPRINT_MEASURE_FAILED = "Worker footprint measure failed";

export interface UnitBinding {
  transport: WorkerTransport;
  client_secret: string;
}

export interface UnitDirectories {
  data: string;
  log: string;
}

export interface UnitFootprintScope {
  residue_root: string;
  worker_placement: boolean;
}

export interface WorkerUnitOptions {
  bindings: UnitBinding[];
  directories: UnitDirectories;
  env: NodeJS.ProcessEnv;
  log: LogConfig["destination"] | ((message: string) => void);
  model_runtime_factory?: ModelRuntimeFactory;
  repository_transport?: RepositoryTransport;
  watchdog?: () => () => void;
  resume_pull_wait_ms?: number;
  refused?: (binding: UnitBinding) => void;
  copy_keys?: CopyKeys;
  footprint?: UnitFootprintScope;
}

interface Entry {
  binding: UnitBinding;
  secret: Buffer;
  pulls: CancellationContext;
  registration?: Registration;
  registering?: Promise<Registration>;
  heartbeat?: { stop(): void };
  pulling?: Promise<unknown>;
  loop?: Promise<Diagnostic | null>;
  kept: boolean;
}

interface Execution {
  claim: ExecutionRecord;
  entry: Entry;
  context: CancellationContext;
  task: Promise<Diagnostic | null | typeof SETUP_UNAVAILABLE>;
}

export class WorkerUnit {
  private readonly options: WorkerUnitOptions;
  private readonly shutdown = new CancellationContext();
  private readonly pulls = new CancellationContext(this.shutdown);
  private readonly entries: Entry[] = [];
  private startTask?: Promise<Error | null>;
  private runTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private started = false;
  private running = false;
  private keepalive?: NodeJS.Timeout;
  private operationalLog?: OperationalLog;
  private repository?: RepositoryTransport;
  private workspaces?: WorkspaceRoot;
  private round?: CancellationContext;
  private execution?: Execution;
  private executionLive = false;
  private draining = false;
  private pullStarted = false;
  private failure?: Diagnostic;
  private changed = Promise.withResolvers<void>();
  private footprint?: UnitFootprint;
  private footprintTimer?: NodeJS.Timeout;
  private footprintTask: Promise<void> = Promise.resolve();
  private footprintResults: FootprintResult[] = [];
  private executionStartedAt: number | null = null;

  constructor(options: WorkerUnitOptions) {
    registerOAuthFlows();
    this.options = options;
    for (const binding of options.bindings)
      this.entries.push(this.entryOf(binding));
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
      const pi = join(this.options.directories.data, PI_DIRECTORY_NAME);
      installPiTools({ env: this.options.env, directory: pi });
      usePiDirectory(pi);
      this.shutdown.signal.throwIfAborted();
      this.repository =
        this.options.repository_transport ?? new RepositoryComponent();
      this.shutdown.signal.throwIfAborted();
      const first = this.entries.at(0);
      if (first) await this.checkVersion(first.binding.transport);
      this.workspaces = WorkspaceRoot.open(this.options.directories.data);
      this.shutdown.signal.throwIfAborted();
      this.openLog();
      for (const entry of [...this.entries]) {
        if (this.shutdown.signal.aborted) return;
        await this.registerEntry(entry);
      }
      if (this.shutdown.signal.aborted) return;
      this.started = true;
      this.keepalive = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
      this.startFootprint();
    });
    return this.startTask;
  }

  private startFootprint(): void {
    const scope = this.options.footprint;
    if (!scope || this.footprint) return;
    this.footprint = new UnitFootprint({
      data: this.options.directories.data,
      logDirectory: this.options.directories.log,
      temporary: this.options.env.TMPDIR ?? tmpdir(),
      residueRoot: scope.residue_root,
      workerPlacement: scope.worker_placement,
      workspaces: this.workspaces!,
      runningSince: () => this.executionStartedAt,
      liveExecutions: () =>
        this.executionLive && this.execution
          ? [this.execution.claim.execution_id]
          : [],
    });
    this.measureFootprint();
    this.footprintTimer = setInterval(
      () => this.measureFootprint(),
      FOOTPRINT_MEASURE_INTERVAL_MS,
    );
    this.footprintTimer.unref();
  }

  private serializeFootprint(task: () => Promise<void>): Promise<void> {
    this.footprintTask = this.footprintTask.then(task).catch((error) => {
      if (!this.shutdown.signal.aborted)
        this.logRecord(
          {
            msg: FOOTPRINT_REPORT_FAILED,
            code: error instanceof Diagnostic ? error.code : null,
          },
          "warn",
        );
    });
    return this.footprintTask;
  }

  private measureFootprint(): void {
    void this.serializeFootprint(async () => {
      let measurement: FootprintMeasurement | null = null;
      try {
        measurement = await this.footprint!.measure(this.shutdown.signal);
      } catch (error) {
        if (this.shutdown.signal.aborted) return;
        this.logRecord(
          {
            msg: FOOTPRINT_MEASURE_FAILED,
            code: (error as NodeJS.ErrnoException).code ?? null,
          },
          "warn",
        );
      }
      await this.reportFootprint(measurement);
    });
  }

  footprintOrders(orders: readonly FootprintOrder[]): Promise<void> {
    if (!this.footprint || !orders.length) return Promise.resolve();
    return this.serializeFootprint(() => this.runFootprintOrders(orders));
  }

  private async reportFootprint(
    measurement: FootprintMeasurement | null,
  ): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    const transport = this.entries.find((entry) => entry.registration)?.binding
      .transport;
    if (!transport) return;
    let orders: readonly FootprintOrder[] = [];
    for (const result of [...this.footprintResults]) {
      const answer = await this.sendFootprint(transport, null, [result]);
      if (answer === null) break;
      this.footprintResults = this.footprintResults.filter(
        (pending) => pending !== result,
      );
      orders = answer;
    }
    if (measurement !== null) {
      const answer = await this.sendFootprint(transport, measurement, []);
      if (answer === null) return;
      orders = answer;
    }
    if (orders.length) await this.runFootprintOrders(orders);
  }

  private async sendFootprint(
    transport: WorkerTransport,
    measurement: FootprintMeasurement | null,
    results: readonly FootprintResult[],
  ): Promise<readonly FootprintOrder[] | null> {
    const answer = await transport.worker["footprint.report"](
      { params: {}, query: {}, body: { measurement, results: [...results] } },
      { context: this.shutdown, idempotencyKey: createIdempotencyKey() },
    );
    if (answer.type === OperationResultType.Indeterminate) return null;
    if (answer.type === OperationResultType.Completed)
      return answer.data.orders;
    if (answer.error.error.code === WorkerErrorCode.FootprintOrderUnknown)
      return [];
    this.logRecord(
      { msg: FOOTPRINT_REPORT_FAILED, code: answer.error.error.code },
      "warn",
    );
    return null;
  }

  private async runFootprintOrders(
    orders: readonly FootprintOrder[],
  ): Promise<void> {
    let ran = false;
    for (const order of orders) {
      if (this.shutdown.signal.aborted) return;
      if (
        this.footprintResults.some(
          (result) => result.cleanup_id === order.cleanup_id,
        )
      )
        continue;
      const result = await this.footprint!.run(order, this.shutdown.signal);
      if (!result) continue;
      this.footprintResults.push(result);
      ran = true;
    }
    if (ran) await this.reportFootprint(null);
  }

  quiesce(): Promise<Error | null> {
    this.quiesceTask ??= lifecycle(async () => {
      this.shutdown.cancel();
      for (const entry of this.entries) entry.heartbeat?.stop();
    });
    return this.quiesceTask;
  }

  stop(): Promise<Error | null> {
    this.stopTask ??= lifecycle(async () => {
      let disarm: (() => void) | undefined;
      try {
        const error = await this.quiesce();
        await this.startTask;
        for (const entry of this.entries) {
          await entry.pulling;
          await entry.registering;
        }
        if (error) throw error;
        if (this.executionLive) {
          this.execution?.context.cancel();
          await this.execution?.task;
          throw new Diagnostic(
            "worker.stop.execution_live",
            "worker: stop during a live execution.",
          );
        }
        clearInterval(this.footprintTimer);
        await this.footprintTask;
        disarm = this.options.watchdog?.();
        for (const entry of this.entries) {
          const failure = await this.deregisterEntry(entry);
          if (failure) throw failure;
        }
      } finally {
        this.started = false;
        for (const entry of this.entries) entry.secret.fill(0);
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

  abandon(): Promise<Error | null> {
    for (const entry of this.entries) entry.kept = true;
    return this.stop();
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

  async add(binding: UnitBinding): Promise<Error | null> {
    if (this.shutdown.signal.aborted || this.pulls.signal.aborted) return null;
    const entry = this.entryOf(binding);
    this.entries.push(entry);
    return lifecycle(async () => {
      await this.startTask;
      if (this.shutdown.signal.aborted) return;
      await this.registerEntry(entry);
      if (this.running && !entry.loop && !this.pulls.signal.aborted)
        this.runEntry(entry);
    });
  }

  async remove(binding: UnitBinding): Promise<Error | null> {
    const entry = this.entries.find((item) => item.binding === binding);
    if (!entry) return null;
    entry.pulls.cancel();
    const failure = await entry.loop;
    await entry.pulling;
    await entry.registering;
    entry.heartbeat?.stop();
    if (failure) return failure;
    if (this.shutdown.signal.aborted) return null;
    const error = await this.deregisterEntry(entry);
    if (error) return error;
    entry.secret.fill(0);
    this.entries.splice(this.entries.indexOf(entry), 1);
    return null;
  }

  private entryOf(binding: UnitBinding): Entry {
    return {
      binding,
      secret: Buffer.from(binding.client_secret, "base64"),
      pulls: new CancellationContext(this.pulls),
      kept: false,
    };
  }

  private async checkVersion(transport: WorkerTransport): Promise<void> {
    const version = await readServerVersion(transport.gateway, {
      context: this.shutdown,
    });
    this.shutdown.signal.throwIfAborted();
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
  }

  private async registerEntry(entry: Entry): Promise<void> {
    entry.registering = register(entry.binding.transport);
    try {
      entry.registration = await entry.registering;
    } finally {
      entry.registering = undefined;
    }
    if (this.shutdown.signal.aborted) return;
    if (this.operationalLog)
      this.operationalLog.logger.info(entry.registration, READY_MESSAGE);
    else this.logRecord({ msg: READY_MESSAGE, ...entry.registration });
  }

  private async deregisterEntry(entry: Entry): Promise<Diagnostic | null> {
    if (!entry.registration || entry.kept) return null;
    const failure = await deregister(
      entry.binding.transport,
      entry.registration.runtime_identity,
    );
    if (failure) return failure;
    entry.registration = undefined;
    return null;
  }

  private runEntry(entry: Entry): void {
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
    if (!this.shutdown.signal.aborted)
      entry.heartbeat = startHeartbeat(entry.binding.transport, (record) =>
        this.logRecord(record, "warn"),
      );
    const resume = this.draining
      ? new CancellationContext(
          entry.pulls,
          Date.now() +
            (this.options.resume_pull_wait_ms ?? RESUME_PULL_WAIT_MS),
        )
      : undefined;
    entry.loop = pullLoop({
      api: entry.binding.transport,
      registration: entry.registration!,
      backoff: new Backoff(),
      shutdown: resume ?? entry.pulls,
      idle: () => this.idle(),
      round: () => this.currentRound(),
      pulling: (task) => {
        entry.pulling = task;
        this.pullStarted = true;
        if (resume)
          void task.then(
            () => resume.cancel(),
            () => resume.cancel(),
          );
      },
      claimed: (claim) => this.beginExecution(entry, claim),
      host: async () => this.execution!.task,
      register: async () => {
        entry.registering = register(entry.binding.transport).then(
          (registration) => {
            entry.registration = registration;
            this.logRecord({ msg: READY_MESSAGE, ...registration });
            return registration;
          },
        );
        return entry.registering;
      },
    }).then(
      (failure) => {
        if (failure?.code === ANSWER_INVALID) entry.kept = true;
        if (this.handsOver(entry, failure)) return null;
        if (failure && !this.failure) {
          this.failure = failure;
          this.pulls.cancel();
        }
        return failure;
      },
      (error: unknown) => {
        this.pulls.cancel();
        throw error;
      },
    );
  }

  private handsOver(entry: Entry, failure: Diagnostic | null): boolean {
    if (
      !failure?.code.startsWith(GATEWAY_CODE) ||
      failure.code.startsWith(GATEWAY_CLIENT_CODE) ||
      !this.options.refused ||
      this.shutdown.signal.aborted ||
      entry.pulls.signal.aborted
    )
      return false;
    entry.kept = true;
    entry.heartbeat?.stop();
    this.options.refused(entry.binding);
    return true;
  }

  async restart(binding: UnitBinding): Promise<Error | null> {
    const entry = this.entries.find((item) => item.binding === binding);
    if (!entry || this.shutdown.signal.aborted || entry.pulls.signal.aborted)
      return null;
    return lifecycle(async () => {
      await entry.loop;
      entry.kept = false;
      await this.registerEntry(entry);
      if (this.running && !this.pulls.signal.aborted) this.runEntry(entry);
    });
  }

  private async waitLoops(): Promise<void> {
    for (;;) {
      const loops = this.entries
        .map((entry) => entry.loop)
        .filter((loop) => loop !== undefined);
      const changed = this.changed.promise;
      await Promise.all(loops);
      if (
        this.entries.some((entry) => entry.loop && !loops.includes(entry.loop))
      )
        continue;
      if (this.pulls.signal.aborted || this.draining) return;
      await Promise.race([cancelled(this.pulls.signal), changed]);
    }
  }

  private async runLoop(context: Context): Promise<Error | null> {
    const stop = () => {
      void this.stop();
    };
    using cancellation = addAbortListener(context.signal, stop);
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await (this.startTask ?? this.start());
    if (error) return (await this.stop()) ?? reasonOf(context.signal) ?? error;
    const loopError = await lifecycle(async () => {
      this.running = true;
      for (const entry of [...this.entries])
        if (entry.registration && !entry.loop) this.runEntry(entry);
      if (this.draining && !this.entries.length) this.pulls.cancel();
      await this.waitLoops();
      if (this.failure) throw this.failure;
    });
    const wasStopping = this.shutdown.signal.aborted;
    const stopError = await this.stop();
    return (
      (wasStopping ? (stopError ?? loopError) : (loopError ?? stopError)) ??
      reasonOf(context.signal)
    );
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      client:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  private async idle(): Promise<void> {
    while (this.executionLive && this.execution) {
      const result = await this.execution.task;
      if (result) return;
    }
  }

  private currentRound(): Context {
    if (!this.round || this.round.signal.aborted)
      this.round = new CancellationContext();
    return this.round;
  }

  private openLog(): void {
    if (!isString(this.options.log)) return;
    this.operationalLog = new OperationalLog(
      { level: "info", destination: this.options.log },
      this.options.directories.log,
    );
  }

  private logRecord(
    record: Record<string, unknown>,
    level: "info" | "warn" = "info",
  ): void {
    if (isString(this.options.log)) {
      const { msg, ...fields } = record;
      this.operationalLog!.logger[level](fields, String(msg));
    } else this.options.log(JSON.stringify(record));
  }

  private beginExecution(entry: Entry, claim: ExecutionRecord): void {
    this.executionLive = true;
    this.executionStartedAt = Date.now();
    this.round?.cancel();
    const context = new CancellationContext(background, claim.expired_at);
    if (this.shutdown.signal.aborted) context.cancel();
    const task = this.execute(entry, claim, context)
      .then((result) => {
        if (result === null || result === SETUP_UNAVAILABLE) {
          this.executionLive = false;
          this.executionStartedAt = null;
        }
        return result;
      })
      .finally(() => context.cancel());
    this.execution = { claim, entry, context, task };
  }

  private async execute(
    entry: Entry,
    claim: ExecutionRecord,
    context: Context,
  ): Promise<Diagnostic | null | typeof SETUP_UNAVAILABLE> {
    return hostExecution({
      claim,
      api: entry.binding.transport,
      clientSecret: entry.secret.toString("base64"),
      copyKeys: this.options.copy_keys,
      workspaces: this.workspaces!,
      transport: this.repository!,
      modelRuntimeFactory:
        this.options.model_runtime_factory ?? defaultModelRuntimeFactory,
      hostHome: this.options.env.HOME ?? homedir(),
      env: this.options.env,
      context,
      sessionRoot: executionSessionRoot(this.options.directories.data),
      log: (record) => this.logRecord(record),
    });
  }
}
