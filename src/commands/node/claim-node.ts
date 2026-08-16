import { objectiveDrivePin } from "../../domain/external-transition.ts";
import {
  liveLeaseRefusal,
  type LiveLease,
} from "../../domain/lease-hierarchy.ts";
import {
  completenessFindings,
  type CompletenessChild,
  type CompletenessParent,
} from "../../domain/plan-completeness.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import type { NodeState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import {
  LeaseError,
  type AcquireLeaseInput,
  type AcquireLeaseResult,
  type Lease,
  type LeaseRecord,
} from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type ClaimRefusal =
  | "node-not-found"
  | "initiative-not-claimable"
  | "plan-incomplete"
  | "drive-mode-pinned"
  | "lease-held"
  | "illegal-transition"
  | "ancestor-not-startable";

export type ClaimedLease = Readonly<{
  subjectId: string;
  owner: string;
  ownerKind: "actor";
  fence: number;
  expiresAt: number;
}>;

export type NodeView = Readonly<{
  id: string;
  state: NodeState;
}>;

export type ClaimNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  ids: IdGenerator;
  sweepExpiredExternalLeases: (
    transaction: Transaction,
    input: Readonly<{ actor: string; now: number }>,
  ) => void;
  attemptLimit: number;
  leaseTtlMs: number;
  instanceId: string;
}>;

export type ClaimNodeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type ClaimNodeResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  runId: string;
  objectiveRunId: string;
  attemptId: string | null;
  attemptNo: number | null;
  heartbeatIntervalMs: number;
  node: NodeView;
}>;

export class ClaimNodeError extends Error {
  readonly refusal: ClaimRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    refusal: ClaimRefusal,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ClaimNodeError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function claimNode(
  dependencies: ClaimNodeDependencies,
  input: ClaimNodeInput,
): ClaimNodeResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();

    dependencies.sweepExpiredExternalLeases(transaction, {
      actor: dependencies.instanceId,
      now,
    });

    const nodes = dependencies.plan.readAllNodes(transaction);
    const node = nodes.find((candidate) => candidate.id === input.nodeId);
    if (node === undefined) {
      throw new ClaimNodeError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new ClaimNodeError(
        "initiative-not-claimable",
        `an initiative is never claimed directly`,
        { refusal: "initiative-not-claimable" },
      );
    }

    const parents = completenessParents(nodes, node);
    const findings = completenessFindings({
      subject: "record",
      parents,
      children: completenessChildren(nodes, parents, node.id),
    });
    if (findings.length > 0) {
      throw new ClaimNodeError(
        "plan-incomplete",
        `the claim of ${node.id} fails the completeness check`,
        { findings },
      );
    }

    const refusal = liveLeaseRefusal({
      targetId: node.id,
      targetKind: node.kind,
      parentId: node.parentId,
      childIds: nodes
        .filter((candidate) => candidate.parentId === node.id)
        .map((candidate) => candidate.id),
      siblingIds:
        node.parentId === null
          ? []
          : nodes
              .filter(
                (candidate) =>
                  candidate.parentId === node.parentId &&
                  candidate.id !== node.id,
              )
              .map((candidate) => candidate.id),
      owner: input.actorId,
      liveLeases: liveLeasesOf(
        dependencies.lease,
        transaction,
        relativesOf(nodes, node),
        now,
      ),
    });
    if (refusal !== null) {
      throw new ClaimNodeError(
        "lease-held",
        `the claim of ${node.id} conflicts with a lease held by another owner`,
        {
          subject: refusal.subjectId,
          holder: refusal.holder,
          holderKind: refusal.holderKind,
          fence: refusal.fence,
          expiresAt: refusal.expiresAt,
          relation: refusal.relation,
        },
      );
    }

