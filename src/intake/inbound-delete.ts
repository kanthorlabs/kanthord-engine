import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { IntakeErrorCode } from "./contract.ts";
import {
  deleteInbound,
  pendingEventCount,
  readInbound,
} from "./inbound-store.ts";

const NO_EVENTS = 0;

export function removeInbound(tx: Transaction, id: string): null {
  if (readInbound(tx, id) === null)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.InboundNotFound,
      "Inbound not found.",
    );
  if (pendingEventCount(tx, id) > NO_EVENTS)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.InboundEventsPending,
      "The inbound holds a pending event.",
    );
  assert.ok(deleteInbound(tx, id), "The inbound row must be deleted.");
  return null;
}
