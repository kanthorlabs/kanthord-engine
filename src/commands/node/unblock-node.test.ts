import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NodeState } from "../../domain/state.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type {
  PlanStore,
  SetNodeStateInput,
} from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import {
  unblockNode,
  UnblockNodeError,
  type UnblockNodeDependencies,
  type UnblockNodeInput,
} from "./unblock-node.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createMigratedStorage,
  databaseBytes,
  tableRows,
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
  seedNodeBlockReason,
  seedNodeState,
  seedRegistry,
  seedSecondRevisionWithTask,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";
const HUMAN = "actor_human";
const HARNESS = "actor_harness";

type EventRecorder = Readonly<{
  events: EventLog;
  appends: AppendEventInput[];
}>;

function createEventRecorder(failType?: string): EventRecorder {
  const appends: AppendEventInput[] = [];
  const events: EventLog = {
    append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
      if (input.type === failType) {
        throw new Error("event append failed");
      }
      appends.push(input);
      transaction.run(
        "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          `event_${appends.length}`,
          input.subjectKind,
          input.subjectId,
          input.type,
          input.actorKind,
          input.actorId,
          JSON.stringify(input.payload),
        ],
      );
      return {
        id: `event_${appends.length}`,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        type: input.type,
        actorKind: input.actorKind,
        actorId: input.actorId,
        payload: input.payload,
        occurredAt: NOW,
      };
    },
    list(): readonly RecordedEvent[] {
      return appends.map((input, index) => ({
        id: `event_${index + 1}`,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        type: input.type,
        actorKind: input.actorKind,
        actorId: input.actorId,
        payload: input.payload,
        occurredAt: NOW,
      }));
    },
  };
  return { events, appends };
}

type UnblockFixture = Readonly<{
  storage: Storage;
  plan: PlanStore;
  planCalls: readonly Readonly<{
    method: "mutateGraph" | "setNodeState";
    input: unknown;
    transitions: readonly unknown[];
  }>[];
  events: EventLog;
  appends: readonly AppendEventInput[];
  dispose(): void;
}>;

function createFixture(
  options: Readonly<{
    failEventType?: string;
    failStateWrite?: boolean;
  }> = {},
): UnblockFixture {
  const temporary = createMigratedStorage();
  const recorder = createEventRecorder(options.failEventType);
  const recording = createRecordingPlanStore(
    createPlanStore(createReadiness(recorder.events, INSTANCE)),
  );
  const plan = options.failStateWrite
    ? new Proxy(recording.plan, {
        get(target, property, receiver) {
          if (property === "setNodeState") {
            return (): never => {
              throw new Error("state write failed");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      })
    : recording.plan;
  return {
    storage: temporary.storage,
    plan,
    planCalls: recording.calls,
    events: recorder.events,
    appends: recorder.appends,
    dispose() {
      temporary.dispose();
    },
  };
}

function seedTask(
  fixture: UnblockFixture,
  state: string,
  blockReason: string | null,
  unsatisfied = false,
): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    if (unsatisfied) {
      seedSecondRevisionWithTask(transaction);
      seedEdge(transaction, {
        id: "edge_task_dependency",
        fromNode: fixtureIds.task,
        toNode: "task_b",
      });
    }
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    const bypassed = state === "awaiting_approval" || state === "partial";
    if (bypassed) {
      transaction.run("PRAGMA ignore_check_constraints = ON");
    }
    seedNodeState(transaction, fixtureIds.task, state);
    if (bypassed) {
      transaction.run("PRAGMA ignore_check_constraints = OFF");
    }
    seedNodeBlockReason(transaction, fixtureIds.task, blockReason);
  });
}

function dependencies(fixture: UnblockFixture): UnblockNodeDependencies {
  return {
    storage: fixture.storage,
    plan: fixture.plan,
    events: fixture.events,
    clock: createMockClock({ start: NOW }),
  };
}

function input(
  actorId = HUMAN,
  actorKind: "human" | "harness" = "human",
  nodeId: string = fixtureIds.task,
): UnblockNodeInput {
  return { nodeId, actorId, actorKind };
}

