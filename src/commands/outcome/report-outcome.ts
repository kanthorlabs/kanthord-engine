import { aggregate } from "../../domain/aggregation.ts";
import { accountAttempts } from "../../domain/attempt-accounting.ts";
import type { ExternalTriggerId } from "../../domain/external-transition.ts";
import {
  assertRunAuthority,
  type RunAuthorityRefusalCode,
} from "../../domain/run-authority.ts";
import {
  taskReportEffect,
  type NodeReportResult,
} from "../../domain/outcome-report.ts";
import { terminalStates } from "../../domain/state.ts";
import type { NodeState, TerminalState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution, RunRecord } from "../../services/execution/index.ts";
import { LeaseError, type Lease } from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

const consumedTriggers = [
  "outcome-accepted",
  "attempt-rejected",
  "attempt-failed",
  "report-cancelled",
  "attempt-limit-reached",
] as const satisfies readonly ExternalTriggerId[];

export type NodeReportRequest =
  | Readonly<{ report: "accepted"; fence: number; objectId: string }>
  | Readonly<{ report: "rejected"; fence: number; reason: string }>
  | Readonly<{ report: "failed"; fence: number; reason: string }>
  | Readonly<{ report: "cancelled"; fence: number; reason?: string }>
  | Readonly<{ report: "attested"; fence: number; objectId: string }>
  | Readonly<{ report: "closed"; acknowledgePartial: boolean }>;

export type ReportObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  fence: number;
  objectId: string;
}>;

export type ReportObjectiveResult = NodeReportResult;

export type CloseObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  acknowledgePartial: boolean;
}>;

export type CloseObjectiveResult = NodeReportResult;

export type ReportOutcomeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  expiry: Readonly<{
    expireRuns(
      transaction: Transaction,
      input: Readonly<{ now: number }>,
    ): readonly unknown[];
  }>;
  caller: string;
  reportObjective: (
    transaction: Transaction,
    input: ReportObjectiveInput,
  ) => ReportObjectiveResult;
  closeObjective: (
    transaction: Transaction,
    input: CloseObjectiveInput,
  ) => CloseObjectiveResult;
  instanceId: string;
}>;

export type ReportOutcomeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  runId: string;
  runFence: number;
  body: NodeReportRequest;
}>;

export type ReportOutcomeResult = NodeReportResult;

export type ReportOutcomeRefusal =
  | RunAuthorityRefusalCode
  | "node-not-found"
  | "initiative-not-reportable"
  | "body-kind-mismatch"
  | "actor-forbidden"
  | "illegal-transition"
  | "lease-held";

export class ReportOutcomeError extends Error {
  readonly refusal: ReportOutcomeRefusal;
  readonly details: unknown;

