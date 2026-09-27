import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  EdgeKind,
  edgeKindSchema,
  NODE_IDENTITY_PREFIX,
  NODE_LIST_LIMIT_DEFAULT,
  type Edge,
} from "./contract.ts";
import { decode, encode, invalidCursor } from "./node-read.ts";
import { listEdges, type EdgeListFilter, type EdgeRow } from "./store.ts";
import { requireMission } from "./write.ts";

const KEY_SEPARATOR = "|";
const KEY_PARTS = 3;
const FIRST_ROW = 0;
const EXTRA_ROW = 1;

export function edgeCursor(cursor: string): string {
  const value = decode(cursor);
  const parts = value.split(KEY_SEPARATOR);
  const [kind, firstId, secondId] = parts;
  if (
    parts.length !== KEY_PARTS ||
    !edgeKindSchema.safeParse(kind).success ||
    !identitySchema(NODE_IDENTITY_PREFIX).safeParse(firstId).success ||
    !identitySchema(NODE_IDENTITY_PREFIX).safeParse(secondId).success
  )
    invalidCursor();
  return value;
}

function edgeRecord(row: EdgeRow): Edge {
  return row.kind === EdgeKind.Containment
    ? { kind: row.kind, parentId: row.firstId, childId: row.secondId }
    : { kind: row.kind, dependentId: row.firstId, dependsOnId: row.secondId };
}

export function edgePage(
  tx: Transaction,
  missionId: string,
  filter: EdgeListFilter,
  limit = NODE_LIST_LIMIT_DEFAULT,
) {
  requireMission(tx, missionId);
  const rows = listEdges(tx, missionId, filter, limit + EXTRA_ROW);
  const selected = rows.slice(FIRST_ROW, limit);
  assert.ok(selected.length <= limit, "An edge page respects its limit.");
  const last = selected.at(-EXTRA_ROW);
  assert.ok(rows.length <= limit || last, "A continued page has a last edge.");
  return {
    items: selected.map(edgeRecord),
    nextCursor: rows.length > limit ? encode(last!.key) : null,
  };
}
