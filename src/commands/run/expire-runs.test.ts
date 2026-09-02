import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expireRuns,
  type ExpireRunsInput,
  type ExpiredRun,
} from "./expire-runs.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import {
  createMigratedStorage,
  databaseBytes,
} from "../../../test/helpers/database.ts";
import { createBackedExecutionFake } from "../../../test/helpers/execution.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

type RecordingExecution = Readonly<{
  expireDueRuns(
    transaction: Transaction,
    input: ExpireRunsInput,
  ): readonly ExpiredRun[];
}>;

type ExpireRunsWithExecution = Parameters<typeof expireRuns>[0] &
  Readonly<{ execution: RecordingExecution }>;

function expiryDependencies(events: EventLog): ExpireRunsWithExecution {
  return {
    events,
    execution: createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    }).execution,
    instanceId: INSTANCE,
  };
}

function seedExpiredRun(
  storage: Storage,
  expiresAt: number = NOW - 1,
  state: "active" | "ended" = "active",
  fence = 3,
): void {
  storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run_expired",
        "execution",
        fixtureIds.task,
        "external",
        null,
        "claude@1",
        fence,
        3,
        null,
        null,
        fixtureIds.planRevision,
        "[]",
        expiresAt,
        NOW + 1000,
        state,
        null,
        null,
      ],
    );
  });
}

