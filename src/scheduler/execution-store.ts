import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ClaimState,
  releaseStopSchema,
  type ReleaseStop,
  type ExecutionRow,
  type ExecutionRecord,
  type InstanceRegistrations,
} from "./contract.ts";

const NO_ROWS = 0;
const ONE_ROW = 1;
const credentialList = z.array(identitySchema("credential"));
const storedStop = releaseStopSchema.nullable();
const COLUMNS = `id AS execution_id, project_id, node_id,
  worker_binding_id, resource_identity,
  runtime_identity, attempt, pinned_revision,
  credentials, expired_at, trace_id, root_span_id,
  created_at, ended_at, stop`;
type StoredRow = Omit<ExecutionRow, "credentials" | "stop"> & {
  credentials: string;
  stop: string | null;
};

function decode(row: StoredRow): ExecutionRow {
  const credentials = credentialList.parse(JSON.parse(row.credentials));
  assert.equal(new Set(credentials).size, credentials.length);
  assert.ok(Number.isSafeInteger(row.attempt) && row.attempt > NO_ROWS);
  const stop = storedStop.parse(
    row.stop === null ? null : JSON.parse(row.stop),
  );
  assert.ok(stop === null || row.ended_at !== null);
  return { ...row, credentials, stop };
}

export function insertExecution(tx: Transaction, row: ExecutionRow): void {
  assert.equal(new Set(row.credentials).size, row.credentials.length);
  assert.ok(
    row.expired_at > row.created_at && Number.isSafeInteger(row.expired_at),
  );
  assert.ok(row.stop === null || row.ended_at !== null);
  tx.database
    .prepare(
      `INSERT INTO scheduler_execution
    (id, project_id, node_id, worker_binding_id, resource_identity, runtime_identity,
     attempt, pinned_revision, credentials, expired_at, trace_id, root_span_id, created_at, ended_at, stop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.execution_id,
      row.project_id,
      row.node_id,
      row.worker_binding_id,
      row.resource_identity,
      row.runtime_identity,
      row.attempt,
      row.pinned_revision,
      canonicalJSON(row.credentials),
      row.expired_at,
      row.trace_id,
      row.root_span_id,
      row.created_at,
      row.ended_at,
      row.stop === null ? null : canonicalJSON(row.stop),
    );
}

function readBy(
  tx: Transaction,
  column: "id" | "node_id" | "runtime_identity",
  value: string,
  unended: boolean,
): ExecutionRow | null {
  assert.ok(value.length > NO_ROWS);
  assert.ok(["id", "node_id", "runtime_identity"].includes(column));
  const row = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM scheduler_execution WHERE ${column} = ?${unended ? " AND ended_at IS NULL" : ""}`,
    )
    .get(value) as StoredRow | undefined;
  return row ? decode(row) : null;
}
export function readExecution(
  tx: Transaction,
  executionId: string,
): ExecutionRow | null {
  return readBy(tx, "id", executionId, false);
}
export function readUnendedOfNode(
  tx: Transaction,
  nodeId: string,
): ExecutionRow | null {
  return readBy(tx, "node_id", nodeId, true);
}
export function readUnendedOfRuntime(
  tx: Transaction,
  runtimeIdentity: string,
): ExecutionRow | null {
  return readBy(tx, "runtime_identity", runtimeIdentity, true);
}
export function readExpiredUnsettled(
  tx: Transaction,
  now: number,
): ExecutionRow[] {
  assert.ok(Number.isSafeInteger(now));
  assert.ok(now >= NO_ROWS);
  return (
    tx.database
      .prepare(
        `SELECT ${COLUMNS} FROM scheduler_execution WHERE ended_at IS NULL AND expired_at <= ? ORDER BY id`,
      )
      .all(now) as StoredRow[]
  ).map(decode);
}
export function countRunningOfGroup(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
  now: number,
): number {
  assert.ok(projectId.length > NO_ROWS);
  assert.ok(resourceIdentity.length > NO_ROWS);
  const row = tx.database
    .prepare(
      "SELECT count(*) AS count FROM scheduler_execution WHERE project_id = ? AND resource_identity = ? AND ended_at IS NULL AND expired_at > ?",
    )
    .get(projectId, resourceIdentity, now)!;
  return Number(row.count);
}
export function endExecution(
  tx: Transaction,
  executionId: string,
  now: number,
  stop: ReleaseStop | null = null,
): void {
  assert.ok(Number.isSafeInteger(now) && now >= NO_ROWS);
  const result = tx.database
    .prepare(
      "UPDATE scheduler_execution SET ended_at = ?, stop = ? WHERE id = ? AND ended_at IS NULL",
    )
    .run(
      now,
      stop === null ? null : canonicalJSON(releaseStopSchema.parse(stop)),
      executionId,
    );
  assert.equal(result.changes, ONE_ROW, "exactly one terminal write must win");
}
export function listExecutions(
  tx: Transaction,
  projectId: string,
  filter: { node_id?: string; attempt?: number },
  after: string | undefined,
  count: number,
): ExecutionRow[] {
  assert.ok(Number.isSafeInteger(count) && count > NO_ROWS);
  assert.ok(filter.attempt === undefined || filter.node_id !== undefined);
  return (
    tx.database
      .prepare(
        `SELECT ${COLUMNS} FROM scheduler_execution
    WHERE project_id = ? AND (? IS NULL OR node_id = ?) AND (? IS NULL OR attempt = ?)
    AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(
        projectId,
        filter.node_id ?? null,
        filter.node_id ?? null,
        filter.attempt ?? null,
        filter.attempt ?? null,
        after ?? null,
        after ?? null,
        count + ONE_ROW,
      ) as StoredRow[]
  ).map(decode);
}
export function claimStateOf(row: ExecutionRow, now: number): ClaimState {
  assert.ok(Number.isSafeInteger(now) && now >= NO_ROWS);
  assert.ok(row.expired_at > row.created_at);
  if (row.ended_at !== null)
    return row.ended_at < row.expired_at
      ? ClaimState.Finished
      : ClaimState.Lost;
  return now < row.expired_at ? ClaimState.Running : ClaimState.Lost;
}
export function executionRecord(
  tx: Transaction,
  registrations: InstanceRegistrations,
  row: ExecutionRow,
  now: number,
): ExecutionRecord {
  const {
    worker_binding_id: workerBindingId,
    resource_identity: resourceIdentity,
    runtime_identity: runtimeIdentity,
    ...fields
  } = row;
  assert.ok(workerBindingId.length > NO_ROWS);
  assert.ok(runtimeIdentity.length > NO_ROWS);
  const attribution = registrations.clientAttributionOf(tx, runtimeIdentity);
  return {
    ...fields,
    claimant: {
      worker_binding_id: workerBindingId,
      resource_identity: resourceIdentity,
      runtime_identity: runtimeIdentity,
      ...(attribution && {
        client_id: attribution.client_id,
        name: attribution.name,
      }),
    },
    claim_state: claimStateOf(row, now),
  };
}
