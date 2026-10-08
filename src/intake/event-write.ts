import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  InboundEventState,
  IntakeErrorCode,
  type InboundEvent,
  type InboundEventStateValue,
} from "./contract.ts";
import {
  eventRecord,
  readEventProjection,
  retryFailedEvent,
  type InboundEventProjectionRow,
} from "./event-store.ts";

const NO_LENGTH = 0;

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
