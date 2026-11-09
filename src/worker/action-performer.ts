import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { MachineIdentity } from "../kernel/caller.ts";
import { Landing } from "../project/contract.ts";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  type ExecutionClaim,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionAssessmentResult,
  type ActionContext,
  ActionNodeState,
  type ActionOperands,
  ActionReadMethod,
  type ActionRef,
  type ActionRequestResult,
  ActionResolution,
  type ActionResultItem,
  ActionResultKind,
  ConversationAction,
  type IntakeActionCall,
  type PlatformAddress,
  PlatformAddressKind,
  RepositoryAction,
  type RepositoryActionEntry,
  type RequiredCheckRead,
  requiredCheckReadSchema,
  Uncertainty,
  WorkerErrorCode,
} from "./contract.ts";
import {
  DispatchReservations,
  ExecutionMutex,
  type ReservationKey,
} from "./action-reservations.ts";
import { operandsOf } from "./action-operands.ts";
import {
  isReplyEntry,
  replyBodyOf,
  type ReplyEntry,
  replyKeyOf,
} from "./action-reply.ts";
import {
  isResultClass,
  performedItem,
  readRefusalItem,
  recordedItem,
} from "./action-classify.ts";
import { fulfils, sameRepository } from "./action-reuse.ts";
import type { Dependencies } from "./service.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";

type PerformerDependencies = Pick<
  Dependencies,
  | "store"
  | "schedulerClaims"
  | "missionActions"
  | "intakeActions"
  | "evidenceRequests"
> & { logger: Pick<Logger, "warn"> | null };
type PerformerCaller = { context: Context; identity: MachineIdentity };
type Pending = {
  entry: RepositoryActionEntry;
  key: ReservationKey;
  operands: ActionOperands;
  reservation: ReturnType<DispatchReservations["acquire"]>;
};
type UncertainItem = Extract<
  ActionResultItem,
  { kind: typeof ActionResultKind.Uncertain }
>;
interface DispatchState {
  settlement: UncertainItem | null;
}
interface DispatchScope {
  caller: PerformerCaller;
  claim: ExecutionClaim;
  pending: Pending;
  call: IntakeActionCall;
  state: DispatchState;
}
interface CheckBlock {
  message: string;
  fields: Partial<Pick<RequiredCheckRead, "pending" | "failed">>;
}
const IN_FLIGHT_CODE = "intake.outbound.request.in_flight";
const MERGE_SKIPPED_MESSAGE = "merge skipped: gate files changed";
const NO_GATE_FILES = 0;
const NO_CHECKS = 0;
const HEAD_COMMIT_CHANGED_MESSAGE = "merge skipped: head commit changed";
const CHECKS_PENDING_MESSAGE = "merge deferred: required checks pending";
const CHECKS_FAILED_MESSAGE = "merge skipped: required checks failed";
const CHECK_READ_FAILED_MESSAGE = "required check read failed";
const MERGE_REFUSED_MESSAGE = "merge request refused";

function isRepositoryEntry(
  entry: ActionContext["actions"][number],
): entry is RepositoryActionEntry {
  return entry.action.action !== ConversationAction.Reply;
}

function landsByKanthorD(entry: Pending["entry"]): boolean {
  return (
    entry.action.configuration.landing === Landing.KanthorD &&
    entry.gate_files.length === NO_GATE_FILES
  );
}

function checkBlockOf(
  data: RequiredCheckRead,
  commit: string,
): CheckBlock | null {
  if (data.head_commit !== commit)
    return { message: HEAD_COMMIT_CHANGED_MESSAGE, fields: {} };
  if (data.pending.length > NO_CHECKS)
    return {
      message: CHECKS_PENDING_MESSAGE,
      fields: { pending: data.pending },
    };
  if (data.failed.length > NO_CHECKS)
    return { message: CHECKS_FAILED_MESSAGE, fields: { failed: data.failed } };
  return null;
}

function recordsOnly(entry: Pending["entry"]): boolean {
  return entry.action.action === RepositoryAction.Push;
}

function provesNoWrite(error: unknown): boolean {
  if (!(error instanceof OperationError)) return false;
  assert.ok(error.code.length, "A refusal names its code.");
  assert.ok(Number.isInteger(error.status), "A refusal carries a status.");
  if (error.code === IN_FLIGHT_CODE) return false;
  return (
    error.status >= HttpStatus.BadRequest &&
    error.status < HttpStatus.InternalServerError
  );
}

