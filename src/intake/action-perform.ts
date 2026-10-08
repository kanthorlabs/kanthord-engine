import assert from "node:assert/strict";
import {
  apiKeySecretSchema,
  GrantKind,
  type ActionFacts,
  type Material,
} from "../custody/contract.ts";
import { isMachineIdentity, type MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  GitHubTargetKind,
  type GitHubCall,
  type GitHubTarget,
} from "../repository/github.ts";
import { GitStage, GitWriteError } from "../repository/index.ts";
import type { ActionCheckDependencies, IntakeCustody } from "./action-check.ts";
import { addressCodec, decodeAddress } from "./address-codec.ts";
import {
  ACTION_TABLE,
  AddressKind,
  GIT_WRITE_DEADLINE_MS,
  IntakeErrorCode,
  OutboundOperation,
  PLATFORM_CALL_DEADLINE_MS,
  ResultClass,
  type OutboundOperationValue,
  type PlatformAddress,
  type ResultClassAnswer,
  type ResultClassValue,
} from "./contract.ts";
import {
  FinalizationKind,
  type CallAnswer,
  type Finalization,
  type OutboundAnswer,
  type OutboundAuthorization,
  type OutboundRun,
  type OutboundScope,
  type ReadBack,
} from "./outbound.ts";

const NODE_BRANCH_PREFIX = "kanthord/";
const PULL_REQUEST_TITLE_PREFIX = "kanthord ";
const GIT_FAILED_CODE = "repository.connector.git_failed";
const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const ACTION_UNMAPPED_STATUS = 422;
const SINGLE_MATCH = 1;
const NO_DURATION = 0;
const NO_NUMBER = 0;

export type PerformBody = {
  key: string;
  commit: string;
  reused_evidence_id: string | null;
  request_key: string;
};
export type PerformAnswer = PlatformAddress | ResultClassAnswer;
export type PerformRunner = (
  request: OutboundRun<PerformAnswer>,
) => Promise<PerformAnswer>;

interface Performer {
  identity: MachineIdentity;
  claim: ExecutionClaim;
}

interface Held {
  operation: OutboundOperationValue | null;
  facts: Readonly<ActionFacts> | null;
}

interface Bound {
  operation: OutboundOperationValue;
  facts: Readonly<ActionFacts>;
}

export function performAction(
  dependencies: ActionCheckDependencies,
  run: PerformRunner,
  caller: CallerContext,
  body: PerformBody,
): Promise<PerformAnswer> {
  const identity = caller.identity;
  const claim = caller.execution;
  assert.ok(identity && isMachineIdentity(identity), "A client performs.");
  assert.ok(claim, "A perform holds a proven execution claim.");
  if (body.reused_evidence_id !== null)
    throw new OperationError(
      HttpStatus.BadRequest,
      VALIDATION_FAILED_CODE,
      "The reuse of a pull request is not admitted.",
    );
  const performer: Performer = { identity, claim };
  const held: Held = { operation: null, facts: null };
  return run({
    requestKey: body.request_key,
    deadlineMs: GIT_WRITE_DEADLINE_MS,
    resultCodec: addressCodec,
    authorize: (tx, now) =>
      authorizePerform(dependencies.custody, tx, now, {
        performer,
        body,
        held,
      }),
    call: (material, scope) =>
      callAction(dependencies, performer, bound(held), material, scope),
    readBack: (material, scope) =>
      readBackAction(dependencies, performer, bound(held), material, scope),
    finalize: (answer) => finalizePerform(bound(held), answer),
  });
}

function bound(held: Held): Bound {
  assert.ok(held.operation !== null, "The authorization names the operation.");
  assert.ok(held.facts !== null, "The authorization holds the facts.");
  return { operation: held.operation, facts: held.facts };
}

function authorizePerform(
  custody: IntakeCustody,
  tx: Transaction,
  now: number,
  request: { performer: Performer; body: PerformBody; held: Held },
): OutboundAuthorization {
  const { performer, body, held } = request;
  assert.equal(held.operation, null, "A perform authorizes once.");
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.FrozenAction,
      identity: performer.identity,
      claim: performer.claim,
      key: body.key,
      commit: body.commit,
      reusedEvidenceId: body.reused_evidence_id,
    },
    now,
  );
  const granted = custody.grantFacts(grant);
  const operation = operationOf(
    granted.facts.frozen_action.action,
    grant.platform,
  );
  held.operation = operation;
  held.facts = granted.facts;
  const material =
    operation === OutboundOperation.GitHubPullRequest
      ? custody.release(tx, grant, now)
      : null;
  if (material === null) custody.consume(grant);
  return {
    operation,
    project_id: granted.project_id,
    credential: granted.credential,
    material,
  };
}

function operationOf(action: string, platform: string): OutboundOperationValue {
  assert.ok(action.length, "A frozen action names its action.");
  assert.ok(platform.length, "A binding names its platform.");
  const row = ACTION_TABLE.find(
    (item) => item.action === action && item.platform === platform,
  );
  if (row === undefined)
    throw new OperationError(
      ACTION_UNMAPPED_STATUS,
      IntakeErrorCode.OutboundRequestActionUnmapped,
      `The action ${action} on a ${platform} binding has no outbound operation.`,
    );
  return row.operation;
}

function callAction(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  material: Material | null,
  scope: OutboundScope,
): Promise<CallAnswer> {
  if (action.operation === OutboundOperation.GitHubPullRequest)
    return createPullRequest(dependencies, performer, action.facts, {
      material,
      scope,
    });
  assert.equal(action.operation, OutboundOperation.GitMergePush);
  assert.equal(material, null, "A merge push holds no material.");
  return mergePush(dependencies, action.facts, scope);
}

