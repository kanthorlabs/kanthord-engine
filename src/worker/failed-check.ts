import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import {
  ActionReadMethod,
  ActionResolution,
  RepositoryAction,
  requiredCheckReadSchema,
  type FailedChecks,
  type IntakeActionCall,
} from "./contract.ts";
import { isResultClass } from "./action-classify.ts";
import type { Dependencies } from "./service.ts";

const BAD_GATEWAY_STATUS = 502;
const NO_FAILED_CHECKS = 0;

type FailedCheckDependencies = Pick<
  Dependencies,
  "store" | "missionActions" | "intakeActions"
>;

function unresolvedRequestsOf(
  dependencies: FailedCheckDependencies,
  claim: ExecutionClaim,
): { evidenceId: string; bindingId: string }[] {
  return dependencies.store.transaction((tx) =>
    dependencies.missionActions
      .actionContextOf(tx, claim.nodeId, claim.attempt)
      .actions.flatMap((entry) =>
        entry.resolution === ActionResolution.Unresolved &&
        entry.action.action === RepositoryAction.PullRequest &&
        entry.request_evidence_id !== null
          ? [
              {
                evidenceId: entry.request_evidence_id,
                bindingId: entry.action.binding_id,
              },
            ]
          : [],
      ),
  );
}

export async function failedChecks(
  dependencies: FailedCheckDependencies,
  call: IntakeActionCall,
  claim: ExecutionClaim,
): Promise<FailedChecks> {
  assert.equal(call.executionId, claim.executionId);
  const items: FailedChecks["items"] = [];
  for (const { evidenceId, bindingId } of unresolvedRequestsOf(
    dependencies,
    claim,
  )) {
    const answer = await dependencies.intakeActions.read(
      call,
      ActionReadMethod.RequiredCheckGet,
      evidenceId,
      {},
    );
    if (isResultClass(answer))
      throw new OperationError(BAD_GATEWAY_STATUS, answer.code, answer.message);
    const read = requiredCheckReadSchema.parse(answer.body);
    if (read.failed.length === NO_FAILED_CHECKS) continue;
    items.push({
      evidence_id: evidenceId,
      binding_id: bindingId,
      head_commit: read.head_commit,
      failed: read.failed,
    });
  }
  return { items };
}
