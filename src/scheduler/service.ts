import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import { asError, Diagnostic, OperationError } from "../kernel/errors.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  createIdentity,
  identitySchema,
  identityTime,
} from "../kernel/identity.ts";
import {
  AccessPolicy,
  type CallerContext,
  type OperationRegistry,
} from "../kernel/operation.ts";
import {
  type Healthcheck,
  HealthStatus,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { SchedulerConfig } from "./config.ts";
import {
  ExecutionEnd,
  type ExecutionTelemetry,
  RevokeCause,
} from "../tracking/contract.ts";
import { executionTransition, reportLost } from "./telemetry.ts";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
  type FailureCause,
} from "../kernel/cause.ts";
import * as settlement from "./settlement.ts";
import {
  nodeBranchOfExecution,
  readExecution,
  readExpiredUnsettled,
  readUnendedOfRuntime,
} from "./execution-store.ts";
import { WaitingPulls } from "./wakeup.ts";
import { InstanceQueue } from "./instance-queue.ts";
import { workPull } from "./work-pull.ts";
import { release } from "./release.ts";
import { claimGet, executionGet, executionList } from "./execution-read.ts";
import {
  type AgentChains,
  type AgentPin,
  type AgentSelection,
  type EndedExecution,
  type EnvironmentGate,
  EXECUTION_IDENTITY_PREFIX,
  type Job,
  JOB_IDENTITY_PREFIX,
  LOSS_SWEEP_INTERVAL_MS,
  type MissionBranches,
  type MissionClaimFacts,
  type MissionTransitions,
  type NodeTransition,
  type ProjectPauses,
  QUEUE_LIST_LIMIT_DEFAULT,
  type Registrations,
  type RevokedExecution,
  SCHEDULER_SERVICE_NAME,
  schedulerOperations,
  type TraceIdentity,
  type UnmatchedClaim,
  type WorkerBindings,
  type WorkerDeclarations,
  type WorkQueue,
} from "./contract.ts";
import { unmatchedClaims } from "./match.ts";

const SCHEDULER_STOPPED_CODE = "scheduler.lifecycle.stopped";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const FIRST_ROW = 0;
const EXTRA_ROW = 1;
const ONE_JOB = 1;
const CURSOR_SEPARATOR = "|";
const QUEUE_CURSOR_PARTS = 2;

type QueueCursor = { priority: number; job_id: string };

type JobRow = {
  id: string;
  project_id: string;
  node_id: string;
  priority: number;
  queued_at: number;
};