async function createPullRequest(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  const call = gitHubCall(performer, held.material, held.scope);
  const answer = await dependencies.github.createPullRequest(
    call,
    targetOf(facts),
    {
      head: NODE_BRANCH_PREFIX + performer.claim.nodeId,
      base: facts.frozen_action.configuration.base_branch,
      title: PULL_REQUEST_TITLE_PREFIX + performer.claim.nodeId,
    },
  );
  if (!answer.ok)
    return {
      ok: false,
      class: answer.class,
      code: answer.code,
      message: answer.message,
    };
  return { ok: true, result: pullRequestAddress(facts, answer.value.number) };
}

async function mergePush(
  dependencies: ActionCheckDependencies,
  facts: Readonly<ActionFacts>,
  scope: OutboundScope,
): Promise<CallAnswer> {
  const baseBranch = facts.frozen_action.configuration.base_branch;
  assert.ok(baseBranch.length, "A merge push names its base branch.");
  try {
    const { commit } = await dependencies.gitWriter.mergePushFresh(
      {
        address: facts.repository.address,
        base_branch: baseBranch,
        commit: facts.snapshot_commit,
      },
      scope.context,
      deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
    );
    return { ok: true, result: branchPushAddress(facts, commit) };
  } catch (error) {
    if (!(error instanceof GitWriteError)) throw error;
    return {
      ok: false,
      class:
        error.stage === GitStage.BeforePush
          ? ResultClass.ConfirmedFailure
          : ResultClass.UnknownOutcome,
      code: error.code,
      message: error.message,
    };
  }
}

function readBackAction(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  material: Material | null,
  scope: OutboundScope,
): Promise<ReadBack> {
  if (action.operation === OutboundOperation.GitHubPullRequest)
    return openPullRequest(dependencies, performer, action.facts, {
      material,
      scope,
    });
  assert.equal(action.operation, OutboundOperation.GitMergePush);
  assert.equal(material, null, "A merge push holds no material.");
  return landedMerge(dependencies, action.facts, scope);
}

async function openPullRequest(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<ReadBack> {
  const call = gitHubCall(performer, held.material, held.scope);
  const answer = await dependencies.github.openPullRequests(
    call,
    targetOf(facts),
    {
      head: NODE_BRANCH_PREFIX + performer.claim.nodeId,
      base: facts.frozen_action.configuration.base_branch,
    },
  );
  if (!answer.ok || answer.value.length !== SINGLE_MATCH)
    return { match: false };
  const [number] = answer.value;
  assert.ok(number !== undefined);
  return { match: true, result: pullRequestAddress(facts, number) };
}

async function landedMerge(
  dependencies: ActionCheckDependencies,
  facts: Readonly<ActionFacts>,
  scope: OutboundScope,
): Promise<ReadBack> {
  const baseBranch = facts.frozen_action.configuration.base_branch;
  assert.ok(baseBranch.length, "A merge push names its base branch.");
  const landing = await dependencies.gitWriter.landedOn(
    {
      address: facts.repository.address,
      branch: baseBranch,
      commit: facts.snapshot_commit,
    },
    scope.context,
    deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
  );
  if (!landing.landed) return { match: false };
  assert.ok(landing.first_parent !== null, "A landing names its commit.");
  return {
    match: true,
    result: branchPushAddress(facts, landing.first_parent),
  };
}

function finalizePerform(
  action: Bound,
  answer: OutboundAnswer,
): Finalization<PerformAnswer> {
  if (answer.ok)
    return {
      kind: FinalizationKind.Answer,
      body: decodeAddress(answer.result),
    };
  return {
    kind: FinalizationKind.Answer,
    body: {
      class: answer.class,
      code: resultCodeOf(action.operation, answer.class),
      message: answer.message,
    },
  };
}

function resultCodeOf(
  operation: OutboundOperationValue,
  resultClass: ResultClassValue,
): string {
  assert.ok(Object.values(ResultClass).includes(resultClass));
  if (operation === OutboundOperation.GitHubPullRequest)
    return GITHUB_RESULT_CODE_PREFIX + resultClass;
  assert.equal(operation, OutboundOperation.GitMergePush);
  return GIT_FAILED_CODE;
}

function gitHubCall(
  performer: Performer,
  material: Material | null,
  scope: OutboundScope,
): GitHubCall {
  assert.ok(material, "A pull request call holds a released material.");
  return {
    token: apiKeySecretSchema.parse(material.value()).key,
    requester: performer.identity,
    signal: scope.signal,
    deadlineAt: deadlineOf(scope, PLATFORM_CALL_DEADLINE_MS),
  };
}

function deadlineOf(scope: OutboundScope, boundMs: number): number {
  const deadline = scope.context.deadline();
  assert.ok(deadline !== null, "An outbound scope holds a deadline.");
  assert.ok(boundMs > NO_DURATION);
  return Math.min(deadline, Date.now() + boundMs);
}

function targetOf(facts: Readonly<ActionFacts>): GitHubTarget {
  assert.ok(facts.repository.address.length, "A binding names its address.");
  return { kind: GitHubTargetKind.Binding, address: facts.repository.address };
}

function pullRequestAddress(
  facts: Readonly<ActionFacts>,
  number: number,
): PlatformAddress {
  assert.ok(Number.isSafeInteger(number) && number > NO_NUMBER);
  return {
    kind: AddressKind.PullRequest,
    resource_identity: facts.repository.resource_identity,
    number,
  };
}

function branchPushAddress(
  facts: Readonly<ActionFacts>,
  commit: string,
): PlatformAddress {
  assert.ok(commit.length, "A branch push names its commit.");
  return {
    kind: AddressKind.BranchPush,
    resource_identity: facts.repository.resource_identity,
    branch: facts.frozen_action.configuration.base_branch,
    commit,
  };
}
