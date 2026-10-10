import assert from "node:assert/strict";
import { z } from "zod";
import {
  ADMISSION_CONCURRENCY,
  INTAKE_SERVICE_NAME,
} from "../intake/contract.ts";
import { isServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { AuthorizationRefusal, authorizationRefused } from "./authorization.ts";
import {
  AdmissionRefusal,
  CheckEndState,
  CONTENT_ENCODING,
  Disposition,
  MissionErrorCode,
  PlatformAddressKind,
  type AdmissionAnswer,
  type deliveryAdmitSchema,
  type IntakeCheck,
  type PlatformAddress,
} from "./contract.ts";
import {
  MatchKind,
  matchRequests,
  unresolvedPullRequests,
} from "./delivery-match.ts";
import { applyEndState, requestContext } from "./node-check.ts";
import { readEvidence } from "./record-store.ts";
import type { Dependencies } from "./service.ts";

type AdmissionInput = z.output<typeof deliveryAdmitSchema>;
type CheckAnswer = Awaited<ReturnType<IntakeCheck["check"]>>;
type Checked = {
  evidenceId: string;
  address: PlatformAddress;
  check: CheckAnswer;
};
type BaseChecked = {
  base: { evidenceId: string; check: CheckAnswer }[];
};

const ACCEPTED: AdmissionAnswer = {
  disposition: Disposition.AcceptedObservation,
  reason: null,
};
const DUPLICATE: AdmissionAnswer = {
  disposition: Disposition.Duplicate,
  reason: null,
};

function authorizeAdmission(caller: CallerContext): void {
  assert.ok(caller.identity, "A service operation holds an identity.");
  assert.ok(isServiceIdentity(caller.identity));
  if (caller.identity.service !== INTAKE_SERVICE_NAME)
    authorizationRefused(AuthorizationRefusal.ServiceMismatch);
}

async function prepareAdmission(
  dependencies: Dependencies,
  caller: CallerContext,
  input: AdmissionInput,
): Promise<AdmissionAnswer | Checked | BaseChecked> {
  const address = dependencies.decoder.decode({
    platform: input.platform,
    resource: input.resource,
    event: Buffer.from(input.event, CONTENT_ENCODING),
    metadata: input.metadata,
  });
  if (address === null)
    return {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Undecodable,
    };
  const match = dependencies.store.transaction((tx) =>
    matchRequests(tx, input.project_id, address),
  );
  if (match.kind === MatchKind.Answer)
    return address.kind === PlatformAddressKind.BranchPush
      ? checkBaseRequests(dependencies, caller, input, address, match.answer)
      : match.answer;
  assert.equal(match.kind, MatchKind.Request);
  const check = await dependencies.intakeCheck.check(
    caller.context,
    match.evidence_id,
  );
  return { evidenceId: match.evidence_id, address, check };
}

async function checkBaseRequests(
  dependencies: Dependencies,
  caller: CallerContext,
  input: AdmissionInput,
  address: Extract<
    PlatformAddress,
    { kind: typeof PlatformAddressKind.BranchPush }
  >,
  unmatched: AdmissionAnswer,
): Promise<AdmissionAnswer | BaseChecked> {
  const selected = dependencies.store.transaction((tx) =>
    unresolvedPullRequests(
      tx,
      input.project_id,
      address.resource_identity,
    ).filter(
      (evidenceId) =>
        requestContext(tx, dependencies, evidenceId).frozen_action.configuration
          .base_branch === address.branch,
    ),
  );
  if (selected.length === NO_SELECTED_REQUESTS) return unmatched;
  const base: BaseChecked["base"] = [];
  for (const evidenceId of selected)
    base.push({
      evidenceId,
      check: await dependencies.intakeCheck.check(caller.context, evidenceId),
    });
  return { base };
}

function commitBaseAdmission(
  tx: Transaction,
  dependencies: Dependencies,
  input: AdmissionInput,
  checked: BaseChecked,
): AdmissionAnswer {
  const now = Date.now();
  for (const { evidenceId, check } of checked.base) {
    if (check.end_state === CheckEndState.None) continue;
    const request = readEvidence(tx, evidenceId);
    assert.ok(request !== null);
    if (request.end_state !== null) continue;
    if (
      dependencies.schedulerClaims.liveExecutionOf(tx, request.node_id, now) !==
      null
    )
      continue;
    applyEndState(tx, dependencies, evidenceId, check, now, {
      inboundEventId: input.inbound_event_id,
    });
  }
  return ACCEPTED;
}

function commitAdmission(
  tx: Transaction,
  dependencies: Dependencies,
  input: AdmissionInput,
  checked: Checked,
): AdmissionAnswer {
  if (checked.check.end_state === CheckEndState.None) return ACCEPTED;
  const request = readEvidence(tx, checked.evidenceId);
  if (request !== null && request.end_state !== null) return DUPLICATE;
  const match = matchRequests(tx, input.project_id, checked.address);
  if (match.kind === MatchKind.Answer) return match.answer;
  if (match.evidence_id !== checked.evidenceId)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.DeliveryMatchChanged,
      "Another request evidence became the one unresolved match.",
    );
  assert.ok(request !== null);
  const now = Date.now();
  const live = dependencies.schedulerClaims.liveExecutionOf(
    tx,
    request.node_id,
    now,
  );
  if (live !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.ClaimLive,
      "Node has a live claim.",
      { node_id: request.node_id, execution_id: live.execution_id },
    );
  applyEndState(tx, dependencies, checked.evidenceId, checked.check, now, {
    inboundEventId: input.inbound_event_id,
  });
  return ACCEPTED;
}

const NO_RUNNING_ADMISSIONS = 0;
const NO_SELECTED_REQUESTS = 0;

export class AdmissionQueue {
  private running = NO_RUNNING_ADMISSIONS;
  private readonly waiters: Array<() => void> = [];

  async run<T>(task: () => Promise<T>): Promise<T> {
    assert.ok(this.running <= ADMISSION_CONCURRENCY);
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < ADMISSION_CONCURRENCY) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    assert.ok(
      this.running > NO_RUNNING_ADMISSIONS,
      "A release follows an acquire.",
    );
    const next = this.waiters.shift();
    if (next === undefined) {
      this.running--;
      return;
    }
    next();
  }
}

export function admitDelivery(
  queue: AdmissionQueue,
  dependencies: Dependencies,
  caller: CallerContext,
  input: AdmissionInput,
): Promise<AdmissionAnswer> {
  assert.ok(queue instanceof AdmissionQueue);
  return queue.run(() => admitOne(dependencies, caller, input));
}

async function admitOne(
  dependencies: Dependencies,
  caller: CallerContext,
  input: AdmissionInput,
): Promise<AdmissionAnswer> {
  authorizeAdmission(caller);
  const prepared = await prepareAdmission(dependencies, caller, input);
  const answer = caller.commit((tx) =>
    "disposition" in prepared
      ? prepared
      : "base" in prepared
        ? commitBaseAdmission(tx, dependencies, input, prepared)
        : commitAdmission(tx, dependencies, input, prepared),
  );
  dependencies.wakeup.wake(input.project_id);
  return answer;
}
