import { createNode } from "../../../src/commands/node/create-node.ts";
import type {
  CreateNodeInput,
  CreateNodeResult,
} from "../../../src/commands/node/create-node.ts";
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

export default function createNodeGuard(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: CreateNodeResult;
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
        ulids: ["00000000000000000000000020", "00000000000000000000000021"],
      }),
      clock: createMockClock({ start: NOW }),
      events,
      revision: createRevision(blobs, plan),
    };
    const recorder = recordSeams(dependencies, {
      [fixtureIds.project]: "P",
    });
    const input: CreateNodeInput = {
      projectId: fixtureIds.project,
      fromRevision: nodeBaselineRevision,
      node: {
        kind: "task",
        title: "Render the manifest",
        parentId: "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      },
      actor: ACTOR,
    };
    const result = createNode(recorder.dependencies, input);
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