    const ownLease = dependencies.lease.read(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      now,
    });
    if (
      node.state === "running" &&
      ownLease !== null &&
      ownLease.owner === input.actorId &&
      ownLease.expiresAt !== null &&
      ownLease.expiresAt > now
    ) {
      return replayResult(
        dependencies,
        transaction,
        input,
        node,
        ownLease,
        now,
      );
    }

    const objectiveId = objectiveScopeId(node);

    const pin = objectiveDrivePin({
      runDrivers: dependencies.execution.runDriversUnderObjective(
        transaction,
        objectiveId,
      ),
      claimDriver: "external",
    });
    if (pin !== null) {
      throw new ClaimNodeError(
        "drive-mode-pinned",
        `the objective ${objectiveId} is pinned to driver ${pin.pinnedDriver}`,
        { pinnedDriver: pin.pinnedDriver, claimDriver: pin.claimDriver },
      );
    }

    const objectiveLease = acquireWithHierarchyRefusal(
      dependencies.lease,
      transaction,
      {
        subjectKind: "node",
        subjectId: objectiveId,
        owner: input.actorId,
        ownerKind: "actor",
        ttlMs: dependencies.leaseTtlMs,
        now,
      },
    );

    const objectiveRunId = openOrAdoptRun(dependencies, transaction, {
      kind: "objective",
      nodeId: objectiveId,
      parentRunId: null,
      leaseFence: objectiveLease.record.fence,
    });

    let claimedLease: AcquireLeaseResult = objectiveLease;
    let runId = objectiveRunId;
    let attemptId: string | null = null;
    let attemptNo: number | null = null;
    if (node.kind === "task") {
      const taskLease = acquireWithHierarchyRefusal(
        dependencies.lease,
        transaction,
        {
          subjectKind: "node",
          subjectId: node.id,
          owner: input.actorId,
          ownerKind: "actor",
          ttlMs: dependencies.leaseTtlMs,
          now,
        },
      );
      claimedLease = taskLease;
      runId = openOrAdoptRun(dependencies, transaction, {
        kind: "task",
        nodeId: node.id,
        parentRunId: objectiveRunId,
        leaseFence: taskLease.record.fence,
      });
      const attempt = dependencies.execution.openAttempt(transaction, {
        runId,
      });
      attemptId = attempt.id;
      attemptNo = attempt.attemptNo;
    }

    if (node.state !== "ready") {
      throw new ClaimNodeError(
        "illegal-transition",
        `the node ${node.id} is ${node.state}, not claimable`,
        { state: node.state, admitted: ["ready", "running"] },
      );
    }

    const cascade = cascadeVerdicts(nodes, node);

    dependencies.plan.setNodeState(transaction, {
      id: node.id,
      from: "ready",
      to: "running",
      trigger: "claim-taken",
      blockReason: null,
      at: now,
      cause: { revision: node.revision, importId: null },
    });
    for (const entry of cascade) {
      dependencies.plan.setNodeState(transaction, {
        id: entry.id,
        from: "ready",
        to: "running",
        trigger: "ancestor-started",
        blockReason: null,
        at: now,
        cause: { revision: entry.revision, importId: null },
      });
    }

    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      type: "lease.claimed",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        subjectId: node.id,
        objectiveId,
        fence: claimedLease.record.fence,
        objectiveFence: objectiveLease.record.fence,
        expiresAt: claimedLease.record.expiresAt,
        runId,
        objectiveRunId,
        attemptId,
        attemptNo,
      },
    });
    for (const entry of cascade) {
      dependencies.events.append(transaction, {
        subjectKind: "node",
        subjectId: entry.id,
        type: "node.running",
        actorKind: "daemon",
        actorId: dependencies.instanceId,
        payload: {
          from: "ready",
          to: "running",
          reason: "child-started",
          revision: entry.revision,
          importId: null,
        },
      });
    }
    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      type: "node.running",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        from: "ready",
        to: "running",
        reason: "claim-taken",
        revision: node.revision,
        importId: null,
      },
    });

    return {
      lease: toClaimedLease(claimedLease.record),
      objectiveLease: toClaimedLease(objectiveLease.record),
      runId,
      objectiveRunId,
      attemptId,
      attemptNo,
      heartbeatIntervalMs: Math.floor(dependencies.leaseTtlMs / 3),
      node: { id: node.id, state: "running" },
    };
  });
}