describe("src/commands/run/expire-runs.test", () => {
  it("the fence rises by exactly one", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(expired, [
        { runId: "run_expired", nodeId: fixtureIds.task, fence: 4 },
      ]);
      const row = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT fence, state, outcome, ended_at FROM run WHERE id = ?",
          ["run_expired"],
        ),
      ) as Readonly<{
        fence: number;
        state: string;
        outcome: string;
        ended_at: number;
      }>;
      assert.equal(row.fence, 4);
      assert.equal(row.state, "ended");
      assert.equal(row.outcome, "expired");
      assert.equal(row.ended_at, NOW);
    } finally {
      fixture.dispose();
    }
  });

  it("a second call raises nothing and appends nothing", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );
      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(expired, []);
      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT fence FROM run WHERE id = ?", ["run_expired"]),
      ) as Readonly<{ fence: number }>;
      assert.equal(row.fence, 4);
      assert.equal(events.list({ type: "run.expired" }).length, 1);
    } finally {
      fixture.dispose();
    }
  });

  it("a run whose expires_at is exactly now is expired", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage, NOW);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(expired, [
        { runId: "run_expired", nodeId: fixtureIds.task, fence: 4 },
      ]);
      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT fence, state FROM run WHERE id = ?", [
          "run_expired",
        ]),
      ) as Readonly<{ fence: number; state: string }>;
      assert.equal(row.fence, 4);
      assert.equal(row.state, "ended");
    } finally {
      fixture.dispose();
    }
  });

  it("a run whose expires_at is one millisecond after now is untouched", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage, NOW + 1);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(expired, []);
      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT fence, state FROM run WHERE id = ?", [
          "run_expired",
        ]),
      ) as Readonly<{ fence: number; state: string }>;
      assert.equal(row.fence, 3);
      assert.equal(row.state, "active");
    } finally {
      fixture.dispose();
    }
  });

  it("an already ended run is untouched", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage, NOW - 1000, "ended", 5);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(expired, []);
      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT fence FROM run WHERE id = ?", ["run_expired"]),
      ) as Readonly<{ fence: number }>;
      assert.equal(row.fence, 5);
    } finally {
      fixture.dispose();
    }
  });

  it("one run.expired event is appended per expired run, carrying the raised fence", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000"],
        }),
      });

      fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      const expiredEvents = events.list({ type: "run.expired" });
      assert.equal(expiredEvents.length, 1);
      assert.deepEqual(expiredEvents[0]?.payload, {
        runId: "run_expired",
        nodeId: fixtureIds.task,
        fence: 4,
        expiredAt: NOW,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("two expired runs produce events in bytewise run id order", () => {
    const fixture = createMigratedStorage();
    try {
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        seedSiblingTask(transaction);
        for (const [runId, nodeId] of [
          ["run_b", fixtureIds.task],
          ["run_a", "task_b"],
        ] as const) {
          transaction.run(
            "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              runId,
              "execution",
              nodeId,
              "external",
              null,
              "claude@1",
              3,
              3,
              null,
              null,
              fixtureIds.planRevision,
              "[]",
              NOW - 1,
              NOW + 1000,
              "active",
              null,
              null,
            ],
          );
        }
      });
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({
          ulids: ["00000000000000000000000000", "00000000000000000000000001"],
        }),
      });

      const expired = fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(
        expired.map((run) => run.runId),
        ["run_a", "run_b"],
      );
      assert.deepEqual(
        events.list({ type: "run.expired" }).map((event) => event.subjectId),
        ["run_a", "run_b"],
      );
    } finally {
      fixture.dispose();
    }
  });

  it("a failure injected at the event append leaves the run active and the fence unchanged", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const before = databaseBytes(fixture.storage);
      const events: EventLog = {
        append() {
          throw new Error("append refused");
        },
        list() {
          return [];
        },
      } as unknown as EventLog;

      assert.throws(
        () =>
          fixture.storage.transact((transaction) =>
            expireRuns(
              {
                events,
                execution: createBackedExecutionFake({
                  ids: createMockIdGenerator({ ulids: [] }),
                }).execution,
                instanceId: INSTANCE,
              },
              transaction,
              { now: NOW },
            ),
          ),
        /append refused/,
      );

      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT state, fence FROM run WHERE id = ?", [
          "run_expired",
        ]),
      ) as Readonly<{ state: string; fence: number }>;
      assert.equal(row.state, "active");
      assert.equal(row.fence, 3);
      assert.deepEqual(databaseBytes(fixture.storage), before);
    } finally {
      fixture.dispose();
    }
  });

  it("expireRuns writes no node row", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({ ulids: ["00000000000000000000000000"] }),
      });
      const nodeRows = (): unknown =>
        fixture.storage.transact((transaction) =>
          transaction.all("SELECT id, state, assignment FROM node ORDER BY id"),
        );
      const before = nodeRows();

      fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(nodeRows(), before);
    } finally {
      fixture.dispose();
    }
  });

  it("expireRuns writes no lease row", () => {
    const fixture = createMigratedStorage();
    try {
      seedExpiredRun(fixture.storage);
      const events: EventLog = new SqliteEventLog({
        storage: fixture.storage,
        ids: createMockIdGenerator({ ulids: ["00000000000000000000000000"] }),
      });
      const leaseRows = (): unknown =>
        fixture.storage.transact((transaction) =>
          transaction.all(
            "SELECT * FROM lease ORDER BY subject_kind, subject_id",
          ),
        );
      const before = leaseRows();

      fixture.storage.transact((transaction) =>
        expireRuns(expiryDependencies(events), transaction, { now: NOW }),
      );

      assert.deepEqual(leaseRows(), before);
    } finally {
      fixture.dispose();
    }
  });

  it("calls execution expiry with the caller transaction and now", () => {
    const fixture = createMigratedStorage();
    try {
      let calledTransaction: Transaction | undefined;
      let calledInput: ExpireRunsInput | undefined;
      const execution: RecordingExecution = {
        expireDueRuns(transaction, input) {
          calledTransaction = transaction;
          calledInput = input;
          return [];
        },
      };
      const events: EventLog = {
        append() {
          throw new Error("unexpected event");
        },
        list() {
          return [];
        },
      };
      const dependencies: ExpireRunsWithExecution = {
        events,
        instanceId: INSTANCE,
        execution,
      };

      fixture.storage.transact((transaction) => {
        assert.deepEqual(
          expireRuns(dependencies, transaction, { now: NOW }),
          [],
        );
        assert.strictEqual(calledTransaction, transaction);
        assert.deepEqual(calledInput, { now: NOW });
      });
    } finally {
      fixture.dispose();
    }
  });
});
