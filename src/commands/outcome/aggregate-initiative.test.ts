import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Clock } from "../../services/clock/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import {
  aggregateInitiative,
  type AggregateInitiativeDependencies,
  type AggregateInitiativeInput,
} from "./aggregate-initiative.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createMigratedStorage,
  databaseBytes,
} from "../../../test/helpers/database.ts";
import {
  createPlanStore,
  createReadiness,
  createRecordingPlanStore,
} from "../../../test/helpers/plan.ts";
import {
  fixtureIds,
  seedEdge,
  seedGraph,
  seedNode,
  seedNodeState,
  seedRegistry,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function createRecordingEvents(): Readonly<{
  events: EventLog;
  appends: readonly RecordedAppend[];
}> {
  const appends: RecordedAppend[] = [];
  return {
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        appends.push({ transaction, input });
        return {
          id: `event_${appends.length}`,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          payload: input.payload,
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return appends.map((record, index) => ({
          id: `event_${index + 1}`,
          subjectKind: record.input.subjectKind,
          subjectId: record.input.subjectId,
          type: record.input.type,
          actorKind: record.input.actorKind,
          actorId: record.input.actorId,
          payload: record.input.payload,
          occurredAt: 0,
        }));
      },
    },
    appends,
  };
}

type AggregateFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  events: EventLog;
  appends: readonly RecordedAppend[];
  dispose(): void;
}>;

function createAggregateFixture(): AggregateFixture {
  const temporary = createMigratedStorage();
  const recorder = createRecordingEvents();
  const plan = createRecordingPlanStore(createPlanStore());
  return {
    storage: temporary.storage,
    plan,
    events: recorder.events,
    appends: recorder.appends,
    dispose() {
      temporary.dispose();
    },
  };
}

function insertObjective(
  transaction: Transaction,
  id: string,
  state: string,
): void {
  seedNode(transaction, {
    id,
    kind: "objective",
    parentId: fixtureIds.initiative,
    title: "Objective",
    repositoryId: fixtureIds.repository,
    state,
  });
}

// The initiative is set running, the seed objective defaults to done, and
// every named objective state is written directly in the database, because
// no route of this block writes a discarded or a partial objective.
function seedObjectiveStates(
  fixture: AggregateFixture,
  states: Readonly<Record<string, string>>,
): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "running");
    const merged: Readonly<Record<string, string>> = {
      [fixtureIds.objective]: "done",
      ...states,
    };
    for (const [id, state] of Object.entries(merged)) {
      if (id === fixtureIds.objective) {
        seedNodeState(transaction, id, state);
      } else {
        insertObjective(transaction, id, state);
      }
    }
  });
}

// The same fixture with the readiness service wired to the recording event
// log, so a readiness event a roll-up transaction triggers is observable.
function createRecordingAggregateFixture(): AggregateFixture {
  const temporary = createMigratedStorage();
  const recorder = createRecordingEvents();
  const plan = createRecordingPlanStore(
    createPlanStore(createReadiness(recorder.events, INSTANCE)),
  );
  return {
    storage: temporary.storage,
    plan,
    events: recorder.events,
    appends: recorder.appends,
    dispose() {
      temporary.dispose();
    },
  };
}

// A second initiative that depends on the first. Its one objective is done
// and the seeded task is ready, so nothing but the dependent initiative is
// pending when the roll-up transaction reads the graph back.
function seedDependentInitiativeFixture(fixture: AggregateFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "running");
    seedNodeState(transaction, fixtureIds.objective, "done");
    seedNodeState(transaction, fixtureIds.task, "ready");
    seedNode(transaction, {
      id: "initiative_b",
      kind: "initiative",
      parentId: null,
      title: "Second initiative",
      state: "pending",
    });
    seedEdge(transaction, {
      id: "edge_b_depends_a",
      fromNode: "initiative_b",
      toNode: fixtureIds.initiative,
    });
  });
}

