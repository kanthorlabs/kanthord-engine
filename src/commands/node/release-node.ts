import type { StoredNode } from "../../domain/plan-graph.ts";
import type { NodeState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import { LeaseError, type Lease } from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type ReleaseRefusal =
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
}>;

export type ReleaseNodeInput = Readonly<{
  nodeId: string;
  fence: number;
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

    const nodes = dependencies.plan.readAllNodes(transaction);
    const node = nodes.find((candidate) => candidate.id === input.nodeId);
    if (node === undefined) {
      throw new ReleaseNodeError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new ReleaseNodeError(
        "initiative-not-claimable",
        `an initiative is never claimed and so never held`,
      );
    }

    assertHeld(dependencies.lease, transaction, input, node.id, now);

    if (node.kind === "task") {
      return releaseTask(dependencies, transaction, input, node, now);
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
): ReleaseNodeResult {
  const run = dependencies.execution.activeRunOfNode(transaction, node.id);
  if (run === null) {
    throw new ReleaseNodeError(
      "no-active-run",
      `no active run of node ${node.id}`,
    );
  }
  const openAttempts = dependencies.execution
    .attemptsOfRun(transaction, run.id)
    .filter((attempt) => attempt.outcome === null);
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
  dependencies.execution.closeAttempt(transaction, {
    attemptId: open.id,
    outcome: "cancelled",
    at: now,
  });
  dependencies.execution.endRun(transaction, {
    runId: run.id,
    outcome: "released",
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
    type: "lease.released",
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: {
      subjectId: node.id,
      objectiveId: objectiveScopeOf(node),
      fence: input.fence,
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
  dependencies.execution.endRun(transaction, {
    runId: run.id,
    outcome: "released",
    at: now,
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
    type: "lease.released",
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: {
      subjectId: node.id,
      objectiveId: node.id,
      fence: input.fence,
    },
  });
  return { node: { id: node.id, state: node.state } };
}

function assertHeld(
  lease: Lease,
  transaction: Transaction,
  input: ReleaseNodeInput,
  subjectId: string,
  now: number,
): void {
  try {
    lease.assertHeld(transaction, {
      subjectKind: "node",
      subjectId,
      owner: input.actorId,
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

function objectiveScopeOf(node: StoredNode): string {
  if (node.parentId === null) {
    throw new Error(`a task with no parent objective cannot be released`);
  }
  return node.parentId;
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
