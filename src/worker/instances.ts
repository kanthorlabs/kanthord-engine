import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { createIdentity } from "../kernel/identity.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { Registration, VerifiedClient } from "./contract.ts";

export const WORKER_INSTANCE_PREFIX = "worker_instance";
const NO_ROWS = 0;
export interface InstanceRow extends Registration {
  registeredAt: number;
  endedAt: number | null;
}
interface StoredRow {
  id: string;
  project_id: string;
  resource_identity: string;
  client_id: string;
  client_name: string;
  registered_at: number;
  ended_at: number | null;
}

function row(value: StoredRow): InstanceRow {
  assert.ok(value.id.startsWith(`${WORKER_INSTANCE_PREFIX}_`));
  assert.ok(Number.isSafeInteger(value.registered_at));
  return {
    runtimeIdentity: value.id,
    projectId: value.project_id,
    resourceIdentity: value.resource_identity,
    clientId: value.client_id,
    name: value.client_name,
    registeredAt: value.registered_at,
    endedAt: value.ended_at,
  };
}

export function readLiveByClient(
  store: Store,
  clientId: string,
): InstanceRow | undefined {
  assert.ok(store.database.isOpen);
  assert.ok(clientId);
  const found = store.database
    .prepare(
      "SELECT * FROM worker_instance WHERE client_id = ? AND ended_at IS NULL",
    )
    .get(clientId) as StoredRow | undefined;
  return found ? row(found) : undefined;
}

export function readLiveOfClient(
  tx: Transaction,
  clientId: string,
): InstanceRow | undefined {
  assert.ok(tx.database.isTransaction);
  assert.ok(clientId);
  const found = tx.database
    .prepare(
      "SELECT * FROM worker_instance WHERE client_id = ? AND ended_at IS NULL",
    )
    .get(clientId) as StoredRow | undefined;
  return found ? row(found) : undefined;
}

export function readRow(
  tx: Transaction,
  runtimeIdentity: string,
): InstanceRow | null {
  assert.ok(tx.database.isTransaction);
  assert.ok(runtimeIdentity);
  const found = tx.database
    .prepare("SELECT * FROM worker_instance WHERE id = ?")
    .get(runtimeIdentity) as StoredRow | undefined;
  return found ? row(found) : null;
}

export function countLive(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): number {
  assert.ok(tx.database.isTransaction);
  assert.ok(projectId && resourceIdentity);
  const found = tx.database
    .prepare(
      "SELECT COUNT(*) AS count FROM worker_instance WHERE project_id = ? AND resource_identity = ? AND ended_at IS NULL",
    )
    .get(projectId, resourceIdentity) as { count: number };
  return found.count;
}

export function insertRegistration(
  tx: Transaction,
  client: VerifiedClient,
  now: number,
): InstanceRow {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const runtimeIdentity = createIdentity(WORKER_INSTANCE_PREFIX);
  tx.database
    .prepare(
      "INSERT INTO worker_instance (id, project_id, resource_identity, client_id, client_name, registered_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .run(
      runtimeIdentity,
      client.projectId,
      client.resourceIdentity,
      client.clientId,
      client.name,
      now,
    );
  return { ...client, runtimeIdentity, registeredAt: now, endedAt: null };
}

export function endRegistration(
  tx: Transaction,
  runtimeIdentity: string,
  now: number,
): number {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  return Number(
    tx.database
      .prepare(
        "UPDATE worker_instance SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
      )
      .run(now, runtimeIdentity).changes,
  );
}

export function endGroup(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
  now: number,
): string[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const ended = tx.database
    .prepare(
      "UPDATE worker_instance SET ended_at = ? WHERE project_id = ? AND resource_identity = ? AND ended_at IS NULL RETURNING id",
    )
    .all(now, projectId, resourceIdentity) as { id: string }[];
  return ended.map(({ id }) => id);
}

export function reopenRegistration(
  tx: Transaction,
  runtimeIdentity: string,
): void {
  assert.ok(tx.database.isTransaction);
  assert.ok(runtimeIdentity);
  tx.database
    .prepare(
      "UPDATE worker_instance SET ended_at = NULL WHERE id = ? AND ended_at IS NOT NULL",
    )
    .run(runtimeIdentity);
}

export function listLive(
  tx: Transaction,
  filter: {
    projectId?: string;
    resourceIdentity?: string;
    cursor?: string;
    limit: number;
  },
): InstanceRow[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(filter.limit) && filter.limit > NO_ROWS);
  const clauses = ["ended_at IS NULL"];
  const values: SQLInputValue[] = [];
  if (filter.projectId !== undefined) {
    clauses.push("project_id = ?");
    values.push(filter.projectId);
  }
  if (filter.resourceIdentity !== undefined) {
    clauses.push("resource_identity = ?");
    values.push(filter.resourceIdentity);
  }
  if (filter.cursor !== undefined) {
    clauses.push("id < ?");
    values.push(filter.cursor);
  }
  values.push(filter.limit + 1);
  return (
    tx.database
      .prepare(
        `SELECT * FROM worker_instance WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      )
      .all(...values) as unknown as StoredRow[]
  ).map(row);
}

export function readAllLive(tx: Transaction): InstanceRow[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(tx.database.isOpen);
  return (
    tx.database
      .prepare("SELECT * FROM worker_instance WHERE ended_at IS NULL")
      .all() as unknown as StoredRow[]
  ).map(row);
}
