import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AdvancingProviderFailure,
  ExecutionStopReason,
  type ExecutionRow,
  type MissionTransitions,
  type Registrations,
  type RevokedExecution,
  type WorkerBindings,
} from "./contract.ts";
import { executionTrace } from "./telemetry.ts";
import {
  endExecution,
  readExecution,
  readUnendedOfNode,
  readUnendedOfRuntime,
} from "./execution-store.ts";
import type { SchedulerConfig } from "./config.ts";

export const EXECUTION_NOT_RUNNING = "scheduler.execution.not_running";
const NO_FAILURES = 0;
const ENDING_FAILURE = 1;
const MILLISECONDS_PER_SECOND = 1000;
export interface SettlementDependencies {
  transitions: MissionTransitions;
  config: Pick<SchedulerConfig, "stop_backoff">;
}

const FIRST_BACKOFF_FAILURE = 1;
const BACKOFF_GROWTH = 2;

export function heldUntil(
  failures: number,
  now: number,
  backoffSeconds: number,
): number | null {
  assert.ok(Number.isSafeInteger(failures) && failures >= NO_FAILURES);
  if (failures < FIRST_BACKOFF_FAILURE) return null;
  const until =
    now +
    MILLISECONDS_PER_SECOND *
      backoffSeconds *
      BACKOFF_GROWTH ** (failures - FIRST_BACKOFF_FAILURE);
  assert.ok(Number.isSafeInteger(until));
  return until;
}

export function recordFailure(
  tx: Transaction,
  dependencies: SettlementDependencies,
  nodeId: string,
  failures: number,
  now: number,
): void {
  dependencies.transitions.failure(tx, nodeId, failures, now);
  const until = heldUntil(failures, now, dependencies.config.stop_backoff);
  if (until === null) return;
  tx.database
    .prepare("UPDATE scheduler_job SET available_at = ? WHERE node_id = ?")
    .run(until, nodeId);
}

export function pinCredential(
  tx: Transaction,
  executionId: string,
  credentialId: string,
): void {
  assert.ok(tx.database.isTransaction);
  assert.ok(identitySchema("credential").safeParse(credentialId).success);
  const row = readExecution(tx, executionId);
  if (!row || row.ended_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      EXECUTION_NOT_RUNNING,
      "The execution has ended.",
    );
  if (row.credentials.includes(credentialId)) return;
  tx.database
    .prepare("UPDATE scheduler_execution SET credentials = ? WHERE id = ?")
    .run(canonicalJSON([...row.credentials, credentialId]), executionId);
}

export function liveExecutionsPinning(
  tx: Transaction,
  credentialId: string,
): string[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(identitySchema("credential").safeParse(credentialId).success);
  return tx.database
    .prepare(
      `SELECT id FROM scheduler_execution
    WHERE ended_at IS NULL AND EXISTS (SELECT 1 FROM json_each(credentials) WHERE value = ?) ORDER BY id`,
    )
    .all(credentialId)
    .map((row) => String(row.id));
}

export function executionAttribution(
  tx: Transaction,
  dependencies: {
    registrations: Registrations;
    bindings: WorkerBindings;
  },
  executionId: string,
) {
  assert.ok(tx.database.isTransaction);
  const row = readExecution(tx, executionId);
  if (!row) return null;
  const attribution = dependencies.registrations.clientAttributionOf(
    tx,
    row.runtime_identity,
  );
  const binding = dependencies.bindings.workerBindingOf(
    tx,
    row.project_id,
    row.resource_identity,
  );
  assert.ok(binding, "an execution retains its worker binding group");
  return {
    client_id: attribution?.client_id ?? null,
    name: attribution?.name ?? null,
    worker_name: binding.worker_name,
  };
}

export function consecutiveFailures(
  tx: Transaction,
  ending: ExecutionRow,
  endingCounts = true,
): number {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      `SELECT count(*) AS count FROM scheduler_execution
    WHERE node_id = ? AND attempt = ? AND id != ?
    AND (ended_at >= expired_at
      OR (coalesce(json_extract(stop, '$.reason'), ?) NOT IN (?, ?)
        AND NOT (json_extract(stop, '$.reason') = ?
          AND json_extract(stop, '$.code') IN (SELECT value FROM json_each(?)))))
    AND rowid > coalesce((SELECT max(rowid) FROM scheduler_execution
      WHERE node_id = ? AND attempt = ? AND ended_at < expired_at
      AND coalesce(json_extract(stop, '$.reason'), ?) = ?), -1)`,
    )
    .get(
      ending.node_id,
      ending.attempt,
      ending.execution_id,
      ExecutionStopReason.BudgetEnd,
      ExecutionStopReason.BudgetEnd,
      ExecutionStopReason.EnvironmentFailed,
      ExecutionStopReason.ProviderFailed,
      canonicalJSON(Object.values(AdvancingProviderFailure)),
      ending.node_id,
      ending.attempt,
      ExecutionStopReason.BudgetEnd,
      ExecutionStopReason.BudgetEnd,
    )!;
  const count =
    Number(result.count) + (endingCounts ? ENDING_FAILURE : NO_FAILURES);
  assert.ok(Number.isSafeInteger(count) && count >= NO_FAILURES);
  return count;
}

export function declareLoss(
  tx: Transaction,
  dependencies: SettlementDependencies,
  row: ExecutionRow,
  now: number,
): void {
  assert.equal(row.ended_at, null);
  assert.ok(now >= row.expired_at);
  endExecution(tx, row.execution_id, now);
  recordFailure(
    tx,
    dependencies,
    row.node_id,
    consecutiveFailures(tx, row),
    now,
  );
}
export function settleNode(
  tx: Transaction,
  dependencies: SettlementDependencies,
  nodeId: string,
  now: number,
): boolean {
  const row = readUnendedOfNode(tx, nodeId);
  if (!row || row.expired_at > now) return false;
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
  if (!row || row.expired_at > now) return false;
  declareLoss(tx, dependencies, row, now);
  return true;
}
export function revoke(
  tx: Transaction,
  nodeId: string,
  now: number,
): RevokedExecution | null {
  const row = liveExecutionOf(tx, nodeId, now);
  if (!row) return null;
  endExecution(tx, row.execution_id, now);
  return {
    execution_id: row.execution_id,
    trace: executionTrace(row),
    ended_at: now,
  };
}
export function liveExecutionOf(
  tx: Transaction,
  nodeId: string,
  now: number,
): ExecutionRow | null {
  const row = readUnendedOfNode(tx, nodeId);
  return row && now < row.expired_at ? row : null;
}
export function runningExecutionOfRuntime(
  tx: Transaction,
  dependencies: SettlementDependencies,
  runtimeIdentity: string,
  now: number,
): ExecutionRow | null {
  settleRuntime(tx, dependencies, runtimeIdentity, now);
  const row = readUnendedOfRuntime(tx, runtimeIdentity);
  return row && now < row.expired_at ? row : null;
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
    row.runtime_identity !== runtimeIdentity ||
    row.ended_at !== null ||
    now >= row.expired_at
  )
    throw new OperationError(
      HttpStatus.Conflict,
      EXECUTION_NOT_RUNNING,
      "The execution is not a running claim of this registration.",
    );
  assert.equal(row.execution_id, executionId);
  assert.equal(row.runtime_identity, runtimeIdentity);
  return row;
}
