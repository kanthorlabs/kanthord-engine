import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  agentPinSchema,
  ClaimState,
  ExecutionStopReason,
  releaseStopSchema,
  type AgentChains,
  type AgentSelection,
  type ReleaseStop,
  type ExecutionRow,
  type ExecutionRecord,
  type InstanceRegistrations,
  type MissionBranches,
} from "./contract.ts";

const NO_ROWS = 0;
const ONE_ROW = 1;
const credentialList = z.array(identitySchema("credential"));
const pinList = z.array(agentPinSchema);
const storedStop = releaseStopSchema.nullable();
interface RecordDependencies {
  registrations: InstanceRegistrations;
  branches: MissionBranches;
  agentChains: Pick<AgentChains, "resolve">;
}
const COLUMNS = `id AS execution_id, project_id, node_id,
  worker_binding_id, resource_identity,
  runtime_identity, attempt, pinned_revision,
  credentials, expired_at, trace_id, root_span_id,
  created_at, ended_at, stop, agent_selections`;
type StoredRow = Omit<ExecutionRow, "credentials" | "stop" | "agent_pins"> & {
  credentials: string;
  stop: string | null;
  agent_selections: string | null;
};

function decode(row: StoredRow): ExecutionRow {
  const credentials = credentialList.parse(JSON.parse(row.credentials));
  assert.equal(new Set(credentials).size, credentials.length);
  assert.ok(Number.isSafeInteger(row.attempt) && row.attempt > NO_ROWS);
  const stop = storedStop.parse(
    row.stop === null ? null : JSON.parse(row.stop),
  );
  assert.ok(stop === null || row.ended_at !== null);
  const { agent_selections: storedPins, ...fields } = row;
  const agentPins = pinList.parse(
    storedPins === null ? [] : JSON.parse(storedPins),
  );
  return { ...fields, credentials, stop, agent_pins: agentPins };
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
     attempt, pinned_revision, credentials, expired_at, trace_id, root_span_id, created_at, ended_at, stop,
     agent_selections)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      canonicalJSON(pinList.parse(row.agent_pins)),
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
export function nodeBranchOfExecution(
  tx: Transaction,
  branches: MissionBranches,
  row: ExecutionRow,
): string {
  const [nodeBranch] = branches.nodeBranchesOf(tx, [
    { node_id: row.node_id, attempt: row.attempt },
  ]);
  assert.ok(nodeBranch);
  return nodeBranch;
}
export function executionRecord(
  tx: Transaction,
  dependencies: RecordDependencies,
  row: ExecutionRow,
  now: number,
): ExecutionRecord {
  return recordOf(
    tx,
    dependencies.registrations,
    row,
    nodeBranchOfExecution(tx, dependencies.branches, row),
    dependencies.agentChains.resolve(tx, row.worker_binding_id, row.agent_pins),
    now,
  );
}
export function executionRecords(
  tx: Transaction,
  dependencies: RecordDependencies,
  rows: readonly ExecutionRow[],
  now: number,
): ExecutionRecord[] {
  const nodeBranches = dependencies.branches.nodeBranchesOf(
    tx,
    rows.map((row) => ({ node_id: row.node_id, attempt: row.attempt })),
  );
  assert.equal(nodeBranches.length, rows.length);
  const memo = new Map<string, AgentSelection[]>();
  return rows.map((row, index) => {
    const key = canonicalJSON([row.worker_binding_id, row.agent_pins]);
    let selections = memo.get(key);
    if (!selections) {
      selections = dependencies.agentChains.resolve(
        tx,
        row.worker_binding_id,
        row.agent_pins,
      );
      memo.set(key, selections);
    }
    return recordOf(
      tx,
      dependencies.registrations,
      row,
      nodeBranches[index]!,
      selections,
      now,
    );
  });
}
function recordOf(
  tx: Transaction,
  registrations: InstanceRegistrations,
  row: ExecutionRow,
  nodeBranch: string,
  selections: AgentSelection[],
  now: number,
): ExecutionRecord {
  const {
    worker_binding_id: workerBindingId,
    resource_identity: resourceIdentity,
    runtime_identity: runtimeIdentity,
    agent_pins: pins,
    ...fields
  } = row;
  assert.ok(workerBindingId.length > NO_ROWS);
  assert.ok(runtimeIdentity.length > NO_ROWS);
  assert.equal(selections.length, pins.length);
  const attribution = registrations.clientAttributionOf(tx, runtimeIdentity);
  return {
    ...fields,
    agent_selections: selections,
    node_branch: nodeBranch,
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

export function consecutiveStalls(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): number {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      `SELECT count(*) AS count FROM scheduler_execution
    WHERE node_id = ? AND attempt = ? AND json_extract(stop, '$.reason') = ?
    AND rowid > coalesce((SELECT max(rowid) FROM scheduler_execution
      WHERE node_id = ? AND attempt = ? AND ended_at IS NOT NULL
      AND coalesce(json_extract(stop, '$.reason'), '') != ?), -1)`,
    )
    .get(
      nodeId,
      attempt,
      ExecutionStopReason.BudgetEnd,
      nodeId,
      attempt,
      ExecutionStopReason.BudgetEnd,
    )!;
  const count = Number(result.count);
  assert.ok(Number.isSafeInteger(count) && count >= NO_ROWS);
  return count;
}
