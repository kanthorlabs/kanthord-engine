import {
  assertRunAuthority,
  type RunAuthorityRefusalCode,
} from "../../domain/run-authority.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution, RunRecord } from "../../services/execution/index.ts";
import {
  LeaseError,
  type Lease,
  type LeaseRecord,
} from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type RenewRefusal =
  | RunAuthorityRefusalCode
  | "node-not-found"
  | "initiative-not-claimable"
  | "lease-held"
  | "lifetime-exceeded"
  | "objective-run-lost";

export type ClaimedLease = Readonly<{
  subjectId: string;
  owner: string;
  ownerKind: "actor";
  fence: number;
  expiresAt: number;
}>;

type Expiry = Readonly<{
  expireRuns(
    transaction: Transaction,
    input: Readonly<{ now: number }>,
  ): readonly unknown[];
}>;

export type RenewRunDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
  clock: Clock;
  expiry: Expiry;
  leaseTtlMs: number;
  runTtlMs: number;
  caller: string;
}>;

export type RenewRunInput = Readonly<{
  nodeId: string;
  fence: number;
  runId: string;
  runFence: number;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type RenewRunResult = Readonly<{
  lease: ClaimedLease;
  objectiveLease: ClaimedLease;
  expiresAt: number;
  objectiveExpiresAt: number;
  renewAfterMs: number;
}>;

export class RenewRunError extends Error {
  readonly refusal: RenewRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    refusal: RenewRefusal,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RenewRunError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function renewRun(
  dependencies: RenewRunDependencies,
  input: RenewRunInput,
): RenewRunResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();
    dependencies.expiry.expireRuns(transaction, { now });

    const node = dependencies.plan.readNode(transaction, input.nodeId);
    if (node === null) {
      throw new RenewRunError("node-not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "initiative") {
      throw new RenewRunError(
        "initiative-not-claimable",
        `an initiative is never renewed and so never held`,
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
      throw new RenewRunError(
        refusal.refusal,
        `run ${refusal.runId} is not authorized for renewal`,
        { runId: refusal.runId },
      );
    }
    if (now >= run!.maxLifetimeAt) {
      throw new RenewRunError(
        "lifetime-exceeded",
        `run ${input.runId} exceeded its maximum lifetime`,
        { runId: input.runId },
      );
    }

    const objectiveId = node.kind === "task" ? objectiveScopeOf(node) : node.id;
    const objectiveRun =
      node.kind === "task"
        ? dependencies.execution.activeRunOfNode(transaction, objectiveId)
        : null;
    if (node.kind === "task" && objectiveRun === null) {
      throw new RenewRunError(
        "objective-run-lost",
        `the objective ${objectiveId} holds no active run`,
        { objectiveId },
      );
    }

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
    const expiresAt = Math.min(now + dependencies.runTtlMs, run!.maxLifetimeAt);
    const renewedRun = dependencies.execution.renewRun(transaction, {
      runId: input.runId,
      expiresAt,
    });

    appendRunRenewed(dependencies, transaction, input, renewedRun);

    let objectiveExpiresAt = renewedRun.expiresAt;
    if (objectiveRun !== null) {
      const renewedObjectiveRun = dependencies.execution.renewRun(transaction, {
        runId: objectiveRun.id,
        expiresAt: Math.min(
          now + dependencies.runTtlMs,
          objectiveRun.maxLifetimeAt,
        ),
      });
      appendRunRenewed(dependencies, transaction, input, renewedObjectiveRun);
      objectiveExpiresAt = renewedObjectiveRun.expiresAt;
    }

    return {
      lease: toClaimedLease(renewed),
      objectiveLease: toClaimedLease(objectiveRenewed),
      expiresAt: renewedRun.expiresAt,
      objectiveExpiresAt,
      renewAfterMs: Math.floor(dependencies.runTtlMs / 3),
    };
  });
}

function appendRunRenewed(
  dependencies: RenewRunDependencies,
  transaction: Transaction,
  input: RenewRunInput,
  run: RunRecord,
): void {
  dependencies.events.append(transaction, {
    subjectKind: "run",
    subjectId: run.id,
    type: "run.renewed",
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: {
      runId: run.id,
      nodeId: run.nodeId,
      fence: run.fence,
      expiresAt: run.expiresAt,
    },
  });
}

function renewLease(
  dependencies: RenewRunDependencies,
  transaction: Transaction,
  input: RenewRunInput,
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
      throw new RenewRunError(
        "lease-held",
        `the lease of ${subjectId} is not held by ${input.actorId} at fence ${input.fence}`,
      );
    }
    throw error;
  }
}

function renewObjectiveLease(
  dependencies: RenewRunDependencies,
  transaction: Transaction,
  input: RenewRunInput,
  objectiveId: string,
  now: number,
): LeaseRecord {
  const record = dependencies.lease.read(transaction, {
    subjectKind: "node",
    subjectId: objectiveId,
    now,
  });
  if (record === null || record.owner === null) {
    throw new RenewRunError(
      "lease-held",
      `the objective lease of ${objectiveId} is absent or free`,
    );
  }
  if (record.owner !== input.actorId) {
    throw new RenewRunError(
      "lease-held",
      `the objective ${objectiveId} is held by another owner`,
    );
  }
  if (record.expiresAt === null || record.expiresAt <= now) {
    throw new RenewRunError(
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
    throw new Error(`a task with no parent objective cannot be renewed`);
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
