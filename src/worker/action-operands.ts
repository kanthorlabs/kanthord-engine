import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  TestedInputKind,
  WorkerErrorCode,
  type ActionContext,
  type ActionOperands,
} from "./contract.ts";
import { nodeBranchOf } from "./node-branch.ts";

export function operandsOf(
  nodeId: string,
  context: ActionContext,
  entry: ActionContext["actions"][number],
): ActionOperands {
  assert.ok(entry.action.key);
  assert.ok(entry.action.configuration.base_branch);
  const testedInput = context.current_assessment?.tested_input;
  if (
    !testedInput ||
    Array.isArray(testedInput) ||
    testedInput.kind !== TestedInputKind.Repository ||
    testedInput.binding_id !== entry.action.binding_id
  )
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.SnapshotAbsent,
      "The assessment names no repository snapshot of the action binding.",
      { requirement_key: entry.action.key },
    );
  return {
    nodeBranch: nodeBranchOf(nodeId),
    baseBranch: entry.action.configuration.base_branch,
    commit: testedInput.commit,
    reusedAddress: null,
    reusedEvidenceId: null,
  };
}
