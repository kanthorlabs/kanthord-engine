import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { type MachineRecord, WORKER_MACHINE_ID_PREFIX } from "./contract.ts";

const NO_ROWS = 0;
const FIRST_REVISION = 1;
const COLUMNS =
  "id, name, revision, public_key, fingerprint, created_at, ended_at";

function record(row: unknown): MachineRecord {
  const value = row as MachineRecord;
  assert.ok(value.id.startsWith(`${WORKER_MACHINE_ID_PREFIX}_`));
  assert.ok(Number.isSafeInteger(value.revision));
  return {
    id: value.id,
    name: value.name,
    revision: value.revision,
    public_key: value.public_key,
    fingerprint: value.fingerprint,
    created_at: value.created_at,
    ended_at: value.ended_at,
  };
}

export function readLatestMachine(
  tx: Transaction,
  name: string,
): MachineRecord | null {
  assert.ok(tx.database.isTransaction);
  const found = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_machine WHERE name = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(name);
  return found ? record(found) : null;
}

export function readLiveMachine(
  tx: Transaction,
  name: string,
): MachineRecord | null {
  const latest = readLatestMachine(tx, name);
  return latest?.ended_at === null ? latest : null;
}

export function readMachineById(
  tx: Transaction,
  machineId: string,
): MachineRecord | null {
  assert.ok(tx.database.isTransaction);
  const found = tx.database
    .prepare(`SELECT ${COLUMNS} FROM worker_machine WHERE id = ?`)
    .get(machineId);
  return found ? record(found) : null;
}

export function insertMachine(
  tx: Transaction,
  value: {
    name: string;
    revision?: number;
    public_key: string;
    fingerprint: string;
  },
  now: number,
): MachineRecord {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const row: MachineRecord = {
    id: createIdentity(WORKER_MACHINE_ID_PREFIX),
    name: value.name,
    revision: value.revision ?? FIRST_REVISION,
    public_key: value.public_key,
    fingerprint: value.fingerprint,
    created_at: now,
    ended_at: null,
  };
  tx.database
    .prepare(
      `INSERT INTO worker_machine (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      row.id,
      row.name,
      row.revision,
      row.public_key,
      row.fingerprint,
      row.created_at,
    );
  return row;
}

export function endMachine(
  tx: Transaction,
  machineId: string,
  now: number,
): void {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const changed = tx.database
    .prepare(
      "UPDATE worker_machine SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
    )
    .run(now, machineId).changes;
  assert.ok(Number(changed) > NO_ROWS);
}

export function listLiveMachines(
  tx: Transaction,
  filter: { after?: string; limit: number },
): MachineRecord[] {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(filter.limit) && filter.limit > NO_ROWS);
  const clauses = ["ended_at IS NULL"];
  const values: SQLInputValue[] = [];
  if (filter.after !== undefined) {
    clauses.push("name > ?");
    values.push(filter.after);
  }
  values.push(filter.limit + 1);
  return tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM worker_machine WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT ?`,
    )
    .all(...values)
    .map(record);
}
