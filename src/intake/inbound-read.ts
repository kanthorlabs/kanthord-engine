import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  INBOUND_ID_PREFIX,
  INBOUND_LIST_LIMIT_DEFAULT,
  InboundKind,
  IntakeErrorCode,
  WEBHOOK_ADDRESS_PREFIX,
  webhookInboundSchema,
  type Inbound,
  type InboundKindValue,
  type InboundPlatformValue,
  type WebhookInbound,
} from "./contract.ts";
import {
  inboundRecord,
  readInbound,
  type InboundRow,
} from "./inbound-store.ts";
import { webhookSecret } from "./webhook-secret.ts";

const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const LOOKAHEAD = 1;
const SLICE_START = 0;
const LAST_OFFSET = 1;

export interface InboundListQuery {
  project_id?: string;
  kind?: InboundKindValue;
  platform?: InboundPlatformValue;
  limit?: number;
  cursor?: string;
}

export interface InboundPage {
  items: Inbound[];
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
    !identitySchema(INBOUND_ID_PREFIX).safeParse(value).success
  )
    invalidCursor();
  return value;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, TEXT_ENCODING).toString(CURSOR_ENCODING);
}

export function listInbound(
  tx: Transaction,
  query: InboundListQuery,
): InboundPage {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const limit = query.limit ?? INBOUND_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      "SELECT * FROM intake_inbound WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR kind = ?) AND (? IS NULL OR platform = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      query.project_id ?? null,
      query.project_id ?? null,
      query.kind ?? null,
      query.kind ?? null,
      query.platform ?? null,
      query.platform ?? null,
      after,
      after,
      limit + LOOKAHEAD,
    ) as unknown as InboundRow[];
  const items = rows.slice(SLICE_START, limit).map(inboundRecord);
  return {
    items,
    next_cursor:
      rows.length > limit ? encodeCursor(items.at(-LAST_OFFSET)!.id) : null,
  };
}

export function getInbound(
  tx: Transaction,
  masterKey: string,
  id: string,
): Inbound | WebhookInbound {
  const row = readInbound(tx, id);
  if (row === null)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.InboundNotFound,
      "Inbound not found.",
    );
  const inbound = inboundRecord(row);
  if (inbound.kind !== InboundKind.Webhook) return inbound;
  return webhookInboundSchema.parse({
    ...inbound,
    address: `${WEBHOOK_ADDRESS_PREFIX}${inbound.id}`,
    secret: webhookSecret(masterKey, inbound.id),
  });
}
