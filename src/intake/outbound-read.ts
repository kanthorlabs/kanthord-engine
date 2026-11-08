import type { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import type { ExternalLink } from "../kernel/external-link.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  IntakeErrorCode,
  OUTBOUND_LIST_LIMIT_DEFAULT,
  OUTBOUND_REQUEST_ID_PREFIX,
  type OutboundOperationValue,
  type OutboundRequest,
  OutboundRequestState,
  type OutboundRequestStateValue,
  REPLY_OPERATIONS,
  replyAccountSchema,
  type replyMatchSchema,
  replyResultSchema,
} from "./contract.ts";
import {
  findById,
  findByKeySuffix,
  outboundRecord,
  type OutboundRow,
} from "./outbound-store.ts";

const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const LOOKAHEAD = 1;
const SLICE_START = 0;
const LAST_OFFSET = 1;
const NO_PENDING = 0;

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

function accountOf(row: OutboundRow): string | null {
  if (row.result === null) return null;
  const result = JSON.parse(row.result);
  const posted = replyResultSchema.safeParse(result);
  if (posted.success) return posted.data.actor_id;
  const recorded = replyAccountSchema.safeParse(result);
  return recorded.success ? recorded.data.actor_id : null;
}

function byCreation(left: OutboundRow, right: OutboundRow): number {
  return left.created_at - right.created_at || (left.id < right.id ? -1 : 1);
}

export function matchReply(
  tx: Transaction,
  input: { update_key: string; external_link: ExternalLink },
): z.output<typeof replyMatchSchema> {
  const succeeded =
    tx.database
      .prepare(
        "SELECT 1 AS found FROM intake_outbound_request WHERE operation IN (SELECT value FROM json_each(?)) AND state = ? AND json_extract(result, '$.update_key') = ? LIMIT 1",
      )
      .get(
        JSON.stringify(REPLY_OPERATIONS),
        OutboundRequestState.Succeeded,
        input.update_key,
      ) !== undefined;
  const link = REPLY_OPERATIONS.flatMap((operation) =>
    findByKeySuffix(tx, operation, `:${canonicalJSON(input.external_link)}`),
  ).sort(byCreation);
  const pending = link.filter(
    (row) => row.state === OutboundRequestState.Pending,
  );
  const account = link
    .filter((row) => row.state === OutboundRequestState.Succeeded)
    .map(accountOf)
    .at(-LAST_OFFSET);
  const actors =
    pending.length === NO_PENDING
      ? []
      : account !== undefined && account !== null
        ? [account]
        : pending.map(accountOf).filter((actor) => actor !== null);
  return { succeeded, pending_actor_ids: [...new Set(actors)] };
}
