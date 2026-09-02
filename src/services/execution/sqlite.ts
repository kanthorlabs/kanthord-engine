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
  type ExpireDueRun,
  type ExpireDueRunsInput,
  type Execution,
  type OpenAttemptInput,
  type OpenRunInput,
  type RunKind,
  type RunRecord,
  type StampRunHeadInput,
} from "./index.ts";

const RUN_COLUMNS =
  "id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at";

const ATTEMPT_COLUMNS =
  "id, run_id, driver, attempt_no, head_oid, outcome, ended_at";

type RunRow = Readonly<{
  id: string;
  kind: RunKind;
  node_id: string;
  driver: RunDriver;
  workspace_id: string | null;
  worker: string;
  fence: number;
  attempt_limit: number;
  judged_oid: string | null;
  graph_revision: string | null;
  agents_json: string;
  expires_at: number;
  max_lifetime_at: number;
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
    driver: row.driver,
    workspaceId: row.workspace_id,
    worker: row.worker,
    fence: row.fence,
    attemptLimit: row.attempt_limit,
    headOid: row.head_oid,
    judgedOid: row.judged_oid,
    graphRevision: row.graph_revision,
    agents: JSON.parse(row.agents_json) as readonly string[],
    expiresAt: row.expires_at,
    maxLifetimeAt: row.max_lifetime_at,
    state: row.state,
    outcome: row.outcome,
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
      `INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at)
VALUES (?, ?, ?, 'external', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
      [
        id,
        input.kind,
        input.nodeId,
        input.workspaceId,
        input.worker,
        input.fence,
        input.attemptLimit,
        input.judgedOid,
        input.graphRevision,
        JSON.stringify(input.agents),
        input.expiresAt,
        input.maxLifetimeAt,
      ],
    );
    return {
      id,
      kind: input.kind,
      nodeId: input.nodeId,
      driver: "external",
      workspaceId: input.workspaceId,
      worker: input.worker,
      fence: input.fence,
      attemptLimit: input.attemptLimit,
      headOid: null,
      judgedOid: input.judgedOid,
      graphRevision: input.graphRevision,
      agents: input.agents,
      expiresAt: input.expiresAt,
      maxLifetimeAt: input.maxLifetimeAt,
      state: "active",
      outcome: null,
      endedAt: null,
    };
  }

  expireDueRuns(
    transaction: Transaction,
    input: ExpireDueRunsInput,
  ): readonly ExpireDueRun[] {
    const rows = transaction.all(
      `UPDATE run SET state = 'ended', fence = fence + 1, ended_at = ?, outcome = 'expired'
WHERE state = 'active' AND expires_at <= ?
RETURNING id, node_id, fence`,
      [input.now, input.now],
    ) as readonly Readonly<{
      id: string;
      node_id: string;
      fence: number;
    }>[];
    return [...rows]
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
      )
      .map((row) => ({
        runId: row.id,
        nodeId: row.node_id,
        fence: row.fence,
      }));
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

  activeRunsOfNodes(
    transaction: Transaction,
    nodeIds: readonly string[],
  ): readonly RunRecord[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => "?").join(", ");
    const rows = transaction.all(
      `SELECT ${RUN_COLUMNS}
FROM run
WHERE state = 'active' AND node_id IN (${placeholders})
ORDER BY node_id, id`,
      nodeIds,
    ) as readonly RunRow[];
    return rows.map(toRunRecord);
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
      `UPDATE run SET fence = ?
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