function run(
  fixture: UnblockFixture,
  value: UnblockNodeInput = input(),
): ReturnType<typeof unblockNode> {
  return unblockNode(dependencies(fixture), value);
}

function refused(
  fixture: UnblockFixture,
  value: UnblockNodeInput = input(),
): UnblockNodeError {
  let raised: unknown;
  try {
    run(fixture, value);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof UnblockNodeError,
    `expected UnblockNodeError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: UnblockFixture, id = fixtureIds.task): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function blockReason(fixture: UnblockFixture): string | null {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get(
      "SELECT block_reason AS blockReason FROM node WHERE id = ?",
      [fixtureIds.task],
    ) as Readonly<{ blockReason: string | null }> | undefined;
    return row?.blockReason ?? null;
  });
}

function setNodeStateCalls(
  fixture: UnblockFixture,
): readonly SetNodeStateInput[] {
  return fixture.planCalls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

describe("src/commands/node/unblock-node.test", () => {
  it("an unblock of an attempt-limit task returns it to the pool", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit");

      const result = run(fixture);

      assert.deepEqual(result.node, {
        id: fixtureIds.task,
        state: "ready",
      });
      assert.equal(nodeState(fixture), "ready");
      assert.equal(blockReason(fixture), null);
      const event = fixture.appends.find(
        (candidate) => candidate.type === "node.unblocked",
      );
      assert.ok(event !== undefined);
      assert.equal(event.actorKind, "human");
      assert.equal(event.actorId, HUMAN);
      assert.deepEqual(Object.keys(event.payload as object), [
        "from",
        "to",
        "clearedReason",
      ]);
      assert.deepEqual(event.payload, {
        from: "blocked",
        to: "pending",
        clearedReason: "attempt-limit",
      });
    } finally {
      fixture.dispose();
    }
  });

  it("readiness promotes a satisfied task in the same transaction", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit");

      const result = run(fixture);

      assert.equal(result.node.state, "ready");
      assert.equal(nodeState(fixture), "ready");
      const readyEvents = fixture.appends.filter(
        (candidate) => candidate.type === "node.ready",
      );
      assert.equal(readyEvents.length, 1);
      assert.equal(readyEvents[0]?.actorKind, "daemon");
      assert.equal(readyEvents[0]?.subjectId, fixtureIds.task);
    } finally {
      fixture.dispose();
    }
  });

  it("an unsatisfied task stays pending", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit", true);

      const result = run(fixture);

      assert.equal(result.node.state, "pending");
      assert.equal(nodeState(fixture), "pending");
      assert.equal(
        fixture.appends.some((candidate) => candidate.type === "node.ready"),
        false,
      );
    } finally {
      fixture.dispose();
    }
  });

  it("the unblock and its event commit together", () => {
    const eventFailure = createFixture({ failEventType: "node.unblocked" });
    try {
      seedTask(eventFailure, "blocked", "attempt-limit");
      const before = databaseBytes(eventFailure.storage);

      assert.throws(() => run(eventFailure), /event append failed/);

      assert.deepEqual(databaseBytes(eventFailure.storage), before);
      assert.equal(nodeState(eventFailure), "blocked");
      assert.equal(blockReason(eventFailure), "attempt-limit");
    } finally {
      eventFailure.dispose();
    }

    const stateFailure = createFixture({ failStateWrite: true });
    try {
      seedTask(stateFailure, "blocked", "attempt-limit");
      const before = databaseBytes(stateFailure.storage);

      assert.throws(() => run(stateFailure), /state write failed/);

      assert.deepEqual(databaseBytes(stateFailure.storage), before);
      assert.equal(stateFailure.appends.length, 1);
      assert.deepEqual(tableRows(stateFailure.storage, "event"), []);
      assert.equal(nodeState(stateFailure), "blocked");
    } finally {
      stateFailure.dispose();
    }
  });

  it("a harness actor is actor-forbidden", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit");
      const before = databaseBytes(fixture.storage);

      const error = refused(fixture, input(HARNESS, "harness"));

      assert.equal(error.refusal, "actor-forbidden");
      assert.deepEqual(databaseBytes(fixture.storage), before);
      assert.equal(fixture.appends.length, 0);
      assert.equal(setNodeStateCalls(fixture).length, 0);
    } finally {
      fixture.dispose();
    }
  });

  it("an absent node is not-found", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit");
      const before = databaseBytes(fixture.storage);

      const error = refused(fixture, input(HUMAN, "human", "task_missing"));

      assert.equal(error.refusal, "not-found");
      assert.deepEqual(databaseBytes(fixture.storage), before);
      assert.equal(fixture.appends.length, 0);
      assert.equal(setNodeStateCalls(fixture).length, 0);
    } finally {
      fixture.dispose();
    }
  });

  it("an objective and an initiative are node-kind-invalid", () => {
    for (const nodeId of [fixtureIds.objective, fixtureIds.initiative]) {
      const fixture = createFixture();
      try {
        seedTask(fixture, "blocked", "attempt-limit");
        const before = databaseBytes(fixture.storage);

        const error = refused(fixture, input(HUMAN, "human", nodeId));

        assert.equal(error.refusal, "node-kind-invalid", nodeId);
        assert.deepEqual(databaseBytes(fixture.storage), before);
        assert.equal(fixture.appends.length, 0);
        assert.equal(setNodeStateCalls(fixture).length, 0);
      } finally {
        fixture.dispose();
      }
    }
  });

  it("a task that is not blocked is not-blocked", () => {
    const states: readonly NodeState[] = [
      "pending",
      "ready",
      "running",
      "awaiting_approval",
      "done",
      "partial",
      "discarded",
    ];
    for (const state of states) {
      const fixture = createFixture();
      try {
        seedTask(fixture, state, null);
        const before = databaseBytes(fixture.storage);

        const error = refused(fixture);

        assert.equal(error.refusal, "not-blocked", state);
        assert.deepEqual(error.details, { state }, state);
        assert.deepEqual(databaseBytes(fixture.storage), before, state);
        assert.equal(fixture.appends.length, 0, state);
        assert.equal(setNodeStateCalls(fixture).length, 0, state);
      } finally {
        fixture.dispose();
      }
    }
  });

  it("a block reason other than attempt-limit is block-reason-not-clearable", () => {
    const reasons = [
      "dependency-discarded",
      "dirty-recovery",
      "stale-base",
      "abandoned",
    ] as const;
    for (const reason of reasons) {
      const fixture = createFixture();
      try {
        seedTask(fixture, "blocked", reason);
        const before = databaseBytes(fixture.storage);

        const error = refused(fixture);

        assert.equal(error.refusal, "block-reason-not-clearable", reason);
        assert.deepEqual(error.details, { blockReason: reason }, reason);
        assert.deepEqual(databaseBytes(fixture.storage), before, reason);
        assert.equal(fixture.appends.length, 0, reason);
        assert.equal(setNodeStateCalls(fixture).length, 0, reason);
      } finally {
        fixture.dispose();
      }
    }
  });

  it("the trigger is manual-unblock", () => {
    const fixture = createFixture();
    try {
      seedTask(fixture, "blocked", "attempt-limit", true);

      run(fixture);

      assert.deepEqual(setNodeStateCalls(fixture), [
        {
          id: fixtureIds.task,
          from: "blocked",
          to: "pending",
          trigger: "manual-unblock",
          blockReason: null,
          at: NOW,
          cause: { revision: fixtureIds.planRevision, importId: null },
        },
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it("the command reads no run, no lease and no workspace", () => {
    type Assert<T extends true> = T;
    type NoExecution = Assert<
      "execution" extends keyof UnblockNodeDependencies ? false : true
    >;
    type NoLease = Assert<
      "lease" extends keyof UnblockNodeDependencies ? false : true
    >;
    type NoGit = Assert<
      "git" extends keyof UnblockNodeDependencies ? false : true
    >;
    type NoWorkspace = Assert<
      "workspaces" extends keyof UnblockNodeDependencies ? false : true
    >;
    const proof: readonly [NoExecution, NoLease, NoGit, NoWorkspace] = [
      true,
      true,
      true,
      true,
    ];
    assert.deepEqual(proof, [true, true, true, true]);
  });
});
