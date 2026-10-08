import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  INBOUND_EVENT_ID_PREFIX,
  InboundEventState,
  inboundEventSchema,
  type ErrorItem,
  type InboundEvent,
  type InboundEventStateValue,
} from "./contract.ts";
import { appendError } from "./error-array.ts";

const NO_LENGTH = 0;
const EARLIEST_TIME = 0;
const ONE_ROW = 1;

export interface NewInboundEvent {
  inbound_id: string;
  event_id: string;
  event: Uint8Array;
  metadata: unknown;
  created_at: number;
}

export const EVENT_PROJECTION_COLUMNS =
  "id, inbound_id, event_id, metadata, state, error, created_at";

export interface InboundEventProjectionRow {
  id: string;
  inbound_id: string;
  event_id: string;
  metadata: string;
  state: InboundEventStateValue;
  error: string | null;
  created_at: number;
}

export interface InboundEventRow extends InboundEventProjectionRow {
  event: Uint8Array;
}

export function findEvent(
  tx: Transaction,
  inboundId: string,
  eventId: string,
): string | null {
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  assert.ok(eventId.length > NO_LENGTH, "An event identity is required.");
  const row = tx.database
    .prepare(
      "SELECT id FROM intake_inbound_event WHERE inbound_id = ? AND event_id = ?",
    )
    .get(inboundId, eventId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function insertEvent(tx: Transaction, input: NewInboundEvent): string {
  assert.ok(input.inbound_id.length > NO_LENGTH, "An inbound is required.");
  assert.ok(
    input.event_id.length > NO_LENGTH,
    "An event identity is required.",
  );
  assert.ok(
    Number.isSafeInteger(input.created_at) && input.created_at >= EARLIEST_TIME,
  );
  const id = createIdentity(INBOUND_EVENT_ID_PREFIX);
  tx.database
    .prepare(
      `INSERT INTO intake_inbound_event
    (id, inbound_id, event_id, event, metadata, state, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.inbound_id,
      input.event_id,
      input.event,
      canonicalJSON(input.metadata),
      InboundEventState.Pending,
      input.created_at,
    );
  return id;
}

export function readEvent(tx: Transaction, id: string): InboundEventRow | null {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  return (
    (tx.database
      .prepare("SELECT * FROM intake_inbound_event WHERE id = ?")
      .get(id) as InboundEventRow | undefined) ?? null
  );
}

export function readEventProjection(
  tx: Transaction,
  id: string,
): InboundEventProjectionRow | null {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  return (
    (tx.database
      .prepare(
        `SELECT ${EVENT_PROJECTION_COLUMNS} FROM intake_inbound_event WHERE id = ?`,
      )
      .get(id) as InboundEventProjectionRow | undefined) ?? null
  );
}

export function pendingCount(tx: Transaction): number {
  const row = tx.database
    .prepare(
      "SELECT COUNT(*) AS total FROM intake_inbound_event WHERE state = ?",
    )
    .get(InboundEventState.Pending) as { total: number | bigint };
  return Number(row.total);
}

export function oldestPendingEvent(
  tx: Transaction,
  excluded: ReadonlySet<string>,
): string | null {
  const exclusion = canonicalJSON([...excluded].sort());
  assert.ok(exclusion.length > NO_LENGTH, "An exclusion encodes to JSON.");
  const row = tx.database
    .prepare(
      `SELECT id FROM intake_inbound_event
    WHERE state = ? AND id NOT IN (SELECT value FROM json_each(?))
    ORDER BY id LIMIT 1`,
    )
    .get(InboundEventState.Pending, exclusion) as { id: string } | undefined;
  return row?.id ?? null;
}

export function eventState(
  tx: Transaction,
  id: string,
): InboundEventStateValue | null {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  const row = tx.database
    .prepare("SELECT state FROM intake_inbound_event WHERE id = ?")
    .get(id) as { state: InboundEventStateValue } | undefined;
  return row?.state ?? null;
}

export function succeedEvent(tx: Transaction, id: string): boolean {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  const changes = tx.database
    .prepare(
      "UPDATE intake_inbound_event SET state = ? WHERE id = ? AND state = ?",
    )
    .run(InboundEventState.Succeeded, id, InboundEventState.Pending).changes;
  assert.ok(Number(changes) <= ONE_ROW, "A write changes at most one row.");
  return Number(changes) === ONE_ROW;
}

export function failEvent(
  tx: Transaction,
  id: string,
  item: ErrorItem,
): boolean {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  assert.ok(Number.isSafeInteger(item.created_at));
  const current = tx.database
    .prepare(
      "SELECT error FROM intake_inbound_event WHERE id = ? AND state = ?",
    )
    .get(id, InboundEventState.Pending) as { error: string | null } | undefined;
  if (current === undefined) return false;
  const changes = tx.database
    .prepare(
      "UPDATE intake_inbound_event SET state = ?, error = ? WHERE id = ? AND state = ?",
    )
    .run(
      InboundEventState.Failed,
      appendError(current.error, item),
      id,
      InboundEventState.Pending,
    ).changes;
  assert.equal(Number(changes), ONE_ROW, "A failed write changes one row.");
  return true;
}

export function eventRecord(row: InboundEventProjectionRow): InboundEvent {
  return inboundEventSchema.parse({
    id: row.id,
    inbound_id: row.inbound_id,
    event_id: row.event_id,
    metadata: JSON.parse(row.metadata),
    state: row.state,
    error: row.error === null ? null : JSON.parse(row.error),
    created_at: row.created_at,
  });
}
