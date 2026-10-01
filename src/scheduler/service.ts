import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
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
import type { Transaction } from "../kernel/store.ts";
import type { SchedulerConfig } from "./config.ts";
import {
  JOB_IDENTITY_PREFIX,
  QUEUE_LIST_LIMIT_DEFAULT,
  SCHEDULER_SERVICE_NAME,
  schedulerOperations,
  type Job,
  type WorkQueue,
} from "./contract.ts";

const SCHEDULER_STOPPED_CODE = "scheduler.lifecycle.stopped";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const FIRST_ROW = 0;
const EXTRA_ROW = 1;

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

function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor ||
    !identitySchema(JOB_IDENTITY_PREFIX).safeParse(decoded).success
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      CURSOR_INVALID_CODE,
      "Cursor is invalid.",
    );
  return decoded;
}

export interface Dependencies {
  config: SchedulerConfig;
  health?: HealthRegistry;
}

export class SchedulerService implements Service, WorkQueue {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;

  constructor(dependencies: Dependencies) {
    dependencies.health?.register(SCHEDULER_SERVICE_NAME, () =>
      this.healthcheck(),
    );
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
      schedulerOperations.queuePeek.access !== AccessPolicy.Human
    )
      throw new Error(
        "Scheduler operations require scheduler ownership and human access.",
      );
    registry.register(schedulerOperations.queueList, (input, caller) =>
      this.queueList(input, caller),
    );
    registry.register(schedulerOperations.queuePeek, (input, caller) =>
      this.queuePeek(input, caller),
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
        : decodeCursor(input.query.cursor);
    return caller.commit((tx) => {
      const rows =
        after === undefined
          ? tx.database
              .prepare(
                "SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? ORDER BY id DESC LIMIT ?",
              )
              .all(projectId, limit + EXTRA_ROW)
          : tx.database
              .prepare(
                "SELECT id, project_id, node_id, priority FROM scheduler_job WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
              )
              .all(projectId, after, limit + EXTRA_ROW);
      const items = (rows as JobRow[]).slice(FIRST_ROW, limit).map(toJob);
      const nextCursor =
        rows.length > limit
          ? Buffer.from(items.at(-1)!.jobId, TEXT_ENCODING).toString(
              CURSOR_ENCODING,
            )
          : null;
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
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
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
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
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
}
