import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { configurationSchemaOf } from "./configuration.ts";
import {
  INBOUND_ID_PREFIX,
  InboundEventState,
  inboundSchema,
  type ConsumerValue,
  type Inbound,
  type InboundKindValue,
  type InboundPlatformValue,
} from "./contract.ts";

const NO_LENGTH = 0;
const EARLIEST_TIME = 0;
const NO_EVENTS = 0;
const ONE_ROW = 1;

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
  assert.ok(id.length > NO_LENGTH, "An inbound identity is required.");
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
  assert.ok(id.length > NO_LENGTH, "An inbound identity is required.");
  return (
    (tx.database
      .prepare("SELECT * FROM intake_inbound WHERE id = ?")
      .get(id) as InboundRow | undefined) ?? null
  );
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
    NO_EVENTS,
    "A pending event blocks the delete of its inbound.",
  );
  tx.database
    .prepare("DELETE FROM intake_inbound_event WHERE inbound_id = ?")
    .run(id);
  const changes = tx.database
    .prepare("DELETE FROM intake_inbound WHERE id = ?")
    .run(id).changes;
  return Number(changes) === ONE_ROW;
}
