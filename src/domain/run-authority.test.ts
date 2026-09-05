import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertRunAuthority, runAuthorityRefusals } from "./run-authority.ts";

const NOW = 1700000000000;
const RUN_ID = "run_a";
const NODE_ID = "task_a";
const CALLER = "general@1";

const validInput = {
  run: {
    id: RUN_ID,
    nodeId: NODE_ID,
    state: "active" as const,
    fence: 4,
    expiresAt: NOW + 1,
    worker: CALLER,
  },
  runId: RUN_ID,
  fence: 4,
  targetNodeId: NODE_ID,
  subtreeIds: [] as readonly string[],
  caller: CALLER,
  now: NOW,
};

describe("src/domain/run-authority.test", () => {
  it("a valid input returns null", () => {
    assert.equal(assertRunAuthority(validInput), null);
  });

  it("run-not-found when the run is null", () => {
    const result = assertRunAuthority({ ...validInput, run: null });

    assert.deepEqual(result, { refusal: "run-not-found", runId: RUN_ID });
  });

  it("run-not-found when the run id does not match", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, id: "run_b" },
    });

    assert.equal(result?.refusal, "run-not-found");
  });

  it("run-ended when the run state is ended", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, state: "ended" },
    });

    assert.equal(result?.refusal, "run-ended");
  });

  it("run-expired when expiresAt is before now", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, expiresAt: NOW - 1 },
    });

    assert.equal(result?.refusal, "run-expired");
  });

  it("run-expired when expiresAt is exactly now", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, expiresAt: NOW },
    });

    assert.equal(result?.refusal, "run-expired");
  });

  it("a run whose expiresAt is one millisecond after now passes", () => {
    assert.equal(
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, expiresAt: NOW + 1 },
      }),
      null,
    );
  });

  it("a run with a null expiresAt passes", () => {
    assert.equal(
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, expiresAt: null },
      }),
      null,
    );
  });

  it("run-caller-mismatch when the worker differs from the caller", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, worker: "tdd@1" },
    });

    assert.equal(result?.refusal, "run-caller-mismatch");
  });

  it("run-caller-mismatch when the run worker is null", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, worker: null },
    });

    assert.equal(result?.refusal, "run-caller-mismatch");
  });

  it("target-outside-run when the target is neither the run node nor in the subtree", () => {
    const result = assertRunAuthority({
      ...validInput,
      targetNodeId: "task_z",
      subtreeIds: ["task_b"],
    });

    assert.equal(result?.refusal, "target-outside-run");
  });

  it("the run's own node is always inside the run", () => {
    assert.equal(
      assertRunAuthority({
        ...validInput,
        targetNodeId: NODE_ID,
        subtreeIds: [],
      }),
      null,
    );
  });

  it("a descendant in subtreeIds is inside the run", () => {
    assert.equal(
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, nodeId: "objective_a" },
        targetNodeId: NODE_ID,
        subtreeIds: [NODE_ID],
      }),
      null,
    );
  });

  it("fence-stale when the presented fence is behind", () => {
    const result = assertRunAuthority({
      ...validInput,
      fence: 3,
    });

    assert.equal(result?.refusal, "fence-stale");
  });

  it("fence-stale when the presented fence is ahead", () => {
    const result = assertRunAuthority({
      ...validInput,
      fence: 5,
    });

    assert.equal(result?.refusal, "fence-stale");
  });

  it("fence-stale when the run fence is null", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, fence: null },
    });

    assert.equal(result?.refusal, "fence-stale");
  });

  it("an ended run presented with its own last fence refuses run-ended", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, state: "ended", fence: 4 },
      fence: 4,
    });

    assert.equal(result?.refusal, "run-ended");
  });

  it("an input failing run-ended and fence-stale reports run-ended", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, state: "ended", fence: 9 },
      fence: 1,
    });

    assert.equal(result?.refusal, "run-ended");
  });

  it("an input failing run-expired and target-outside-run reports run-expired", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, expiresAt: NOW },
      targetNodeId: "task_z",
    });

    assert.equal(result?.refusal, "run-expired");
  });

  it("an input failing run-caller-mismatch and fence-stale reports run-caller-mismatch", () => {
    const result = assertRunAuthority({
      ...validInput,
      run: { ...validInput.run, worker: "tdd@1", fence: 4 },
      fence: 1,
    });

    assert.equal(result?.refusal, "run-caller-mismatch");
  });

  it("the refusal order is exactly the pinned tuple", () => {
    assert.deepEqual(
      [...runAuthorityRefusals],
      [
        "run-not-found",
        "run-ended",
        "run-expired",
        "run-caller-mismatch",
        "target-outside-run",
        "fence-stale",
      ],
    );
    assert.equal(runAuthorityRefusals.length, 6);
  });

  it("the subtree array is not mutated", () => {
    const subtreeIds = ["task_b", "task_c"];
    const before = [...subtreeIds];

    assertRunAuthority({ ...validInput, subtreeIds });

    assert.deepEqual(subtreeIds, before);
  });

  it("no refusal carries a fence value", () => {
    const refusals = [
      assertRunAuthority({ ...validInput, run: null }),
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, state: "ended" },
      }),
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, expiresAt: NOW },
      }),
      assertRunAuthority({
        ...validInput,
        run: { ...validInput.run, worker: "tdd@1" },
      }),
      assertRunAuthority({
        ...validInput,
        targetNodeId: "task_z",
      }),
      assertRunAuthority({ ...validInput, fence: 3 }),
    ];

    for (const refusal of refusals) {
      assert.ok(refusal);
      assert.deepEqual(Object.keys(refusal).sort(), ["refusal", "runId"]);
    }
  });
});
