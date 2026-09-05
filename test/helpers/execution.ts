import type { RunDriver } from "../../src/domain/run.ts";
import { accountAttempts } from "../../src/domain/attempt-accounting.ts";
import type { AttemptOutcome } from "../../src/domain/attempt.ts";
import type { IdGenerator } from "../../src/services/ids/index.ts";
import type {
  AttemptRecord,
  CloseAttemptInput,
  EndRunInput,
  Execution,
  ExpireDueRun,
  ExpireDueRunsInput,
  OpenAttemptInput,
  OpenRunInput,
  RunKind,
  RunRecord,
  StampRunHeadInput,
} from "../../src/services/execution/index.ts";
import { ExecutionError } from "../../src/services/execution/index.ts";
import type { AdoptRunInput } from "../../src/services/execution/index.ts";
import type { Transaction } from "../../src/services/storage/index.ts";

export type ExecutionFake = Readonly<{
  execution: Execution;
  attemptsByRun: Map<string, readonly AttemptRecord[]>;
  endRunCalls: readonly EndRunInput[];
  closeAttemptCalls: readonly CloseAttemptInput[];
  attemptsOfRunCalls: readonly string[];
  unexpectedCalls: readonly string[];
}>;

export function createExecutionFake(): ExecutionFake {
  const attemptsByRun = new Map<string, readonly AttemptRecord[]>();
  const endRunCalls: EndRunInput[] = [];
  const closeAttemptCalls: CloseAttemptInput[] = [];
  const attemptsOfRunCalls: string[] = [];
  const unexpectedCalls: string[] = [];

  const unexpected = (name: string): never => {
    unexpectedCalls.push(name);
    throw new Error(`unexpected execution call: ${name}`);
  };

  const execution: Execution = {
    openRun(_transaction: Transaction, _input: OpenRunInput): never {
      return unexpected("openRun");
    },
    expireDueRuns(
      _transaction: Transaction,
      _input: ExpireDueRunsInput,
    ): readonly ExpireDueRun[] {
      return [];
    },
    activeRunOfNode(_transaction: Transaction, _nodeId: string): never {
      return unexpected("activeRunOfNode");
    },
    activeRunsOfNodes(
      _transaction: Transaction,
      _nodeIds: readonly string[],
    ): never {
      return unexpected("activeRunsOfNodes");
    },
    runById(_transaction: Transaction, _runId: string): never {
      return unexpected("runById");
    },
    renewRun(
      _transaction: Transaction,
      _input: Readonly<{ runId: string; expiresAt: number }>,
    ): never {
      return unexpected("renewRun");
    },
    adoptRun(_transaction: Transaction, _input: unknown): never {
      return unexpected("adoptRun");
    },
    endRun(_transaction: Transaction, input: EndRunInput) {
      endRunCalls.push(input);
      return {
        id: input.runId,
        kind: "execution",
        nodeId: "",
        driver: "external",
        workspaceId: null,
        worker: "",
        fence: 0,
        attemptLimit: 0,
        headOid: null,
        judgedOid: null,
        graphRevision: null,
        agents: [],
        expiresAt: input.at,
        maxLifetimeAt: input.at,
        state: "ended",
        outcome: input.outcome,
        endedAt: input.at,
      };
    },
    stampRunHead(_transaction: Transaction, _input: unknown): never {
      return unexpected("stampRunHead");
    },
    latestRunOfNode(_transaction: Transaction, _nodeId: string): never {
      return unexpected("latestRunOfNode");
    },
    openAttempt(_transaction: Transaction, _input: OpenAttemptInput): never {
      return unexpected("openAttempt");
    },
    closeAttempt(_transaction: Transaction, input: CloseAttemptInput) {
      closeAttemptCalls.push(input);
      return {
        id: input.attemptId,
        runId: "",
        driver: "external",
        attemptNo: 1,
        headOid: null,
        outcome: input.outcome,
        endedAt: input.at,
      };
    },
    attemptsOfRun(
      _transaction: Transaction,
      runId: string,
    ): readonly AttemptRecord[] {
      attemptsOfRunCalls.push(runId);
      return attemptsByRun.get(runId) ?? [];
    },
    runDriversUnderObjective(
      _transaction: Transaction,
      _objectiveId: string,
    ): readonly RunDriver[] {
      return unexpected("runDriversUnderObjective");
    },
  };

  return {
    execution,
    attemptsByRun,
    endRunCalls,
    closeAttemptCalls,
    attemptsOfRunCalls,
    unexpectedCalls,
  };
}

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
  head_oid: string | null;
  judged_oid: string | null;
  graph_revision: string | null;
  agents_json: string;
  expires_at: number;
  max_lifetime_at: number;
  state: "active" | "ended";
  outcome: string | null;
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

export type BackedExecutionFake = Readonly<{
  execution: Execution;
  openRunCalls: readonly OpenRunInput[];
  adoptRunCalls: readonly AdoptRunInput[];
  openAttemptCalls: readonly OpenAttemptInput[];
  activeRunOfNodeCalls: readonly string[];
  attemptsOfRunCalls: readonly string[];
  runDriversUnderObjectiveCalls: readonly string[];
  endRunCalls: readonly EndRunInput[];
  closeAttemptCalls: readonly CloseAttemptInput[];
}>;

