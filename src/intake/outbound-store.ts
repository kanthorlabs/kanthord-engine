import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  OUTBOUND_REQUEST_ID_PREFIX,
  OutboundRequestState,
  RESULT_MAX_BYTES,
  outboundRequestSchema,
  type OutboundOperationValue,
  type OutboundRequest,
  type OutboundRequestStateValue,
} from "./contract.ts";
import { appendError } from "./error-array.ts";

const NO_LENGTH = 0;
const EARLIEST_TIME = 0;
const ONE_ROW = 1;
const KEY_UNIQUE_FAILURE =
  /UNIQUE constraint failed: intake_outbound_request\.operation, intake_outbound_request\.request_key/;
const SUCCEED_SOURCES: readonly OutboundRequestStateValue[] = [
  OutboundRequestState.Pending,
  OutboundRequestState.Failed,
];

export class OutboundKeyConflict extends Error {
  readonly operation: OutboundOperationValue;
  readonly requestKey: string;

  constructor(operation: OutboundOperationValue, requestKey: string) {
    super(`An outbound request of ${operation} already holds this key.`);
    this.name = "OutboundKeyConflict";
    this.operation = operation;
    this.requestKey = requestKey;
  }
}

export interface PendingOutbound {
  project_id: string;
  operation: OutboundOperationValue;
  request_key: string;
  credential: string | null;
  created_at: number;
}

export interface OutboundRow extends PendingOutbound {
  id: string;
  state: OutboundRequestStateValue;
  result: string | null;
  error: string | null;
}

export interface OutboundFailure {
  code: string;
  message: string;
}

export function insertPending(tx: Transaction, row: PendingOutbound): string {
  assert.ok(row.request_key.length > NO_LENGTH, "A request key is required.");
  assert.ok(
    Number.isSafeInteger(row.created_at) && row.created_at >= EARLIEST_TIME,
  );
  const id = createIdentity(OUTBOUND_REQUEST_ID_PREFIX);
  try {
    tx.database
      .prepare(
        `INSERT INTO intake_outbound_request
    (id, project_id, operation, request_key, credential, state, result, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        row.project_id,
        row.operation,
        row.request_key,
        row.credential,
        OutboundRequestState.Pending,
        row.created_at,
      );
  } catch (error) {
    if (error instanceof Error && KEY_UNIQUE_FAILURE.test(error.message))
      throw new OutboundKeyConflict(row.operation, row.request_key);
    throw error;
  }
  return id;
}

export function findByKey(
  tx: Transaction,
  operation: OutboundOperationValue,
  requestKey: string,
): OutboundRow | null {
  assert.ok(requestKey.length > NO_LENGTH, "A request key is required.");
  return (
    (tx.database
      .prepare(
        "SELECT * FROM intake_outbound_request WHERE operation = ? AND request_key = ?",
      )
      .get(operation, requestKey) as OutboundRow | undefined) ?? null
  );
}

export function findById(tx: Transaction, id: string): OutboundRow | null {
  assert.ok(id.length > NO_LENGTH, "An identity is required.");
  return (
    (tx.database
      .prepare("SELECT * FROM intake_outbound_request WHERE id = ?")
      .get(id) as OutboundRow | undefined) ?? null
  );
}

export function outboundRecord(row: OutboundRow): OutboundRequest {
  return outboundRequestSchema.parse({
    id: row.id,
    project_id: row.project_id,
    operation: row.operation,
    request_key: row.request_key,
    state: row.state,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error === null ? null : JSON.parse(row.error),
    created_at: row.created_at,
  });
}

export function succeed(
  tx: Transaction,
  id: string,
  result: unknown,
  expected: readonly OutboundRequestStateValue[],
): boolean {
  assert.ok(
    expected.length > NO_LENGTH,
    "A succeed write requires a source state.",
  );
  assert.ok(
    expected.every((state) => SUCCEED_SOURCES.includes(state)),
    "A succeed write starts only from pending or failed.",
  );
  const stored = canonicalJSON(result);
  assert.ok(
    Buffer.byteLength(stored, "utf8") <= RESULT_MAX_BYTES,
    "A result must fit its byte bound.",
  );
  const sources = expected.map(() => "?").join(", ");
  const changes = tx.database
    .prepare(
      `UPDATE intake_outbound_request SET state = ?, result = ? WHERE id = ? AND state IN (${sources})`,
    )
    .run(OutboundRequestState.Succeeded, stored, id, ...expected).changes;
  return Number(changes) === ONE_ROW;
}

export function fail(
  tx: Transaction,
  id: string,
  item: OutboundFailure,
  now: number,
): boolean {
  assert.ok(Number.isSafeInteger(now) && now >= EARLIEST_TIME);
  const current = tx.database
    .prepare(
      "SELECT error FROM intake_outbound_request WHERE id = ? AND state = ?",
    )
    .get(id, OutboundRequestState.Pending) as
    { error: string | null } | undefined;
  if (current === undefined) return false;
  const error = appendError(current.error, {
    code: item.code,
    message: item.message,
    created_at: now,
  });
  const changes = tx.database
    .prepare(
      "UPDATE intake_outbound_request SET state = ?, error = ? WHERE id = ? AND state = ?",
    )
    .run(
      OutboundRequestState.Failed,
      error,
      id,
      OutboundRequestState.Pending,
    ).changes;
  assert.equal(Number(changes), ONE_ROW, "A failed write changes one row.");
  return true;
}

export function discard(tx: Transaction, id: string): boolean {
  const changes = tx.database
    .prepare(
      "UPDATE intake_outbound_request SET state = ? WHERE id = ? AND state = ?",
    )
    .run(
      OutboundRequestState.Discarded,
      id,
      OutboundRequestState.Pending,
    ).changes;
  return Number(changes) === ONE_ROW;
}
