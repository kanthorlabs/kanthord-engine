import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Dependencies } from "./service.ts";
import {
  NODE_LIST_LIMIT_DEFAULT,
  actionKeySchema,
  type MissionBindings,
  type ExternalAction,
} from "./contract.ts";
import { requireRunnable } from "./control.ts";
import { requireNode, decode, encode, invalidCursor } from "./node-read.ts";
import {
  attemptRecord,
  externalActionRecords,
  assessmentRecord,
  outcomeRecord,
} from "./record-read.ts";
import { listAttempts, readAttempt, type AttemptRow } from "./record-store.ts";
import {
  readAssessment,
  readOutcome,
  type AssessmentRow,
  type OutcomeRow,
} from "./record-store.ts";

type RecordQuery = { attempt?: number; limit?: number; cursor?: string };

function identityCursor(
  cursor: string | undefined,
  prefix: string,
): string | null {
  if (cursor === undefined) return null;
  const id = decode(cursor);
  if (!identitySchema(prefix).safeParse(id).success) invalidCursor();
  return id;
}

export function getAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  id: string,
) {
  const row = readAssessment(tx, id);
  if (row === null) recordNotFound();
  return assessmentRecord(tx, dependencies, row);
}

export function getOutcome(
  tx: Transaction,
  dependencies: Dependencies,
  id: string,
) {
  const row = readOutcome(tx, id);
  if (row === null) recordNotFound();
  return outcomeRecord(tx, dependencies.bindings, row);
}

export function assessmentPage(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  query: RecordQuery,
) {
  requireRunnable(requireNode(tx, nodeId));
  const after = identityCursor(query.cursor, "assessment");
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      "SELECT * FROM mission_assessment WHERE node_id = ? AND (? IS NULL OR attempt = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      nodeId,
      query.attempt ?? null,
      query.attempt ?? null,
      after,
      after,
      limit + PAGINATION_LOOKAHEAD,
    ) as unknown as AssessmentRow[];
  const items = rows
    .slice(SLICE_FROM_START, limit)
    .map((row) => assessmentRecord(tx, dependencies, row));
  return {
    items,
    next_cursor:
      rows.length > limit ? encode(items.at(-LAST_ITEM_OFFSET)!.id) : null,
  };
}

export function outcomePage(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  query: RecordQuery,
) {
  requireRunnable(requireNode(tx, nodeId));
  const after = identityCursor(query.cursor, "outcome");
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = tx.database
    .prepare(
      "SELECT o.* FROM mission_outcome o JOIN mission_assessment a ON a.id = o.assessment_id WHERE o.node_id = ? AND (? IS NULL OR a.attempt = ?) AND (? IS NULL OR o.id < ?) ORDER BY o.id DESC LIMIT ?",
    )
    .all(
      nodeId,
      query.attempt ?? null,
      query.attempt ?? null,
      after,
      after,
      limit + PAGINATION_LOOKAHEAD,
    ) as unknown as OutcomeRow[];
  const items = rows
    .slice(SLICE_FROM_START, limit)
    .map((row) => outcomeRecord(tx, dependencies.bindings, row));
  return {
    items,
    next_cursor:
      rows.length > limit ? encode(items.at(-LAST_ITEM_OFFSET)!.id) : null,
  };
}

const SLICE_FROM_START = 0;
const ATTEMPT_LOWER_BOUND = 0;
const NO_ROWS = 0;
const FIRST_CURSOR_PART = 0;
const SORT_EQUAL = 0;
const PAGINATION_LOOKAHEAD = 1;
const LAST_ITEM_OFFSET = 1;
const ATTEMPT_STEP = 1;
const MINIMUM_ATTEMPT = 1;
const CURSOR_KEY_PART = 1;
const SORT_AFTER = 1;
const CURSOR_PARTS = 2;
const RECORD_NOT_FOUND = "mission.record.not_found";
const ATTEMPT_BATCH_SIZE = 64;

