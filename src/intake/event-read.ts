import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  INBOUND_EVENT_ID_PREFIX,
  INBOUND_EVENT_LIST_LIMIT_DEFAULT,
  IntakeErrorCode,
  type InboundEvent,
  type InboundEventStateValue,
} from "./contract.ts";
import { eventRecord, readEvent, type InboundEventRow } from "./event-store.ts";

const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const LOOKAHEAD = 1;
const SLICE_START = 0;
const LAST_OFFSET = 1;

export interface EventListQuery {
  inbound_id?: string;
  state?: InboundEventStateValue;
  limit?: number;
  cursor?: string;
}

export interface EventPage {
  items: InboundEvent[];
  next_cursor: string | null;
}

function invalidCursor(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    IntakeErrorCode.CursorInvalid,
    "Cursor is invalid.",
  );
}

function decodeCursor(cursor: string): string {
  const value = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    Buffer.from(value, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor ||
    !identitySchema(INBOUND_EVENT_ID_PREFIX).safeParse(value).success
  )
    invalidCursor();
  return value;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, TEXT_ENCODING).toString(CURSOR_ENCODING);
}

export function listEvents(tx: Transaction, query: EventListQuery): EventPage {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const limit = query.limit ?? INBOUND_EVENT_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      "SELECT * FROM intake_inbound_event WHERE (? IS NULL OR inbound_id = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      query.inbound_id ?? null,
      query.inbound_id ?? null,
      query.state ?? null,
      query.state ?? null,
      after,
      after,
      limit + LOOKAHEAD,
    ) as unknown as InboundEventRow[];
  const items = rows.slice(SLICE_START, limit).map(eventRecord);
  return {
    items,
    next_cursor:
      rows.length > limit ? encodeCursor(items.at(-LAST_OFFSET)!.id) : null,
  };
}

export function getEvent(tx: Transaction, id: string): InboundEvent {
  const row = readEvent(tx, id);
  if (row === null)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.InboundEventNotFound,
      "Inbound event not found.",
    );
  return eventRecord(row);
}
