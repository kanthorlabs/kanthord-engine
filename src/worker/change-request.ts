import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import {
  ActionReadMethod,
  ActionResolution,
  RepositoryAction,
  changeRequestReadSchema,
  type ClearedChangeRequests,
  type IntakeActionCall,
} from "./contract.ts";
import { isResultClass } from "./action-classify.ts";
import type { Dependencies } from "./service.ts";

const FIRST_ATTEMPT = 1;
const BAD_GATEWAY_STATUS = 502;

type ChangeRequestDependencies = Pick<
  Dependencies,
  "store" | "missionActions" | "intakeActions"
>;

function otherEndRequestsOf(
  dependencies: ChangeRequestDependencies,
  claim: ExecutionClaim,
): { evidenceId: string; bindingId: string }[] {
  assert.ok(claim.attempt > FIRST_ATTEMPT);
  return dependencies.store.transaction((tx) =>
    dependencies.missionActions
      .actionContextOf(tx, claim.nodeId, claim.attempt - FIRST_ATTEMPT)
      .actions.flatMap((entry) =>
        entry.resolution === ActionResolution.OtherEnd &&
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

export async function clearedChangeRequests(
  dependencies: ChangeRequestDependencies,
  call: IntakeActionCall,
  claim: ExecutionClaim,
): Promise<ClearedChangeRequests> {
  assert.equal(call.executionId, claim.executionId);
  if (claim.attempt === FIRST_ATTEMPT) return { items: [] };
  const items: ClearedChangeRequests["items"] = [];
  for (const { evidenceId, bindingId } of otherEndRequestsOf(
    dependencies,
    claim,
  )) {
    const answer = await dependencies.intakeActions.read(
      call,
      ActionReadMethod.ChangeRequestGet,
      evidenceId,
      {},
    );
    if (isResultClass(answer))
      throw new OperationError(BAD_GATEWAY_STATUS, answer.code, answer.message);
    items.push({
      evidence_id: evidenceId,
      binding_id: bindingId,
      ...changeRequestReadSchema.parse(answer.body),
    });
  }
  return { items };
}
