import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  DELETE_IDS_MAX,
  IntakeErrorCode,
  OutboundRequestState,
  type OutboundDelete,
  type OutboundRequest,
  type OutboundRequestStateValue,
} from "./contract.ts";
import { discard, findById, outboundRecord } from "./outbound-store.ts";

const EMPTY_LIST_LENGTH = 0;
const EMPTY_TEXT_LENGTH = 0;
const MIN_DELETE_COUNT = 0;

type DeleteFilter =
  | { ids: string[] }
  | { state: OutboundRequestStateValue; from: string; to: string };

function notFound(): never {
  throw new OperationError(
    HttpStatus.NotFound,
    IntakeErrorCode.OutboundRequestNotFound,
    "Outbound request not found.",
  );
}

function filterInvalid(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    IntakeErrorCode.OutboundRequestFilterInvalid,
    "A delete takes either a state other than pending with from and to, or a list of identities.",
  );
}

export function discardOutbound(
  tx: Transaction,
  inFlight: ReadonlySet<string>,
  id: string,
): OutboundRequest {
  assert.ok(id.length > EMPTY_TEXT_LENGTH, "An identity is required.");
  const row = findById(tx, id) ?? notFound();
  if (inFlight.has(id))
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.OutboundRequestInFlight,
      "The call of this outbound request runs.",
    );
  if (row.state !== OutboundRequestState.Pending)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.OutboundRequestStateConflict,
      `An outbound request in the state ${row.state} cannot be discarded.`,
    );
  assert.ok(discard(tx, id), "A pending request turns to discarded.");
  const discarded = findById(tx, id);
  assert.ok(discarded !== null, "A discarded request stays stored.");
  return outboundRecord(discarded);
}

function deleteFilter(body: OutboundDelete): DeleteFilter {
  if (body.force !== true)
    throw new OperationError(
      HttpStatus.BadRequest,
      IntakeErrorCode.OutboundRequestForceRequired,
      "A delete requires force: true.",
    );
  const { state, from, to, ids } = body;
  const rangeFields = [state, from, to].filter((value) => value !== undefined);
  if (ids !== undefined) {
    if (rangeFields.length > EMPTY_LIST_LENGTH) filterInvalid();
    return { ids };
  }
  if (state === undefined || from === undefined || to === undefined)
    filterInvalid();
  if (state === OutboundRequestState.Pending) filterInvalid();
  return { state, from, to };
}

function deleteByIds(tx: Transaction, ids: readonly string[]): number {
  assert.ok(ids.length > EMPTY_LIST_LENGTH, "An identity list is not empty.");
  assert.ok(ids.length <= DELETE_IDS_MAX, "An identity list fits its bound.");
  const marks = ids.map(() => "?").join(", ");
  const pending = tx.database
    .prepare(
      `SELECT id FROM intake_outbound_request WHERE id IN (${marks}) AND state = ? LIMIT 1`,
    )
    .get(...ids, OutboundRequestState.Pending) as { id: string } | undefined;
  if (pending !== undefined)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.OutboundRequestStateConflict,
      `The outbound request ${pending.id} is pending and cannot be deleted.`,
    );
  const changes = tx.database
    .prepare(`DELETE FROM intake_outbound_request WHERE id IN (${marks})`)
    .run(...ids).changes;
  return Number(changes);
}

function deleteByRange(
  tx: Transaction,
  state: OutboundRequestStateValue,
  from: string,
  to: string,
): number {
  assert.notEqual(state, OutboundRequestState.Pending);
  assert.ok(from.length > EMPTY_TEXT_LENGTH && to.length > EMPTY_TEXT_LENGTH);
  const matched = tx.database
    .prepare(
      "SELECT COUNT(*) AS total FROM intake_outbound_request WHERE state = ? AND id >= ? AND id <= ?",
    )
    .get(state, from, to) as { total: number | bigint };
  if (Number(matched.total) > DELETE_IDS_MAX)
    throw new OperationError(
      HttpStatus.BadRequest,
      IntakeErrorCode.OutboundRequestFilterInvalid,
      `A range matches more than ${DELETE_IDS_MAX} outbound requests. Narrow the range.`,
    );
  const changes = tx.database
    .prepare(
      "DELETE FROM intake_outbound_request WHERE state = ? AND id >= ? AND id <= ?",
    )
    .run(state, from, to).changes;
  return Number(changes);
}

export function deleteOutbound(
  tx: Transaction,
  body: OutboundDelete,
): { count: number } {
  assert.ok(tx.database, "A delete runs inside a transaction.");
  const filter = deleteFilter(body);
  const count =
    "ids" in filter
      ? deleteByIds(tx, filter.ids)
      : deleteByRange(tx, filter.state, filter.from, filter.to);
  assert.ok(Number.isSafeInteger(count) && count >= MIN_DELETE_COUNT);
  return { count };
}
