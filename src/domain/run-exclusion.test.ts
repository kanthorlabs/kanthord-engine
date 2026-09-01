import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  objectiveBusy,
  subtreeExclusion,
  type ExclusionRun,
  type ObjectiveBusyInput,
  type SubtreeExclusionInput,
} from "./run-exclusion.ts";

const NOW = 1700000000000;
const INITIATIVE = "initiative_a";
const OBJECTIVE = "objective_a";
const TASK = "task_a";
const OTHER_TASK = "task_b";

function run(overrides: Partial<ExclusionRun> = {}): ExclusionRun {
  return {
    runId: "run_a",
    nodeId: OBJECTIVE,
    state: "active",
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

function input(
  overrides: Partial<SubtreeExclusionInput> = {},
): SubtreeExclusionInput {
  return {
    targetId: TASK,
    ancestorIds: [OBJECTIVE],
    descendantIds: [],
    runs: [],
    now: NOW,
    ...overrides,
  };
}

function objectiveInput(
  overrides: Partial<ObjectiveBusyInput> = {},
): ObjectiveBusyInput {
  return {
    objectiveId: OBJECTIVE,
    siblingRuns: [],
    now: NOW,
    ...overrides,
  };
}

describe("src/domain/run-exclusion.test", () => {
  it("a run on an ancestor refuses a claim on a descendant, naming the ancestor", () => {
    assert.deepEqual(
      subtreeExclusion(
        input({
          ancestorIds: [INITIATIVE, OBJECTIVE],
          runs: [run()],
        }),
      ),
      {
        refusal: "subtree-busy",
        relation: "ancestor",
        nodeId: OBJECTIVE,
        runId: "run_a",
        expiresAt: NOW + 1000,
      },
    );
  });

  it("a run on a descendant refuses a claim on an ancestor, naming the descendant", () => {
    assert.deepEqual(
      subtreeExclusion(
        input({
          targetId: OBJECTIVE,
          ancestorIds: [],
          descendantIds: [TASK],
          runs: [run({ nodeId: TASK })],
        }),
      ),
      {
        refusal: "subtree-busy",
        relation: "descendant",
        nodeId: TASK,
        runId: "run_a",
        expiresAt: NOW + 1000,
      },
    );
  });

  it("a run on the target itself refuses with relation self", () => {
    const refusal = subtreeExclusion(input({ runs: [run({ nodeId: TASK })] }));
    assert.equal(refusal?.relation, "self");
  });

  it("a run on an unrelated node admits the claim", () => {
    assert.equal(
      subtreeExclusion(input({ runs: [run({ nodeId: OTHER_TASK })] })),
      null,
    );
  });

  it("an expired run in the input set does not refuse", () => {
    assert.equal(
      subtreeExclusion(input({ runs: [run({ expiresAt: NOW - 1 })] })),
      null,
    );
  });

  it("a run whose expiresAt is exactly now does not refuse", () => {
    assert.equal(
      subtreeExclusion(input({ runs: [run({ expiresAt: NOW })] })),
      null,
    );
  });

  it("a run whose expiresAt is one millisecond after now refuses", () => {
    assert.notEqual(
      subtreeExclusion(input({ runs: [run({ expiresAt: NOW + 1 })] })),
      null,
    );
  });

  it("an ended run does not refuse, even with a future expiresAt", () => {
    assert.equal(
      subtreeExclusion(
        input({ runs: [run({ state: "ended", expiresAt: NOW + 100000 })] }),
      ),
      null,
    );
  });

  it("a run with a null expiresAt refuses", () => {
    const refusal = subtreeExclusion(
      input({ runs: [run({ expiresAt: null })] }),
    );
    assert.notEqual(refusal, null);
    assert.equal(refusal?.expiresAt, null);
  });

  it("self is reported before ancestor", () => {
    const refusal = subtreeExclusion(
      input({
        runs: [
          run({ nodeId: OBJECTIVE, runId: "run_ancestor" }),
          run({ nodeId: TASK, runId: "run_self" }),
        ],
      }),
    );
    assert.equal(refusal?.relation, "self");
  });

  it("ancestor is reported before descendant", () => {
    const refusal = subtreeExclusion(
      input({
        descendantIds: [OTHER_TASK],
        runs: [
          run({ nodeId: OTHER_TASK, runId: "run_descendant" }),
          run({ nodeId: OBJECTIVE, runId: "run_ancestor" }),
        ],
      }),
    );
    assert.equal(refusal?.relation, "ancestor");
  });

  it("two live ancestor runs are broken by bytewise node id", () => {
    const refusal = subtreeExclusion(
      input({
        ancestorIds: ["objective_b", OBJECTIVE],
        runs: [
          run({ nodeId: "objective_b", runId: "run_b" }),
          run({ nodeId: OBJECTIVE, runId: "run_a" }),
        ],
      }),
    );
    assert.equal(refusal?.nodeId, OBJECTIVE);
  });

  it("the same run set in two different array orders produces a deep-equal refusal", () => {
    const runs = [
      run({ nodeId: "objective_b", runId: "run_b" }),
      run({ nodeId: OBJECTIVE, runId: "run_a" }),
    ];
    const first = input({ ancestorIds: ["objective_b", OBJECTIVE], runs });
    const second = {
      ...first,
      ancestorIds: [...first.ancestorIds].reverse(),
      runs: [...first.runs].reverse(),
    };
    assert.deepEqual(subtreeExclusion(first), subtreeExclusion(second));
  });

  it("the input arrays are not mutated", () => {
    const runs = [run({ nodeId: "objective_b", runId: "run_b" }), run()];
    const ancestorIds = ["objective_b", OBJECTIVE];
    const runsBefore = [...runs];
    const ancestorIdsBefore = [...ancestorIds];
    subtreeExclusion(input({ ancestorIds, runs }));
    assert.deepEqual(runs, runsBefore);
    assert.deepEqual(ancestorIds, ancestorIdsBefore);
  });

  it("an empty run set admits the claim", () => {
    assert.equal(subtreeExclusion(input({ runs: [] })), null);
  });

  describe("objectiveBusy", () => {
    it("a sibling task with an active run refuses, naming the sibling node, its run and its expiresAt", () => {
      assert.deepEqual(
        objectiveBusy(
          objectiveInput({
            siblingRuns: [run({ nodeId: OTHER_TASK, expiresAt: NOW + 5000 })],
          }),
        ),
        {
          refusal: "objective-busy",
          objectiveId: OBJECTIVE,
          siblingNodeId: OTHER_TASK,
          siblingRunId: "run_a",
          expiresAt: NOW + 5000,
        },
      );
    });

    it("a sibling task with an ended run admits", () => {
      assert.equal(
        objectiveBusy(
          objectiveInput({
            siblingRuns: [run({ state: "ended", expiresAt: NOW + 100000 })],
          }),
        ),
        null,
      );
    });

    it("a sibling task with an expired run admits", () => {
      assert.equal(
        objectiveBusy(
          objectiveInput({ siblingRuns: [run({ expiresAt: NOW - 1 })] }),
        ),
        null,
      );
    });

    it("a sibling run whose expiresAt is exactly now admits", () => {
      assert.equal(
        objectiveBusy(
          objectiveInput({ siblingRuns: [run({ expiresAt: NOW })] }),
        ),
        null,
      );
    });

    it("an empty sibling set admits", () => {
      assert.equal(objectiveBusy(objectiveInput({ siblingRuns: [] })), null);
    });

    it("a sibling run with a null expiresAt refuses and reports a null expiresAt", () => {
      const refusal = objectiveBusy(
        objectiveInput({ siblingRuns: [run({ expiresAt: null })] }),
      );
      assert.notEqual(refusal, null);
      assert.equal(refusal?.expiresAt, null);
    });

    it("two live sibling runs are broken by bytewise node id", () => {
      const refusal = objectiveBusy(
        objectiveInput({
          siblingRuns: [
            run({ nodeId: "task_c", runId: "run_c" }),
            run({ nodeId: OTHER_TASK, runId: "run_b" }),
          ],
        }),
      );
      assert.equal(refusal?.siblingNodeId, OTHER_TASK);
    });

    it("two live sibling runs on the same node are broken by bytewise run id", () => {
      const refusal = objectiveBusy(
        objectiveInput({
          siblingRuns: [
            run({ nodeId: OTHER_TASK, runId: "run_b" }),
            run({ nodeId: OTHER_TASK, runId: "run_a" }),
          ],
        }),
      );
      assert.equal(refusal?.siblingRunId, "run_a");
    });

    it("the same sibling set in two array orders produces a deep-equal refusal", () => {
      const siblingRuns = [
        run({ nodeId: "task_c", runId: "run_c" }),
        run({ nodeId: OTHER_TASK, runId: "run_b" }),
      ];
      const first = objectiveInput({ siblingRuns });
      const second = {
        ...first,
        siblingRuns: [...first.siblingRuns].reverse(),
      };
      assert.deepEqual(objectiveBusy(first), objectiveBusy(second));
    });

    it("the refusal carries no fence key", () => {
      const refusal = objectiveBusy(
        objectiveInput({ siblingRuns: [run({ nodeId: OTHER_TASK })] }),
      );
      assert.notEqual(refusal, null);
      assert.equal(Object.keys(refusal!).includes("fence"), false);
    });

    it("the input array is not mutated", () => {
      const siblingRuns = [
        run({ nodeId: "task_c", runId: "run_c" }),
        run({ nodeId: OTHER_TASK, runId: "run_b" }),
      ];
      const siblingRunsBefore = [...siblingRuns];
      objectiveBusy(objectiveInput({ siblingRuns }));
      assert.deepEqual(siblingRuns, siblingRunsBefore);
    });

    it("objectiveBusy and subtreeExclusion agree on the liveness boundary", () => {
      for (const expiresAt of [NOW - 1, NOW, NOW + 1]) {
        const siblingRun = run({ expiresAt });
        assert.equal(
          objectiveBusy(objectiveInput({ siblingRuns: [siblingRun] })) === null,
          subtreeExclusion(input({ runs: [siblingRun] })) === null,
        );
      }
    });
  });
});
