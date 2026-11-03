import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema, identityTime } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  actorSchema,
  type Finding,
  FINDING_IDENTITY_PREFIX,
  findingSchema,
  FindingSource,
  FindingStatus,
  MissionErrorCode,
  NODE_LIST_LIMIT_DEFAULT,
} from "./contract.ts";
import {
  type FindingRow,
  listFindings,
  listUndecidedFindings,
  type PlacedFindingRow,
  readFinding,
} from "./finding-store.ts";
import { decode, encode, invalidCursor, requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import { readAssessment, readAssessmentRound } from "./record-store.ts";
import { readMissionByProject } from "./store.ts";

const SLICE_FROM_START = 0;
const PAGINATION_LOOKAHEAD = 1;
const LAST_ITEM_OFFSET = 1;

function actorOf(value: string | null) {
  return value === null ? null : actorSchema.parse(JSON.parse(value));
}

export function findingRecord(row: PlacedFindingRow): Finding {
  const human = row.created_by !== null;
  return findingSchema.parse({
    id: row.id,
    node_id: row.node_id,
    attempt: row.attempt,
    round: human ? null : row.round,
    assessment_id: row.assessment_id,
    source: human ? FindingSource.Human : FindingSource.Reviewer,
    label: row.label,
    kind: row.kind,
    action: row.action,
    task_id: row.task_id,
    ground: row.ground,
    name: row.name,
    description: row.description,
    fix: row.fix,
    why: row.why,
    route: row.route,
    status:
      row.fixed_assessment_id === null
        ? FindingStatus.Open
        : FindingStatus.Fixed,
    fixed_assessment_id: row.fixed_assessment_id,
    cause_owner: row.cause_owner,
    created_by: actorOf(row.created_by),
    created_at: identityTime(row.id),
    decision: row.decision,
    decision_reason: row.decision_reason,
    decided_by: actorOf(row.decided_by),
    decided_at: row.decided_at,
  });
}

export function placeFinding(
  tx: Transaction,
  row: FindingRow,
): PlacedFindingRow {
  const assessment = readAssessment(tx, row.assessment_id);
  assert.ok(assessment);
  return {
    ...row,
    attempt: assessment.attempt,
    round: row.created_by === null ? readAssessmentRound(tx, assessment) : null,
  };
}

export function requireFinding(tx: Transaction, id: string): FindingRow {
  const row = readFinding(tx, id);
  if (row === null) recordNotFound();
  return row;
}

export function getFinding(tx: Transaction, id: string): Finding {
  return findingRecord(placeFinding(tx, requireFinding(tx, id)));
}

function findingCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const after = decode(cursor);
  if (!identitySchema(FINDING_IDENTITY_PREFIX).safeParse(after).success)
    invalidCursor();
  return after;
}

function pageOfRows(rows: PlacedFindingRow[], limit: number) {
  const items = rows.slice(SLICE_FROM_START, limit).map(findingRecord);
  return {
    items,
    next_cursor:
      rows.length > limit ? encode(items.at(-LAST_ITEM_OFFSET)!.id) : null,
  };
}

export function findingPage(
  tx: Transaction,
  nodeId: string,
  query: { attempt?: number; round?: number; limit?: number; cursor?: string },
) {
  requireNode(tx, nodeId);
  const after = findingCursor(query.cursor);
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  return pageOfRows(
    listFindings(tx, nodeId, {
      attempt: query.attempt ?? null,
      round: query.round ?? null,
      route: null,
      open: false,
      after,
      count: limit + PAGINATION_LOOKAHEAD,
    }),
    limit,
  );
}

export function undecidedFindingPage(
  tx: Transaction,
  projectId: string,
  query: { limit?: number; cursor?: string },
) {
  const mission = readMissionByProject(tx, projectId);
  if (mission === null)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.MissionNotFound,
      "Mission not found.",
    );
  const after = findingCursor(query.cursor);
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  return pageOfRows(
    listUndecidedFindings(
      tx,
      mission.id,
      after,
      limit + PAGINATION_LOOKAHEAD,
    ).map((row) => placeFinding(tx, row)),
    limit,
  );
}
