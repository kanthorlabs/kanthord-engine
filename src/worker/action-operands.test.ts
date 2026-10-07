import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionAssessmentResult,
  ActionNodeState,
  ActionResolution,
  RepositoryAction,
  TestedInputKind,
  WorkerErrorCode,
  type ActionContext,
  type TestedInput,
} from "./contract.ts";
import { operandsOf } from "./action-operands.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const COMMIT = "b".repeat(40);
const entry: ActionContext["actions"][number] = {
  action: {
    key: "gated.pull_request",
    binding_id: BINDING,
    action: RepositoryAction.PullRequest,
    expected_end_state: "pull_request_merged",
    follows: null,
    configuration: { base_branch: "main" },
  },
  resource_identity: "repository:github:owner/gated",
  resolution: ActionResolution.Unrequested,
  request_evidence_id: null,
  eligible: true,
  reuse_candidates: [],
};
const snapshot = {
  kind: TestedInputKind.Repository,
  binding_id: BINDING,
  commit: COMMIT,
};
function context(testedInput: TestedInput): ActionContext {
  return {
    state: ActionNodeState.Evaluating,
    current_assessment: {
      result: ActionAssessmentResult.Success,
      tested_input: testedInput,
    },
    actions: [entry],
  };
}

test("action operands come from the admitted assessment and pinned action", () => {
  const operands = operandsOf(NODE, context(snapshot), entry);
  assert.deepEqual(operands, {
    nodeBranch: "kanthord/" + NODE,
    baseBranch: "main",
    commit: COMMIT,
    reusedAddress: null,
  });
  assert.equal(operands.commit, snapshot.commit);
});

test("non-repository, aggregate and wrong-binding snapshots are refused", () => {
  const inputs: TestedInput[] = [
    { kind: TestedInputKind.Produced, sha256: "a".repeat(64) },
    [snapshot],
    { ...snapshot, binding_id: "binding_other" },
    { kind: TestedInputKind.Object, location: "s3://bucket/key" },
  ];
  for (const input of inputs)
    assert.throws(() => operandsOf(NODE, context(input), entry), {
      code: WorkerErrorCode.SnapshotAbsent,
      status: 409,
    });
  assert.throws(
    () =>
      operandsOf(
        NODE,
        { ...context(snapshot), current_assessment: null },
        entry,
      ),
    { code: WorkerErrorCode.SnapshotAbsent },
  );
});
