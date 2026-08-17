import { accountAttempts } from "../../domain/attempt-accounting.ts";
import type { AttemptOutcome } from "../../domain/attempt.ts";
import type { RunDriver } from "../../domain/run.ts";
import type { IdGenerator } from "../ids/index.ts";
import type { Transaction } from "../storage/index.ts";
import {
  ExecutionError,
  type AdoptRunInput,
  type AttemptRecord,
  type CloseAttemptInput,
  type EndRunInput,
  type Execution,
  type OpenAttemptInput,
  type OpenRunInput,
  type RunKind,
  type RunRecord,
  type StampRunHeadInput,
} from "./index.ts";

const RUN_COLUMNS =
  "id, kind, node_id, parent_run_id, driver, lease_fence, attempt_limit, state, outcome, head_oid, ended_at";

const ATTEMPT_COLUMNS =
  "id, run_id, driver, attempt_no, head_oid, outcome, ended_at";

type RunRow = Readonly<{
  id: string;
  kind: RunKind;
  node_id: string;
  parent_run_id: string | null;
  driver: RunDriver;
  lease_fence: number;
  attempt_limit: number;
  state: "active" | "ended";
  outcome: string | null;
  head_oid: string | null;
  ended_at: number | null;
}>;

type AttemptRow = Readonly<{
  id: string;
  run_id: string;
  driver: RunDriver;
  attempt_no: number;
  head_oid: string | null;
  outcome: AttemptOutcome | null;
  ended_at: number | null;
}>;

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    nodeId: row.node_id,
    parentRunId: row.parent_run_id,
    driver: row.driver,
    leaseFence: row.lease_fence,
    attemptLimit: row.attempt_limit,
    state: row.state,
    outcome: row.outcome,
    headOid: row.head_oid,
    endedAt: row.ended_at,
  };
}

function toAttemptRecord(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    driver: row.driver,
    attemptNo: row.attempt_no,
    headOid: row.head_oid,
    outcome: row.outcome,
    endedAt: row.ended_at,
  };
}

export class SqliteExecution implements Execution {
  private readonly ids: IdGenerator;

  constructor(dependencies: Readonly<{ ids: IdGenerator }>) {
    this.ids = dependencies.ids;
  }

  openRun(transaction: Transaction, input: OpenRunInput): RunRecord {
    const id = this.ids.mint("run");
    transaction.run(
      `INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at)
VALUES (?, ?, ?, ?, 'external', NULL, NULL, ?, ?, NULL, NULL, 'active', NULL, NULL)`,
      [
        id,
        input.kind,
        input.nodeId,
        input.parentRunId,
        input.leaseFence,
        input.attemptLimit,
      ],
    );
    return {
      id,
      kind: input.kind,
      nodeId: input.nodeId,
      parentRunId: input.parentRunId,
      driver: "external",
      leaseFence: input.leaseFence,
      attemptLimit: input.attemptLimit,
      state: "active",
      outcome: null,
      headOid: null,
      endedAt: null,
    };
  }

  activeRunOfNode(transaction: Transaction, nodeId: string): RunRecord | null {
    const row = transaction.get(
      `SELECT ${RUN_COLUMNS}
FROM run
WHERE node_id = ? AND state = 'active'`,
      [nodeId],
    ) as RunRow | undefined;
    return row === undefined ? null : toRunRecord(row);
  }

  latestRunOfNode(transaction: Transaction, nodeId: string): RunRecord | null {
    const row = transaction.get(
      `SELECT ${RUN_COLUMNS}
FROM run
WHERE node_id = ?
ORDER BY id DESC LIMIT 1`,
      [nodeId],
    ) as RunRow | undefined;
    return row === undefined ? null : toRunRecord(row);
  }

