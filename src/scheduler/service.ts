import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { asError, Diagnostic, OperationError } from "../kernel/errors.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import {
  AccessPolicy,
  type CallerContext,
  type OperationRegistry,
} from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { SchedulerConfig } from "./config.ts";
import * as settlement from "./settlement.ts";
import {
  readExecution,
  readExpiredUnsettled,
  readUnendedOfRuntime,
} from "./execution-store.ts";
import { WaitingPulls } from "./wakeup.ts";
import { workPull } from "./work-pull.ts";
import { release } from "./release.ts";
import { claimGet, executionGet, executionList } from "./execution-read.ts";
import {
  JOB_IDENTITY_PREFIX,
  EXECUTION_IDENTITY_PREFIX,
  LOSS_SWEEP_INTERVAL_MS,
  QUEUE_LIST_LIMIT_DEFAULT,
  SCHEDULER_SERVICE_NAME,
  schedulerOperations,
  type Job,
  type WorkQueue,
  type MissionTransitions,
  type InstanceRegistrations,
  type WorkerDeclarations,
  type WorkerBindings,
  type TraceIdentity,
} from "./contract.ts";

const SCHEDULER_STOPPED_CODE = "scheduler.lifecycle.stopped";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const FIRST_ROW = 0;
const EXTRA_ROW = 1;
const CURSOR_SEPARATOR = "|";
const QUEUE_CURSOR_PARTS = 2;

type QueueCursor = { priority: number; jobId: string };

type JobRow = {
  id: string;
  project_id: string;
  node_id: string;
  priority: number;
};

function toJob(row: JobRow): Job {
  return {
    jobId: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    priority: row.priority,
  };
}

function decodeCursor(cursor: string, prefix: string): string {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor ||
    !identitySchema(prefix).safeParse(decoded).success
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      CURSOR_INVALID_CODE,
      "Cursor is invalid.",
    );
  return decoded;
}

function invalidCursor(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    CURSOR_INVALID_CODE,
    "Cursor is invalid.",
  );
}

function encodeQueueCursor(job: Job): string {
  return Buffer.from(
    `${job.priority}${CURSOR_SEPARATOR}${job.jobId}`,
    TEXT_ENCODING,
  ).toString(CURSOR_ENCODING);
}

function decodeQueueCursor(cursor: string): QueueCursor {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor)
    invalidCursor();
  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length !== QUEUE_CURSOR_PARTS) invalidCursor();
  const [priorityText, jobId] = parts as [string, string];
  const priority = Number(priorityText);
  if (
    !Number.isSafeInteger(priority) ||
    String(priority) !== priorityText ||
    !identitySchema(JOB_IDENTITY_PREFIX).safeParse(jobId).success
  )
    invalidCursor();
  return { priority, jobId };
}

export interface Dependencies {
  config: SchedulerConfig;
  store: Store;
  transitions: MissionTransitions;
  registrations: InstanceRegistrations;
  declarations: WorkerDeclarations;
  bindings: WorkerBindings;
  traceIdentity: TraceIdentity;
  health?: HealthRegistry;
}

