import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attemptOutcomes } from "./attempt.ts";
import type { AttemptAccounting } from "./attempt-accounting.ts";
import { externalTransitions } from "./external-transition.ts";
import {
  objectiveReportKinds,
  reportKinds,
  taskReportEffect,
  taskReportOutcomes,
} from "./outcome-report.ts";
import type {
  NodeReportResult,
  TaskReportEffect,
  TaskReportOutcome,
} from "./outcome-report.ts";

describe("src/domain/outcome-report.test", () => {
  it("the three vocabularies are exact", () => {
    assert.deepEqual(reportKinds, [
      "accepted",
      "rejected",
      "failed",
      "cancelled",
      "attested",
      "closed",
    ]);
    assert.deepEqual(taskReportOutcomes, [
      "accepted",
      "rejected",
      "failed",
      "cancelled",
    ]);
    assert.deepEqual(objectiveReportKinds, ["attested", "closed"]);
    for (const outcome of taskReportOutcomes) {
      assert.ok(
        (attemptOutcomes as readonly string[]).includes(outcome),
        `${outcome} is not an attempt outcome`,
      );
    }
  });

  it("timed-out is not a task report outcome", () => {
    assert.ok(!(taskReportOutcomes as readonly string[]).includes("timed-out"));
    assert.ok((attemptOutcomes as readonly string[]).includes("timed-out"));
  });

  it("the full cross product returns the fixed record", () => {
    const notExhausted: AttemptAccounting = {
      counter: 1,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 2,
    };
    const exhausted: AttemptAccounting = {
      counter: 3,
      rejections: 0,
      exhausted: true,
      nextAttemptNo: 4,
    };
    const expected: Readonly<
      Record<
        TaskReportOutcome,
        Readonly<{ under: TaskReportEffect; atLimit: TaskReportEffect }>
      >
    > = {
      accepted: {
        under: {
          attemptOutcome: "accepted",
          nodeState: "done",
          blockReason: null,
          runEnd: "done",
          objectIdRequired: true,
          trigger: "outcome-accepted",
        },
        atLimit: {
          attemptOutcome: "accepted",
          nodeState: "done",
          blockReason: null,
          runEnd: "done",
          objectIdRequired: true,
          trigger: "outcome-accepted",
        },
      },
      rejected: {
        under: {
          attemptOutcome: "rejected",
          nodeState: "ready",
          blockReason: null,
          runEnd: null,
          objectIdRequired: false,
          trigger: "attempt-rejected",
        },
        atLimit: {
          attemptOutcome: "rejected",
          nodeState: "blocked",
          blockReason: "attempt-limit",
          runEnd: "blocked",
          objectIdRequired: false,
          trigger: "attempt-limit-reached",
        },
      },
      failed: {
        under: {
          attemptOutcome: "failed",
          nodeState: "ready",
          blockReason: null,
          runEnd: null,
          objectIdRequired: false,
          trigger: "attempt-failed",
        },
        atLimit: {
          attemptOutcome: "failed",
          nodeState: "blocked",
          blockReason: "attempt-limit",
          runEnd: "blocked",
          objectIdRequired: false,
          trigger: "attempt-limit-reached",
        },
      },
      cancelled: {
        under: {
          attemptOutcome: "cancelled",
          nodeState: "ready",
          blockReason: null,
          runEnd: null,
          objectIdRequired: false,
          trigger: "report-cancelled",
        },
        atLimit: {
          attemptOutcome: "cancelled",
          nodeState: "blocked",
          blockReason: "attempt-limit",
          runEnd: "blocked",
          objectIdRequired: false,
          trigger: "attempt-limit-reached",
        },
      },
    };

    for (const outcome of taskReportOutcomes) {
      assert.deepEqual(
        taskReportEffect({ outcome, accounting: notExhausted }),
        expected[outcome].under,
        `${outcome} under the limit`,
      );
      assert.deepEqual(
        taskReportEffect({ outcome, accounting: exhausted }),
        expected[outcome].atLimit,
        `${outcome} at the limit`,
      );
    }
  });

  it("nodeState equals the to of the row the trigger names", () => {
    const notExhausted: AttemptAccounting = {
      counter: 1,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 2,
    };
    const exhausted: AttemptAccounting = {
      counter: 3,
      rejections: 0,
      exhausted: true,
      nextAttemptNo: 4,
    };
    for (const outcome of taskReportOutcomes) {
      for (const accounting of [notExhausted, exhausted]) {
        const result = taskReportEffect({ outcome, accounting });
        const row = externalTransitions.find(
          (candidate) => candidate.trigger === result.trigger,
        );
        assert.ok(row, `no external row for trigger ${result.trigger}`);
        assert.equal(row.level, "task");
        assert.equal(row.to, result.nodeState);
      }
    }
  });

  it("accepted ignores the accounting", () => {
    const notExhausted: AttemptAccounting = {
      counter: 1,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 2,
    };
    const exhausted: AttemptAccounting = {
      counter: 3,
      rejections: 0,
      exhausted: true,
      nextAttemptNo: 4,
    };
    assert.deepEqual(
      taskReportEffect({ outcome: "accepted", accounting: notExhausted }),
      taskReportEffect({ outcome: "accepted", accounting: exhausted }),
    );
  });

  it("cancelled reaches the limit exactly as rejected does", () => {
    const exhausted: AttemptAccounting = {
      counter: 3,
      rejections: 0,
      exhausted: true,
      nextAttemptNo: 4,
    };
    const cancelled = taskReportEffect({
      outcome: "cancelled",
      accounting: exhausted,
    });
    const rejected = taskReportEffect({
      outcome: "rejected",
      accounting: exhausted,
    });
    const { attemptOutcome: cancelledOutcome, ...cancelledRest } = cancelled;
    const { attemptOutcome: rejectedOutcome, ...rejectedRest } = rejected;
    assert.equal(cancelledOutcome, "cancelled");
    assert.equal(rejectedOutcome, "rejected");
    assert.deepEqual(cancelledRest, rejectedRest);
  });

  it("NodeReportResult holds ten keys in order", () => {
    const record: NodeReportResult = {
      nodeId: "01JZQ4T0",
      kind: "task",
      state: "done",
      blockReason: null,
      attemptId: null,
      attemptNo: null,
      attemptsRemaining: null,
      objectId: null,
      objectiveState: null,
      objectiveProjection: null,
    };
    assert.deepEqual(Object.keys(record), [
      "nodeId",
      "kind",
      "state",
      "blockReason",
      "attemptId",
      "attemptNo",
      "attemptsRemaining",
      "objectId",
      "objectiveState",
      "objectiveProjection",
    ]);
  });
});
