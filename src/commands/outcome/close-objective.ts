import { aggregate } from "../../domain/aggregation.ts";
import type { NodeReportResult } from "../../domain/outcome-report.ts";
import type { TerminalState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Transaction } from "../../services/storage/index.ts";

type InitiativeRollUpInput = Readonly<{
  initiativeId: string | null;
  at: number;
}>;

export type CloseObjectiveDependencies = Readonly<{
  plan: PlanStore;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  aggregateInitiative: (
    transaction: Transaction,
    input: InitiativeRollUpInput,
  ) => void;
  instanceId: string;
}>;

export type CloseObjectiveInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  acknowledgePartial: boolean;
}>;

export type CloseObjectiveResult = NodeReportResult;

export type CloseObjectiveRefusal =
  "actor-forbidden" | "illegal-transition" | "acknowledgement-required";

export class CloseObjectiveError extends Error {
  readonly refusal: CloseObjectiveRefusal;
  readonly details: unknown;

  constructor(
    refusal: CloseObjectiveRefusal,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "CloseObjectiveError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function closeObjective(
  dependencies: CloseObjectiveDependencies,
  transaction: Transaction,
  input: CloseObjectiveInput,
): CloseObjectiveResult {
  const now = dependencies.clock.now();

  if (input.actorKind === "harness") {
    throw new CloseObjectiveError(
      "actor-forbidden",
      `a harness actor never closes an objective`,
    );
  }

  const node = dependencies.plan.readNode(transaction, input.nodeId);
  if (node === null) {
    throw new CloseObjectiveError(
      "illegal-transition",
      `no node ${input.nodeId}`,
    );
  }
  if (node.state !== "awaiting_approval") {
    throw new CloseObjectiveError(
      "illegal-transition",
      `the objective ${node.id} is ${node.state}, not awaiting_approval`,
      { state: node.state, admitted: ["awaiting_approval"] },
    );
  }

  const run = dependencies.execution.activeRunOfNode(transaction, node.id);
  if (run === null) {
    throw new CloseObjectiveError(
      "illegal-transition",
      `the objective ${node.id} holds no active run`,
      { guard: "no-active-run" },
    );
  }
  if (run.driver === "internal") {
    throw new CloseObjectiveError(
      "illegal-transition",
      `the objective ${node.id} runs on an internal driver`,
      { runDriver: run.driver, expectedDriver: "external" },
    );
  }
  if (run.headOid === null) {
    throw new CloseObjectiveError(
      "illegal-transition",
      `the objective ${node.id} holds no attested object id`,
      { guard: "object-not-attested" },
    );
  }

  const states = dependencies.plan
    .readAllNodes(transaction)
    .filter((candidate) => candidate.parentId === node.id)
    .sort((left, right) => compareIds(left.id, right.id))
    .map((candidate) => candidate.state);
  if (states.length === 0) {
    throw new Error(`the objective ${node.id} holds no task`);
  }
  const derived = aggregate("objective", states as readonly TerminalState[]);

  if (derived === "partial" && !input.acknowledgePartial) {
    throw new CloseObjectiveError(
      "acknowledgement-required",
      `a partial close of the objective ${node.id} needs an acknowledgement`,
    );
  }
  if (derived === "discarded") {
    throw new CloseObjectiveError(
      "illegal-transition",
      `the objective ${node.id} projects discarded`,
      { guard: "projection-discarded" },
    );
  }

  dependencies.plan.setNodeState(transaction, {
    id: node.id,
    from: "awaiting_approval",
    to: derived,
    trigger: derived === "done" ? "human-close" : "human-close-partial",
    blockReason: null,
    at: now,
    cause: { revision: node.revision, importId: null },
  });

  dependencies.events.append(transaction, {
    subjectKind: "node",
    subjectId: node.id,
    type: derived === "done" ? "node.done" : "node.partial",
    actorKind: "human",
    actorId: input.actorId,
    payload: {
      from: "awaiting_approval",
      to: derived,
      reason: "human-close",
      objectId: run.headOid,
      objectiveRunId: run.id,
      acknowledgePartial: input.acknowledgePartial,
    },
  });

  dependencies.aggregateInitiative(transaction, {
    initiativeId: node.parentId,
    at: now,
  });

  dependencies.execution.endRun(transaction, {
    runId: run.id,
    outcome: derived,
    at: now,
  });

  return {
    nodeId: node.id,
    kind: "objective",
    state: derived,
    blockReason: null,
    attemptId: null,
    attemptNo: null,
    attemptsRemaining: null,
    objectId: run.headOid,
    objectiveState: derived,
    objectiveProjection: derived,
  };
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
