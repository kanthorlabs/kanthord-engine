import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ClaimState,
  type ExecutionRow,
  type ExecutionRecord,
  type InstanceRegistrations,
} from "./contract.ts";

const NO_ROWS = 0;
const ONE_ROW = 1;
const credentialList = z.array(identitySchema("credential"));
const COLUMNS = `id AS executionId, project_id AS projectId, node_id AS nodeId,
  worker_binding_id AS workerBindingId, resource_identity AS resourceIdentity,
  runtime_identity AS runtimeIdentity, attempt, pinned_revision AS pinnedRevision,
  credentials, expired_at AS expiredAt, trace_id AS traceId, root_span_id AS rootSpanId,
  created_at AS createdAt, ended_at AS endedAt`;
type StoredRow = Omit<ExecutionRow, "credentials"> & { credentials: string };

function decode(row: StoredRow): ExecutionRow {
  const credentials = credentialList.parse(JSON.parse(row.credentials));
  assert.equal(new Set(credentials).size, credentials.length);
  assert.ok(Number.isSafeInteger(row.attempt) && row.attempt > NO_ROWS);
  return { ...row, credentials };
}

export function insertExecution(tx: Transaction, row: ExecutionRow): void {
  assert.equal(new Set(row.credentials).size, row.credentials.length);
  assert.ok(
    row.expiredAt > row.createdAt && Number.isSafeInteger(row.expiredAt),
  );
  tx.database
    .prepare(
      `INSERT INTO scheduler_execution
    (id, project_id, node_id, worker_binding_id, resource_identity, runtime_identity,
     attempt, pinned_revision, credentials, expired_at, trace_id, root_span_id, created_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.executionId,
      row.projectId,
      row.nodeId,
      row.workerBindingId,
      row.resourceIdentity,
      row.runtimeIdentity,
      row.attempt,
      row.pinnedRevision,
      canonicalJSON(row.credentials),
      row.expiredAt,
      row.traceId,
      row.rootSpanId,
      row.createdAt,
      row.endedAt,
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
): void {
  assert.ok(Number.isSafeInteger(now) && now >= NO_ROWS);
  const result = tx.database
    .prepare(
      "UPDATE scheduler_execution SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
    )
    .run(now, executionId);
  assert.equal(result.changes, ONE_ROW, "exactly one terminal write must win");
}
export function listExecutions(
  tx: Transaction,
  projectId: string,
  filter: { nodeId?: string; attempt?: number },
  after: string | undefined,
  count: number,
): ExecutionRow[] {
  assert.ok(Number.isSafeInteger(count) && count > NO_ROWS);
  assert.ok(filter.attempt === undefined || filter.nodeId !== undefined);
  return (
    tx.database
      .prepare(
        `SELECT ${COLUMNS} FROM scheduler_execution
    WHERE project_id = ? AND (? IS NULL OR node_id = ?) AND (? IS NULL OR attempt = ?)
    AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(
        projectId,
        filter.nodeId ?? null,
        filter.nodeId ?? null,
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
  assert.ok(row.expiredAt > row.createdAt);
  if (row.endedAt !== null)
    return row.endedAt < row.expiredAt ? ClaimState.Finished : ClaimState.Lost;
  return now < row.expiredAt ? ClaimState.Running : ClaimState.Lost;
}
export function executionRecord(
  tx: Transaction,
  registrations: InstanceRegistrations,
  row: ExecutionRow,
  now: number,
): ExecutionRecord {
  const { workerBindingId, resourceIdentity, runtimeIdentity, ...fields } = row;
  assert.ok(workerBindingId.length > NO_ROWS);
  assert.ok(runtimeIdentity.length > NO_ROWS);
  const attribution = registrations.clientAttributionOf(tx, runtimeIdentity);
  return {
    ...fields,
    claimant: {
      workerBindingId,
      resourceIdentity,
      runtimeIdentity,
      ...(attribution && {
        clientId: attribution.client_id,
        name: attribution.name,
      }),
    },
    claimState: claimStateOf(row, now),
  };
}
