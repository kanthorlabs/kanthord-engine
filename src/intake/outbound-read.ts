import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  IntakeErrorCode,
  OUTBOUND_LIST_LIMIT_DEFAULT,
  OUTBOUND_REQUEST_ID_PREFIX,
  type OutboundOperationValue,
  type OutboundRequest,
  type OutboundRequestStateValue,
} from "./contract.ts";
import {
  findById,
  outboundRecord,
  type OutboundRow,
} from "./outbound-store.ts";

const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const LOOKAHEAD = 1;
const SLICE_START = 0;
const LAST_OFFSET = 1;

export interface OutboundListQuery {
  project_id?: string;
  state?: OutboundRequestStateValue;
  operation?: OutboundOperationValue;
  limit?: number;
  cursor?: string;
}

export interface OutboundPage {
  items: OutboundRequest[];
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
    !identitySchema(OUTBOUND_REQUEST_ID_PREFIX).safeParse(value).success
  )
    invalidCursor();
  return value;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, TEXT_ENCODING).toString(CURSOR_ENCODING);
}

export function listOutbound(
  tx: Transaction,
  query: OutboundListQuery,
): OutboundPage {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const limit = query.limit ?? OUTBOUND_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      "SELECT * FROM intake_outbound_request WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR operation = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      query.project_id ?? null,
      query.project_id ?? null,
      query.state ?? null,
      query.state ?? null,
      query.operation ?? null,
      query.operation ?? null,
      after,
      after,
      limit + LOOKAHEAD,
    ) as unknown as OutboundRow[];
  const items = rows.slice(SLICE_START, limit).map(outboundRecord);
  return {
    items,
    next_cursor:
      rows.length > limit ? encodeCursor(items.at(-LAST_OFFSET)!.id) : null,
  };
}

export function getOutbound(tx: Transaction, id: string): OutboundRequest {
  const row = findById(tx, id);
  if (row === null)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.OutboundRequestNotFound,
      "Outbound request not found.",
    );
  return outboundRecord(row);
}
