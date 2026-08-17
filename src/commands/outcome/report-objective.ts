import { aggregate } from "../../domain/aggregation.ts";
import { objectiveOutcome } from "../../domain/outcome.ts";
import type { NodeReportResult } from "../../domain/outcome-report.ts";
import { terminalStates } from "../../domain/state.ts";
import type { NodeState, TerminalState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import type { Lease } from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Transaction } from "../../services/storage/index.ts";

export type ReportObjectiveDependencies = Readonly<{
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  instanceId: string;
}>;

export type ReportObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  fence: number;
  objectId: string;
}>;

export type ReportObjectiveResult = NodeReportResult;

export type ReportObjectiveRefusal =
  "actor-forbidden" | "illegal-transition" | "lease-held";

export class ReportObjectiveError extends Error {
  readonly refusal: ReportObjectiveRefusal;
  readonly details: unknown;

  constructor(
    refusal: ReportObjectiveRefusal,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ReportObjectiveError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function reportObjective(
  dependencies: ReportObjectiveDependencies,
  transaction: Transaction,
  input: ReportObjectiveInput,
): ReportObjectiveResult {
  const now = dependencies.clock.now();

  if (input.actorKind === "human") {
    throw new ReportObjectiveError(
      "actor-forbidden",
      `a human actor never attests an objective`,
    );
  }

  const node = dependencies.plan.readNode(transaction, input.nodeId);
  if (node === null) {
    throw new ReportObjectiveError(
      "illegal-transition",
      `no node ${input.nodeId}`,
    );
  }
  if (node.state !== "running") {
    throw new ReportObjectiveError(
      "illegal-transition",
      `the objective ${node.id} is ${node.state}, not running`,
      { state: node.state, admitted: ["running"] },
    );
  }

  const leaseRecord = dependencies.lease.read(transaction, {
    subjectKind: "node",
    subjectId: node.id,
    now,
  });
  const staleLease = `the lease of ${node.id} is not held by ${input.actorId} at fence ${input.fence}`;
  if (
    leaseRecord !== null &&
    leaseRecord.owner !== null &&
    leaseRecord.ownerKind !== null &&
    leaseRecord.expiresAt !== null &&
    leaseRecord.expiresAt > now &&
    leaseRecord.owner !== input.actorId
  ) {
    throw new ReportObjectiveError("lease-held", staleLease, {
      subject: node.id,
      holder: leaseRecord.owner,
      holderKind: leaseRecord.ownerKind,
      fence: leaseRecord.fence,
      expiresAt: leaseRecord.expiresAt,
      relation: "self",
    });
  }
  if (
    leaseRecord === null ||
    leaseRecord.owner !== input.actorId ||
    leaseRecord.fence !== input.fence ||
    leaseRecord.expiresAt === null ||
    leaseRecord.expiresAt <= now
  ) {
    throw new ReportObjectiveError("lease-held", staleLease);
  }

  const tasks = dependencies.plan
    .readAllNodes(transaction)
    .filter((candidate) => candidate.parentId === node.id)
    .sort((left, right) => compareIds(left.id, right.id));
  const states = tasks.map((candidate) => candidate.state);
  const everyTerminal = states.every((state) =>
    (terminalStates as readonly NodeState[]).includes(state),
  );
  if (!everyTerminal) {
    throw new ReportObjectiveError(
      "illegal-transition",
      `a task of the objective ${node.id} is not terminal`,
      { guard: "children-not-terminal" },
    );
  }

  if (states.length === 0) {
    throw new Error(`the objective ${node.id} holds no task`);
  }
  const projected = aggregate("objective", states as readonly TerminalState[]);
  if (projected === "discarded") {
    throw new ReportObjectiveError(
      "illegal-transition",
      `the objective ${node.id} projects discarded`,
      { guard: "projection-discarded" },
    );
  }
  const outcome = objectiveOutcome(projected);

  dependencies.plan.setNodeState(transaction, {
    id: node.id,
    from: "running",
    to: outcome.state,
    trigger: "object-reported",
    blockReason: outcome.blockReason,
    at: now,
    cause: { revision: node.revision, importId: null },
  });

  const run = dependencies.execution.activeRunOfNode(transaction, node.id);
  if (run === null) {
    throw new ReportObjectiveError(
      "illegal-transition",
      `the objective ${node.id} holds no active run`,
      { guard: "no-active-run" },
    );
  }
  dependencies.execution.stampRunHead(transaction, {
    runId: run.id,
    headOid: input.objectId,
  });

  dependencies.lease.release(transaction, {
    subjectKind: "node",
    subjectId: node.id,
    owner: input.actorId,
    ownerKind: "actor",
    fence: input.fence,
    now,
  });

  dependencies.events.append(transaction, {
    subjectKind: "node",
    subjectId: node.id,
    type: "node.awaitingApproval",
    actorKind: "harness",
    actorId: input.actorId,
    payload: {
      from: "running",
      to: "awaiting_approval",
      reason: "object-attested",
      objectId: input.objectId,
      projection: projected,
      objectiveRunId: run.id,
    },
  });

  return {
    nodeId: node.id,
    kind: "objective",
    state: outcome.state,
    blockReason: outcome.blockReason,
    attemptId: null,
    attemptNo: null,
    attemptsRemaining: null,
    objectId: input.objectId,
    objectiveState: outcome.state,
    objectiveProjection: projected,
  };
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
