import type {
  ReleaseNodeDependencies,
  ReleaseNodeResult,
} from "../../../src/commands/node/release-node.ts";
import { releaseNode } from "../../../src/commands/node/release-node.ts";
import { expireRuns } from "../../../src/commands/run/expire-runs.ts";
import { SqliteEventLog } from "../../../src/services/event/sqlite.ts";
import type { EventLog } from "../../../src/services/event/index.ts";
import { SqliteExecution } from "../../../src/services/execution/sqlite.ts";
import { SqliteLease } from "../../../src/services/lease/sqlite.ts";
import {
  createPlanStore,
  createReadiness,
} from "../../../test/helpers/plan.ts";
import type { Transaction } from "../../../src/services/storage/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedGraph,
  seedNodeState,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";
const ACTOR = "actor_alpha";
const RUN_ID = "run_release";
const ATTEMPT_ID = "attempt_release";

function seedFixture(transaction: Transaction): void {
  seedRegistry(transaction);
  seedGraph(transaction);
  seedNodeState(transaction, fixtureIds.initiative, "running");
  seedNodeState(transaction, fixtureIds.objective, "running");
  seedNodeState(transaction, fixtureIds.task, "running");
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["node", fixtureIds.objective, ACTOR, "actor", 1, NOW, NOW, NOW + 1000],
  );
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["node", fixtureIds.task, ACTOR, "actor", 1, NOW, NOW, NOW + 1000],
  );
  transaction.run(
    "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      RUN_ID,
      "execution",
      fixtureIds.task,
      "external",
      null,
      "claude@1",
      1,
      3,
      null,
      null,
      fixtureIds.planRevision,
      "[]",
      NOW + 1000,
      NOW + 900000,
      "active",
      null,
      null,
    ],
  );
  transaction.run(
    "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      ATTEMPT_ID,
      RUN_ID,
      "external",
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  );
}

function createExpiry(
  events: EventLog,
  execution: SqliteExecution,
): ReleaseNodeDependencies["expiry"] {
  return {
    expireRuns(transaction, input) {
      return expireRuns(
        { events, execution, instanceId: INSTANCE },
        transaction,
        input,
      );
    },
  };
}

export default function releaseSuccess(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: ReleaseNodeResult;
}> {
  const fixture = createMigratedStorage();
  try {
    fixture.storage.transact(seedFixture);
    const events: EventLog = new SqliteEventLog({
      storage: fixture.storage,
      ids: createMockIdGenerator({
        ulids: [
          "00000000000000000000000000",
          "00000000000000000000000001",
          "00000000000000000000000002",
        ],
      }),
    });
    const execution = new SqliteExecution({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const dependencies: ReleaseNodeDependencies = {
      storage: fixture.storage,
      plan: createPlanStore(createReadiness(events, INSTANCE)),
      lease: new SqliteLease(),
      execution,
      events,
      clock: createMockClock({ start: NOW }),
      expiry: createExpiry(events, execution),
      caller: "claude@1",
    };
    const recorder = recordSeams(dependencies, {
      [fixtureIds.initiative]: "I",
      [fixtureIds.objective]: "O",
      [fixtureIds.task]: "T",
      [RUN_ID]: "R",
      [ATTEMPT_ID]: "A",
    });
    const result = releaseNode(recorder.dependencies, {
      nodeId: fixtureIds.task,
      fence: 1,
      runId: RUN_ID,
      runFence: 1,
      actorId: ACTOR,
      actorKind: "harness",
    });
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
