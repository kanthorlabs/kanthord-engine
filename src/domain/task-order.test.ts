import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskOrder, TaskOrderError } from "./task-order.ts";

const A = "task_01HZY8QF3M4N5P6R7S8T9V0W1A";
const B = "task_01HZY8QF3M4N5P6R7S8T9V0W1B";
const C = "task_01HZY8QF3M4N5P6R7S8T9V0W1C";
const D = "task_01HZY8QF3M4N5P6R7S8T9V0W1D";

describe("src/domain/task-order.test", () => {
  it("empty input", () => {
    assert.deepEqual(taskOrder({ tasks: [], edges: [] }), []);
  });

  it("one task, no edge", () => {
    assert.deepEqual(taskOrder({ tasks: [A], edges: [] }), [A]);
  });

  it("tie-break: lexicographic when no edges", () => {
    assert.deepEqual(taskOrder({ tasks: [C, A, B], edges: [] }), [A, B, C]);
  });

  it("direction: from depends on to, to comes first", () => {
    assert.deepEqual(
      taskOrder({
        tasks: [A, B],
        edges: [{ from: A, to: B, waived: false }],
      }),
      [B, A],
    );
  });

  it("chain: B→A, C→B, D→C", () => {
    assert.deepEqual(
      taskOrder({
        tasks: [D, C, B, A],
        edges: [
          { from: B, to: A, waived: false },
          { from: C, to: B, waived: false },
          { from: D, to: C, waived: false },
        ],
      }),
      [A, B, C, D],
    );
  });

  it("diamond: B→A, C→A, D→B, D→C", () => {
    assert.deepEqual(
      taskOrder({
        tasks: [A, B, C, D],
        edges: [
          { from: B, to: A, waived: false },
          { from: C, to: A, waived: false },
          { from: D, to: B, waived: false },
          { from: D, to: C, waived: false },
        ],
      }),
      [A, B, C, D],
    );
  });

  it("tie inside a walk: B and C available, smaller goes first", () => {
    assert.deepEqual(
      taskOrder({
        tasks: [A, C, B],
        edges: [
          { from: A, to: B, waived: false },
          { from: A, to: C, waived: false },
        ],
      }),
      [B, C, A],
    );
  });

  it("determinism across repeated runs", () => {
    const input = {
      tasks: [B, A],
      edges: [] as readonly { from: string; to: string; waived: boolean }[],
    };
    const expected = [A, B];
    for (let i = 0; i < 100; i++) {
      assert.deepEqual(taskOrder(input), expected);
    }
  });

  it("determinism under permutation of tasks", () => {
    const tasks = [A, B, C, D];
    const edges = [
      { from: B, to: A, waived: false },
      { from: C, to: A, waived: false },
      { from: D, to: B, waived: false },
      { from: D, to: C, waived: false },
    ];
    const expected = [A, B, C, D];

    const permutations = permute(tasks);
    assert.equal(permutations.length, 24);
    for (const p of permutations) {
      assert.deepEqual(taskOrder({ tasks: p, edges }), expected);
    }
  });

  it("determinism under permutation of edges", () => {
    const tasks = [A, B, C, D];
    const edges = [
      { from: B, to: A, waived: false },
      { from: C, to: A, waived: false },
      { from: D, to: B, waived: false },
      { from: D, to: C, waived: false },
    ];
    const expected = [A, B, C, D];

    const permutations = permute(edges);
    assert.equal(permutations.length, 24);
    for (const p of permutations) {
      assert.deepEqual(taskOrder({ tasks, edges: p }), expected);
    }
  });

  it("waived edge is dropped, tie-break decides", () => {
    assert.deepEqual(
      taskOrder({
        tasks: [A, B],
        edges: [{ from: A, to: B, waived: true }],
      }),
      [A, B],
    );
  });

  it("cycle: A→B and B→A", () => {
    const edges = [
      { from: A, to: B, waived: false },
      { from: B, to: A, waived: false },
    ];
    {
      const err = getError(() =>
        taskOrder({ tasks: [A, B], edges: [edges[0]!, edges[1]!] }),
      );
      assert.ok(err instanceof TaskOrderError);
      assert.equal(err.code, "task-order-cycle");
    }
    {
      const err = getError(() =>
        taskOrder({ tasks: [A, B], edges: [edges[1]!, edges[0]!] }),
      );
      assert.ok(err instanceof TaskOrderError);
      assert.equal(err.code, "task-order-cycle");
    }
  });

  it("self edge is a cycle", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A],
        edges: [{ from: A, to: A, waived: false }],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-cycle");
  });

  it("unknown endpoint: from not in tasks", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A],
        edges: [{ from: A, to: B, waived: false }],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-unknown-task");
    assert.ok(err.message.includes(B));
  });

  it("unknown endpoint: to not in tasks", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A],
        edges: [{ from: B, to: A, waived: false }],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-unknown-task");
    assert.ok(err.message.includes(B));
  });

  it("a waived edge is still validated", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A],
        edges: [{ from: A, to: B, waived: true }],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-unknown-task");
  });

  it("duplicate task: [A, A]", () => {
    const err = getError(() => taskOrder({ tasks: [A, A], edges: [] }));
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-duplicate-task");
    assert.ok(err.message.includes(A));
  });

  it("duplicate task: [A, B, A]", () => {
    const err = getError(() => taskOrder({ tasks: [A, B, A], edges: [] }));
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-duplicate-task");
    assert.ok(err.message.includes(A));
  });

  it("duplicate edge", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A, B],
        edges: [
          { from: A, to: B, waived: false },
          { from: A, to: B, waived: false },
        ],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-duplicate-edge");
  });

  it("duplicate edge with waived on second", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A, B],
        edges: [
          { from: A, to: B, waived: false },
          { from: A, to: B, waived: true },
        ],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-duplicate-edge");
  });

  it("reversed pair is not a duplicate — it is a cycle", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A, B],
        edges: [
          { from: A, to: B, waived: false },
          { from: B, to: A, waived: false },
        ],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-cycle");
  });

  it("validation precedes the walk: duplicate task wins over cycle", () => {
    const err = getError(() =>
      taskOrder({
        tasks: [A, A],
        edges: [{ from: A, to: A, waived: false }],
      }),
    );
    assert.ok(err instanceof TaskOrderError);
    assert.equal(err.code, "task-order-duplicate-task");
  });

  it("error code is permutation-independent", () => {
    const edges = [
      { from: A, to: C, waived: false },
      { from: B, to: A, waived: false },
    ];
    for (const p of permute(edges)) {
      const err = getError(() => taskOrder({ tasks: [A, B], edges: p }));
      assert.ok(err instanceof TaskOrderError);
      assert.equal(err.code, "task-order-unknown-task");
    }
  });

  it("result is a permutation of the input for every passing case", () => {
    const cases = [
      {
        tasks: [] as readonly string[],
        edges: [] as readonly { from: string; to: string; waived: boolean }[],
      },
      { tasks: [A], edges: [] },
      { tasks: [C, A, B], edges: [] },
      { tasks: [A, B], edges: [{ from: A, to: B, waived: false }] },
      {
        tasks: [D, C, B, A],
        edges: [
          { from: B, to: A, waived: false },
          { from: C, to: B, waived: false },
          { from: D, to: C, waived: false },
        ],
      },
      {
        tasks: [A, B, C, D],
        edges: [
          { from: B, to: A, waived: false },
          { from: C, to: A, waived: false },
          { from: D, to: B, waived: false },
          { from: D, to: C, waived: false },
        ],
      },
      {
        tasks: [A, C, B],
        edges: [
          { from: A, to: B, waived: false },
          { from: A, to: C, waived: false },
        ],
      },
      { tasks: [B, A], edges: [] },
      { tasks: [A, B], edges: [{ from: A, to: B, waived: true }] },
    ];

    for (const input of cases) {
      const result = taskOrder(input);
      assert.equal(
        result.length,
        input.tasks.length,
        `length mismatch for tasks=[${input.tasks}]`,
      );
      assert.deepEqual(
        [...result].sort(),
        [...input.tasks].sort(),
        `sorted mismatch for tasks=[${input.tasks}]`,
      );
    }
  });
});

function getError(fn: () => unknown): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

function permute<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [arr as T[]];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permute(rest)) {
      result.push([arr[i]!, ...p]);
    }
  }
  return result;
}