  adoptRun(transaction: Transaction, input: AdoptRunInput): RunRecord {
    const rows = transaction.all(
      `UPDATE run SET lease_fence = ?
WHERE id = ? AND state = 'active'
RETURNING ${RUN_COLUMNS}`,
      [input.leaseFence, input.runId],
    ) as readonly RunRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new ExecutionError(
        "run-not-active",
        `run ${input.runId} is not active`,
      );
    }
    return toRunRecord(row);
  }

  endRun(transaction: Transaction, input: EndRunInput): RunRecord {
    const rows = transaction.all(
      `UPDATE run SET state = 'ended', outcome = ?, ended_at = ?
WHERE id = ? AND state = 'active'
RETURNING ${RUN_COLUMNS}`,
      [input.outcome, input.at, input.runId],
    ) as readonly RunRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new ExecutionError(
        "run-not-active",
        `run ${input.runId} is not active`,
      );
    }
    return toRunRecord(row);
  }

  stampRunHead(transaction: Transaction, input: StampRunHeadInput): void {
    const rows = transaction.all(
      `UPDATE run SET head_oid = ?
WHERE id = ? AND ended_at IS NULL
RETURNING ${RUN_COLUMNS}`,
      [input.headOid, input.runId],
    ) as readonly RunRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new ExecutionError(
        "run-not-active",
        `run ${input.runId} is not active`,
      );
    }
  }

  openAttempt(
    transaction: Transaction,
    input: OpenAttemptInput,
  ): AttemptRecord {
    const run = transaction.get("SELECT attempt_limit FROM run WHERE id = ?", [
      input.runId,
    ]) as Readonly<{ attempt_limit: number }> | undefined;
    if (run === undefined) {
      throw new ExecutionError(
        "run-not-found",
        `run ${input.runId} is not found`,
      );
    }
    const attempts = this.attemptsOfRun(transaction, input.runId);
    const accounting = accountAttempts({
      attempts,
      limit: run.attempt_limit,
    });
    const id = this.ids.mint("attempt");
    transaction.run(
      `INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at)
VALUES (?, ?, 'external', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [id, input.runId, accounting.nextAttemptNo],
    );
    return {
      id,
      runId: input.runId,
      driver: "external",
      attemptNo: accounting.nextAttemptNo,
      headOid: null,
      outcome: null,
      endedAt: null,
    };
  }

  closeAttempt(
    transaction: Transaction,
    input: CloseAttemptInput,
  ): AttemptRecord {
    const writesHeadOid = input.headOid !== undefined;
    const rows = transaction.all(
      writesHeadOid
        ? `UPDATE attempt SET outcome = ?, head_oid = ?, ended_at = ?
WHERE id = ? AND outcome IS NULL
RETURNING ${ATTEMPT_COLUMNS}`
        : `UPDATE attempt SET outcome = ?, ended_at = ?
WHERE id = ? AND outcome IS NULL
RETURNING ${ATTEMPT_COLUMNS}`,
      writesHeadOid
        ? [input.outcome, input.headOid, input.at, input.attemptId]
        : [input.outcome, input.at, input.attemptId],
    ) as readonly AttemptRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new ExecutionError(
        "attempt-not-open",
        `attempt ${input.attemptId} is not open`,
      );
    }
    return toAttemptRecord(row);
  }

  attemptsOfRun(
    transaction: Transaction,
    runId: string,
  ): readonly AttemptRecord[] {
    const rows = transaction.all(
      `SELECT ${ATTEMPT_COLUMNS}
FROM attempt
WHERE run_id = ?
ORDER BY attempt_no ASC`,
      [runId],
    ) as readonly AttemptRow[];
    return rows.map(toAttemptRecord);
  }

  runDriversUnderObjective(
    transaction: Transaction,
    objectiveId: string,
  ): readonly RunDriver[] {
    const rows = transaction.all(
      `SELECT r.driver
FROM run r
JOIN node n ON n.id = r.node_id
WHERE r.node_id = ? OR n.parent_id = ?
ORDER BY r.id`,
      [objectiveId, objectiveId],
    ) as readonly Readonly<{ driver: RunDriver }>[];
    return rows.map((row) => row.driver);
  }
}
