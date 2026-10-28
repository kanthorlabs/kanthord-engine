import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { createIdentity } from "../kernel/identity.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  InstancePlacement,
  type InstanceRecord,
  WORKER_INSTANCE_ID_PREFIX,
} from "./contract.ts";

const NO_ROWS = 0;
const FIRST_REVISION = 1;
const COLUMNS =
  "id, name, worker, revision, placement, public_key, fingerprint, created_at, ended_at";

function record(row: unknown): InstanceRecord {
  const value = row as InstanceRecord;
  assert.ok(value.id.startsWith(`${WORKER_INSTANCE_ID_PREFIX}_`));
  assert.ok(Number.isSafeInteger(value.revision));
  return {
    id: value.id,
    name: value.name,
    worker: value.worker,
    revision: value.revision,
    placement: value.placement,
    public_key: value.public_key,
    fingerprint: value.fingerprint,
    created_at: value.created_at,
    ended_at: value.ended_at,
  };
}

export function readLatestInstance(
  tx: Transaction,
  name: string,
): InstanceRecord | null {
  assert.ok(tx.database.isTransaction);
  const found = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_instance WHERE name = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(name);
  return found ? record(found) : null;
}

export function readLiveInstance(
  tx: Transaction,
  name: string,
): InstanceRecord | null {
  const latest = readLatestInstance(tx, name);
  return latest?.ended_at === null ? latest : null;
}

export function readInstanceById(
  tx: Transaction,
  instanceId: string,
): InstanceRecord | null {
  assert.ok(tx.database.isTransaction);
  const found = tx.database
    .prepare(`SELECT ${COLUMNS} FROM worker_instance WHERE id = ?`)
    .get(instanceId);
  return found ? record(found) : null;
}

export function readLiveInstanceById(
  store: Store,
  instanceId: string,
): InstanceRecord | null {
  assert.ok(store.database.isOpen);
  const found = store.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_instance WHERE id = ? AND ended_at IS NULL`,
    )
    .get(instanceId);
  return found ? record(found) : null;
}

export function revisionIdsOf(tx: Transaction, name: string): string[] {
  assert.ok(tx.database.isTransaction);
  return (
    tx.database
      .prepare(
        "SELECT id FROM worker_instance WHERE name = ? ORDER BY revision",
      )
      .all(name) as { id: string }[]
  ).map(({ id }) => id);
}

export function fingerprintTaken(
  tx: Transaction,
  fingerprint: string,
): boolean {
  assert.ok(tx.database.isTransaction);
  return (
    tx.database
      .prepare("SELECT 1 FROM worker_instance WHERE fingerprint = ?")
      .get(fingerprint) !== undefined
  );
}

export function countLiveServerInstances(tx: Transaction): number {
  assert.ok(tx.database.isTransaction);
  const row = tx.database
    .prepare(
      "SELECT COUNT(*) AS count FROM worker_instance WHERE ended_at IS NULL AND placement IN (?, ?)",
    )
    .get(InstancePlacement.Server, InstancePlacement.Container) as {
    count: number;
  };
  return row.count;
}

export function readLiveServerInstances(tx: Transaction): InstanceRecord[] {
  assert.ok(tx.database.isTransaction);
  return tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_instance WHERE ended_at IS NULL AND placement IN (?, ?) ORDER BY created_at, name`,
    )
    .all(InstancePlacement.Server, InstancePlacement.Container)
    .map(record);
}

export function insertInstance(
  tx: Transaction,
  value: {
    name: string;
    worker: string;
    revision?: number;
    placement: InstancePlacement;
    public_key: string | null;
    fingerprint: string | null;
  },
  now: number,
): InstanceRecord {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const row: InstanceRecord = {
    id: createIdentity(WORKER_INSTANCE_ID_PREFIX),
    name: value.name,
    worker: value.worker,
    revision: value.revision ?? FIRST_REVISION,
    placement: value.placement,
    public_key: value.public_key,
    fingerprint: value.fingerprint,
    created_at: now,
    ended_at: null,
  };
  tx.database
    .prepare(
      `INSERT INTO worker_instance (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      row.id,
      row.name,
      row.worker,
      row.revision,
      row.placement,
      row.public_key,
      row.fingerprint,
      row.created_at,
    );
  return row;
}

export function endInstance(
  tx: Transaction,
  instanceId: string,
  now: number,
): void {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const changed = tx.database
    .prepare(
      "UPDATE worker_instance SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
    )
    .run(now, instanceId).changes;
  assert.ok(Number(changed) > NO_ROWS);
}

export function listInstances(
  tx: Transaction,
  filter: {
    worker?: string;
    include_archived: boolean;
    after?: string;
    limit: number;
  },
): InstanceRecord[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(filter.limit) && filter.limit > NO_ROWS);
  const clauses = [
    "revision = (SELECT MAX(revision) FROM worker_instance AS later WHERE later.name = worker_instance.name)",
  ];
  const values: SQLInputValue[] = [];
  if (!filter.include_archived) clauses.push("ended_at IS NULL");
  if (filter.worker !== undefined) {
    clauses.push("worker = ?");
    values.push(filter.worker);
  }
  if (filter.after !== undefined) {
    clauses.push("name > ?");
    values.push(filter.after);
  }
  values.push(filter.limit + 1);
  return tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_instance WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ?`,
    )
    .all(...values)
    .map(record);
}
