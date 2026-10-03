import assert from "node:assert/strict";
import { ulid } from "ulid";
import type { MachineIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  OperationResultType,
  type ExecutionClaim,
  type OperationResult,
} from "../kernel/operation.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionAssessmentResult,
  ActionNodeState,
  ActionResultKind,
  ActionReadMethod,
  RepositoryAction,
  WorkerErrorCode,
  type ActionContext,
  type ActionRequestResult,
  type ActionResultItem,
  type ActionOperands,
  type PlatformAddress,
  type IntakeActionCall,
} from "./contract.ts";
import {
  DispatchReservations,
  ExecutionMutex,
  type ReservationKey,
} from "./action-reservations.ts";
import { operandsOf } from "./action-operands.ts";
import {
  isResultClass,
  performedItem,
  recordedItem,
  readRefusalItem,
} from "./action-classify.ts";
import { fulfils, sameRepository } from "./action-reuse.ts";
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
type Pending = {
  entry: ActionContext["actions"][number];
  key: ReservationKey;
  operands: ActionOperands;
  reservation: ReturnType<DispatchReservations["acquire"]>;
};

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
      const pending = this.reserve(claim, context);
      const items: ActionResultItem[] = [];
      for (const action of pending) {
        if ("held" in action.reservation) {
          items.push(action.reservation.held);
          continue;
        }
        const item = await this.dispatch(caller, claim, action);
        this.reservations.settle(
          action.key,
          action.reservation.owner,
          item.kind === ActionResultKind.Uncertain ? item : null,
        );
        items.push(item);
      }
      return { toolName: ACTION_REQUEST_TOOL_NAME, items };
    });
  }

  private reserve(claim: ExecutionClaim, context: ActionContext): Pending[] {
    const entries = context.actions
      .filter((entry) => entry.eligible)
      .sort((left, right) =>
        left.action.key < right.action.key
          ? -1
          : left.action.key > right.action.key
            ? 1
            : 0,
      );
    const prepared = entries.map((entry) => ({
      entry,
      operands: operandsOf(claim.nodeId, context, entry),
      key: {
        nodeId: claim.nodeId,
        attempt: claim.attempt,
        action: { key: entry.action.key, bindingId: entry.action.bindingId },
      },
    }));
    return prepared.map((action) => ({
      ...action,
      reservation: this.reservations.acquire(action.key),
    }));
  }

  private async dispatch(
    caller: PerformerCaller,
    claim: ExecutionClaim,
    pending: Pending,
  ): Promise<ActionResultItem> {
    const call = { ...caller, executionId: claim.executionId };
    const refusal = await this.reuse(call, pending);
    if (refusal) return refusal;
    const answer = await this.dependencies.intakeActions.perform(
      call,
      pending.entry.action,
      pending.operands,
    );
    const item = performedItem(pending.key.action, answer);
    if (item) return item;
    assert.ok(!isResultClass(answer));
    return this.record(caller, claim, pending, answer);
  }

  private async reuse(
    call: IntakeActionCall,
    pending: Pending,
  ): Promise<ActionResultItem | null> {
    const { entry, operands } = pending;
    assert.ok(entry.action.key);
    assert.ok(entry.resourceIdentity);
    if (entry.action.action !== RepositoryAction.PullRequest) return null;
    for (const candidate of entry.reuseCandidates) {
      if (!sameRepository(candidate, entry.resourceIdentity)) continue;
      const answer = await this.dependencies.intakeActions.read(
        call,
        ActionReadMethod.PullRequestGet,
        candidate.address,
      );
      if (isResultClass(answer))
        return readRefusalItem(pending.key.action, answer);
      if (!fulfils(answer.body, operands, entry.resourceIdentity)) continue;
      operands.reusedAddress = candidate.address;
      break;
    }
    return null;
  }

  private async record(
    caller: PerformerCaller,
    claim: ExecutionClaim,
    pending: Pending,
    address: PlatformAddress,
  ): Promise<ActionResultItem> {
    let result: OperationResult<unknown>;
    try {
      result = await this.dependencies.evidenceRequests.request(
        {
          params: { nodeId: claim.nodeId },
          query: {},
          body: {
            executionId: claim.executionId,
            attempt: claim.attempt,
            nodeRevision: claim.pinnedRevision,
            requirementKey: pending.entry.action.key,
            subject: pending.entry.action.key,
            address,
          },
        },
        { ...caller, idempotencyKey: ulid() },
      );
    } catch {
      result = { type: OperationResultType.Indeterminate };
    }
    return recordedItem(pending.key.action, address, result);
  }
}
