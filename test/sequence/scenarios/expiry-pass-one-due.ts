import type { EventLog } from "../../../src/services/event/index.ts";
import { SqliteEventLog } from "../../../src/services/event/sqlite.ts";
import { SqliteExecution } from "../../../src/services/execution/sqlite.ts";
import {
  expireRuns,
  type ExpiredRun,
} from "../../../src/commands/run/expire-runs.ts";
import type { Transaction } from "../../../src/services/storage/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

function seedDueRun(transaction: Transaction): void {
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
      3,
      3,
      null,
      null,
      fixtureIds.planRevision,
      "[]",
      NOW,
      NOW + 1000,
      "active",
      null,
      null,
    ],
  );
}

export default function expiryPassOneDue(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: readonly ExpiredRun[];
}> {
  const fixture = createMigratedStorage();
  try {
    fixture.storage.transact(seedDueRun);
    const events: EventLog = new SqliteEventLog({
      storage: fixture.storage,
      ids: createMockIdGenerator({
        ulids: ["00000000000000000000000000"],
      }),
    });
    const executionService = new SqliteExecution({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const recorder = recordSeams(
      { execution: executionService, events },
      {
        run_expired: "R",
      },
    );
    const result = fixture.storage.transact((transaction) =>
      expireRuns(
        {
          events: recorder.dependencies.events,
          execution: recorder.dependencies.execution,
          instanceId: INSTANCE,
        },
        transaction,
        { now: NOW },
      ),
    );
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
