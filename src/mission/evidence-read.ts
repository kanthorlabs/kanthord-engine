import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { NODE_LIST_LIMIT_DEFAULT } from "./contract.ts";
import { requireRunnable } from "./control.ts";
import { decode, encode, invalidCursor, requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import { evidenceRecord } from "./record-read.ts";
import { listEvidence, readEvidence } from "./record-store.ts";

const SLICE_FROM_START = 0;
const PAGINATION_LOOKAHEAD = 1;
const LAST_ITEM_OFFSET = 1;

export function evidenceCursor(cursor?: string): string | null {
  if (cursor === undefined) return null;
  const id = decode(cursor);
  if (!identitySchema("evidence").safeParse(id).success) invalidCursor();
  return id;
}

export function evidencePage(
  tx: Transaction,
  nodeId: string,
  query: { attempt?: number; limit?: number; cursor?: string },
) {
  requireRunnable(requireNode(tx, nodeId));
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = listEvidence(
    tx,
    nodeId,
    query.attempt ?? null,
    evidenceCursor(query.cursor),
    limit + PAGINATION_LOOKAHEAD,
  );
  const items = rows
    .slice(SLICE_FROM_START, limit)
    .map((row) => evidenceRecord(tx, row));
  return {
    items,
    next_cursor:
      rows.length > limit ? encode(items.at(-LAST_ITEM_OFFSET)!.id) : null,
  };
}

export function getEvidence(tx: Transaction, evidenceId: string) {
  const row = readEvidence(tx, evidenceId);
  if (!row) recordNotFound();
  return evidenceRecord(tx, row);
}
