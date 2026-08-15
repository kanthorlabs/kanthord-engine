import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deriveReadiness } from "../../domain/readiness.ts";
import type {
  ReadinessNode,
  ReadinessTransition,
} from "../../domain/readiness.ts";
import type { StoredEdge } from "../../domain/plan-graph.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../event/index.ts";
import type { Transaction } from "../storage/index.ts";
import type { Readiness, ReadinessCause, ReadinessInput } from "./index.ts";
import { DependencyReadiness } from "./dependency.ts";
import type { DependencyReadinessDependencies } from "./dependency.ts";

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

type ReadinessEventPayload = Readonly<{
  from: string;
  to: string;
  reason: string;
  revision: string;
  importId: string | null;
}>;

function createRecordingEventLog(): Readonly<{
  events: EventLog;
  recorded: RecordedAppend[];
}> {
  const recorded: RecordedAppend[] = [];
  return {
    recorded,
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        recorded.push({ transaction, input });
        return {
          id: "event_1",
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
        return [];
      },
    },
  };
}

function throwingTransaction(): Transaction {
  const fail = (): never => {
    throw new Error("stub transaction touched the database");
  };
  return { run: fail, get: fail, all: fail };
}

function createReadiness(
  dependencies: DependencyReadinessDependencies,
): Readiness {
  return new DependencyReadiness(dependencies);
}

function edge(fromNode: string, toNode: string): StoredEdge {
  return { id: `edge_${fromNode}_${toNode}`, fromNode, toNode, waivedAt: null };
}

function readinessInput(
  nodes: readonly ReadinessNode[],
  edges: readonly StoredEdge[],
  cause: ReadinessCause = { revision: "revision_x", importId: "import_x" },
): ReadinessInput {
  return { projectId: "project_1", nodes, edges, at: 1000, cause };
}

const promotionNodes: readonly ReadinessNode[] = [
  { id: "task_done", state: "done" },
  { id: "node_B", state: "pending" },
];

const promotionEdges: readonly StoredEdge[] = [edge("node_B", "task_done")];

const demotionNodes: readonly ReadinessNode[] = [
  { id: "task_running", state: "running" },
  { id: "node_a", state: "ready" },
];

const demotionEdges: readonly StoredEdge[] = [edge("node_a", "task_running")];

const mixedNodes: readonly ReadinessNode[] = [
  { id: "task_done", state: "done" },
  { id: "task_running", state: "running" },
  { id: "node_B", state: "pending" },
  { id: "node_a", state: "ready" },
];

const mixedEdges: readonly StoredEdge[] = [
  edge("node_B", "task_done"),
  edge("node_a", "task_running"),
];

const bytewiseNodes: readonly ReadinessNode[] = [
  { id: "node_Z", state: "pending" },
  { id: "node_a", state: "pending" },
  { id: "node_B", state: "pending" },
];

