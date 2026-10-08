import assert from "node:assert/strict";
import { ulid } from "ulid";
import type { MachineIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";
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
  PlatformAddressKind,
  RepositoryAction,
  Uncertainty,
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
type UncertainItem = Extract<
  ActionResultItem,
  { kind: typeof ActionResultKind.Uncertain }
>;
const UNWIRED_CODE = "system.composition.unwired";

function requestKeyOf(pending: Pending): string {
  const base = `${pending.key.nodeId}/${pending.key.attempt}/${pending.entry.action.key}`;
  if (pending.entry.action.action === RepositoryAction.MergePush)
    return `${base}/${pending.operands.commit}`;
  const reused = pending.operands.reusedAddress;
  if (reused?.kind === PlatformAddressKind.PullRequest)
    return `${base}/${reused.number}/${pending.operands.commit}`;
  return base;
}

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
      assert.equal(running.node_id, claim.nodeId);
      assert.equal(running.attempt, claim.attempt);
      assert.equal(running.pinned_revision, claim.pinnedRevision);
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
      if (context.current_assessment?.result !== ActionAssessmentResult.Success)
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
      try {
        for (const action of pending)
          items.push(
            "held" in action.reservation
              ? action.reservation.held
              : await this.dispatch(caller, claim, action),
          );
        return { tool_name: ACTION_REQUEST_TOOL_NAME, items };
      } finally {
        for (const action of pending) {
          if ("owner" in action.reservation)
            this.reservations.settle(
              action.key,
              action.reservation.owner,
              null,
            );
        }
      }
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
        action: {
          key: entry.action.key,
          binding_id: entry.action.binding_id,
        },
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
    assert.ok("owner" in pending.reservation);
    assert.equal(pending.key.nodeId, claim.nodeId);
    const authorized = this.dependencies.store.transaction((tx) =>
      this.dependencies.missionActions.authorizeAction(
        tx,
        claim,
        pending.entry.action.key,
      ),
    );
    assert.deepEqual(authorized, pending.entry.action);
    const call = { ...caller, executionId: claim.executionId };
    let settlement: UncertainItem | null = null;
    try {
      const refusal = await this.reuse(call, claim, pending);
      if (refusal) return refusal;
      this.dependencies.store.transaction((tx) =>
        this.dependencies.missionActions.authorizeAction(
          tx,
          claim,
          pending.entry.action.key,
        ),
      );
      settlement = {
        kind: ActionResultKind.Uncertain,
        action: pending.key.action,
        uncertainty: Uncertainty.Effect,
      };
      const answer = await this.performIntake(call, pending, () => {
        settlement = null;
      });
      const item = performedItem(pending.key.action, answer);
      if (item) {
        settlement = item.kind === ActionResultKind.Uncertain ? item : null;
        return item;
      }
      assert.ok(!isResultClass(answer));
      settlement = {
        kind: ActionResultKind.Uncertain,
        action: pending.key.action,
        uncertainty: Uncertainty.Recording,
        address: answer,
      };
      const recorded = await this.record(caller, claim, pending, answer);
      settlement =
        recorded.kind === ActionResultKind.Uncertain ? recorded : null;
      return recorded;
    } finally {
      this.reservations.settle(
        pending.key,
        pending.reservation.owner,
        settlement,
      );
    }
  }

  private async performIntake(
    call: IntakeActionCall,
    pending: Pending,
    noEffect: () => void,
  ) {
    try {
      return await this.dependencies.intakeActions.perform(
        call,
        {
          key: pending.entry.action.key,
          commit: pending.operands.commit,
          reusedEvidenceId: pending.operands.reusedEvidenceId,
        },
        requestKeyOf(pending),
      );
    } catch (error) {
      if (error instanceof CodedError && error.code === UNWIRED_CODE)
        noEffect();
      throw error;
    }
  }

  private async reuse(
    call: IntakeActionCall,
    claim: ExecutionClaim,
    pending: Pending,
  ): Promise<ActionResultItem | null> {
    const { entry, operands } = pending;
    assert.ok(entry.action.key);
    assert.ok(entry.resource_identity);
    if (entry.action.action !== RepositoryAction.PullRequest) return null;
    for (const candidate of entry.reuse_candidates) {
      if (!sameRepository(candidate, entry.resource_identity)) continue;
      this.dependencies.store.transaction((tx) =>
        this.dependencies.missionActions.authorizeRequest(
          tx,
          candidate.evidence_id,
          claim,
        ),
      );
      const answer = await this.dependencies.intakeActions.read(
        call,
        ActionReadMethod.PullRequestGet,
        candidate.evidence_id,
        {},
      );
      if (isResultClass(answer))
        return readRefusalItem(pending.key.action, answer);
      if (!fulfils(answer.body, operands, entry.resource_identity)) continue;
      operands.reusedAddress = candidate.address;
      operands.reusedEvidenceId = candidate.evidence_id;
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
          params: { node_id: claim.nodeId },
          query: {},
          body: {
            execution_id: claim.executionId,
            attempt: claim.attempt,
            node_revision: claim.pinnedRevision,
            requirement_key: pending.entry.action.key,
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
