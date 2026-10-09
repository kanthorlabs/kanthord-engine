import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { configurationSchemaOf } from "./configuration.ts";
import {
  INBOUND_ID_PREFIX,
  InboundEventState,
  InboundKind,
  inboundSchema,
  type ConsumerValue,
  type Inbound,
  type InboundKindValue,
  type InboundPlatformValue,
} from "./contract.ts";

const EMPTY_TEXT_LENGTH = 0;
const EARLIEST_TIME = 0;
const DELETABLE_PENDING_COUNT = 0;
const ROWS_PER_WRITE = 1;

export interface NewInbound {
  project_id: string;
  kind: InboundKindValue;
  platform: InboundPlatformValue;
  consumer: ConsumerValue;
  credential: string | null;
  configuration: unknown;
  checkpoint: unknown;
  created_at: number;
}

export interface InboundRow {
  id: string;
  project_id: string;
  kind: InboundKindValue;
  platform: InboundPlatformValue;
  consumer: ConsumerValue;
  credential: string | null;
  configuration: string;
  checkpoint: string | null;
  created_at: number;
}

export function allocateInboundId(): string {
  return createIdentity(INBOUND_ID_PREFIX);
}

export function insertInbound(
  tx: Transaction,
  id: string,
  row: NewInbound,
): void {
  assert.ok(id.length > EMPTY_TEXT_LENGTH, "An inbound identity is required.");
  assert.ok(
    Number.isSafeInteger(row.created_at) && row.created_at >= EARLIEST_TIME,
  );
  const configuration = configurationSchemaOf(row.kind, row.platform).parse(
    row.configuration,
  );
  tx.database
    .prepare(
      `INSERT INTO intake_inbound
    (id, project_id, kind, platform, consumer, credential, configuration, checkpoint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.project_id,
      row.kind,
      row.platform,
      row.consumer,
      row.credential,
      canonicalJSON(configuration),
      row.checkpoint === null ? null : canonicalJSON(row.checkpoint),
      row.created_at,
    );
}

export function readInbound(tx: Transaction, id: string): InboundRow | null {
  assert.ok(id.length > EMPTY_TEXT_LENGTH, "An inbound identity is required.");
  return (
    (tx.database
      .prepare("SELECT * FROM intake_inbound WHERE id = ?")
      .get(id) as InboundRow | undefined) ?? null
  );
}

export function writeCheckpoint(
  tx: Transaction,
  id: string,
  text: string,
): void {
  assert.ok(id.length > EMPTY_TEXT_LENGTH, "An inbound identity is required.");
  assert.ok(text.length > EMPTY_TEXT_LENGTH, "A checkpoint is required.");
  const changes = tx.database
    .prepare("UPDATE intake_inbound SET checkpoint = ? WHERE id = ?")
    .run(text, id).changes;
  assert.equal(Number(changes), ROWS_PER_WRITE, "A checkpoint writes one row.");
}

export function pollInboundIds(tx: Transaction): string[] {
  assert.ok(tx.database, "A transaction holds a database.");
  const rows = tx.database
    .prepare("SELECT id FROM intake_inbound WHERE kind = ? ORDER BY id")
    .all(InboundKind.Poll) as { id: string }[];
  const ids = rows.map((row) => row.id);
  assert.ok(ids.every((id) => id.length > EMPTY_TEXT_LENGTH));
  return ids;
}

export function allInbounds(tx: Transaction): InboundRow[] {
  assert.ok(tx.database, "A transaction holds a database.");
  const rows = tx.database
    .prepare("SELECT * FROM intake_inbound ORDER BY id")
    .all() as unknown as InboundRow[];
  assert.ok(rows.every((row) => row.id.length > EMPTY_TEXT_LENGTH));
  return rows;
}

export function inboundRecord(row: InboundRow): Inbound {
  return inboundSchema.parse({
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    platform: row.platform,
    consumer: row.consumer,
    credential: row.credential,
    configuration: JSON.parse(row.configuration),
    checkpoint: row.checkpoint === null ? null : JSON.parse(row.checkpoint),
    created_at: row.created_at,
  });
}

export function pendingEventCount(tx: Transaction, id: string): number {
  const row = tx.database
    .prepare(
      "SELECT COUNT(*) AS total FROM intake_inbound_event WHERE inbound_id = ? AND state = ?",
    )
    .get(id, InboundEventState.Pending) as { total: number | bigint };
  return Number(row.total);
}

export function deleteInbound(tx: Transaction, id: string): boolean {
  assert.equal(
    pendingEventCount(tx, id),
    DELETABLE_PENDING_COUNT,
    "A pending event blocks the delete of its inbound.",
  );
  tx.database
    .prepare("DELETE FROM intake_inbound_event WHERE inbound_id = ?")
    .run(id);
  const changes = tx.database
    .prepare("DELETE FROM intake_inbound WHERE id = ?")
    .run(id).changes;
  return Number(changes) === ROWS_PER_WRITE;
}