export class SchedulerService implements Service, WorkQueue {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly dependencies: Dependencies;
  private readonly waiting = new WaitingPulls();
  private accepting = true;
  private lossTimer?: NodeJS.Timeout;
  private runError: Error | null = null;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(SCHEDULER_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  settle(tx: Transaction, nodeId: string, now: number): void {
    settlement.settleNode(tx, this.dependencies, nodeId, now);
  }
  pinCredential(
    tx: Transaction,
    executionId: string,
    credentialId: string,
  ): void {
    settlement.pinCredential(tx, executionId, credentialId);
  }
  liveExecutionsPinning(tx: Transaction, credentialId: string): string[] {
    return settlement.liveExecutionsPinning(tx, credentialId);
  }
  executionAttribution(tx: Transaction, executionId: string) {
    return settlement.executionAttribution(tx, this.dependencies, executionId);
  }
  wake(projectId: string): void {
    this.waiting.wake(projectId);
  }
  pulling(runtimeIdentity: string): boolean {
    return this.waiting.pulling(runtimeIdentity);
  }
  activityOf(tx: Transaction, runtimeIdentity: string, now: number) {
    const row = readUnendedOfRuntime(tx, runtimeIdentity);
    if (row && now < row.expiredAt)
      return { activity: "executing" as const, executionId: row.executionId };
    return {
      activity: this.pulling(runtimeIdentity)
        ? ("pulling" as const)
        : ("idle" as const),
      executionId: null,
    };
  }
  executionOf(executionId: string) {
    return this.dependencies.store.transaction(
      (tx) => readExecution(tx, executionId) ?? undefined,
    );
  }
  revoke(tx: Transaction, nodeId: string, now: number): string | null {
    return settlement.revoke(tx, nodeId, now);
  }
  liveExecutionOf(tx: Transaction, nodeId: string, now: number) {
    return settlement.liveExecutionOf(tx, nodeId, now);
  }
  runningExecutionOfRuntime(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ) {
    return settlement.runningExecutionOfRuntime(
      tx,
      this.dependencies,
      runtimeIdentity,
      now,
    );
  }
  requireRunning(
    tx: Transaction,
    executionId: string,
    runtimeIdentity: string,
    now: number,
  ) {
    return settlement.requireRunning(tx, executionId, runtimeIdentity, now);
  }

  insert(
    tx: Transaction,
    nodeId: string,
    projectId: string,
    priority: number,
  ): void {
    const id = createIdentity(JOB_IDENTITY_PREFIX);
    tx.database
      .prepare(
        "INSERT INTO scheduler_job (id, project_id, node_id, priority) VALUES (?, ?, ?, ?)",
      )
      .run(id, projectId, nodeId, priority);
  }

  delete(tx: Transaction, nodeId: string): void {
    tx.database
      .prepare("DELETE FROM scheduler_job WHERE node_id = ?")
      .run(nodeId);
  }

  priorityUpdate(tx: Transaction, nodeId: string, priority: number): void {
    tx.database
      .prepare("UPDATE scheduler_job SET priority = ? WHERE node_id = ?")
      .run(priority, nodeId);
  }

  declare(registry: OperationRegistry): void {
    if (
      schedulerOperations.queueList.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.queueList.access !== AccessPolicy.Human ||
      schedulerOperations.queuePeek.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.queuePeek.access !== AccessPolicy.Human ||
      schedulerOperations.workPull.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.workPull.access !== AccessPolicy.Client ||
      schedulerOperations.executionRelease.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.executionRelease.access !== AccessPolicy.Client ||
      schedulerOperations.claimGet.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.claimGet.access !== AccessPolicy.Client ||
      schedulerOperations.executionList.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.executionList.access !== AccessPolicy.Human ||
      schedulerOperations.executionGet.service !== SCHEDULER_SERVICE_NAME ||
      schedulerOperations.executionGet.access !== AccessPolicy.Human
    )
      throw new Error(
        "Scheduler operations require scheduler ownership and their declared access.",
      );
    registry.register(schedulerOperations.queueList, (input, caller) =>
      this.queueList(input, caller),
    );
    registry.register(schedulerOperations.claimGet, (input, caller) =>
      claimGet(this.dependencies, input.params.executionId, caller),
    );
    registry.register(schedulerOperations.executionGet, (input, caller) =>
      executionGet(this.dependencies, input.params.executionId, caller),
    );
    registry.register(schedulerOperations.executionList, (input, caller) =>
      executionList(
        this.dependencies,
        input,
        caller,
        input.query.cursor === undefined
          ? undefined
          : decodeCursor(input.query.cursor, EXECUTION_IDENTITY_PREFIX),
      ),
    );
    registry.register(schedulerOperations.executionRelease, (input, caller) =>
      release(
        this.dependencies,
        input.params.executionId,
        input.body.furtherWork,
        caller,
        (projectId) => this.wake(projectId),
      ),
    );
    registry.register(schedulerOperations.queuePeek, (input, caller) =>
      this.queuePeek(input, caller),
    );
    registry.register(schedulerOperations.workPull, (input, caller) =>
      workPull(
        {
          ...this.dependencies,
          waiting: this.waiting,
          accepting: () => this.accepting,
        },
        input.body,
        caller,
      ),
    );
  }

  private queueList(
    input: typeof schedulerOperations.queueList.input._output,
    caller: CallerContext,
  ): typeof schedulerOperations.queueList.output._output {
    const { projectId } = input.params;
    const limit = input.query.limit ?? QUEUE_LIST_LIMIT_DEFAULT;
    const after =
      input.query.cursor === undefined
        ? undefined
        : decodeQueueCursor(input.query.cursor);
    return caller.commit((tx) => {
      const rows =
        after === undefined
          ? tx.database
              .prepare(
                "SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC LIMIT ?",
              )
              .all(projectId, limit + EXTRA_ROW)
          : tx.database
              .prepare(
                "SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? AND (priority < ? OR (priority = ? AND id > ?)) ORDER BY priority DESC, id ASC LIMIT ?",
              )
              .all(
                projectId,
                after.priority,
                after.priority,
                after.jobId,
                limit + EXTRA_ROW,
              );
      const items = (rows as JobRow[]).slice(FIRST_ROW, limit).map(toJob);
      const nextCursor =
        rows.length > limit ? encodeQueueCursor(items.at(-1)!) : null;
      return { items, nextCursor };
    });
  }

  private queuePeek(
    input: typeof schedulerOperations.queuePeek.input._output,
    caller: CallerContext,
  ): typeof schedulerOperations.queuePeek.output._output {
    return caller.commit((tx) => {
      const row = tx.database
        .prepare(
          "SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC LIMIT 1",
        )
        .get(input.params.projectId) as JobRow | undefined;
      return { job: row ? toJob(row) : null };
    });
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          SCHEDULER_STOPPED_CODE,
          "scheduler: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    clearInterval(this.lossTimer);
    this.lossTimer = undefined;
    this.accepting = false;
    this.waiting.wakeAll();
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
    void this.quiesce();
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= Promise.resolve(null);
    return this.stopTask;
  }
  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      if (this.accepting)
        this.lossTimer ??= setInterval(() => {
          try {
            this.sweep();
          } catch (failure) {
            this.runError = asError(failure);
            void this.stop();
          }
        }, LOSS_SWEEP_INTERVAL_MS).unref();
      await this.shutdown.done();
      return (await this.stop()) ?? this.runError ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      queue:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  sweep(): void {
    const identities = this.dependencies.store.transaction((tx) =>
      readExpiredUnsettled(tx, Date.now()).map((row) => row.executionId),
    );
    for (let index = 0; index < identities.length; index++) {
      const projectId = this.dependencies.store.transaction((tx) => {
        const now = Date.now();
        const row = readExecution(tx, identities[index]!);
        if (!row || row.endedAt !== null || now < row.expiredAt) return null;
        settlement.declareLoss(tx, this.dependencies, row, now);
        return row.projectId;
      });
      if (projectId !== null) this.wake(projectId);
    }
    const projects = this.waiting.projectIds();
    for (let index = 0; index < projects.length; index++)
      this.wake(projects[index]!);
  }
}