function requestKeyOf(pending: Pending): string {
  const base = `${pending.key.nodeId}/${pending.key.attempt}/${pending.entry.action.key}`;
  if (pending.entry.action.action === RepositoryAction.Push)
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
        await this.requestReworkMerges(
          { ...caller, executionId: claim.executionId },
          claim,
          context,
        );
        items.push(...(await this.performReplies(caller, claim, context)));
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

  private async performReplies(
    caller: PerformerCaller,
    claim: ExecutionClaim,
    context: ActionContext,
  ): Promise<ActionResultItem[]> {
    if (!context.actions.some((entry) => isReplyEntry(entry) && entry.eligible))
      return [];
    const fresh = this.admit(claim);
    const items: ActionResultItem[] = [];
    const entries = fresh.actions
      .filter(isReplyEntry)
      .filter((entry) => entry.eligible)
      .sort((left, right) =>
        left.action.key < right.action.key
          ? -1
          : left.action.key > right.action.key
            ? 1
            : 0,
      );
    for (const entry of entries)
      items.push(await this.reply(caller, claim, fresh, entry));
    return items;
  }

  private async reply(
    caller: PerformerCaller,
    claim: ExecutionClaim,
    context: ActionContext,
    entry: ReplyEntry,
  ): Promise<ActionResultItem> {
    const ref = {
      key: entry.action.key,
      binding_id: entry.action.binding_id,
    };
    const key = { nodeId: claim.nodeId, attempt: claim.attempt, action: ref };
    const reservation = this.reservations.acquire(key);
    if ("held" in reservation) return reservation.held;
    try {
      const authorized = this.dependencies.store.transaction((tx) =>
        this.dependencies.missionActions.authorizeAction(tx, claim, ref.key),
      );
      assert.deepEqual(authorized, entry.action);
      const answer = await this.dependencies.intakeActions.perform(
        { ...caller, executionId: claim.executionId },
        {
          key: ref.key,
          commit: null,
          comment: replyBodyOf(context, claim.attempt),
          reusedEvidenceId: null,
        },
        replyKeyOf(claim.nodeId, claim.attempt, entry.action),
      );
      const item = performedItem(ref, answer);
      if (item) return item;
      assert.ok(!isResultClass(answer));
      return await this.record(caller, claim, { key: ref.key, ref }, answer);
    } finally {
      this.reservations.settle(key, reservation.owner, null);
    }
  }

  private reserve(claim: ExecutionClaim, context: ActionContext): Pending[] {
    const entries = context.actions
      .filter(isRepositoryEntry)
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
      operands: operandsOf(claim.nodeBranch, context, entry),
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
    const scope: DispatchScope = {
      caller,
      claim,
      pending,
      call: { ...caller, executionId: claim.executionId },
      state: { settlement: null },
    };
    try {
      return await this.performDispatch(scope);
    } finally {
      this.reservations.settle(
        pending.key,
        pending.reservation.owner,
        scope.state.settlement,
      );
    }
  }

  private async performDispatch(
    scope: DispatchScope,
  ): Promise<ActionResultItem> {
    const { claim, pending, call } = scope;
    const refusal = await this.reuse(call, claim, pending);
    if (refusal) return refusal;
    this.dependencies.store.transaction((tx) =>
      this.dependencies.missionActions.authorizeAction(
        tx,
        claim,
        pending.entry.action.key,
      ),
    );
    if (recordsOnly(pending.entry)) return this.dispatchRecordsOnly(scope);
    return this.dispatchPerformed(scope);
  }

  private async dispatchRecordsOnly(
    scope: DispatchScope,
  ): Promise<ActionResultItem> {
    const { caller, claim, pending, state } = scope;
    const address: PlatformAddress = {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: pending.entry.resource_identity,
      branch: pending.operands.baseBranch,
      commit: pending.operands.commit,
    };
    state.settlement = {
      kind: ActionResultKind.Uncertain,
      action: pending.key.action,
      uncertainty: Uncertainty.Recording,
      address,
    };
    const landing = await this.record(
      caller,
      claim,
      { key: pending.entry.action.key, ref: pending.key.action },
      address,
    );
    state.settlement =
      landing.kind === ActionResultKind.Uncertain ? landing : null;
    if (
      landing.kind === ActionResultKind.Submitted &&
      pending.entry.gate_files.length > NO_GATE_FILES
    )
      this.warnMergeSkipped(
        landing.evidence.id as string,
        pending.entry.gate_files,
      );
    return landing;
  }

  private async dispatchPerformed(
    scope: DispatchScope,
  ): Promise<ActionResultItem> {
    const { caller, claim, pending, call, state } = scope;
    state.settlement = {
      kind: ActionResultKind.Uncertain,
      action: pending.key.action,
      uncertainty: Uncertainty.Effect,
    };
    const answer = await this.performIntake(call, pending, () => {
      state.settlement = null;
    });
    const item = performedItem(pending.key.action, answer);
    if (item) {
      state.settlement = item.kind === ActionResultKind.Uncertain ? item : null;
      return item;
    }
    assert.ok(!isResultClass(answer));
    state.settlement = {
      kind: ActionResultKind.Uncertain,
      action: pending.key.action,
      uncertainty: Uncertainty.Recording,
      address: answer,
    };
    const recorded = await this.record(
      caller,
      claim,
      { key: pending.entry.action.key, ref: pending.key.action },
      answer,
    );
    state.settlement =
      recorded.kind === ActionResultKind.Uncertain ? recorded : null;
    if (
      recorded.kind === ActionResultKind.Submitted &&
      answer.kind === PlatformAddressKind.PullRequest
    )
      await this.landRecordedPullRequest(scope, recorded.evidence.id as string);
    return recorded;
  }

  private async landRecordedPullRequest(
    scope: DispatchScope,
    evidenceId: string,
  ): Promise<void> {
    const { claim, pending, call } = scope;
    const { entry } = pending;
    if (
      entry.action.action !== RepositoryAction.PullRequest ||
      entry.action.configuration.landing !== Landing.KanthorD
    )
      return;
    if (!landsByKanthorD(entry)) {
      this.warnMergeSkipped(evidenceId, entry.gate_files);
      return;
    }
    await this.requestMerge(
      call,
      claim.nodeId,
      claim.attempt,
      entry.action.key,
      pending.operands.commit,
      evidenceId,
    ).catch((error: unknown) => {
      this.dependencies.logger?.warn(
        {
          evidence_id: evidenceId,
          code: error instanceof OperationError ? error.code : undefined,
        },
        "merge request failed",
      );
    });
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
      if (provesNoWrite(error)) noEffect();
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
    pending: { key: string; ref: ActionRef },
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
            requirement_key: pending.key,
            subject: pending.key,
            address,
          },
        },
        { ...caller, idempotencyKey: createIdempotencyKey() },
      );
    } catch {
      result = { type: OperationResultType.Indeterminate };
    }
    return recordedItem(pending.ref, address, result);
  }

  private async requestReworkMerges(
    call: IntakeActionCall,
    claim: ExecutionClaim,
    context: ActionContext,
  ): Promise<void> {
    for (const entry of context.actions) {
      if (
        !isRepositoryEntry(entry) ||
        entry.resolution !== ActionResolution.Unresolved ||
        entry.action.action !== RepositoryAction.PullRequest ||
        entry.action.configuration.landing !== Landing.KanthorD ||
        entry.request_evidence_id === null
      )
        continue;
      const evidenceId = entry.request_evidence_id;
      if (!landsByKanthorD(entry)) {
        this.warnMergeSkipped(evidenceId, entry.gate_files);
        continue;
      }
      await Promise.resolve()
        .then(() => {
          const operands = operandsOf(claim.nodeBranch, context, entry);
          return this.requestMerge(
            call,
            claim.nodeId,
            claim.attempt,
            entry.action.key,
            operands.commit,
            evidenceId,
          );
        })
        .catch((error: unknown) => {
          this.dependencies.logger?.warn(
            {
              evidence_id: evidenceId,
              code: error instanceof OperationError ? error.code : undefined,
            },
            "merge request failed",
          );
        });
    }
  }

  private warnMergeSkipped(evidenceId: string, gateFiles: string[]): void {
    this.dependencies.logger?.warn(
      { evidence_id: evidenceId, gate_files: gateFiles },
      MERGE_SKIPPED_MESSAGE,
    );
  }

  private async requestMerge(
    call: IntakeActionCall,
    nodeId: string,
    attempt: number,
    actionKey: string,
    commit: string,
    evidenceId: string,
  ): Promise<void> {
    if (await this.mergeBlocked(call, commit, evidenceId)) return;
    const mergeRequestKey = `${nodeId}/${attempt}/${actionKey}/merge/${commit}`;
    const answer = await this.dependencies.intakeActions.perform(
      call,
      {
        key: actionKey,
        commit,
        reusedEvidenceId: null,
        mergeEvidenceId: evidenceId,
      },
      mergeRequestKey,
    );
    if (isResultClass(answer))
      this.dependencies.logger?.warn(
        { evidence_id: evidenceId, class: answer.class, code: answer.code },
        MERGE_REFUSED_MESSAGE,
      );
  }

  private async mergeBlocked(
    call: IntakeActionCall,
    commit: string,
    evidenceId: string,
  ): Promise<boolean> {
    const answer = await this.dependencies.intakeActions.read(
      call,
      ActionReadMethod.RequiredCheckGet,
      evidenceId,
      {},
    );
    if (isResultClass(answer)) {
      this.dependencies.logger?.warn(
        { evidence_id: evidenceId, class: answer.class, code: answer.code },
        CHECK_READ_FAILED_MESSAGE,
      );
      return true;
    }
    const parsed = requiredCheckReadSchema.safeParse(answer.body);
    if (!parsed.success) {
      this.dependencies.logger?.warn(
        { evidence_id: evidenceId },
        CHECK_READ_FAILED_MESSAGE,
      );
      return true;
    }
    const block = checkBlockOf(parsed.data, commit);
    if (!block) return false;
    this.dependencies.logger?.warn(
      { evidence_id: evidenceId, ...block.fields },
      block.message,
    );
    return true;
  }
}
