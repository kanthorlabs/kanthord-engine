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
      limit + ONE,
    ) as unknown as AssessmentRow[];
  const items = rows
    .slice(ZERO, limit)
    .map((row) => assessmentRecord(tx, dependencies, row));
  return {
    items,
    nextCursor: rows.length > limit ? encode(items.at(-ONE)!.id) : null,
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
      limit + ONE,
    ) as unknown as OutcomeRow[];
  const items = rows
    .slice(ZERO, limit)
    .map((row) => outcomeRecord(tx, dependencies.bindings, row));
  return {
    items,
    nextCursor: rows.length > limit ? encode(items.at(-ONE)!.id) : null,
  };
}

const ZERO = 0;
const ONE = 1;
const CURSOR_PARTS = 2;
const RECORD_NOT_FOUND = "mission.record.not_found";
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
  if (!Number.isSafeInteger(number) || number < ONE || String(number) !== value)
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
    limit + ONE,
  );
  const items = rows
    .slice(ZERO, limit)
    .map((row) => attemptRecord(tx, bindings, row));
  return {
    items,
    nextCursor:
      rows.length > limit ? encode(String(items.at(-ONE)!.attempt)) : null,
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
    !actionKeySchema.safeParse(parts[ONE]).success
  )
    invalidCursor();
  return { attempt: attemptCursor(encode(parts[ZERO]!)), key: parts[ONE]! };
}

export function externalActionPage(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  query: { attempt?: number; limit?: number; cursor?: string },
) {
  requireRunnable(requireNode(tx, nodeId));
  const after = query.cursor === undefined ? null : actionCursor(query.cursor);
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const attempts = tx.database
    .prepare(
      "SELECT * FROM mission_attempt WHERE node_id = ? AND (? IS NULL OR attempt = ?) ORDER BY attempt DESC",
    )
    .all(
      nodeId,
      query.attempt ?? null,
      query.attempt ?? null,
    ) as unknown as AttemptRow[];
  const records: ExternalAction[] = [];
  for (const attempt of attempts) {
    const actions = externalActionRecords(
      tx,
      bindings,
      nodeId,
      attempt.attempt,
    ).sort((a, b) =>
      a.action.key < b.action.key
        ? ONE
        : a.action.key > b.action.key
          ? -ONE
          : ZERO,
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
  const items = records.slice(ZERO, limit);
  const last = items.at(-ONE);
  return {
    items,
    nextCursor:
      records.length > limit && last !== undefined
        ? encode(`${last.attempt}|${last.action.key}`)
        : null,
  };
}
