import { z } from "zod";
import { type HumanActor, humanActorSchema } from "../kernel/actor.ts";
import { identityTime } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  CleanableKind,
  type CleanupOutcome,
  cleanupOutcomeSchema,
  type CleanupRecord,
  cleanupRuleSchema,
  type CleanupRuleValue,
  CleanupState,
  footprintKeySchema,
} from "./contract.ts";

export interface StoredCleanup {
  readonly cleanup_id: string;
  readonly kind: CleanableKind;
  readonly instance_name: string | null;
  readonly rule: CleanupRuleValue | null;
  readonly keys: readonly string[];
  readonly requested_by: HumanActor;
  readonly state: CleanupState;
  readonly finished_at: number | null;
  readonly outcome: CleanupOutcome | null;
}

interface CleanupRow {
  id: string;
  kind: string;
  instance_name: string | null;
  rule: string | null;
  keys: string;
  requested_by: string;
  state: string;
  finished_at: number | null;
  outcome: string | null;
}

const COLUMNS =
  "id, kind, instance_name, rule, keys, requested_by, state, finished_at, outcome";
const OPEN_STATES = [CleanupState.Queued, CleanupState.Running];

function parsed(row: CleanupRow): StoredCleanup {
  const kind = z.enum(CleanableKind).parse(row.kind);
  return {
    cleanup_id: row.id,
    kind,
    instance_name: row.instance_name,
    rule:
      row.rule === null ? null : cleanupRuleSchema.parse(JSON.parse(row.rule)),
    keys: z.array(footprintKeySchema(kind)).parse(JSON.parse(row.keys)),
    requested_by: humanActorSchema.parse(JSON.parse(row.requested_by)),
    state: z.enum(CleanupState).parse(row.state),
    finished_at: row.finished_at,
    outcome:
      row.outcome === null
        ? null
        : cleanupOutcomeSchema.parse(JSON.parse(row.outcome)),
  };
}

export function resumeIndex(outcome: CleanupOutcome | null): number {
  return outcome === null
    ? 0
    : outcome.removed + outcome.absent + outcome.refused.length;
}

export function cleanupRecord(stored: StoredCleanup): CleanupRecord {
  return {
    cleanup_id: stored.cleanup_id,
    kind: stored.kind,
    instance_name: stored.instance_name,
    rule: stored.rule,
    keys: [...stored.keys],
    requested_by: stored.requested_by,
    requested_at: identityTime(stored.cleanup_id),
    state: stored.state,
    finished_at: stored.finished_at,
    outcome:
      stored.outcome === null
        ? null
        : {
            ...stored.outcome,
            refused: [...stored.outcome.refused],
            pending: stored.keys.length - resumeIndex(stored.outcome),
          },
  };
}

export function insertCleanup(tx: Transaction, cleanup: StoredCleanup): void {
  const kind = z.enum(CleanableKind).parse(cleanup.kind);
  tx.database
    .prepare(
      `INSERT INTO footprint_cleanup (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cleanup.cleanup_id,
      kind,
      cleanup.instance_name,
      cleanup.rule === null
        ? null
        : JSON.stringify(cleanupRuleSchema.parse(cleanup.rule)),
      JSON.stringify(z.array(footprintKeySchema(kind)).parse(cleanup.keys)),
      JSON.stringify(humanActorSchema.parse(cleanup.requested_by)),
      z.enum(CleanupState).parse(cleanup.state),
      cleanup.finished_at,
      cleanup.outcome === null
        ? null
        : JSON.stringify(cleanupOutcomeSchema.parse(cleanup.outcome)),
    );
}

export function cleanupOf(
  tx: Transaction,
  cleanupId: string,
): StoredCleanup | null {
  const row = tx.database
    .prepare(`SELECT ${COLUMNS} FROM footprint_cleanup WHERE id = ?`)
    .get(cleanupId) as CleanupRow | undefined;
  return row === undefined ? null : parsed(row);
}

export function updateCleanup(
  tx: Transaction,
  cleanupId: string,
  state: CleanupState,
  outcome: CleanupOutcome | null,
  finishedAt: number | null,
): void {
  tx.database
    .prepare(
      "UPDATE footprint_cleanup SET state = ?, outcome = ?, finished_at = ? WHERE id = ?",
    )
    .run(
      z.enum(CleanupState).parse(state),
      outcome === null
        ? null
        : JSON.stringify(cleanupOutcomeSchema.parse(outcome)),
      finishedAt,
      cleanupId,
    );
}

export function listCleanups(
  tx: Transaction,
  kind: CleanableKind | null,
  before: string | null,
  limit: number,
): StoredCleanup[] {
  const rows = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM footprint_cleanup WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    )
    .all(kind, kind, before, before, limit) as unknown as CleanupRow[];
  return rows.map(parsed);
}

export function openCleanups(tx: Transaction): StoredCleanup[] {
  const rows = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM footprint_cleanup WHERE state IN (?, ?) ORDER BY id`,
    )
    .all(...OPEN_STATES) as unknown as CleanupRow[];
  return rows.map(parsed);
}

export function completedSince(
  tx: Transaction,
  since: number,
): StoredCleanup[] {
  const rows = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM footprint_cleanup WHERE state = ? AND finished_at >= ?`,
    )
    .all(CleanupState.Completed, since) as unknown as CleanupRow[];
  return rows.map(parsed);
}
