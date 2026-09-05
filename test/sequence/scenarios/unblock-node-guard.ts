import { unblockNode } from "../../../src/commands/node/unblock-node.ts";
import type {
  UnblockNodeInput,
  UnblockNodeResult,
} from "../../../src/commands/node/unblock-node.ts";
import { SqliteEventLog } from "../../../src/services/event/sqlite.ts";
import type { EventLog } from "../../../src/services/event/index.ts";
import {
  createBlobStore,
  createPlanStore,
  createReadiness,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedNodeBlockReason,
  seedNodeState,
} from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

export default function unblockNodeGuard(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: UnblockNodeResult;
}> {
  const fixture = createMigratedStorage();
  try {
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
          "00000000000000000000000018",
          "00000000000000000000000019",
        ],
      }),
    });
    const plan = createPlanStore(createReadiness(events, INSTANCE));
    const blobs = createBlobStore(
      fixture.storage,
      createMockClock({ start: NOW, step: 1000 }),
    );
    seedPlanFixture(fixture.storage, plan, blobs);
    fixture.storage.transact((transaction) => {
      seedNodeState(transaction, planFixtureIdentities.task, "blocked");
      seedNodeBlockReason(
        transaction,
        planFixtureIdentities.task,
        "attempt-limit",
      );
    });
    reseedBaselineRevision(fixture.storage);

    const dependencies = {
      storage: fixture.storage,
      plan,
      events,
      clock: createMockClock({ start: NOW }),
    };
    const recorder = recordSeams(dependencies, {
      [fixtureIds.task]: "T",
      [planFixtureIdentities.task]: "T",
    });
    const input: UnblockNodeInput = {
      nodeId: planFixtureIdentities.task,
      actorId: "actor_human",
      actorKind: "human",
    };
    const result = unblockNode(recorder.dependencies, input);
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
