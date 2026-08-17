import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SqliteExecution } from "./sqlite.ts";
import { ExecutionError } from "./index.ts";
import type { Transaction } from "../storage/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const AT = NOW + 5000;
const BASE = `sha256:${"0".repeat(64)}`;
const OID40 = "a1".repeat(20);
const OID64 = "a1".repeat(32);

const RUN1 = "01HZY8QF3M4N5P6R7S8T9V0W1A";
const RUN2 = "01HZY8QF3M4N5P6R7S8T9V0W1B";
const RUN3 = "01HZY8QF3M4N5P6R7S8T9V0W1C";
const ATTEMPT1 = "01HZY8QF3M4N5P6R7S8T9V0W1D";
const ATTEMPT2 = "01HZY8QF3M4N5P6R7S8T9V0W1E";

type BuildResult = {
  storage: import("../storage/index.ts").Storage;
  execution: SqliteExecution;
  dispose(): void;
};

function build(ulids: readonly string[]): BuildResult {
  const temporary = createMigratedStorage();
  temporary.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedSiblingTask(transaction);
  });
  return {
    storage: temporary.storage,
    execution: new SqliteExecution({
      ids: createMockIdGenerator({ ulids }),
    }),
    dispose: temporary.dispose,
  };
}

function insertWorkspaceForTask(
  transaction: Transaction,
  nodeId: string,
): void {
  transaction.run(
    "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.workspace,
      nodeId,
      fixtureIds.repository,
      "tasks/task",
      BASE,
      BASE,
      fixtureIds.profileBlob,
      "coding/v1",
      null,
      "ready",
      1,
    ],
  );
}

function insertInternalRun(
  transaction: Transaction,
  id: string,
  nodeId: string,
  parentRunId: string | null,
): void {
  transaction.run(
    "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      "task",
      nodeId,
      parentRunId,
      fixtureIds.workspace,
      "general@1",
      1,
      3,
      BASE,
      null,
      "active",
      null,
      null,
    ],
  );
}

function insertExternalAttempt(
  transaction: Transaction,
  id: string,
  runId: string,
  attemptNo: number,
): void {
  transaction.run(
    "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'external', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
    [id, runId, attemptNo],
  );
}

function assertConstraint(work: () => unknown, pattern: RegExp): void {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof Error, "expected an Error");
    assert.equal(
      ((error as { errcode?: number }).errcode ?? 0) & 0xff,
      19,
      "expected a constraint error",
    );
    assert.match(error.message, pattern);
    return true;
  });
}

function assertExecutionError(
  work: () => unknown,
  code: "run-not-found" | "run-not-active" | "attempt-not-open",
): void {
  assert.throws(work, (error: unknown) => {
    if (!(error instanceof ExecutionError)) {
      throw error;
    }
    assert.equal(error.code, code);
    return true;
  });
}

const objectiveRunInput = {
  nodeId: fixtureIds.objective,
  kind: "objective" as const,
  parentRunId: null,
  leaseFence: 1,
  attemptLimit: 3,
};

