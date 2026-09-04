import { importPlan } from "../../../src/commands/plan/import-plan.ts";
import type { ImportPlanResult } from "../../../src/commands/plan/import-plan.ts";
import { exportPlan } from "../../../src/queries/plan/export-plan.ts";
import { validatePlan } from "../../../src/queries/plan/validate-plan.ts";
import { SqliteEventLog } from "../../../src/services/event/sqlite.ts";
import type { EventLog } from "../../../src/services/event/index.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanReader,
  createPlanStore,
  createReadiness,
  createRevision,
  planFixtureBodies,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds } from "../../../test/helpers/rows.ts";
import { recordSeams } from "../../../test/helpers/sequence-conformance.ts";

const NOW = 1700000000000;

export default function importPlanGuard(): Readonly<{
  recorder: Readonly<{ tokens: readonly string[] }>;
  result: ImportPlanResult;
}> {
  const fixture = createMigratedStorage();
  try {
    const events: EventLog = new SqliteEventLog({
      storage: fixture.storage,
      ids: createMockIdGenerator({
        ulids: Array.from({ length: 32 }, (_, index) =>
          index.toString().padStart(26, "0"),
        ),
      }),
    });
    const plan = createPlanStore(createReadiness(events, "daemon_instance_a"));
    const blobs = createBlobStore(
      fixture.storage,
      createMockClock({ start: NOW, step: 1000 }),
    );
    const reader = createPlanReader();
    const graph = createPlanGraph();
    const revision = createRevision(blobs, plan);
    seedPlanFixture(fixture.storage, plan, blobs);

    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan,
        revision,
      },
      { projectId: fixtureIds.project },
    );
    const task = exported.documents.find((document) =>
      document.content.includes(planFixtureBodies.taskInstruction),
    );
    if (task === undefined) throw new Error("task fixture document is missing");
    const documents = [
      {
        ...task,
        content: task.content.replace(
          'title: "Harden the verify CLI"',
          'title: "Renamed task"',
        ),
      },
    ];
    const validation = validatePlan(
      {
        storage: fixture.storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        documents,
      },
    );
    const dependencies = {
      storage: fixture.storage,
      plan,
      blobs,
      reader,
      graph,
      ids: createMockIdGenerator({
        ulids: ["00000000000000000000000020"],
      }),
      clock: createMockClock({ start: NOW }),
      events,
    };
    const recorder = recordSeams(dependencies, {
      [fixtureIds.initiative]: "I",
      [fixtureIds.objective]: "O",
      [fixtureIds.task]: "T",
    });
    const result = importPlan(recorder.dependencies, {
      projectId: fixtureIds.project,
      fromRevision: fixtureIds.planRevision,
      importId: "import_sequence_guard",
      documents,
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
      ],
      validatedRevision: fixtureIds.planRevision,
      documentsHash: validation.documentsHash,
      actor: "human_1",
    });
    return { recorder, result };
  } finally {
    fixture.dispose();
  }
}
