import type { StoredNode } from "../../domain/plan-graph.ts";
import { accountAttempts } from "../../domain/attempt-accounting.ts";
import {
  assertRunAuthority,
  type RunAuthorityRefusalCode,
} from "../../domain/run-authority.ts";
import type { NodeState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution, RunRecord } from "../../services/execution/index.ts";
import { LeaseError, type Lease } from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type ReleaseRefusal =
  | RunAuthorityRefusalCode
  | "node-not-found"
  | "initiative-not-claimable"
  | "lease-held"
  | "no-active-run"
  | "no-open-attempt"
  | "illegal-transition";

export type NodeView = Readonly<{
  id: string;
  state: NodeState;
}>;

export type ReleaseNodeDependencies = Readonly<{
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
}>;

export type ReleaseNodeInput = Readonly<{
  nodeId: string;
  fence: number;
  runId: string;
  runFence: number;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type ReleaseNodeResult = Readonly<{ node: NodeView }>;

export class ReleaseNodeError extends Error {
  readonly refusal: ReleaseRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    refusal: ReleaseRefusal,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ReleaseNodeError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function releaseNode(
  dependencies: ReleaseNodeDependencies,
  input: ReleaseNodeInput,
): ReleaseNodeResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();
    dependencies.expiry.expireRuns(transaction, { now });

    const node = dependencies.plan.readNode(transaction, input.nodeId);
    if (node === null) {
      throw new ReleaseNodeError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new ReleaseNodeError(
        "initiative-not-claimable",
        `an initiative is never claimed and so never held`,
      );
    }

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
      throw new ReleaseNodeError(
        refusal.refusal,
        `run ${refusal.runId} is not authorized for release`,
        { runId: refusal.runId },
      );
    }

    if (node.kind === "task") {
      return releaseTask(dependencies, transaction, input, node, now, run!);
    }
    return releaseObjective(dependencies, transaction, input, node, now);
  });
}

function releaseTask(
  dependencies: ReleaseNodeDependencies,
  transaction: Transaction,
  input: ReleaseNodeInput,
  node: StoredNode,
  now: number,
  run: RunRecord,
): ReleaseNodeResult {
  const attempts = dependencies.execution.attemptsOfRun(transaction, run.id);
  const openAttempts = attempts.filter((attempt) => attempt.outcome === null);
  if (openAttempts.length > 1) {
    throw new Error(`run ${run.id} holds more than one open attempt`);
  }
  const open = openAttempts[0];
  if (open === undefined) {
    throw new ReleaseNodeError(
      "no-open-attempt",
      `run ${run.id} holds no open attempt`,
    );
  }
  const projected = accountAttempts({
    attempts: attempts.map((attempt) =>
      attempt.id === open.id
        ? { attemptNo: attempt.attemptNo, outcome: "cancelled" as const }
        : { attemptNo: attempt.attemptNo, outcome: attempt.outcome },
    ),
    limit: run.attemptLimit,
  });
  if (projected.exhausted) {
    dependencies.execution.closeAttempt(transaction, {
      attemptId: open.id,
      outcome: "cancelled",
      at: now,
    });
    dependencies.plan.setNodeState(transaction, {
      id: node.id,
      from: "running",
      to: "blocked",
      trigger: "attempt-limit-reached",
      blockReason: "attempt-limit",
      at: now,
      cause: { revision: node.revision, importId: null },
    });
    const endedRun = dependencies.execution.endRun(transaction, {
      runId: run.id,
      outcome: "blocked",
      at: now,
    });
    releaseLease(dependencies, transaction, input, node.id, now);
    dependencies.events.append(transaction, {
      subjectKind: "run",
      subjectId: endedRun.id,
      type: "run.ended",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        runId: endedRun.id,
        nodeId: endedRun.nodeId,
        fence: endedRun.fence,
        outcome: "blocked",
        reason: null,
      },
    });
    return { node: { id: node.id, state: "blocked" } };
  }
  dependencies.execution.closeAttempt(transaction, {
    attemptId: open.id,
    outcome: "cancelled",
    at: now,
  });
  dependencies.plan.setNodeState(transaction, {
    id: node.id,
    from: "running",
    to: "ready",
    trigger: "claim-released",
    blockReason: null,
    at: now,
    cause: { revision: node.revision, importId: null },
  });
  const endedRun = dependencies.execution.endRun(transaction, {
    runId: run.id,
    outcome: "released",
    at: now,
  });
  releaseLease(dependencies, transaction, input, node.id, now);
  dependencies.events.append(transaction, {
    subjectKind: "run",
    subjectId: endedRun.id,
    type: "run.ended",
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: {
      runId: endedRun.id,
      nodeId: endedRun.nodeId,
      fence: endedRun.fence,
      outcome: "released",
      reason: null,
    },
  });
  return { node: { id: node.id, state: "ready" } };
}

