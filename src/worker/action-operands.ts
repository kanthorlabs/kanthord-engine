import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  TestedInputKind,
  WorkerErrorCode,
  type ActionContext,
  type ActionOperands,
} from "./contract.ts";

export function operandsOf(
  nodeBranch: string,
  context: ActionContext,
  entry: ActionContext["actions"][number],
): ActionOperands {
  assert.ok(entry.action.key);
  assert.ok(entry.action.configuration.base_branch);
  const testedInput = context.current_assessment?.tested_input;
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  const snapshot = addresses.find(
    (address) =>
      address?.kind === TestedInputKind.Repository &&
      address.binding_id === entry.action.binding_id,
  );
  if (!snapshot || snapshot.kind !== TestedInputKind.Repository)
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.SnapshotAbsent,
      "The assessment names no repository snapshot of the action binding.",
      { requirement_key: entry.action.key },
    );
  return {
    nodeBranch,
    baseBranch: entry.action.configuration.base_branch,
    commit: snapshot.commit,
    reusedAddress: null,
    reusedEvidenceId: null,
  };
}