  constructor(
    refusal: ReportOutcomeRefusal,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ReportOutcomeError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function reportOutcome(
  dependencies: ReportOutcomeDependencies,
  input: ReportOutcomeInput,
): ReportOutcomeResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();
    dependencies.expiry.expireRuns(transaction, { now });

    const node = dependencies.plan.readNode(transaction, input.nodeId);
    if (node === null) {
      throw new ReportOutcomeError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new ReportOutcomeError(
        "initiative-not-reportable",
        `the initiative ${node.id} is never reported`,
      );
    }

    const body = input.body;
    if (node.kind === "objective") {
      switch (body.report) {
        case "attested":
        case "closed":
          break;
        default:
          throw new ReportOutcomeError(
            "body-kind-mismatch",
            `a task report names a task node, not the objective ${node.id}`,
          );
      }
      assertRunAuthorityForReport(dependencies, transaction, input, now);
      switch (body.report) {
        case "attested":
          return dependencies.reportObjective(transaction, {
            nodeId: node.id,
            actorId: input.actorId,
            actorKind: input.actorKind,
            fence: body.fence,
            objectId: body.objectId,
          });
        case "closed":
          return dependencies.closeObjective(transaction, {
            nodeId: node.id,
            actorId: input.actorId,
            actorKind: input.actorKind,
            acknowledgePartial: body.acknowledgePartial,
          });
      }
    }

    switch (body.report) {
      case "accepted":
      case "rejected":
      case "failed":
      case "cancelled":
        break;
      default:
        throw new ReportOutcomeError(
          "body-kind-mismatch",
          `an objective report names an objective node, not the task ${node.id}`,
        );
    }
    if (input.actorKind === "human") {
      throw new ReportOutcomeError(
        "actor-forbidden",
        `a human actor never reports a task outcome`,
      );
    }
    if (node.state !== "running") {
      throw new ReportOutcomeError(
        "illegal-transition",
        `the task ${node.id} is ${node.state}, not running`,
        { state: node.state, admitted: ["running"] },
      );
    }

    const run = assertRunAuthorityForReport(
      dependencies,
      transaction,
      input,
      now,
    );
    const openAttempts = dependencies.execution
      .attemptsOfRun(transaction, run.id)
      .filter((attempt) => attempt.outcome === null);
    if (openAttempts.length > 1) {
      throw new Error(`run ${run.id} holds more than one open attempt`);
    }
    const open = openAttempts[0];
    if (open === undefined) {
      throw new Error(`run ${run.id} holds no open attempt`);
    }

    const objectId: string | null =
      body.report === "accepted" ? body.objectId : null;
    let reason: string | null = null;
    if (body.report === "rejected" || body.report === "failed") {
      reason = body.reason;
    } else if (body.report === "cancelled") {
      reason = body.reason ?? null;
    }

    const attempt = dependencies.execution.closeAttempt(transaction, {
      attemptId: open.id,
      outcome: body.report,
      at: now,
      headOid: objectId,
    });

    const accounting = accountAttempts({
      attempts: dependencies.execution
        .attemptsOfRun(transaction, run.id)
        .map((row) => ({ attemptNo: row.attemptNo, outcome: row.outcome })),
      limit: run.attemptLimit,
    });
    const effect = taskReportEffect({ outcome: body.report, accounting });
    if (!(consumedTriggers as readonly string[]).includes(effect.trigger)) {
      throw new Error(
        `taskReportEffect returned the trigger ${effect.trigger}, which this command does not consume`,
      );
    }
    const attemptsRemaining = Math.max(
      0,
      run.attemptLimit - accounting.counter,
    );

    dependencies.plan.setNodeState(transaction, {
      id: node.id,
      from: "running",
      to: effect.nodeState,
      trigger: effect.trigger,
      blockReason: effect.blockReason,
      at: now,
      cause: { revision: node.revision, importId: null },
    });

    if (effect.runEnd !== null) {
      if (body.report === "accepted") {
        dependencies.execution.stampRunHead(transaction, {
          runId: run.id,
          headOid: body.objectId,
        });
      }
      dependencies.execution.endRun(transaction, {
        runId: run.id,
        outcome: effect.runEnd,
        at: now,
      });
    }

    try {
      dependencies.lease.release(transaction, {
        subjectKind: "node",
        subjectId: node.id,
        owner: input.actorId,
        ownerKind: "actor",
        fence: body.fence,
        now,
      });
    } catch (error) {
      if (error instanceof LeaseError && error.code === "lease-fenced") {
        throw new ReportOutcomeError(
          "lease-held",
          `the lease of ${node.id} is not held by ${input.actorId} at fence ${body.fence}`,
        );
      }
      throw error;
    }

    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      type: "outcome.reported",
      actorKind: "harness",
      actorId: input.actorId,
      payload: {
        runId: run.id,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        outcome: body.report,
        reason,
        objectId,
        attemptsRemaining,
        fromState: "running",
        toState: effect.nodeState,
      },
    });

    const nodes = dependencies.plan.readAllNodes(transaction);
    const siblings = nodes
      .filter(
        (candidate) =>
          candidate.kind === "task" && candidate.parentId === node.parentId,
      )
      .sort((left, right) => compareIds(left.id, right.id));
    const siblingStates = siblings.map((candidate) => candidate.state);
    const everyTerminal =
      siblingStates.length > 0 &&
      siblingStates.every((state) =>
        (terminalStates as readonly NodeState[]).includes(state),
      );
    const objectiveNode =
      node.parentId === null
        ? undefined
        : nodes.find((candidate) => candidate.id === node.parentId);

    return {
      nodeId: node.id,
      kind: "task",
      state: effect.nodeState,
      blockReason: effect.blockReason,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      attemptsRemaining,
      objectId,
      objectiveState: objectiveNode?.state ?? null,
      objectiveProjection: everyTerminal
        ? aggregate("objective", siblingStates as readonly TerminalState[])
        : null,
    };
  });
}

function assertRunAuthorityForReport(
  dependencies: ReportOutcomeDependencies,
  transaction: Transaction,
  input: ReportOutcomeInput,
  now: number,
): RunRecord {
  const run = dependencies.execution.runById(transaction, input.runId);
  const refusal = assertRunAuthority({
    run,
    runId: input.runId,
    fence: input.runFence,
    targetNodeId: input.nodeId,
    caller: dependencies.caller,
    now,
  });
  if (refusal !== null) {
    throw new ReportOutcomeError(
      refusal.refusal,
      `run ${refusal.runId} is not authorized for reporting`,
      { runId: refusal.runId },
    );
  }
  if (run === null) {
    throw new ReportOutcomeError("run-not-found", `no run ${input.runId}`, {
      runId: input.runId,
    });
  }
  return run;
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
