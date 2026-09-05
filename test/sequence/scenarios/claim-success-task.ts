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
const TASK_SIBLING = "task_s";

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
  for (const id of [
    fixtureIds.initiative,
    fixtureIds.objective,
    fixtureIds.task,
    TASK_SIBLING,
  ]) {
    seedNodeState(transaction, id, "ready");
  }
}

export default function claimSuccessTask(): Readonly<{
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
        run_00000000000000000000000020: "O",
        run_00000000000000000000000021: "R",
      },
      {
        siblings: [TASK_SIBLING],
        subtree: [fixtureIds.task, fixtureIds.objective, fixtureIds.initiative],
      },
    );
    const result = claimNode(
      { ...recorder.dependencies, registry: workerRegistry },
      {
        nodeId: fixtureIds.task,
        actorId: "actor_alpha",
        actorKind: "harness",
        available: true,
      },
    );
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
