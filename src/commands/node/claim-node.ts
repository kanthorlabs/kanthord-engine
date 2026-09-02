import { nodePairLegality } from "../../domain/node-pair.ts";
import { runKindFor } from "../../domain/run-kind.ts";
import { objectiveBusy, subtreeExclusion } from "../../domain/run-exclusion.ts";
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
import type { Deliverable } from "../../domain/deliverable.ts";
import type { NodeState } from "../../domain/state.ts";
import { capableWorkers, routeWorker } from "../../domain/worker-routing.ts";
import type { WorkerEntry } from "../../domain/worker-registry.ts";
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
  | "pair-illegal"
  | "plan-incomplete"
  | "assignment-held"
  | "unroutable"
  | "review-head-unavailable"
  | "lease-held"
  | "drive-mode-pinned"
  | "objective-busy"
  | "subtree-busy"
  | "illegal-transition"
  | "ancestor-not-startable";

export const claimRefusalCodes = [
  "node-not-found",
  "pair-illegal",
  "plan-incomplete",
  "assignment-held",
  "unroutable",
  "review-head-unavailable",
  "lease-held",
  "drive-mode-pinned",
  "objective-busy",
  "subtree-busy",
  "illegal-transition",
  "ancestor-not-startable",
] as const satisfies readonly ClaimRefusal[];

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

export type Expiry = Readonly<{
  expireRuns(
    transaction: Transaction,
    input: Readonly<{ now: number }>,
  ): readonly unknown[];
}>;

export type ClaimCallerRecord = Readonly<{
  worker: string;
  authorized: readonly string[];
}>;

export type ClaimNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  ids: IdGenerator;
  expiry: Expiry;
  callerRecord: ClaimCallerRecord;
  registry: readonly WorkerEntry[];
  attemptLimit: number;
  leaseTtlMs: number;
  runTtlMs: number;
  runMaxLifetimeMs: number;
  instanceId: string;
}>;

export type ClaimNodeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
  available: boolean;
}>;