function run(
  fixture: AggregateFixture,
  input: AggregateInitiativeInput = {
    initiativeId: fixtureIds.initiative,
    at: NOW,
  },
  instanceId = INSTANCE,
): void {
  const dependencies: AggregateInitiativeDependencies = {
    plan: fixture.plan.plan,
    events: fixture.events,
    instanceId,
  };
  fixture.storage.transact((transaction) =>
    aggregateInitiative(dependencies, transaction, input),
  );
}

function nodeState(fixture: AggregateFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function setNodeStateCalls(
  fixture: AggregateFixture,
): readonly SetNodeStateInput[] {
  return fixture.plan.calls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

function runCount(fixture: AggregateFixture): number {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get(
      "SELECT COUNT(*) AS count FROM run",
    ) as Readonly<{ count: number }>;
    return row.count;
  });
}

function assertRollUp(
  fixture: AggregateFixture,
  expected: Readonly<{
    to: string;
    trigger: string;
    type: string;
    states: readonly string[];
  }>,
): void {
  assert.equal(nodeState(fixture, fixtureIds.initiative), expected.to);
  const calls = setNodeStateCalls(fixture);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      id: calls[0]!.id,
      from: calls[0]!.from,
      to: calls[0]!.to,
      trigger: calls[0]!.trigger,
    },
    {
      id: fixtureIds.initiative,
      from: "running",
      to: expected.to,
      trigger: expected.trigger,
    },
  );
  assert.equal(fixture.appends.length, 1);
  assert.deepEqual(fixture.appends[0]!.input, {
    subjectKind: "node",
    subjectId: fixtureIds.initiative,
    type: expected.type,
    actorKind: "daemon",
    actorId: INSTANCE,
    payload: {
      from: "running",
      to: expected.to,
      reason: "objectives-terminal",
      objectiveStates: expected.states,
    },
  });
}

function assertNoWrite(
  fixture: AggregateFixture,
  bytes: Buffer,
  calls: number,
): void {
  assert.deepEqual(databaseBytes(fixture.storage), bytes);
  assert.equal(setNodeStateCalls(fixture).length, calls);
  assert.equal(fixture.appends.length, 0);
}

