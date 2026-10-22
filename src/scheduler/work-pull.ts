import assert from "node:assert/strict";
import { isMachineIdentity, type MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { WORK_PULL_WAIT_MS, WorkPullKind, type WorkPull } from "./contract.ts";
import type { WaitingPulls } from "./wakeup.ts";
import {
  claimOnce,
  ClaimOutcome,
  type ClaimDependencies,
  type ClaimResult,
} from "./claim.ts";
import { executionRecord } from "./execution-store.ts";
import { settleRuntime } from "./settlement.ts";
import { executionTrace } from "./telemetry.ts";

const WINDOW_ENDED = 0;
export interface PullDependencies extends ClaimDependencies {
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

function heldJobWait(
  dependencies: PullDependencies,
  projectId: string,
  now: number,
): number | null {
  const row = dependencies.store.transaction(
    (tx) =>
      tx.database
        .prepare(
          "SELECT min(available_at) AS until FROM scheduler_job WHERE project_id = ? AND available_at > ?",
        )
        .get(projectId, now) as { until: number | null },
  );
  return row.until === null ? null : row.until - now;
}

function cancelled(caller: CallerContext): void {
  if (caller.context.signal.aborted)
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
  let claimed = false;
  let siblings: string[] = [];
  const answer = caller.commit((tx) => {
    const result = decide(tx, dependencies, identity, pull, now);
    settled = result.settled;
    claimed = result.outcome === ClaimOutcome.Claimed;
    if (claimed)
      siblings = dependencies.registrations.registrationsOfInstance(
        tx,
        pull.runtime_identity,
      );
    if (!result.row) return { kind: WorkPullKind.NoWork } as const;
    return {
      kind: WorkPullKind.Claimed,
      execution: executionRecord(tx, dependencies, result.row, now),
    } as const;
  });
  if (settled) dependencies.waiting.wake(identity.projectId);
  if (claimed) dependencies.instances.claimed(pull.runtime_identity, siblings);
  if (answer.kind === WorkPullKind.Claimed) {
    if (claimed)
      dependencies.agentChains.selected(
        answer.execution.agent_selections,
        answer.execution.execution_id,
      );
    dependencies.telemetry.executionOpened(
      executionTrace(answer.execution),
      answer.execution.created_at,
    );
  }
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
      (result.outcome !== ClaimOutcome.None &&
        result.outcome !== ClaimOutcome.Queued) ||
      result.settled ||
      remaining <= WINDOW_ENDED ||
      dependencies.waiting.pulling(pull.runtime_identity) ||
      !dependencies.accepting()
    )
      return commit(dependencies, identity, pull, caller, now);
    const held = heldJobWait(dependencies, identity.projectId, now);
    await dependencies.waiting.park(
      identity.projectId,
      pull.runtime_identity,
      held === null ? remaining : Math.min(remaining, held),
      caller.context,
    );
  }
}
