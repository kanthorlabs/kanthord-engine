import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionAssessmentResult,
  type ActionContext,
  ActionNodeState,
  ActionResolution,
  RepositoryAction,
  type RepositoryActionEntry,
  type TestedInput,
  TestedInputKind,
  WorkerErrorCode,
} from "./contract.ts";
import { operandsOf } from "./action-operands.ts";

const NODE_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAV-a2";
const BINDING = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const COMMIT = "b".repeat(40);
const NODE_NAME = "Ship accounts";
const entry: RepositoryActionEntry = {
  action: {
    key: "gated.pull_request",
    binding_id: BINDING,
    action: RepositoryAction.PullRequest,
    expected_end_state: "pull_request_merged",
    follows: null,
    configuration: { base_branch: "main", landing: "human" as const },
  },
  resource_identity: "repository:github:owner/gated",
  resolution: ActionResolution.Unrequested,
  request_evidence_id: null,
  eligible: true,
  gate_files: [],
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
    node_name: NODE_NAME,
    request_addresses: [],
    current_assessment: {
      result: ActionAssessmentResult.Success,
      tested_input: testedInput,
    },
    actions: [entry],
  };
}

test("non-repository and wrong-binding snapshots are refused", () => {
  const inputs: TestedInput[] = [
    { kind: TestedInputKind.Produced, sha256: "a".repeat(64) },
    [{ ...snapshot, binding_id: "binding_other" }],
    { ...snapshot, binding_id: "binding_other" },
    { kind: TestedInputKind.Object, location: "s3://bucket/key" },
  ];
  for (const input of inputs)
    assert.throws(() => operandsOf(NODE_BRANCH, context(input), entry), {
      code: WorkerErrorCode.SnapshotAbsent,
      status: 409,
    });
  assert.throws(
    () =>
      operandsOf(
        NODE_BRANCH,
        { ...context(snapshot), current_assessment: null },
        entry,
      ),
    { code: WorkerErrorCode.SnapshotAbsent },
  );
});