describe("src/commands/outcome/aggregate-initiative.test", () => {
  it("one partial objective gives partial", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, { [fixtureIds.objective]: "partial" });
    run(fixture);
    assertRollUp(fixture, {
      to: "partial",
      trigger: "initiative-aggregated-partial",
      type: "node.partial",
      states: ["partial"],
    });
  });

  it("done plus partial gives partial", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {
      [fixtureIds.objective]: "done",
      objective_b: "partial",
    });
    run(fixture);
    assertRollUp(fixture, {
      to: "partial",
      trigger: "initiative-aggregated-partial",
      type: "node.partial",
      states: ["done", "partial"],
    });
  });

  it("partial plus discarded gives partial", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {
      [fixtureIds.objective]: "partial",
      objective_b: "discarded",
    });
    run(fixture);
    assertRollUp(fixture, {
      to: "partial",
      trigger: "initiative-aggregated-partial",
      type: "node.partial",
      states: ["partial", "discarded"],
    });
  });

  it("every objective discarded gives discarded and never partial", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {
      [fixtureIds.objective]: "discarded",
      objective_b: "discarded",
    });
    run(fixture);
    assertRollUp(fixture, {
      to: "discarded",
      trigger: "initiative-aggregated-discarded",
      type: "node.discarded",
      states: ["discarded", "discarded"],
    });
  });

  it("every objective done gives done", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {
      [fixtureIds.objective]: "done",
      objective_b: "done",
    });
    run(fixture);
    assertRollUp(fixture, {
      to: "done",
      trigger: "initiative-aggregated-done",
      type: "node.done",
      states: ["done", "done"],
    });
  });

  it("the initiative stays running while one objective is not terminal", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {
      [fixtureIds.objective]: "done",
      objective_b: "running",
    });
    const bytes = databaseBytes(fixture.storage);
    const calls = setNodeStateCalls(fixture).length;
    run(fixture);
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
    assertNoWrite(fixture, bytes, calls);
  });

  it("a null initiative id writes nothing", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {});
    const bytes = databaseBytes(fixture.storage);
    const calls = setNodeStateCalls(fixture).length;
    run(fixture, { initiativeId: null, at: NOW });
    assertNoWrite(fixture, bytes, calls);
  });

  it("an initiative that is not running writes nothing", (t) => {
    for (const state of ["done", "partial"]) {
      const fixture = createAggregateFixture();
      t.after(() => fixture.dispose());
      seedObjectiveStates(fixture, {});
      fixture.storage.transact((transaction) => {
        seedNodeState(transaction, fixtureIds.initiative, state);
      });
      const bytes = databaseBytes(fixture.storage);
      const calls = setNodeStateCalls(fixture).length;
      run(fixture);
      assert.equal(nodeState(fixture, fixtureIds.initiative), state);
      assertNoWrite(fixture, bytes, calls);
    }
  });

  it("the event names the daemon instance", (t) => {
    const first = createAggregateFixture();
    t.after(() => first.dispose());
    seedObjectiveStates(first, {});
    run(first, { initiativeId: fixtureIds.initiative, at: NOW }, "daemon_one");
    const second = createAggregateFixture();
    t.after(() => second.dispose());
    seedObjectiveStates(second, {});
    run(second, { initiativeId: fixtureIds.initiative, at: NOW }, "daemon_two");
    assert.equal(first.appends.length, 1);
    assert.equal(second.appends.length, 1);
    assert.equal(first.appends[0]!.input.actorKind, "daemon");
    assert.equal(first.appends[0]!.input.actorId, "daemon_one");
    assert.equal(second.appends[0]!.input.actorId, "daemon_two");
    assert.notEqual(
      first.appends[0]!.input.actorId,
      second.appends[0]!.input.actorId,
    );
    const payload = first.appends[0]!.input.payload as Readonly<
      Record<string, unknown>
    >;
    assert.deepEqual(Object.keys(payload), [
      "from",
      "to",
      "reason",
      "objectiveStates",
    ]);
  });

  it("objectiveStates is ordered bytewise by node id", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    // The ids sort bytewise into objective_1, objective_10, objective_2,
    // objective_a, which no title-alphabetical order produces.
    const states: Readonly<Record<string, string>> = {
      objective_1: "done",
      objective_10: "partial",
      objective_2: "discarded",
    };
    seedObjectiveStates(fixture, states);
    const expectedIds = [fixtureIds.objective, ...Object.keys(states)].sort(
      (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    assert.deepEqual(expectedIds, [
      "objective_1",
      "objective_10",
      "objective_2",
      fixtureIds.objective,
    ]);
    const expectedStates = expectedIds.map((id) =>
      id === fixtureIds.objective ? "done" : states[id],
    );
    run(fixture);
    assert.equal(fixture.appends.length, 1);
    const payload = fixture.appends[0]!.input.payload as Readonly<{
      objectiveStates: readonly string[];
    }>;
    assert.deepEqual(payload.objectiveStates, expectedStates);
  });

  it("the roll-up promotes a dependent initiative", (t) => {
    const fixture = createRecordingAggregateFixture();
    t.after(() => fixture.dispose());
    seedDependentInitiativeFixture(fixture);
    run(fixture);
    assert.equal(nodeState(fixture, fixtureIds.initiative), "done");
    assert.equal(nodeState(fixture, "initiative_b"), "ready");
    const ready = fixture.appends.filter(
      (record) => record.input.type === "node.ready",
    );
    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.input.subjectId, "initiative_b");
    assert.equal(ready[0]!.input.actorKind, "daemon");
    assert.equal(ready[0]!.input.actorId, INSTANCE);
    const rolled = fixture.appends.filter(
      (record) => record.input.type === "node.done",
    );
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0]!.input.actorKind, "daemon");
    assert.equal(rolled[0]!.transaction, ready[0]!.transaction);
  });

  it("no run row is written", (t) => {
    const fixture = createAggregateFixture();
    t.after(() => fixture.dispose());
    seedObjectiveStates(fixture, {});
    const before = runCount(fixture);
    assert.equal(before, 0);
    run(fixture);
    assert.equal(runCount(fixture), before);
  });
});