describe("src/services/execution/sqlite.test", () => {
  it("openRun writes an external objective run with null workspace, worker and base oid", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        assert.equal(record.id, `run_${RUN1}`);
        assert.equal(record.kind, "objective");
        assert.equal(record.nodeId, fixtureIds.objective);
        assert.equal(record.parentRunId, null);
        assert.equal(record.driver, "external");
        assert.equal(record.leaseFence, 1);
        assert.equal(record.attemptLimit, 3);
        assert.equal(record.state, "active");
        assert.equal(record.outcome, null);
        assert.equal(record.headOid, null);
        assert.equal(record.endedAt, null);
        const row = transaction.get(
          "SELECT driver, workspace_id, worker, base_oid, kind, parent_run_id, lease_fence, attempt_limit, state, head_oid, outcome, ended_at FROM run WHERE id = ?",
          [record.id],
        ) as Readonly<Record<string, unknown>>;
        assert.equal(row.driver, "external");
        assert.equal(row.workspace_id, null);
        assert.equal(row.worker, null);
        assert.equal(row.base_oid, null);
        assert.equal(row.kind, "objective");
        assert.equal(row.parent_run_id, null);
        assert.equal(row.lease_fence, 1);
        assert.equal(row.attempt_limit, 3);
        assert.equal(row.state, "active");
        assert.equal(row.head_oid, null);
        assert.equal(row.outcome, null);
        assert.equal(row.ended_at, null);
      });
    } finally {
      dispose();
    }
  });

  it("openRun writes an external task run whose parent_run_id names the objective run", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        assert.equal(taskRun.kind, "task");
        assert.equal(taskRun.parentRunId, objectiveRun.id);
        const row = transaction.get(
          "SELECT kind, parent_run_id FROM run WHERE id = ?",
          [taskRun.id],
        ) as Readonly<Record<string, unknown>>;
        assert.equal(row.kind, "task");
        assert.equal(row.parent_run_id, objectiveRun.id);
      });
    } finally {
      dispose();
    }
  });

  it("openRun refuses an objective run that names a parent run", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        assertConstraint(
          () =>
            execution.openRun(transaction, {
              nodeId: fixtureIds.task,
              kind: "objective",
              parentRunId: objectiveRun.id,
              leaseFence: 1,
              attemptLimit: 3,
            }),
          /CHECK constraint failed/,
        );
      });
    } finally {
      dispose();
    }
  });

  it("activeRunOfNode returns the one active run or null", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        assert.equal(
          execution.activeRunOfNode(transaction, fixtureIds.objective),
          null,
        );
        const record = execution.openRun(transaction, objectiveRunInput);
        const active = execution.activeRunOfNode(
          transaction,
          fixtureIds.objective,
        );
        assert.ok(active !== null);
        assert.equal(active.id, record.id);
        assert.equal(active.state, "active");
        execution.endRun(transaction, {
          runId: record.id,
          outcome: "expired",
          at: AT,
        });
        assert.equal(
          execution.activeRunOfNode(transaction, fixtureIds.objective),
          null,
        );
      });
    } finally {
      dispose();
    }
  });

  it("a second active run on one node is refused", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2, RUN3]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        assertConstraint(
          () =>
            execution.openRun(transaction, {
              nodeId: fixtureIds.task,
              kind: "task",
              parentRunId: objectiveRun.id,
              leaseFence: 1,
              attemptLimit: 3,
            }),
          /UNIQUE constraint failed/,
        );
      });
    } finally {
      dispose();
    }
  });

  it("adoptRun moves the lease fence and opens no second run", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        const adopted = execution.adoptRun(transaction, {
          runId: record.id,
          leaseFence: 7,
        });
        assert.equal(adopted.leaseFence, 7);
        assert.equal(adopted.id, record.id);
        const count = transaction.get(
          "SELECT COUNT(*) AS n FROM run WHERE node_id = ?",
          [fixtureIds.objective],
        ) as { n: number };
        assert.equal(count.n, 1);
        const active = execution.activeRunOfNode(
          transaction,
          fixtureIds.objective,
        );
        assert.ok(active !== null);
        assert.equal(active.leaseFence, 7);
      });
    } finally {
      dispose();
    }
  });

  it("adoptRun on an ended run raises run-not-active", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        execution.endRun(transaction, {
          runId: record.id,
          outcome: "expired",
          at: AT,
        });
        assertExecutionError(
          () =>
            execution.adoptRun(transaction, {
              runId: record.id,
              leaseFence: 2,
            }),
          "run-not-active",
        );
      });
    } finally {
      dispose();
    }
  });

  it("endRun writes the outcome and the end instant", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        const ended = execution.endRun(transaction, {
          runId: record.id,
          outcome: "expired",
          at: AT,
        });
        assert.equal(ended.state, "ended");
        assert.equal(ended.outcome, "expired");
        assert.equal(ended.endedAt, AT);
        const row = transaction.get(
          "SELECT state, outcome, ended_at FROM run WHERE id = ?",
          [record.id],
        ) as Readonly<Record<string, unknown>>;
        assert.equal(row.state, "ended");
        assert.equal(row.outcome, "expired");
        assert.equal(row.ended_at, AT);
      });
    } finally {
      dispose();
    }
  });

  it("endRun on an ended run raises run-not-active", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        execution.endRun(transaction, {
          runId: record.id,
          outcome: "expired",
          at: AT,
        });
        assertExecutionError(
          () =>
            execution.endRun(transaction, {
              runId: record.id,
              outcome: "expired",
              at: AT,
            }),
          "run-not-active",
        );
      });
    } finally {
      dispose();
    }
  });

  it("openAttempt mints attempt_no 1 on an empty run, then 2", () => {
    const { storage, execution, dispose } = build([
      RUN1,
      RUN2,
      ATTEMPT1,
      ATTEMPT2,
    ]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        const first = execution.openAttempt(transaction, {
          runId: taskRun.id,
        });
        assert.equal(first.id, `attempt_${ATTEMPT1}`);
        assert.equal(first.runId, taskRun.id);
        assert.equal(first.driver, "external");
        assert.equal(first.attemptNo, 1);
        assert.equal(first.headOid, null);
        assert.equal(first.outcome, null);
        assert.equal(first.endedAt, null);
        const second = execution.openAttempt(transaction, {
          runId: taskRun.id,
        });
        assert.equal(second.id, `attempt_${ATTEMPT2}`);
        assert.equal(second.attemptNo, 2);
        for (const [id, attemptNo] of [
          [first.id, 1],
          [second.id, 2],
        ] as const) {
          const row = transaction.get(
            "SELECT driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid FROM attempt WHERE id = ?",
            [id],
          ) as Readonly<Record<string, unknown>>;
          assert.equal(row.driver, "external");
          assert.equal(row.attempt_no, attemptNo);
          assert.equal(row.provider_id, null);
          assert.equal(row.provider_model, null);
          assert.equal(row.timeout_ms, null);
          assert.equal(row.base_oid, null);
        }
      });
    } finally {
      dispose();
    }
  });

  it("openAttempt reads the number from the rows", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2, ATTEMPT1]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        insertExternalAttempt(transaction, "attempt_seeded", taskRun.id, 5);
        const next = execution.openAttempt(transaction, { runId: taskRun.id });
        assert.equal(next.attemptNo, 6);
      });
    } finally {
      dispose();
    }
  });

  it("closeAttempt writes the outcome and the end instant, and refuses a second close", () => {
    const { storage, execution, dispose } = build([
      RUN1,
      RUN2,
      ATTEMPT1,
      ATTEMPT2,
    ]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        const attempt = execution.openAttempt(transaction, {
          runId: taskRun.id,
        });
        const closed = execution.closeAttempt(transaction, {
          attemptId: attempt.id,
          outcome: "cancelled",
          at: AT,
        });
        assert.equal(closed.outcome, "cancelled");
        assert.equal(closed.endedAt, AT);
        const row = transaction.get(
          "SELECT outcome, ended_at FROM attempt WHERE id = ?",
          [attempt.id],
        ) as Readonly<Record<string, unknown>>;
        assert.equal(row.outcome, "cancelled");
        assert.equal(row.ended_at, AT);
        assertExecutionError(
          () =>
            execution.closeAttempt(transaction, {
              attemptId: attempt.id,
              outcome: "cancelled",
              at: AT,
            }),
          "attempt-not-open",
        );
      });
    } finally {
      dispose();
    }
  });

  it("attemptsOfRun returns every attempt ordered by attempt_no", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        insertExternalAttempt(transaction, "attempt_seeded_c", taskRun.id, 3);
        insertExternalAttempt(transaction, "attempt_seeded_a", taskRun.id, 1);
        insertExternalAttempt(transaction, "attempt_seeded_b", taskRun.id, 2);
        const attempts = execution.attemptsOfRun(transaction, taskRun.id);
        assert.deepEqual(
          attempts.map((attempt) => attempt.attemptNo),
          [1, 2, 3],
        );
        assert.deepEqual(
          attempts.map((attempt) => attempt.id),
          ["attempt_seeded_a", "attempt_seeded_b", "attempt_seeded_c"],
        );
        for (const attempt of attempts) {
          assert.equal(attempt.runId, taskRun.id);
          assert.equal(attempt.driver, "external");
          assert.equal(attempt.headOid, null);
          assert.equal(attempt.outcome, null);
          assert.equal(attempt.endedAt, null);
        }
      });
    } finally {
      dispose();
    }
  });

  it("stampRunHead writes head_oid on an active run and moves no other column", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        const before = transaction.get("SELECT * FROM run WHERE id = ?", [
          record.id,
        ]) as Readonly<Record<string, unknown>>;
        execution.stampRunHead(transaction, {
          runId: record.id,
          headOid: OID40,
        });
        const after = transaction.get("SELECT * FROM run WHERE id = ?", [
          record.id,
        ]) as Readonly<Record<string, unknown>>;
        assert.equal(after.head_oid, OID40);
        for (const column of Object.keys(before)) {
          if (column === "head_oid") {
            continue;
          }
          assert.deepEqual(after[column], before[column]);
        }
      });
    } finally {
      dispose();
    }
  });

  it("stampRunHead accepts a 64-character object id", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        execution.stampRunHead(transaction, {
          runId: record.id,
          headOid: OID64,
        });
        const row = transaction.get("SELECT head_oid FROM run WHERE id = ?", [
          record.id,
        ]) as Readonly<{ head_oid: string | null }>;
        assert.equal(row.head_oid, OID64);
      });
    } finally {
      dispose();
    }
  });

  it("stampRunHead refuses an ended run", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        const record = execution.openRun(transaction, objectiveRunInput);
        execution.endRun(transaction, {
          runId: record.id,
          outcome: "expired",
          at: AT,
        });
        const before = transaction.get("SELECT * FROM run WHERE id = ?", [
          record.id,
        ]) as Readonly<Record<string, unknown>>;
        assertExecutionError(
          () =>
            execution.stampRunHead(transaction, {
              runId: record.id,
              headOid: OID40,
            }),
          "run-not-active",
        );
        const after = transaction.get("SELECT * FROM run WHERE id = ?", [
          record.id,
        ]) as Readonly<Record<string, unknown>>;
        assert.deepEqual(after, before);
      });
    } finally {
      dispose();
    }
  });

  it("stampRunHead refuses an unknown run id", () => {
    const { storage, execution, dispose } = build([RUN1]);
    try {
      storage.transact((transaction) => {
        assertExecutionError(
          () =>
            execution.stampRunHead(transaction, {
              runId: "run_unknown",
              headOid: OID40,
            }),
          "run-not-active",
        );
      });
    } finally {
      dispose();
    }
  });

  it("latestRunOfNode returns the run with the greatest id", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2]);
    try {
      storage.transact((transaction) => {
        const first = execution.openRun(transaction, objectiveRunInput);
        assert.equal(
          execution.latestRunOfNode(transaction, fixtureIds.objective)?.id,
          first.id,
        );
        execution.endRun(transaction, {
          runId: first.id,
          outcome: "expired",
          at: AT,
        });
        const ended = execution.latestRunOfNode(
          transaction,
          fixtureIds.objective,
        );
        assert.ok(ended !== null);
        assert.equal(ended.id, first.id);
        assert.equal(ended.state, "ended");
        const second = execution.openRun(transaction, objectiveRunInput);
        const latest = execution.latestRunOfNode(
          transaction,
          fixtureIds.objective,
        );
        assert.ok(latest !== null);
        assert.equal(latest.id, second.id);
      });
    } finally {
      dispose();
    }
  });

  it("latestRunOfNode returns null for a node with no run", () => {
    const { storage, execution, dispose } = build([]);
    try {
      storage.transact((transaction) => {
        assert.equal(
          execution.latestRunOfNode(transaction, fixtureIds.objective),
          null,
        );
      });
    } finally {
      dispose();
    }
  });

  it("latestRunOfNode returns the ended run after the close", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2]);
    try {
      storage.transact((transaction) => {
        const first = execution.openRun(transaction, objectiveRunInput);
        execution.endRun(transaction, {
          runId: first.id,
          outcome: "expired",
          at: AT,
        });
        const second = execution.openRun(transaction, objectiveRunInput);
        execution.stampRunHead(transaction, {
          runId: second.id,
          headOid: OID40,
        });
        execution.endRun(transaction, {
          runId: second.id,
          outcome: "done",
          at: AT,
        });
        const latest = execution.latestRunOfNode(
          transaction,
          fixtureIds.objective,
        );
        assert.ok(latest !== null);
        assert.equal(latest.id, second.id);
        assert.equal(latest.state, "ended");
        assert.equal(latest.headOid, OID40);
      });
    } finally {
      dispose();
    }
  });

  it("attemptsOfRun returns head_oid", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2, ATTEMPT1]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRun = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        const attempt = execution.openAttempt(transaction, {
          runId: taskRun.id,
        });
        transaction.run("UPDATE attempt SET head_oid = ? WHERE id = ?", [
          OID40,
          attempt.id,
        ]);
        execution.closeAttempt(transaction, {
          attemptId: attempt.id,
          outcome: "accepted",
          at: AT,
        });
        const attempts = execution.attemptsOfRun(transaction, taskRun.id);
        assert.equal(attempts.length, 1);
        const closed = attempts[0];
        assert.ok(closed !== undefined);
        assert.equal(closed.id, attempt.id);
        assert.equal(closed.headOid, OID40);
      });
    } finally {
      dispose();
    }
  });

  it("runDriversUnderObjective returns every driver under the objective, ended runs included", () => {
    const { storage, execution, dispose } = build([RUN1, RUN2, RUN3]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        const taskRunA = execution.openRun(transaction, {
          nodeId: fixtureIds.task,
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        execution.openRun(transaction, {
          nodeId: "task_b",
          kind: "task",
          parentRunId: objectiveRun.id,
          leaseFence: 1,
          attemptLimit: 3,
        });
        execution.endRun(transaction, {
          runId: taskRunA.id,
          outcome: "expired",
          at: AT,
        });
        assert.deepEqual(
          execution.runDriversUnderObjective(transaction, fixtureIds.objective),
          ["external", "external", "external"],
        );
        insertWorkspaceForTask(transaction, fixtureIds.task);
        insertInternalRun(
          transaction,
          "run_0000000000000000000000000000",
          fixtureIds.task,
          objectiveRun.id,
        );
        assert.deepEqual(
          execution.runDriversUnderObjective(transaction, fixtureIds.objective),
          ["internal", "external", "external", "external"],
        );
      });
    } finally {
      dispose();
    }
  });

  it("runDriversUnderObjective returns an empty list for an objective with no run", () => {
    const { storage, execution, dispose } = build([]);
    try {
      storage.transact((transaction) => {
        assert.deepEqual(
          execution.runDriversUnderObjective(transaction, fixtureIds.objective),
          [],
        );
      });
    } finally {
      dispose();
    }
  });

  it("an external attempt under an internal run is refused", () => {
    const { storage, execution, dispose } = build([RUN1, ATTEMPT1]);
    try {
      storage.transact((transaction) => {
        const objectiveRun = execution.openRun(transaction, objectiveRunInput);
        insertWorkspaceForTask(transaction, fixtureIds.task);
        insertInternalRun(
          transaction,
          "run_internal",
          fixtureIds.task,
          objectiveRun.id,
        );
        assertConstraint(
          () => execution.openAttempt(transaction, { runId: "run_internal" }),
          /FOREIGN KEY constraint failed/,
        );
      });
    } finally {
      dispose();
    }
  });

  it("SqliteExecution reads no clock", () => {
    const source = readFileSync(
      new URL("./sqlite.ts", import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("Date.now("));
    assert.ok(!source.includes("new Date("));
    assert.ok(!/from\s+["']\.\.\/clock\//.test(source));
  });

  it("no node column holds an attempt count", () => {
    const { storage, dispose } = build([]);
    try {
      const columns = storage.transact((transaction) =>
        transaction.all("PRAGMA table_info(node)"),
      ) as readonly Readonly<Record<string, unknown>>[];
      for (const column of columns) {
        assert.ok(
          !String(column.name).includes("attempt"),
          `column ${String(column.name)} holds an attempt count`,
        );
      }
    } finally {
      dispose();
    }
  });
});
