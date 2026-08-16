import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  LeaseError,
  type Lease,
  type LeaseRecord,
} from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type HeartbeatRefusal =
  "node-not-found" | "initiative-not-claimable" | "lease-held";

export type ClaimedLease = Readonly<{
  subjectId: string;
  owner: string;
  ownerKind: "actor";
  fence: number;
  expiresAt: number;
}>;

export type HeartbeatNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  events: EventLog;
  clock: Clock;
  leaseTtlMs: number;
}>;

export type HeartbeatNodeInput = Readonly<{
  nodeId: string;
  fence: number;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type HeartbeatNodeResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  heartbeatIntervalMs: number;
}>;

export class HeartbeatNodeError extends Error {
  readonly refusal: HeartbeatRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    refusal: HeartbeatRefusal,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HeartbeatNodeError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function heartbeatNode(
  dependencies: HeartbeatNodeDependencies,
  input: HeartbeatNodeInput,
): HeartbeatNodeResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();

    const nodes = dependencies.plan.readAllNodes(transaction);
    const node = nodes.find((candidate) => candidate.id === input.nodeId);
    if (node === undefined) {
      throw new HeartbeatNodeError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new HeartbeatNodeError(
        "initiative-not-claimable",
        `an initiative is never claimed and so never held`,
      );
    }

    const objectiveId = node.kind === "task" ? objectiveScopeOf(node) : node.id;

    const renewed = renewLease(dependencies, transaction, input, node.id, now);
    const objectiveRenewed =
      node.kind === "task"
        ? renewObjectiveLease(
            dependencies,
            transaction,
            input,
            objectiveId,
            now,
          )
        : renewed;

    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      type: "lease.renewed",
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: {
        subjectId: node.id,
        objectiveId,
        fence: renewed.fence,
        objectiveFence: objectiveRenewed.fence,
        expiresAt: renewed.expiresAt,
        objectiveExpiresAt: objectiveRenewed.expiresAt,
      },
    });

    return {
      lease: toClaimedLease(renewed),
      objectiveLease: toClaimedLease(objectiveRenewed),
      heartbeatIntervalMs: Math.floor(dependencies.leaseTtlMs / 3),
    };
  });
}

function renewLease(
  dependencies: HeartbeatNodeDependencies,
  transaction: Transaction,
  input: HeartbeatNodeInput,
  subjectId: string,
  now: number,
): LeaseRecord {
  try {
    return dependencies.lease.renew(transaction, {
      subjectKind: "node",
      subjectId,
      owner: input.actorId,
      ownerKind: "actor",
      fence: input.fence,
      ttlMs: dependencies.leaseTtlMs,
      now,
    });
  } catch (error) {
    if (error instanceof LeaseError && error.code === "lease-fenced") {
      throw new HeartbeatNodeError(
        "lease-held",
        `the lease of ${subjectId} is not held by ${input.actorId} at fence ${input.fence}`,
      );
    }
    throw error;
  }
}

function renewObjectiveLease(
  dependencies: HeartbeatNodeDependencies,
  transaction: Transaction,
  input: HeartbeatNodeInput,
  objectiveId: string,
  now: number,
): LeaseRecord {
  const record = dependencies.lease.read(transaction, {
    subjectKind: "node",
    subjectId: objectiveId,
    now,
  });
  if (record === null || record.owner === null) {
    throw new HeartbeatNodeError(
      "lease-held",
      `the objective lease of ${objectiveId} is absent or free`,
    );
  }
  if (record.owner !== input.actorId) {
    throw new HeartbeatNodeError(
      "lease-held",
      `the objective ${objectiveId} is held by another owner`,
    );
  }
  if (record.expiresAt === null || record.expiresAt <= now) {
    throw new HeartbeatNodeError(
      "lease-held",
      `the objective lease of ${objectiveId} has expired`,
    );
  }
  return dependencies.lease.renew(transaction, {
    subjectKind: "node",
    subjectId: objectiveId,
    owner: input.actorId,
    ownerKind: "actor",
    fence: record.fence,
    ttlMs: dependencies.leaseTtlMs,
    now,
  });
}

function objectiveScopeOf(node: Readonly<{ parentId: string | null }>): string {
  if (node.parentId === null) {
    throw new Error(`a task with no parent objective cannot be heartbeated`);
  }
  return node.parentId;
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