function replayResult(
  dependencies: ClaimNodeDependencies,
  transaction: Transaction,
  input: ClaimNodeInput,
  node: StoredNode,
  ownLease: LeaseRecord,
  now: number,
): ClaimNodeResult {
  const activeRun = dependencies.execution.activeRunOfNode(
    transaction,
    node.id,
  );
  const objectiveId = objectiveScopeId(node);
  const activeObjectiveRun = dependencies.execution.activeRunOfNode(
    transaction,
    objectiveId,
  );
  const objectiveLease = dependencies.lease.read(transaction, {
    subjectKind: "node",
    subjectId: objectiveId,
    now,
  });
  if (
    activeRun === null ||
    activeObjectiveRun === null ||
    objectiveLease === null
  ) {
    throw new Error(
      `the running node ${node.id} holds an incomplete claim state`,
    );
  }
  let attemptId: string | null = null;
  let attemptNo: number | null = null;
  if (node.kind === "task") {
    const openAttempts = dependencies.execution
      .attemptsOfRun(transaction, activeRun.id)
      .filter((attempt) => attempt.outcome === null);
    if (openAttempts.length > 1) {
      throw new Error(`run ${activeRun.id} holds more than one open attempt`);
    }
    const open = openAttempts[0];
    if (open !== undefined) {
      attemptId = open.id;
      attemptNo = open.attemptNo;
    }
  }
  return {
    lease: toClaimedLease(ownLease),
    objectiveLease: toClaimedLease(objectiveLease),
    runId: activeRun.id,
    objectiveRunId: activeObjectiveRun.id,
    attemptId,
    attemptNo,
    heartbeatIntervalMs: Math.floor(dependencies.leaseTtlMs / 3),
    node: { id: node.id, state: node.state },
  };
}

function acquireWithHierarchyRefusal(
  lease: Lease,
  transaction: Transaction,
  input: AcquireLeaseInput,
): AcquireLeaseResult {
  try {
    return lease.acquire(transaction, input);
  } catch (error) {
    if (error instanceof LeaseError && error.code === "lease-held") {
      const refusal = error.refusal;
      throw new ClaimNodeError(
        "lease-held",
        `the lease of ${input.subjectId} is held by another owner`,
        refusal === undefined
          ? {}
          : {
              subject: refusal.subjectId,
              holder: refusal.holder,
              holderKind: refusal.holderKind,
              fence: refusal.fence,
              expiresAt: refusal.expiresAt,
              relation: refusal.relation,
            },
      );
    }
    throw error;
  }
}

function openOrAdoptRun(
  dependencies: ClaimNodeDependencies,
  transaction: Transaction,
  input: Readonly<{
    kind: "objective" | "task";
    nodeId: string;
    parentRunId: string | null;
    leaseFence: number;
  }>,
): string {
  const active = dependencies.execution.activeRunOfNode(
    transaction,
    input.nodeId,
  );
  if (active === null) {
    return dependencies.execution.openRun(transaction, {
      kind: input.kind,
      nodeId: input.nodeId,
      parentRunId: input.parentRunId,
      leaseFence: input.leaseFence,
      attemptLimit: dependencies.attemptLimit,
    }).id;
  }
  if (active.driver !== "external") {
    throw new ClaimNodeError(
      "drive-mode-pinned",
      `the active run of ${input.nodeId} is internal and is never adopted`,
      { pinnedDriver: active.driver, claimDriver: "external" },
    );
  }
  return dependencies.execution.adoptRun(transaction, {
    runId: active.id,
    leaseFence: input.leaseFence,
  }).id;
}

function objectiveScopeId(node: StoredNode): string {
  if (node.kind === "task") {
    if (node.parentId === null) {
      throw new Error(`task ${node.id} has no parent objective`);
    }
    return node.parentId;
  }
  return node.id;
}

