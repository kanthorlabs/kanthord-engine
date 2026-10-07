import assert from "node:assert/strict";
import { isMachineIdentity, type MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { WORK_PULL_WAIT_MS, WorkPullKind, type WorkPull } from "./contract.ts";
import type { Dependencies } from "./service.ts";
import type { WaitingPulls } from "./wakeup.ts";
import { claimOnce, ClaimOutcome, type ClaimResult } from "./claim.ts";
import { executionRecord } from "./execution-store.ts";
import { settleRuntime } from "./settlement.ts";

const WINDOW_ENDED = 0;
export interface PullDependencies extends Dependencies {
  waiting: WaitingPulls;
  accepting(): boolean;
}

class Probe {
  readonly result: ClaimResult;
  constructor(result: ClaimResult) {
    this.result = result;
  }
}

function decide(
  tx: Transaction,
  dependencies: PullDependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  now: number,
): ClaimResult {
  assert.equal(identity.runtimeIdentity, pull.runtime_identity);
  assert.equal(identity.resourceIdentity, pull.resource_identity);
  if (dependencies.accepting())
    return claimOnce(tx, dependencies, identity, pull, now);
  return {
    outcome: ClaimOutcome.None,
    row: null,
    settled: settleRuntime(tx, dependencies, pull.runtime_identity, now),
  };
}

function probe(
  dependencies: PullDependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  now: number,
): ClaimResult {
  try {
    return dependencies.store.transaction((tx) => {
      throw new Probe(decide(tx, dependencies, identity, pull, now));
    });
  } catch (error) {
    if (error instanceof Probe) return error.result;
    throw error;
  }
}

function cancelled(caller: CallerContext): void {
  if (caller.context.err())
    throw new OperationError(
      HttpStatus.ServiceUnavailable,
      "gateway.invocation.cancelled",
      "Request cancelled.",
    );
}

function commit(
  dependencies: PullDependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  caller: CallerContext,
  now: number,
) {
  cancelled(caller);
  let settled = false;
  const answer = caller.commit((tx) => {
    const result = decide(tx, dependencies, identity, pull, now);
    settled = result.settled;
    if (!result.row) return { kind: WorkPullKind.NoWork } as const;
    return {
      kind: WorkPullKind.Claimed,
      execution: executionRecord(
        tx,
        dependencies.registrations,
        result.row,
        now,
      ),
    } as const;
  });
  if (settled) dependencies.waiting.wake(identity.projectId);
  return answer;
}

export async function workPull(
  dependencies: PullDependencies,
  pull: WorkPull,
  caller: CallerContext,
) {
  const identity = caller.identity;
  assert.ok(
    isMachineIdentity(identity),
    "work pull requires a verified machine",
  );
  if (
    pull.runtime_identity !== identity.runtimeIdentity ||
    pull.resource_identity !== identity.resourceIdentity
  )
    throw new OperationError(
      HttpStatus.Forbidden,
      "scheduler.work.claimant_mismatch",
      "The pull must name this machine's live registration and resource.",
    );
  const deadline = performance.now() + WORK_PULL_WAIT_MS;
  while (true) {
    cancelled(caller);
    const now = Date.now();
    const result = probe(dependencies, identity, pull, now);
    const remaining = deadline - performance.now();
    if (
      result.outcome !== ClaimOutcome.None ||
      result.settled ||
      remaining <= WINDOW_ENDED ||
      dependencies.waiting.pulling(pull.runtime_identity) ||
      !dependencies.accepting()
    )
      return commit(dependencies, identity, pull, caller, now);
    await dependencies.waiting.park(
      identity.projectId,
      pull.runtime_identity,
      remaining,
      caller.context,
    );
  }
}