function toJob(row: JobRow): Job {
  return {
    job_id: row.id,
    project_id: row.project_id,
    node_id: row.node_id,
    priority: row.priority,
    queued_at: row.queued_at,
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
    `${job.priority}${CURSOR_SEPARATOR}${job.job_id}`,
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
  return { priority, job_id: jobId };
}

export interface Dependencies {
  config: SchedulerConfig;
  store: Store;
  transitions: MissionTransitions;
  registrations: Registrations;
  declarations: WorkerDeclarations;
  bindings: WorkerBindings;
  facts: MissionClaimFacts;
  environments: EnvironmentGate;
  branches: MissionBranches;
  projects: ProjectPauses;
  agentChains: AgentChains;
  traceIdentity: TraceIdentity;
  telemetry: ExecutionTelemetry;
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
  private readonly instances = new InstanceQueue((runtimeIdentities) =>
    this.waiting.wakeRuntimes(runtimeIdentities),
  );
  private accepting = true;
  private lossTimer?: NodeJS.Timeout;
  private runError: Error | null = null;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(SCHEDULER_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  settle(tx: Transaction, nodeId: string, now: number): EndedExecution[] {
    const lost = settlement.settleNode(tx, this.dependencies, nodeId, now);
    return lost === null ? [] : [lost];
  }
  executionsLost(lost: readonly EndedExecution[]): void {
    reportLost(this.dependencies.telemetry, lost);
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
    if (row && now < row.expired_at)
      return { activity: "executing" as const, execution_id: row.execution_id };
    return {
      activity: this.pulling(runtimeIdentity)
        ? ("pulling" as const)
        : ("idle" as const),
      execution_id: null,
    };
  }
  executionOf(executionId: string) {
    return this.dependencies.store.transaction((tx) => {
      const row = readExecution(tx, executionId);
      if (row === null) return undefined;
      return {
        ...row,
        node_branch: nodeBranchOfExecution(tx, this.dependencies.branches, row),
      };
    });
  }
  revoke(
    tx: Transaction,
    nodeId: string,
    now: number,
  ): RevokedExecution | null {
    return settlement.revoke(tx, nodeId, now);
  }
  executionRevoked(
    execution: RevokedExecution,
    cause: RevokeCause,
    transition: NodeTransition | null,
    failureCause: FailureCause | null,
  ): void {
    this.dependencies.telemetry.executionEnded({
      trace: execution.trace,
      ended_at: execution.ended_at,
      end: ExecutionEnd.Revoked,
      revoke_cause: cause,
      stop: null,
      cause:
        cause === RevokeCause.Human
          ? attributed(CauseCategory.Human, CauseSubcategory.Intervention)
          : failureCause,
    });
    if (cause !== RevokeCause.Assessment) return;
    assert.ok(transition, "a revocation by an assessment moved its node");
    this.dependencies.telemetry.executionTransition(
      execution.trace,
      executionTransition(transition, execution.ended_at, null),
    );
  }
  liveExecutionOf(tx: Transaction, nodeId: string, now: number) {
    return settlement.liveExecutionOf(tx, nodeId, now);
  }
  unendedExecutionOf(tx: Transaction, runtimeIdentity: string) {
    return readUnendedOfRuntime(tx, runtimeIdentity);
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
  agentSelectionsOf(tx: Transaction, executionId: string): AgentSelection[] {
    const row = readExecution(tx, executionId);
    return row
      ? this.dependencies.agentChains.resolve(
          tx,
          row.worker_binding_id,
          row.agent_pins,
        )
      : [];
  }
  agentPinsOf(
    tx: Transaction,
    executionId: string,
  ): { worker_binding_id: string; pins: AgentPin[] } | null {
    const row = readExecution(tx, executionId);
    return row
      ? { worker_binding_id: row.worker_binding_id, pins: row.agent_pins }
      : null;
  }
  unmatchedClaims(tx: Transaction, projectId: string): UnmatchedClaim[] {
    return unmatchedClaims(tx, this.dependencies, projectId);
  }

  insert(
    tx: Transaction,
    nodeId: string,
    projectId: string,
    priority: number,
  ): void {
    tx.database
      .prepare(
        "INSERT INTO scheduler_queue_place (node_id, job_id) VALUES (?, ?) ON CONFLICT (node_id) DO NOTHING",
      )
      .run(nodeId, createIdentity(JOB_IDENTITY_PREFIX));
    const inserted = tx.database
      .prepare(
        "INSERT INTO scheduler_job (id, project_id, node_id, priority, queued_at) SELECT job_id, ?, node_id, ?, ? FROM scheduler_queue_place WHERE node_id = ?",
      )
      .run(projectId, priority, Date.now(), nodeId);
    assert.equal(inserted.changes, ONE_JOB);
  }

  firstQueuedAt(tx: Transaction, nodeId: string): number | null {
    const place = tx.database
      .prepare("SELECT job_id FROM scheduler_queue_place WHERE node_id = ?")
      .get(nodeId) as { job_id: string } | undefined;
    return place === undefined ? null : identityTime(place.job_id);
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
      claimGet(this.dependencies, input.params.execution_id, caller),
    );
    registry.register(schedulerOperations.executionGet, (input, caller) =>
      executionGet(this.dependencies, input.params.execution_id, caller),
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
        input.params.execution_id,
        input.body,
        caller,
        (projectId, runtimeIdentities) => {
          this.wake(projectId);
          this.waiting.wakeRuntimes(runtimeIdentities);
        },
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
          instances: this.instances,
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
    const { project_id: projectId } = input.params;
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
                "SELECT id, project_id, node_id, priority, queued_at FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC LIMIT ?",
              )
              .all(projectId, limit + EXTRA_ROW)
          : tx.database
              .prepare(
                "SELECT id, project_id, node_id, priority, queued_at FROM scheduler_job WHERE project_id = ? AND (priority < ? OR (priority = ? AND id > ?)) ORDER BY priority DESC, id ASC LIMIT ?",
              )
              .all(
                projectId,
                after.priority,
                after.priority,
                after.job_id,
                limit + EXTRA_ROW,
              );
      const items = (rows as JobRow[]).slice(FIRST_ROW, limit).map(toJob);
      const nextCursor =
        rows.length > limit ? encodeQueueCursor(items.at(-1)!) : null;
      return { items, next_cursor: nextCursor };
    });
  }

  private queuePeek(
    input: typeof schedulerOperations.queuePeek.input._output,
    caller: CallerContext,
  ): typeof schedulerOperations.queuePeek.output._output {
    return caller.commit((tx) => {
      const row = tx.database
        .prepare(
          "SELECT id, project_id, node_id, priority, queued_at FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC LIMIT 1",
        )
        .get(input.params.project_id) as JobRow | undefined;
      return { job: row ? toJob(row) : null };
    });
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
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
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
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
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? this.runError ?? reasonOf(context.signal);
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      queue:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  sweep(): void {
    this.dependencies.store.transaction((tx) =>
      this.instances.prune((runtimeIdentity) =>
        this.dependencies.registrations.registrationHealthcheck(
          tx,
          runtimeIdentity,
        ),
      ),
    );
    const identities = this.dependencies.store.transaction((tx) =>
      readExpiredUnsettled(tx, Date.now()).map((row) => row.execution_id),
    );
    for (let index = 0; index < identities.length; index++) {
      const lost = this.dependencies.store.transaction((tx) => {
        const now = Date.now();
        const row = readExecution(tx, identities[index]!);
        if (!row || row.ended_at !== null || now < row.expired_at) return null;
        return settlement.declareLoss(tx, this.dependencies, row, now);
      });
      if (lost === null) continue;
      this.executionsLost([lost]);
      this.wake(lost.trace.project_id);
    }
    const projects = this.waiting.projectIds();
    for (let index = 0; index < projects.length; index++)
      this.wake(projects[index]!);
  }
}
