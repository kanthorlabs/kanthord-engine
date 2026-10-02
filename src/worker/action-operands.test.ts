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
    bindingId: BINDING,
    action: RepositoryAction.PullRequest,
    expectedEndState: "pull_request_merged",
    follows: null,
    configuration: { baseBranch: "main" },
  },
  resourceIdentity: "repository:github:owner/gated",
  resolution: ActionResolution.Unrequested,
  requestEvidenceId: null,
  eligible: true,
  reuseCandidates: [],
};
const snapshot = {
  kind: TestedInputKind.Repository,
  bindingId: BINDING,
  commit: COMMIT,
};
function context(testedInput: TestedInput): ActionContext {
  return {
    state: ActionNodeState.Evaluating,
    currentAssessment: { result: ActionAssessmentResult.Success, testedInput },
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
    { ...snapshot, bindingId: "binding_other" },
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
        { ...context(snapshot), currentAssessment: null },
        entry,
      ),
    { code: WorkerErrorCode.SnapshotAbsent },
  );
});
