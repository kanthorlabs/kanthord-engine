import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionAssessmentResult,
  ActionNodeState,
  WorkerErrorCode,
  type ActionContext,
  type ActionRequestResult,
} from "./contract.ts";
import { DispatchReservations, ExecutionMutex } from "./action-reservations.ts";
import type { Dependencies } from "./service.ts";

type PerformerDependencies = Pick<
  Dependencies,
  | "store"
  | "schedulerClaims"
  | "missionActions"
  | "intakeActions"
  | "evidenceRequests"
>;
type PerformerCaller = { context: Context; identity: MachineIdentity };

export class ActionPerformer {
  private readonly dependencies: PerformerDependencies;
  private readonly mutex: ExecutionMutex;
  private readonly reservations: DispatchReservations;

  constructor(
    dependencies: PerformerDependencies,
    mutex = new ExecutionMutex(),
    reservations = new DispatchReservations(),
  ) {
    this.dependencies = dependencies;
    this.mutex = mutex;
    this.reservations = reservations;
  }

  private admit(claim: ExecutionClaim): ActionContext {
    return this.dependencies.store.transaction((tx) => {
      const now = Date.now();
      const running = this.dependencies.schedulerClaims.requireRunning(
        tx,
        claim.executionId,
        claim.runtimeIdentity,
        now,
      );
      assert.equal(running.nodeId, claim.nodeId);
      assert.equal(running.attempt, claim.attempt);
      assert.equal(running.pinnedRevision, claim.pinnedRevision);
      const context = this.dependencies.missionActions.actionContextOf(
        tx,
        claim.nodeId,
        claim.attempt,
      );
      if (context.state !== ActionNodeState.Evaluating)
        throw new OperationError(
          HttpStatus.Conflict,
          WorkerErrorCode.ClaimNotEvaluation,
          "The claim is not an evaluation claim.",
        );
      if (context.currentAssessment?.result !== ActionAssessmentResult.Success)
        throw new OperationError(
          HttpStatus.Conflict,
          WorkerErrorCode.AssessmentNotCurrent,
          "The attempt holds no current passing assessment.",
        );
      return context;
    });
  }

  perform(
    caller: PerformerCaller,
    claim: ExecutionClaim,
  ): Promise<ActionRequestResult> {
    assert.equal(caller.identity.runtimeIdentity, claim.runtimeIdentity);
    assert.equal(caller.identity.projectId, claim.projectId);
    return this.mutex.run(claim.executionId, async () => {
      const context = this.admit(claim);
      this.reservations.prune(claim.nodeId, claim.attempt, context.actions);
      assert.ok(context.currentAssessment);
      return { toolName: ACTION_REQUEST_TOOL_NAME, items: [] };
    });
  }
}