// A hand-written Execution implementation backed by the real SQLite rows, for
// command tests that must assert real run and attempt rows without reaching
// the service implementation. Mirrors the statements of
// src/services/execution/sqlite.ts, including attempt numbering through
// accountAttempts over the rows of one run.
export function createBackedExecutionFake(
  dependencies: Readonly<{ ids: IdGenerator }>,
): BackedExecutionFake {
  const openRunCalls: OpenRunInput[] = [];
  const adoptRunCalls: AdoptRunInput[] = [];
  const openAttemptCalls: OpenAttemptInput[] = [];
  const activeRunOfNodeCalls: string[] = [];
  const attemptsOfRunCalls: string[] = [];
  const runDriversUnderObjectiveCalls: string[] = [];
  const endRunCalls: EndRunInput[] = [];
  const closeAttemptCalls: CloseAttemptInput[] = [];

  const attemptsOfRun = (
    transaction: Transaction,
    runId: string,
  ): readonly AttemptRecord[] => {
    attemptsOfRunCalls.push(runId);
    const rows = transaction.all(
      `SELECT ${ATTEMPT_COLUMNS}
FROM attempt
WHERE run_id = ?
ORDER BY attempt_no ASC`,
      [runId],
    ) as readonly AttemptRow[];
    return rows.map(toAttemptRecord);
  };

  const execution: Execution = {
    openRun(transaction: Transaction, input: OpenRunInput): RunRecord {
      openRunCalls.push(input);
      const id = dependencies.ids.mint("run");
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
    },
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
    },
    activeRunOfNode(
      transaction: Transaction,
      nodeId: string,
    ): RunRecord | null {
      activeRunOfNodeCalls.push(nodeId);
      const row = transaction.get(
        `SELECT ${RUN_COLUMNS}
FROM run
WHERE node_id = ? AND state = 'active'`,
        [nodeId],
      ) as RunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },
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
    },
    runById(transaction: Transaction, runId: string): RunRecord | null {
      const row = transaction.get(
        `SELECT ${RUN_COLUMNS}
FROM run
WHERE id = ?`,
        [runId],
      ) as RunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },
    renewRun(
      transaction: Transaction,
      input: Readonly<{ runId: string; expiresAt: number }>,
    ): RunRecord {
      const rows = transaction.all(
        `UPDATE run SET expires_at = ?
WHERE id = ?
RETURNING ${RUN_COLUMNS}`,
        [input.expiresAt, input.runId],
      ) as readonly RunRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new ExecutionError(
          "run-not-found",
          `run ${input.runId} is not found`,
        );
      }
      return toRunRecord(row);
    },
    adoptRun(transaction: Transaction, input: AdoptRunInput): RunRecord {
      adoptRunCalls.push(input);
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
    },
    endRun(transaction: Transaction, input: EndRunInput): RunRecord {
      endRunCalls.push(input);
      const rows = transaction.all(
        `UPDATE run SET state = 'ended', fence = fence + 1, outcome = ?, ended_at = ?
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
    },
    stampRunHead(transaction: Transaction, input: StampRunHeadInput): void {
      const rows = transaction.all(
        `UPDATE run SET head_oid = ?
WHERE id = ? AND ended_at IS NULL
RETURNING id`,
        [input.headOid, input.runId],
      ) as readonly Readonly<{ id: string }>[];
      if (rows.length === 0) {
        throw new ExecutionError(
          "run-not-active",
          `run ${input.runId} is not active`,
        );
      }
    },
    latestRunOfNode(
      transaction: Transaction,
      nodeId: string,
    ): RunRecord | null {
      const row = transaction.get(
        `SELECT ${RUN_COLUMNS}
FROM run
WHERE node_id = ?
ORDER BY id DESC
LIMIT 1`,
        [nodeId],
      ) as RunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },
    openAttempt(
      transaction: Transaction,
      input: OpenAttemptInput,
    ): AttemptRecord {
      openAttemptCalls.push(input);
      const run = transaction.get(
        "SELECT attempt_limit FROM run WHERE id = ?",
        [input.runId],
      ) as Readonly<{ attempt_limit: number }> | undefined;
      if (run === undefined) {
        throw new ExecutionError(
          "run-not-found",
          `run ${input.runId} is not found`,
        );
      }
      const attempts = attemptsOfRun(transaction, input.runId);
      const accounting = accountAttempts({
        attempts,
        limit: run.attempt_limit,
      });
      const id = dependencies.ids.mint("attempt");
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
    },
    closeAttempt(
      transaction: Transaction,
      input: CloseAttemptInput,
    ): AttemptRecord {
      closeAttemptCalls.push(input);
      const headOid =
        "headOid" in input ? (input.headOid as string | null) : null;
      const rows = transaction.all(
        `UPDATE attempt SET outcome = ?, head_oid = ?, ended_at = ?
WHERE id = ? AND outcome IS NULL
RETURNING ${ATTEMPT_COLUMNS}`,
        [input.outcome, headOid, input.at, input.attemptId],
      ) as readonly AttemptRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new ExecutionError(
          "attempt-not-open",
          `attempt ${input.attemptId} is not open`,
        );
      }
      return toAttemptRecord(row);
    },
    attemptsOfRun,
    runDriversUnderObjective(
      transaction: Transaction,
      objectiveId: string,
    ): readonly RunDriver[] {
      runDriversUnderObjectiveCalls.push(objectiveId);
      const rows = transaction.all(
        `SELECT r.driver
FROM run r
JOIN node n ON n.id = r.node_id
WHERE r.node_id = ? OR n.parent_id = ?
ORDER BY r.id`,
        [objectiveId, objectiveId],
      ) as readonly Readonly<{ driver: RunDriver }>[];
      return rows.map((row) => row.driver);
    },
  };

  return {
    execution,
    openRunCalls,
    adoptRunCalls,
    openAttemptCalls,
    activeRunOfNodeCalls,
    attemptsOfRunCalls,
    runDriversUnderObjectiveCalls,
    endRunCalls,
    closeAttemptCalls,
  };
}