function* actionCandidates(
  tx: Transaction,
  nodeId: string,
  bound: number,
  filter: number | undefined,
): Generator<AttemptRow> {
  assert.ok(Number.isSafeInteger(bound) && bound >= ATTEMPT_LOWER_BOUND);
  assert.ok(tx.database.isTransaction);
  let upper = bound;
  for (let pass = ATTEMPT_LOWER_BOUND; pass < bound; pass++) {
    const rows = tx.database
      .prepare(
        "SELECT * FROM mission_attempt WHERE node_id = ? AND (? IS NULL OR attempt = ?) AND attempt <= ? ORDER BY attempt DESC LIMIT ?",
      )
      .all(
        nodeId,
        filter ?? null,
        filter ?? null,
        upper,
        ATTEMPT_BATCH_SIZE,
      ) as unknown as AttemptRow[];
    if (rows.length === NO_ROWS) return;
    yield* rows;
    const next = rows.at(-LAST_ITEM_OFFSET)!.attempt - ATTEMPT_STEP;
    assert.ok(next < upper);
    upper = next;
    if (rows.length < ATTEMPT_BATCH_SIZE || upper === ATTEMPT_LOWER_BOUND)
      return;
  }
}
export function recordNotFound(): never {
  throw new OperationError(
    HttpStatus.NotFound,
    RECORD_NOT_FOUND,
    "Mission record not found.",
  );
}

function attemptCursor(cursor: string): number {
  const value = decode(cursor);
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < MINIMUM_ATTEMPT ||
    String(number) !== value
  )
    invalidCursor();
  return number;
}

export function attemptPage(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  query: { limit?: number; cursor?: string },
) {
  requireRunnable(requireNode(tx, nodeId));
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = listAttempts(
    tx,
    nodeId,
    query.cursor === undefined ? null : attemptCursor(query.cursor),
    limit + PAGINATION_LOOKAHEAD,
  );
  const items = rows
    .slice(SLICE_FROM_START, limit)
    .map((row) => attemptRecord(tx, bindings, row));
  return {
    items,
    next_cursor:
      rows.length > limit
        ? encode(String(items.at(-LAST_ITEM_OFFSET)!.attempt))
        : null,
  };
}

export function getAttempt(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
) {
  requireRunnable(requireNode(tx, nodeId));
  const row = readAttempt(tx, nodeId, attempt);
  if (row === null) recordNotFound();
  return attemptRecord(tx, bindings, row);
}

export function getExternalAction(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
  key: string,
) {
  getAttempt(tx, bindings, nodeId, attempt);
  const record = externalActionRecords(tx, bindings, nodeId, attempt).find(
    (item) => item.action.key === key,
  );
  if (record === undefined) recordNotFound();
  return record;
}

function actionCursor(cursor: string): { attempt: number; key: string } {
  const parts = decode(cursor).split("|");
  if (
    parts.length !== CURSOR_PARTS ||
    !actionKeySchema.safeParse(parts[CURSOR_KEY_PART]).success
  )
    invalidCursor();
  return {
    attempt: attemptCursor(encode(parts[FIRST_CURSOR_PART]!)),
    key: parts[CURSOR_KEY_PART]!,
  };
}

export function externalActionPage(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  query: { attempt?: number; limit?: number; cursor?: string },
) {
  const node = requireNode(tx, nodeId);
  requireRunnable(node);
  const after = query.cursor === undefined ? null : actionCursor(query.cursor);
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const attempts = actionCandidates(
    tx,
    nodeId,
    Math.min(node.attempt!, after?.attempt ?? node.attempt!),
    query.attempt,
  );
  const records: ExternalAction[] = [];
  for (const attempt of attempts) {
    const actions = externalActionRecords(
      tx,
      bindings,
      nodeId,
      attempt.attempt,
    ).sort((a, b) =>
      a.action.key < b.action.key
        ? SORT_AFTER
        : a.action.key > b.action.key
          ? -SORT_AFTER
          : SORT_EQUAL,
    );
    records.push(
      ...actions.filter(
        (item) =>
          after === null ||
          item.attempt < after.attempt ||
          (item.attempt === after.attempt && item.action.key < after.key),
      ),
    );
    if (records.length > limit) break;
  }
  const items = records.slice(SLICE_FROM_START, limit);
  const last = items.at(-LAST_ITEM_OFFSET);
  return {
    items,
    next_cursor:
      records.length > limit && last !== undefined
        ? encode(`${last.attempt}|${last.action.key}`)
        : null,
  };
}
