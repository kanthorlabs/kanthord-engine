import type {
  ClaimNodeResult,
  Expiry,
} from "../../../src/commands/node/claim-node.ts";
import { claimNode } from "../../../src/commands/node/claim-node.ts";
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
  seedNodeWithDeliverable,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";
import { workerRegistry } from "../../../src/domain/worker-registry.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";
const ACTOR = "actor_alpha";
const TASK_SIBLING = "task_s";
const OBJECTIVE_RUN_ID = "run_objective_reused";

function seedFixture(transaction: Transaction): void {
  seedRegistry(transaction);
  seedGraph(transaction);
  seedNodeWithDeliverable(transaction, {
    id: TASK_SIBLING,
    kind: "task",
    parentId: fixtureIds.objective,
    title: "Second task",
    deliverable: "implementation",
  });
  seedNodeState(transaction, fixtureIds.initiative, "running");
  seedNodeState(transaction, fixtureIds.objective, "running");
  seedNodeState(transaction, fixtureIds.task, "ready");
  seedNodeState(transaction, TASK_SIBLING, "ready");
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["node", fixtureIds.objective, ACTOR, "actor", 1, NOW, NOW, NOW + 300000],
  );
  transaction.run(
    "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      OBJECTIVE_RUN_ID,
      "structural",
      fixtureIds.objective,
      "external",
      null,
      "claude@1",
      2,
      3,
      null,
      null,
      fixtureIds.planRevision,
      "[]",
      NOW - 1000,
      NOW - 1000,
      "ended",
      "expired",
      NOW - 1000,
    ],
  );
}

export default function claimRecoversObjectiveAuthority(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: ClaimNodeResult;
}> {
  const fixture = createMigratedStorage();
  try {
    fixture.storage.transact(seedFixture);

    const events: EventLog = new SqliteEventLog({
      storage: fixture.storage,
      ids: createMockIdGenerator({
        ulids: [
          "00000000000000000000000010",
          "00000000000000000000000011",
          "00000000000000000000000012",
          "00000000000000000000000013",
          "00000000000000000000000014",
          "00000000000000000000000015",
          "00000000000000000000000016",
          "00000000000000000000000017",
        ],
      }),
    });
    const execution = new SqliteExecution({
      ids: createMockIdGenerator({
        ulids: [
          "00000000000000000000000020",
          "00000000000000000000000021",
          "00000000000000000000000022",
        ],
      }),
    });
    const expiry: Expiry = {
      expireRuns(transaction, input) {
        return expireRuns(
          { events, execution, instanceId: INSTANCE },
          transaction,
          input,
        );
      },
    };
    const dependencies = {
      storage: fixture.storage,
      plan: createPlanStore(createReadiness(events, INSTANCE)),
      lease: new SqliteLease(),
      execution,
      events,
      clock: createMockClock({ start: NOW }),
      ids: createMockIdGenerator({
        ulids: ["00000000000000000000000022"],
      }),
      expiry,
      callerRecord: {
        worker: "claude@1",
        authorized: ["claude@1"],
      },
      attemptLimit: 3,
      leaseTtlMs: 300000,
      runTtlMs: 300000,
      runMaxLifetimeMs: 1800000,
      instanceId: INSTANCE,
    };
    const recorder = recordSeams(
      dependencies,
      {
        [fixtureIds.initiative]: "I",
        [fixtureIds.objective]: "O",
        [fixtureIds.task]: "T",
        [TASK_SIBLING]: "S",
        run_00000000000000000000000020: "OR",
      },
      {
        siblings: [TASK_SIBLING],
        subtree: [
          fixtureIds.objective,
          fixtureIds.initiative,
          fixtureIds.task,
          TASK_SIBLING,
        ],
      },
    );
    const result = claimNode(
      { ...recorder.dependencies, registry: workerRegistry },
      {
        nodeId: fixtureIds.objective,
        actorId: ACTOR,
        actorKind: "harness",
        available: true,
      },
    );
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
