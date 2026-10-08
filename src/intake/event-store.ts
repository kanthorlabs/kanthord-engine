import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  INBOUND_EVENT_ID_PREFIX,
  InboundEventState,
  inboundEventSchema,
  type InboundEvent,
  type InboundEventStateValue,
} from "./contract.ts";

const NO_LENGTH = 0;
const EARLIEST_TIME = 0;

export interface NewInboundEvent {
  inbound_id: string;
  event_id: string;
  event: Uint8Array;
  metadata: unknown;
  created_at: number;
}

export interface InboundEventRow {
  id: string;
  inbound_id: string;
  event_id: string;
  event: Uint8Array;
  metadata: string;
  state: InboundEventStateValue;
  error: string | null;
  created_at: number;
}

export function findEvent(
  tx: Transaction,
  inboundId: string,
  eventId: string,
): InboundEventRow | null {
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  assert.ok(eventId.length > NO_LENGTH, "An event identity is required.");
  return (
    (tx.database
      .prepare(
        "SELECT * FROM intake_inbound_event WHERE inbound_id = ? AND event_id = ?",
      )
      .get(inboundId, eventId) as InboundEventRow | undefined) ?? null
  );
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

export function pendingCount(tx: Transaction): number {
  const row = tx.database
    .prepare(
      "SELECT COUNT(*) AS total FROM intake_inbound_event WHERE state = ?",
    )
    .get(InboundEventState.Pending) as { total: number | bigint };
  return Number(row.total);
}

export function eventRecord(row: InboundEventRow): InboundEvent {
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