function cascadeVerdicts(
  nodes: readonly StoredNode[],
  node: StoredNode,
): readonly Readonly<{ id: string; revision: string }>[] {
  const started: Readonly<{ id: string; revision: string }>[] = [];
  for (const ancestor of ancestorChain(nodes, node)) {
    if (ancestor.state === "ready") {
      started.push({ id: ancestor.id, revision: ancestor.revision });
    } else if (ancestor.state !== "running") {
      throw new ClaimNodeError(
        "ancestor-not-startable",
        `the ancestor ${ancestor.id} is ${ancestor.state}, not startable`,
        {
          ancestorId: ancestor.id,
          state: ancestor.state,
          admitted: ["ready", "running"],
        },
      );
    }
  }
  return started;
}

function ancestorChain(
  nodes: readonly StoredNode[],
  node: StoredNode,
): readonly StoredNode[] {
  const index = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const chain: StoredNode[] = [];
  let parentId = node.parentId;
  while (parentId !== null) {
    const parent = index.get(parentId);
    if (parent === undefined) {
      throw new Error(`node ${node.id} has an unknown parent ${parentId}`);
    }
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain;
}

function completenessParents(
  nodes: readonly StoredNode[],
  node: StoredNode,
): readonly CompletenessParent[] {
  const chain = [...ancestorChain(nodes, node)].reverse();
  return chain.concat(node).map((ancestor) => ({
    kind: ancestor.kind,
    key: ancestor.id,
    path: null,
    id: ancestor.id,
  }));
}

function completenessChildren(
  nodes: readonly StoredNode[],
  parents: readonly CompletenessParent[],
  claimedNodeId: string,
): readonly CompletenessChild[] {
  const children: CompletenessChild[] = [];
  for (const parent of parents) {
    const members = nodes
      .filter(
        (candidate) =>
          candidate.parentId === parent.id &&
          (candidate.state !== "discarded" || candidate.id === claimedNodeId),
      )
      .sort((left, right) => compareIds(left.id, right.id));
    for (const member of members) {
      children.push({ kind: member.kind, parentKey: parent.id });
    }
  }
  return children;
}

function relativesOf(
  nodes: readonly StoredNode[],
  node: StoredNode,
): readonly string[] {
  const children = nodes
    .filter((candidate) => candidate.parentId === node.id)
    .map((candidate) => candidate.id)
    .sort(compareIds);
  const siblings =
    node.parentId === null
      ? []
      : nodes
          .filter(
            (candidate) =>
              candidate.parentId === node.parentId && candidate.id !== node.id,
          )
          .map((candidate) => candidate.id)
          .sort(compareIds);
  return [
    node.id,
    ...(node.parentId === null ? [] : [node.parentId]),
    ...children,
    ...siblings,
  ];
}

function liveLeasesOf(
  lease: Lease,
  transaction: Transaction,
  subjectIds: readonly string[],
  now: number,
): readonly LiveLease[] {
  const live: LiveLease[] = [];
  for (const subjectId of subjectIds) {
    const record = lease.read(transaction, {
      subjectKind: "node",
      subjectId,
      now,
    });
    if (record === null) continue;
    if (
      record.owner === null ||
      record.expiresAt === null ||
      record.expiresAt <= now
    ) {
      continue;
    }
    if (record.ownerKind === null) {
      throw new Error(`lease ${record.subjectId} is missing its owner kind`);
    }
    live.push({
      subjectId: record.subjectId,
      owner: record.owner,
      ownerKind: record.ownerKind,
      fence: record.fence,
      expiresAt: record.expiresAt,
    });
  }
  return live;
}

function toClaimedLease(record: LeaseRecord): ClaimedLease {
  if (
    record.owner === null ||
    record.ownerKind !== "actor" ||
    record.expiresAt === null
  ) {
    throw new Error(`lease ${record.subjectId} is not held by an actor`);
  }
  return {
    subjectId: record.subjectId,
    owner: record.owner,
    ownerKind: "actor",
    fence: record.fence,
    expiresAt: record.expiresAt,
  };
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
