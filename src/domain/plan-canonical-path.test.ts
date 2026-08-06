import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NodeKind } from "./state.ts";
import { canonicalPaths, type CanonicalNode } from "./plan-canonical-path.ts";

const uI = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const uO1 = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const uO2 = "01CRZ3NDEKTSV4RRFFQ69G5FAV";
const uT1 = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const uT2 = "01ERZ3NDEKTSV4RRFFQ69G5FAV";
const uT3 = "01FRZ3NDEKTSV4RRFFQ69G5FAV";
const uT4 = "01GRZ3NDEKTSV4RRFFQ69G5FAV";
const uT5 = "01HRZ3NDEKTSV4RRFFQ69G5FAV";
const u0 = "00AZZ3NDEKTSV4RRFFQ69G5FAV";

function node(
  identity: string,
  kind: NodeKind,
  title: string,
  parentIdentity: string | null,
  dependencies: readonly string[] = [],
): CanonicalNode {
  return { identity, kind, title, parentIdentity, dependencies };
}

function ulid(n: number): string {
  return "01" + String(n).padStart(24, "0");
}

describe("src/domain/plan-canonical-path.test", () => {
  it("maps one initiative, two objectives and five tasks to exact canonical paths", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(
        `objective_${uO2}`,
        "objective",
        "Objective Two",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
      node(`task_${uT2}`, "task", "Task B", `objective_${uO1}`),
      node(`task_${uT3}`, "task", "Task C", `objective_${uO2}`),
      node(`task_${uT4}`, "task", "Task D", `objective_${uO2}`),
      node(`task_${uT5}`, "task", "Task E", `objective_${uO2}`),
    ];
    const expected = new Map<string, string>([
      [
        `initiative_${uI}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/initiative.md",
      ],
      [
        `objective_${uO1}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/objective.md",
      ],
      [
        `objective_${uO2}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/objective.md",
      ],
      [
        `task_${uT1}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
      ],
      [
        `task_${uT2}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/02-task-b--01erz3ndektsv4rrffq69g5fav.md",
      ],
      [
        `task_${uT3}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/01-task-c--01frz3ndektsv4rrffq69g5fav.md",
      ],
      [
        `task_${uT4}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/02-task-d--01grz3ndektsv4rrffq69g5fav.md",
      ],
      [
        `task_${uT5}`,
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/03-task-e--01hrz3ndektsv4rrffq69g5fav.md",
      ],
    ]);
    assert.deepEqual(canonicalPaths(nodes), expected);
    assert.equal(canonicalPaths(nodes).size, 8);
  });

  it("lowercases the ULID in a path segment and keeps the identity uppercase", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
    ];
    const map = canonicalPaths(nodes);
    const path = map.get(`task_${uT1}`)!;
    assert.ok(path.includes("task-a--01drz3ndektsv4rrffq69g5fav"));
    assert.ok(!path.includes("01DRZ3NDEKTSV4RRFFQ69G5FAV"));
    assert.ok(map.has(`task_${uT1}`));
  });

  it("orders task ordinals by the Kahn walk, not identity order", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`, [
        `task_${uT3}`,
      ]),
      node(`task_${uT2}`, "task", "Task B", `objective_${uO1}`),
      node(`task_${uT3}`, "task", "Task C", `objective_${uO1}`),
    ];
    const map = canonicalPaths(nodes);
    assert.equal(
      map.get(`task_${uT1}`),
      "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/03-task-a--01drz3ndektsv4rrffq69g5fav.md",
    );
    assert.equal(
      map.get(`task_${uT2}`),
      "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/01-task-b--01erz3ndektsv4rrffq69g5fav.md",
    );
    assert.equal(
      map.get(`task_${uT3}`),
      "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/02-task-c--01frz3ndektsv4rrffq69g5fav.md",
    );
  });

  it("zero-pads task ordinals to max(2, digits of the sibling count)", () => {
    const objectiveOrdinals = (count: number): readonly string[] => {
      const tasks = Array.from({ length: count }, (_, i) =>
        node(`task_${ulid(i + 1)}`, "task", "Task", `objective_${uO1}`),
      );
      const map = canonicalPaths([
        node(`initiative_${uI}`, "initiative", "Initiative", null),
        node(
          `objective_${uO1}`,
          "objective",
          "Objective One",
          `initiative_${uI}`,
        ),
        ...tasks,
      ]);
      return tasks
        .map((t) => map.get(t.identity)!.split("/").at(-1)!.split("-")[0]!)
        .sort();
    };
    assert.equal(objectiveOrdinals(1)[0], "01");
    assert.equal(objectiveOrdinals(9)[0], "01");
    assert.equal(objectiveOrdinals(9).at(-1), "09");
    assert.equal(objectiveOrdinals(10)[0], "01");
    assert.equal(objectiveOrdinals(10).at(-1), "10");
    assert.equal(objectiveOrdinals(100)[0], "001");
    assert.equal(objectiveOrdinals(100).at(-1), "100");
  });

  it("treats every dependency edge as active, so a store-waived edge still orders the walk", () => {
    const build = (): readonly CanonicalNode[] => [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`, [
        `task_${uT3}`,
      ]),
      node(`task_${uT2}`, "task", "Task B", `objective_${uO1}`),
      node(`task_${uT3}`, "task", "Task C", `objective_${uO1}`),
    ];
    const waivedInSource = canonicalPaths(build());
    const unwaived = canonicalPaths(build());
    assert.deepEqual(waivedInSource, unwaived);
    assert.equal(
      waivedInSource.get(`task_${uT1}`)?.includes("/03-task-a--"),
      true,
    );
  });

  it("adding a sibling whose identity sorts first renames nothing", () => {
    const four = [
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
      node(`task_${uT2}`, "task", "Task B", `objective_${uO1}`),
      node(`task_${uT3}`, "task", "Task C", `objective_${uO1}`),
      node(`task_${uT4}`, "task", "Task D", `objective_${uO1}`),
    ];
    const base = (
      tasks: readonly CanonicalNode[],
    ): readonly CanonicalNode[] => [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      ...tasks,
    ];
    const map4 = canonicalPaths(base(four));
    const five = [
      node(`task_${u0}`, "task", "Task A", `objective_${uO1}`, [
        `task_${uT1}`,
        `task_${uT2}`,
        `task_${uT3}`,
        `task_${uT4}`,
      ]),
      ...four,
    ];
    const map5 = canonicalPaths(base(five));
    for (const t of four) {
      assert.equal(map5.get(t.identity), map4.get(t.identity));
    }
    assert.equal(
      map5.get(`task_${u0}`),
      "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/05-task-a--00azz3ndektsv4rrffq69g5fav.md",
    );
  });

  it("two siblings with the same title get different paths", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
      node(`task_${uT2}`, "task", "Task A", `objective_${uO1}`),
    ];
    const map = canonicalPaths(nodes);
    const p1 = map.get(`task_${uT1}`)!;
    const p2 = map.get(`task_${uT2}`)!;
    assert.notEqual(p1, p2);
    assert.ok(p1.includes("task-a--01drz3ndektsv4rrffq69g5fav"));
    assert.ok(p2.includes("task-a--01erz3ndektsv4rrffq69g5fav"));
  });

  it("a title that slugs to node produces node--<ulid>, and two such siblings do not collide", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "日本語", `objective_${uO1}`),
      node(`task_${uT2}`, "task", "!!!", `objective_${uO1}`),
    ];
    const map = canonicalPaths(nodes);
    const p1 = map.get(`task_${uT1}`)!;
    const p2 = map.get(`task_${uT2}`)!;
    assert.notEqual(p1, p2);
    assert.ok(p1.includes("node--01drz3ndektsv4rrffq69g5fav"));
    assert.ok(p2.includes("node--01erz3ndektsv4rrffq69g5fav"));
  });

  it("is deterministic across two calls and a reversed array, order included", () => {
    const nodes = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
    ];
    const first = canonicalPaths(nodes);
    const second = canonicalPaths(nodes);
    const reversed = canonicalPaths([...nodes].reverse());
    assert.deepEqual(second, first);
    assert.deepEqual(reversed, first);
    assert.deepEqual([...reversed.entries()], [...first.entries()]);
  });
});
