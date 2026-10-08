import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  DELETE_IDS_MAX,
  InboundEventState,
  IntakeErrorCode,
  type InboundEvent,
  type InboundEventDelete,
  type InboundEventStateValue,
} from "./contract.ts";
import {
  deleteEventsInRange,
  deleteSettledEvents,
  discardEventFrom,
  eventRecord,
  pendingEventAmong,
  readEventProjection,
  retryFailedEvent,
  type InboundEventProjectionRow,
} from "./event-store.ts";

const NO_LENGTH = 0;
const MIN_DELETE_COUNT = 0;

type DeleteFilter =
  | { ids: string[] }
  | { state: InboundEventStateValue; from: string; to: string };

function stored(tx: Transaction, id: string): InboundEventProjectionRow {
  const row = readEventProjection(tx, id);
  if (row === null)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.InboundEventNotFound,
      "Inbound event not found.",
    );
  return row;
}

function stateConflict(state: InboundEventStateValue, verb: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    IntakeErrorCode.InboundEventStateConflict,
    `An inbound event in the state ${state} cannot be ${verb}.`,
  );
}

function current(tx: Transaction, id: string): InboundEvent {
  const row = readEventProjection(tx, id);
  assert.ok(row !== null, "A written event stays stored.");
  return eventRecord(row);
}

export function retryEvent(tx: Transaction, id: string): InboundEvent {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  const row = stored(tx, id);
  if (row.state === InboundEventState.Pending) return eventRecord(row);
  if (row.state !== InboundEventState.Failed)
    stateConflict(row.state, "retried");
  assert.ok(retryFailedEvent(tx, id), "A failed event turns to pending.");
  return current(tx, id);
}

export function discardEvent(
  tx: Transaction,
  inFlight: (id: string) => boolean,
  id: string,
): InboundEvent {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  const row = stored(tx, id);
  if (row.state === InboundEventState.Pending && inFlight(id))
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.InboundEventInFlight,
      "The handoff of this inbound event runs.",
    );
  if (
    row.state !== InboundEventState.Pending &&
    row.state !== InboundEventState.Failed
  )
    stateConflict(row.state, "discarded");
  assert.ok(
    discardEventFrom(tx, id, row.state),
    "A pending or a failed event turns to discarded.",
  );
  return current(tx, id);
}

function filterInvalid(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    IntakeErrorCode.InboundEventFilterInvalid,
    "A delete takes either a state other than pending with from and to, or a list of identities.",
  );
}

function deleteFilter(body: InboundEventDelete): DeleteFilter {
  const { state, from, to, ids } = body;
  const rangeFields = [state, from, to].filter((value) => value !== undefined);
  if (ids !== undefined) {
    if (rangeFields.length > NO_LENGTH) filterInvalid();
    return { ids };
  }
  if (state === undefined || from === undefined || to === undefined)
    filterInvalid();
  if (state === InboundEventState.Pending) filterInvalid();
  return { state, from, to };
}

function deleteByIds(tx: Transaction, ids: readonly string[]): number {
  assert.ok(ids.length > NO_LENGTH, "An identity list is not empty.");
  assert.ok(ids.length <= DELETE_IDS_MAX, "An identity list fits its bound.");
  const pending = pendingEventAmong(tx, ids);
  if (pending !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.InboundEventStateConflict,
      `The inbound event ${pending} is pending and cannot be deleted.`,
    );
  return deleteSettledEvents(tx, ids);
}

export function deleteEvents(
  tx: Transaction,
  body: InboundEventDelete,
): { count: number } {
  assert.ok(tx.database, "A delete runs inside a transaction.");
  const filter = deleteFilter(body);
  const count =
    "ids" in filter
      ? deleteByIds(tx, filter.ids)
      : deleteEventsInRange(tx, filter.state, filter.from, filter.to);
  assert.ok(Number.isSafeInteger(count) && count >= MIN_DELETE_COUNT);
  return { count };
}
