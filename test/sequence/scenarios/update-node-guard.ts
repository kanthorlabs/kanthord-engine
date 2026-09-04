import { updateNode } from "../../../src/commands/node/update-node.ts";
import type {
  UpdateNodeInput,
  UpdateNodeResult,
} from "../../../src/commands/node/update-node.ts";
import type { ActorRow } from "../../../src/domain/actor.ts";
import { SqliteEventLog } from "../../../src/services/event/sqlite.ts";
import type { EventLog } from "../../../src/services/event/index.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRevision,
  nodeBaselineRevision,
  planFixtureBodies,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds } from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

const ACTOR: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: "actor_00000000000000000000000000",
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

export default function updateNodeGuard(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: UpdateNodeResult;
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
        ],
      }),
    });
    const plan = createPlanStore(createReadiness(events, INSTANCE));
    const blobs = createBlobStore(
      fixture.storage,
      createMockClock({ start: NOW, step: 1000 }),
    );
    seedPlanFixture(fixture.storage, plan, blobs);
    reseedBaselineRevision(fixture.storage);

    const dependencies = {
      storage: fixture.storage,
      plan,
      blobs,
      graph: createPlanGraph(),
      ids: createMockIdGenerator({
        ulids: ["00000000000000000000000020"],
      }),
      clock: createMockClock({ start: NOW }),
      events,
      revision: createRevision(blobs, plan),
    };
    const recorder = recordSeams(dependencies, {
      [fixtureIds.initiative]: "I",
      [fixtureIds.objective]: "O",
      [fixtureIds.task]: "T",
    });
    const input: UpdateNodeInput = {
      id: planFixtureIdentities.objective,
      fromRevision: nodeBaselineRevision,
      node: {
        kind: "objective",
        title: "Harden the verify CLI",
        parentId: planFixtureIdentities.initiative,
        repo: "kanthord-verify",
        instruction: "Update the objective work.\n",
        worker: null,
        dependsOn: [],
      },
      actor: ACTOR,
    };
    const result = updateNode(recorder.dependencies, input);
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