describe("src/services/readiness/dependency.test", () => {
  describe("DependencyReadiness.apply", () => {
    it("apply over a node set that yields no transition returns [] and appends nothing", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const result = readiness.apply(
        throwingTransaction(),
        readinessInput([{ id: "node_done", state: "done" }], []),
      );
      assert.deepEqual(result, []);
      assert.equal(recorded.length, 0);
    });

    it("apply over a promotion fixture returns the transitions deriveReadiness returns, in the same order", () => {
      const { events } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const input = readinessInput(promotionNodes, promotionEdges);
      const result = readiness.apply(throwingTransaction(), input);
      const expected: readonly ReadinessTransition[] = deriveReadiness(
        input.nodes,
        input.edges,
      );
      assert.deepEqual(result, expected);
    });

    it("apply appends exactly one event per returned transition", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const result = readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges),
      );
      assert.equal(recorded.length, result.length);
      assert.equal(recorded.length, 1);
    });

    it("apply passes the caller's transaction to every append", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const transaction = throwingTransaction();
      readiness.apply(
        transaction,
        readinessInput(promotionNodes, promotionEdges),
      );
      assert.ok(recorded.length > 0);
      for (const append of recorded) {
        assert.equal(append.transaction, transaction);
      }
    });

    it("apply writes no row — the stubbed transaction throws on run, get and all", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const result = readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges),
      );
      assert.equal(result.length, 1);
      assert.equal(recorded.length, 1);
    });

    it("the event order equals the transition order, bytewise by node identity", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const result = readiness.apply(
        throwingTransaction(),
        readinessInput(bytewiseNodes, []),
      );
      assert.deepEqual(
        result.map((transition) => transition.nodeId),
        ["node_B", "node_Z", "node_a"],
      );
      assert.deepEqual(
        recorded.map((append) => append.input.subjectId),
        ["node_B", "node_Z", "node_a"],
      );
    });

    it("apply over the mixed fixture returns both directions from one call and appends two events", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      const input = readinessInput(mixedNodes, mixedEdges);
      const result = readiness.apply(throwingTransaction(), input);
      assert.deepEqual(result, [
        {
          nodeId: "node_B",
          from: "pending",
          to: "ready",
          trigger: "readiness-promoted",
        },
        {
          nodeId: "node_a",
          from: "ready",
          to: "pending",
          trigger: "readiness-demoted",
        },
      ]);
      assert.equal(recorded.length, 2);
    });

    it("src/services/readiness/index.ts contains no implementation", () => {
      const content = fs.readFileSync(
        new URL("./index.ts", import.meta.url),
        "utf8",
      );
      assert.ok(
        !content.includes("implements "),
        "readiness/index.ts contains an implementation",
      );
    });
  });

  describe("the appended readiness event", () => {
    it("a promotion appends node.ready with reason dependency-satisfied", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges),
      );
      assert.equal(recorded.length, 1);
      const append = recorded[0];
      assert.ok(append, "expected one recorded append");
      assert.deepEqual(append.input, {
        subjectKind: "node",
        subjectId: "node_B",
        type: "node.ready",
        actorKind: "daemon",
        actorId: "instance_1",
        payload: {
          from: "pending",
          to: "ready",
          reason: "dependency-satisfied",
          revision: "revision_x",
          importId: "import_x",
        },
      });
    });

    it("a demotion appends node.pending with reason dependency-unsatisfied", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput(demotionNodes, demotionEdges),
      );
      assert.equal(recorded.length, 1);
      const append = recorded[0];
      assert.ok(append, "expected one recorded append");
      assert.deepEqual(append.input, {
        subjectKind: "node",
        subjectId: "node_a",
        type: "node.pending",
        actorKind: "daemon",
        actorId: "instance_1",
        payload: {
          from: "ready",
          to: "pending",
          reason: "dependency-unsatisfied",
          revision: "revision_x",
          importId: "import_x",
        },
      });
    });

    it("actorId is the constructed instance identity and never an input", () => {
      const { events, recorded } = createRecordingEventLog();
      const first = createReadiness({ events, instanceId: "instance_1" });
      const second = createReadiness({ events, instanceId: "instance_2" });
      const input = readinessInput(promotionNodes, promotionEdges);
      first.apply(throwingTransaction(), input);
      second.apply(throwingTransaction(), input);
      assert.equal(recorded.length, 2);
      const firstAppend = recorded[0];
      const secondAppend = recorded[1];
      assert.ok(firstAppend, "expected the first recorded append");
      assert.ok(secondAppend, "expected the second recorded append");
      assert.equal(firstAppend.input.actorId, "instance_1");
      assert.equal(secondAppend.input.actorId, "instance_2");
      assert.notEqual(firstAppend.input.actorId, secondAppend.input.actorId);
    });

    it("the payload carries the cause revision and importId", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges, {
          revision: "revision_x",
          importId: "import_x",
        }),
      );
      assert.equal(recorded.length, 1);
      const firstAppend = recorded[0];
      assert.ok(firstAppend, "expected the first recorded append");
      const firstPayload = firstAppend.input.payload as ReadinessEventPayload;
      assert.equal(firstPayload.revision, "revision_x");
      assert.equal(firstPayload.importId, "import_x");
      readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges, {
          revision: "revision_y",
          importId: null,
        }),
      );
      assert.equal(recorded.length, 2);
      const secondAppend = recorded[1];
      assert.ok(secondAppend, "expected the second recorded append");
      const secondPayload = secondAppend.input.payload as ReadinessEventPayload;
      assert.equal(secondPayload.revision, "revision_y");
      assert.equal(secondPayload.importId, null);
    });

    it("the payload holds exactly five keys in order", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput(promotionNodes, promotionEdges),
      );
      assert.equal(recorded.length, 1);
      const append = recorded[0];
      assert.ok(append, "expected one recorded append");
      const payload = append.input.payload as ReadinessEventPayload;
      assert.deepEqual(Object.keys(payload), [
        "from",
        "to",
        "reason",
        "revision",
        "importId",
      ]);
    });

    it("a mixed pass appends one node.ready and one node.pending", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput(mixedNodes, mixedEdges),
      );
      assert.deepEqual(
        recorded.map((append) => append.input.type),
        ["node.ready", "node.pending"],
      );
    });

    it("no transition appends no event", () => {
      const { events, recorded } = createRecordingEventLog();
      const readiness = createReadiness({ events, instanceId: "instance_1" });
      readiness.apply(
        throwingTransaction(),
        readinessInput([{ id: "node_done", state: "done" }], []),
      );
      assert.equal(recorded.length, 0);
    });
  });
});