function releaseObjective(
  dependencies: ReleaseNodeDependencies,
  transaction: Transaction,
  input: ReleaseNodeInput,
  node: StoredNode,
  now: number,
): ReleaseNodeResult {
  const children = dependencies.plan
    .readAllNodes(transaction)
    .filter((candidate) => candidate.parentId === node.id)
    .sort((left, right) => compareIds(left.id, right.id));
  for (const child of children) {
    const record = dependencies.lease.read(transaction, {
      subjectKind: "node",
      subjectId: child.id,
      now,
    });
    if (
      record !== null &&
      record.owner !== null &&
      record.expiresAt !== null &&
      record.expiresAt > now
    ) {
      throw new ReleaseNodeError(
        "lease-held",
        `the task ${child.id} under ${node.id} is still held`,
        {
          subject: child.id,
          holder: record.owner,
          holderKind: record.ownerKind,
          fence: record.fence,
          expiresAt: record.expiresAt,
          relation: "descendant",
        },
      );
    }
  }
  const run = dependencies.execution.activeRunOfNode(transaction, node.id);
  if (run === null) {
    throw new ReleaseNodeError(
      "no-active-run",
      `no active run of node ${node.id}`,
    );
  }
  for (const child of children) {
    const childRun = dependencies.execution.activeRunOfNode(
      transaction,
      child.id,
    );
    if (childRun === null) {
      continue;
    }
    for (const attempt of dependencies.execution.attemptsOfRun(
      transaction,
      childRun.id,
    )) {
      if (attempt.outcome !== null) {
        continue;
      }
      dependencies.execution.closeAttempt(transaction, {
        attemptId: attempt.id,
        outcome: "cancelled",
        at: now,
      });
    }
    const endedChildRun = dependencies.execution.endRun(transaction, {
      runId: childRun.id,
      outcome: "released",
      at: now,
    });
    dependencies.events.append(transaction, {
      subjectKind: "run",
      subjectId: endedChildRun.id,
      type: "run.ended",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        runId: endedChildRun.id,
        nodeId: endedChildRun.nodeId,
        fence: endedChildRun.fence,
        outcome: "released",
        reason: null,
      },
    });
  }
  const endedRun = dependencies.execution.endRun(transaction, {
    runId: run.id,
    outcome: "released",
    at: now,
  });
  releaseLease(dependencies, transaction, input, node.id, now);
  dependencies.events.append(transaction, {
    subjectKind: "run",
    subjectId: endedRun.id,
    type: "run.ended",
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: {
      runId: endedRun.id,
      nodeId: endedRun.nodeId,
      fence: endedRun.fence,
      outcome: "released",
      reason: null,
    },
  });
  return { node: { id: node.id, state: node.state } };
}

function releaseLease(
  dependencies: ReleaseNodeDependencies,
  transaction: Transaction,
  input: ReleaseNodeInput,
  subjectId: string,
  now: number,
): void {
  try {
    dependencies.lease.release(transaction, {
      subjectKind: "node",
      subjectId,
      owner: input.actorId,
      ownerKind: "actor",
      fence: input.fence,
      now,
    });
  } catch (error) {
    if (error instanceof LeaseError && error.code === "lease-fenced") {
      throw new ReleaseNodeError(
        "lease-held",
        `the lease of ${subjectId} is not held by ${input.actorId} at fence ${input.fence}`,
      );
    }
    throw error;
  }
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