export type ClaimNodeResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  runId: string;
  objectiveRunId: string;
  attemptId: string | null;
  attemptNo: number | null;
  fence: number;
  expiresAt: number;
  renewAfterMs: number;
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
    dependencies.expiry.expireRuns(transaction, { now });

    const nodes = dependencies.plan.readAllNodes(transaction);
    const node = nodes.find((candidate) => candidate.id === input.nodeId);
    if (node === undefined) {
      throw new ClaimNodeError("node-not-found", `no node ${input.nodeId}`);
    }

    if (node.deliverable === null) {
      throw new ClaimNodeError(
        "pair-illegal",
        `the ${node.kind} carries no deliverable`,
        { kind: node.kind, deliverable: null },
      );
    }

    const deliverable = node.deliverable as Deliverable;
    const pair = nodePairLegality(node.kind, deliverable);
    if (!pair.legal) {
      throw new ClaimNodeError(
        "pair-illegal",
        `the ${node.kind} cannot carry ${deliverable}`,
        { kind: node.kind, deliverable },
      );
    }

    const parents = completenessParents(nodes, node);
    const findings = completenessFindings({
      subject: "record",
      parents,
      children: completenessChildren(nodes, parents, node.id),
    });
    const relevantFindings =
      deliverable === "expansion"
        ? findings.filter((finding) => finding.id !== node.id)
        : findings;
    if (relevantFindings.length > 0) {
      throw new ClaimNodeError(
        "plan-incomplete",
        `the claim of ${node.id} fails the completeness check`,
        { findings: relevantFindings },
      );
    }

    const caller = dependencies.callerRecord;
    if (node.assignment !== null && node.assignment !== caller.worker) {
      throw new ClaimNodeError(
        "assignment-held",
        `the node ${node.id} is assigned to ${node.assignment}`,
        {
          assignment: node.assignment,
          claimant: caller.worker,
          maySwitch: true,
        },
      );
    }

    const routedWorker =
      node.assignment ??
      routeClaimWorker(node, caller, input.available, dependencies.registry);
    const runKind = runKindFor(deliverable);
    if (runKind === "review") {
      throw new ClaimNodeError(
        "review-head-unavailable",
        `the review head for ${node.id} is unavailable`,
        { nodeId: node.id, runKind },
      );
    }

    const graphRevision = dependencies.plan.newestRevision(
      transaction,
      node.projectId,
    );
    const relativeIds = relativesOf(nodes, node);
    const leaseRefusal = liveLeaseRefusal({
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
        relativeIds,
        now,
      ),
    });
    if (leaseRefusal !== null) {
      throw new ClaimNodeError(
        "lease-held",
        `the claim of ${node.id} conflicts with a lease held by another owner`,
        {
          subject: leaseRefusal.subjectId,
          holder: leaseRefusal.holder,
          holderKind: leaseRefusal.holderKind,
          fence: leaseRefusal.fence,
          expiresAt: leaseRefusal.expiresAt,
          relation: leaseRefusal.relation,
        },
      );
    }

    const objectiveId = objectiveScopeId(node);
    if (node.kind !== "initiative") {
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
    }

    if (node.kind === "task" && runKind === "execution") {
      const objective = objectiveAncestor(nodes, node);
      const siblingIds = nodes
        .filter(
          (candidate) =>
            candidate.parentId === objective.id &&
            candidate.kind === "task" &&
            candidate.id !== node.id,
        )
        .map((candidate) => candidate.id);
      const siblingRuns = dependencies.execution
        .activeRunsOfNodes(transaction, siblingIds)
        .map((run) => ({
          runId: run.id,
          nodeId: run.nodeId,
          state: run.state,
          expiresAt: run.expiresAt,
        }));
      const refusal = objectiveBusy({
        objectiveId: objective.id,
        siblingRuns,
        now,
      });
      if (refusal !== null) {
        throw new ClaimNodeError(
          "objective-busy",
          `the objective ${objective.id} has a busy sibling task`,
          {
            objectiveId: refusal.objectiveId,
            siblingNodeId: refusal.siblingNodeId,
            siblingRunId: refusal.siblingRunId,
            expiresAt: refusal.expiresAt,
          },
        );
      }
    }

    const subtreeIds = dependencies.plan.readSubtree(transaction, node.id);
    const ancestorIds = ancestorChain(nodes, node).map(
      (ancestor) => ancestor.id,
    );
    const runs = dependencies.execution
      .activeRunsOfNodes(
        transaction,
        uniqueIds([node.id, ...ancestorIds, ...subtreeIds]),
      )
      .map((run) => ({
        runId: run.id,
        nodeId: run.nodeId,
        state: run.state,
        expiresAt: run.expiresAt,
      }));
    const exclusion = subtreeExclusion({
      targetId: node.id,
      ancestorIds,
      descendantIds: subtreeIds.filter((id) => id !== node.id),
      runs,
      now,
    });
    if (exclusion !== null) {
      throw new ClaimNodeError(
        "subtree-busy",
        `the subtree of ${node.id} is busy`,
        {
          relation: exclusion.relation,
          nodeId: exclusion.nodeId,
          runId: exclusion.runId,
          expiresAt: exclusion.expiresAt,
        },
      );
    }

    if (node.state !== "ready") {
      throw new ClaimNodeError(
        "illegal-transition",
        `the node ${node.id} is ${node.state}, not claimable`,
        { state: node.state, admitted: ["ready", "running"] },
      );
    }
    const cascade = cascadeVerdicts(nodes, node);

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
    const claimedLease =
      node.kind === "task"
        ? acquireWithHierarchyRefusal(dependencies.lease, transaction, {
            subjectKind: "node",
            subjectId: node.id,
            owner: input.actorId,
            ownerKind: "actor",
            ttlMs: dependencies.leaseTtlMs,
            now,
          })
        : objectiveLease;
    dependencies.plan.setNodeAssignment(transaction, {
      id: node.id,
      assignment: routedWorker,
    });
    const run = dependencies.execution.openRun(transaction, {
      nodeId: node.id,
      kind: runKind,
      workspaceId: null,
      worker: routedWorker,
      fence: 1,
      attemptLimit: dependencies.attemptLimit,
      judgedOid: null,
      graphRevision,
      agents: [],
      expiresAt: now + dependencies.runTtlMs,
      maxLifetimeAt: now + dependencies.runMaxLifetimeMs,
    });
    const fence = run.fence;
    const attempt =
      runKind === "execution"
        ? dependencies.execution.openAttempt(transaction, { runId: run.id })
        : null;
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
      subjectKind: "run",
      subjectId: run.id,
      type: "run.opened",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        runId: run.id,
        nodeId: node.id,
        fence,
        kind: runKind,
        worker: routedWorker,
        expiresAt: now + dependencies.runTtlMs,
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
      runId: run.id,
      objectiveRunId: run.id,
      attemptId: attempt?.id ?? null,
      attemptNo: attempt?.attemptNo ?? null,
      fence,
      expiresAt: now + dependencies.runTtlMs,
      renewAfterMs: Math.floor(dependencies.runTtlMs / 3),
      node: { id: node.id, state: "running" },
    };
  });
}

function routeClaimWorker(
  node: StoredNode,
  caller: ClaimCallerRecord,
  available: boolean,
  registry: readonly WorkerEntry[],
): string {
  const deliverable = node.deliverable as Deliverable;
  const capable = capableWorkers(registry, {
    kind: node.kind,
    deliverable,
  });
  if (capable.length === 0) {
    throw new ClaimNodeError("unroutable", `no worker can claim ${node.id}`, {
      failedSet: "capable",
    });
  }
  const authorized = caller.authorized.filter((id) => capable.includes(id));
  const availableWorkers =
    available && authorized.includes(caller.worker) ? [caller.worker] : [];
  const result = routeWorker({
    registry,
    kind: node.kind,
    deliverable,
    authorized,
    available: availableWorkers,
  });
  if (!result.routed) {
    throw new ClaimNodeError(
      "unroutable",
      `no available worker can claim ${node.id}`,
      {
        failedSet: result.failedSet,
      },
    );
  }
  return result.worker.worker;
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

function objectiveScopeId(node: StoredNode): string {
  if (node.kind === "task") {
    if (node.parentId === null) {
      throw new Error(`task ${node.id} has no parent objective`);
    }
    return node.parentId;
  }
  return node.id;
}

function objectiveAncestor(
  nodes: readonly StoredNode[],
  node: StoredNode,
): StoredNode {
  const objective = ancestorChain(nodes, node).find(
    (ancestor) => ancestor.kind === "objective",
  );
  if (objective === undefined) {
    throw new Error(`task ${node.id} has no objective ancestor`);
  }
  return objective;
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

function uniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
