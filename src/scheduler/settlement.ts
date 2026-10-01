import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import type { ExecutionRow, MissionTransitions } from "./contract.ts";
import {
  endExecution,
  readExecution,
  readUnendedOfNode,
  readUnendedOfRuntime,
} from "./execution-store.ts";

export const EXECUTION_NOT_RUNNING = "scheduler.execution.not_running";
const NO_LOSSES = 0;
export interface SettlementDependencies {
  transitions: MissionTransitions;
}

export function declareLoss(
  tx: Transaction,
  dependencies: SettlementDependencies,
  row: ExecutionRow,
  now: number,
): void {
  assert.equal(row.endedAt, null);
  assert.ok(now >= row.expiredAt);
  endExecution(tx, row.executionId, now);
  const result = tx.database
    .prepare(
      `SELECT count(*) AS count FROM scheduler_execution
    WHERE node_id = ? AND attempt = ? AND ended_at >= expired_at
    AND ended_at > coalesce((SELECT max(ended_at) FROM scheduler_execution
      WHERE node_id = ? AND attempt = ? AND ended_at < expired_at), -1)`,
    )
    .get(row.nodeId, row.attempt, row.nodeId, row.attempt)!;
  const count = Number(result.count);
  assert.ok(Number.isSafeInteger(count) && count > NO_LOSSES);
  dependencies.transitions.loss(tx, row.nodeId, count, now);
}
export function settleNode(
  tx: Transaction,
  dependencies: SettlementDependencies,
  nodeId: string,
  now: number,
): boolean {
  const row = readUnendedOfNode(tx, nodeId);
  if (!row || row.expiredAt > now) return false;
  declareLoss(tx, dependencies, row, now);
  return true;
}
export function settleRuntime(
  tx: Transaction,
  dependencies: SettlementDependencies,
  runtimeIdentity: string,
  now: number,
): boolean {
  const row = readUnendedOfRuntime(tx, runtimeIdentity);
  if (!row || row.expiredAt > now) return false;
  declareLoss(tx, dependencies, row, now);
  return true;
}
export function revoke(
  tx: Transaction,
  nodeId: string,
  now: number,
): string | null {
  const row = liveExecutionOf(tx, nodeId, now);
  if (!row) return null;
  endExecution(tx, row.executionId, now);
  return row.executionId;
}
export function liveExecutionOf(
  tx: Transaction,
  nodeId: string,
  now: number,
): ExecutionRow | null {
  const row = readUnendedOfNode(tx, nodeId);
  return row && now < row.expiredAt ? row : null;
}
export function runningExecutionOfRuntime(
  tx: Transaction,
  dependencies: SettlementDependencies,
  runtimeIdentity: string,
  now: number,
): ExecutionRow | null {
  settleRuntime(tx, dependencies, runtimeIdentity, now);
  const row = readUnendedOfRuntime(tx, runtimeIdentity);
  return row && now < row.expiredAt ? row : null;
}
export function requireRunning(
  tx: Transaction,
  executionId: string,
  runtimeIdentity: string,
  now: number,
): ExecutionRow {
  const row = readExecution(tx, executionId);
  if (
    !row ||
    row.runtimeIdentity !== runtimeIdentity ||
    row.endedAt !== null ||
    now >= row.expiredAt
  )
    throw new OperationError(
      HttpStatus.Conflict,
      EXECUTION_NOT_RUNNING,
      "The execution is not a running claim of this registration.",
    );
  assert.equal(row.executionId, executionId);
  assert.equal(row.runtimeIdentity, runtimeIdentity);
  return row;
}
