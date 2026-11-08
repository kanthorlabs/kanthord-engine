import assert from "node:assert/strict";
import { z } from "zod";
import {
  apiKeySecretSchema,
  type CredentialMetadataFn,
  type Grant,
  type GrantFacts,
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
  type ReplyRequestFacts,
  type RequestFacts,
  type SshIdentitySubject,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { type Context, DEADLINE_EXCEEDED_CODE } from "../kernel/context.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { PlatformAddressKind } from "../mission/contract.ts";
import {
  CheckEndState,
  type CheckFold,
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubFailure,
  type GitHubPlatform,
  GitHubTargetKind,
  type RequiredCheckRead,
} from "../repository/github.ts";
import {
  BaseMovedError,
  foldBranchPush,
  GIT_BASE_MOVED,
  GitStage,
  GitWriteError,
  type GitWriter,
  PushRefusalKind,
  pushRefusalOf,
  type SshAccess,
  type SshKeyAccess,
} from "../repository/index.ts";
import { SshAgentErrorCode } from "../repository/ssh-agent.ts";
import {
  OutboundRequestState,
  PLATFORM_CALL_DEADLINE_MS,
  REPLY_OPERATIONS,
  replyRequestKey,
  ResultClass,
} from "./contract.ts";
import type { CallAnswer } from "./outbound.ts";
import { findByKey } from "./outbound-store.ts";

const BAD_GATEWAY_STATUS = 502;
export const GIT_FAILED_CODE = "repository.connector.git_failed";
export const GIT_PUSH_REFUSED = "git.push_refused";
const UNEXPECTED_BODY_MESSAGE = "the GitHub answer holds an unexpected body";
const PULL_REQUEST_STATE_OPEN = "open";
const NO_CHECKS = { head_commit: "", pending: [], failed: [] };
const expectedEndStateSchema = z.enum(ExpectedEndState);
const openPullRequestSchema = z.looseObject({
  state: z.literal(PULL_REQUEST_STATE_OPEN),
  merged: z.literal(false),
});

export const GIT_TRANSPORT_CODES: readonly string[] = [
  GIT_FAILED_CODE,
  SshAgentErrorCode.Failed,
  DEADLINE_EXCEEDED_CODE,
  GIT_BASE_MOVED,
  GIT_PUSH_REFUSED,
];

export function isGitTransportFailure(error: unknown): error is CodedError {
  return (
    error instanceof CodedError && GIT_TRANSPORT_CODES.includes(error.code)
  );
}

export function gitFailure(error: unknown): CallAnswer {
  if (error instanceof BaseMovedError)
    return {
      ok: false,
      class: ResultClass.ConfirmedFailure,
      code: GIT_BASE_MOVED,
      message: error.message,
    };
  if (!(error instanceof GitWriteError)) throw error;
  if (error.stage === GitStage.BeforePush)
    return {
      ok: false,
      class: ResultClass.ConfirmedFailure,
      code: error.code,
      message: error.message,
    };
  return pushFailure(error);
}

function pushFailure(error: GitWriteError): CallAnswer {
  const refusal = pushRefusalOf(error);
  if (refusal?.kind === PushRefusalKind.Rule)
    return {
      ok: false,
      class: ResultClass.FinalRefusal,
      code: GIT_PUSH_REFUSED,
      message: refusal.detail,
    };
  return {
    ok: false,
    class:
      refusal?.kind === PushRefusalKind.NonFastForward
        ? ResultClass.RetryableRefusal
        : ResultClass.UnknownOutcome,
    code: error.code,
    message: error.message,
  };
}

export interface IntakeCustody {
  authorizeOperation<R extends GrantRequest>(
    tx: Transaction,
    request: R,
    now: number,
  ): GrantOf<R["kind"]>;
  release(tx: Transaction, grant: Grant, now: number): Material;
  consume(grant: Grant): void;
  grantFacts<G extends Grant>(grant: G): GrantFacts<G>;
  custodySuitability(
    tx: Transaction,
    request: { credential: string; platform: string },
  ): void;
  credentialMetadata: CredentialMetadataFn;
}

export interface ActionCheckDependencies {
  store: Store;
  custody: IntakeCustody;
  github: GitHubPlatform;
  gitWriter: GitWriter;
}

interface Hold {
  material: Material | null;
  ssh: SshAccess | null;
}

export interface SshRelease {
  credential: string;
  binding_id: string | null;
  address: string;
  access: SshKeyAccess;
}

export async function checkAction(
  dependencies: ActionCheckDependencies,
  caller: CallerContext,
  evidenceId: string,
): Promise<CheckFold> {
  assert.ok(caller.identity, "A service operation holds an identity.");
  assert.ok(evidenceId.length);
  const identity = caller.identity;
  const hold: Hold = { material: null, ssh: null };
  try {
    const checked = dependencies.store.transaction((tx) =>
      authorizeCheck(dependencies, tx, identity, evidenceId, hold),
    );
    const fold =
      "fold" in checked
        ? checked.fold
        : await inspect(dependencies, caller, checked.facts, hold);
    return caller.commit(() => fold);
  } finally {
    hold.material?.drop();
  }
}

export function releaseSshAccess(
  dependencies: Pick<ActionCheckDependencies, "custody" | "gitWriter">,
  tx: Transaction,
  now: number,
  request: {
    identity: CallerIdentity;
    claim: ExecutionClaim | null;
    subject: SshIdentitySubject;
  },
): SshRelease {
  assert.notEqual(request.subject.kind, SshIdentitySubjectKind.Draft);
  const custody = dependencies.custody;
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.SshIdentity,
      identity: request.identity,
      subject: request.subject,
      claim: request.claim,
    },
    now,
  );
  const granted = custody.grantFacts(grant);
  assert.ok(granted.credential !== null, "An SSH identity names its key.");
  const material = custody.release(tx, grant, now);
  return {
    credential: granted.credential,
    binding_id: granted.facts.binding_id,
    address: granted.facts.address,
    access: dependencies.gitWriter.sshAccessOf(tx, granted, material),
  };
}

function authorizeCheck(
  dependencies: ActionCheckDependencies,
  tx: Transaction,
  identity: CallerIdentity,
  evidenceId: string,
  hold: Hold,
): { facts: Readonly<RequestFacts> } | { fold: CheckFold } {
  assert.equal(hold.material, null);
  assert.equal(hold.ssh, null);
  const custody = dependencies.custody;
  const now = Date.now();
  const grant = custody.authorizeOperation(
    tx,
    { kind: GrantKind.RequestEvidence, identity, evidenceId, claim: null },
    now,
  );
  const { facts } = custody.grantFacts(grant);
  assert.equal(grant.execution, null, "A service check pins nothing.");
  if (!("repository" in facts)) {
    custody.consume(grant);
    return { fold: foldReply(tx, grant.project_id, facts) };
  }
  if (facts.address.kind === PlatformAddressKind.PullRequest) {
    hold.material = custody.release(tx, grant, now);
    return { facts };
  }
  custody.consume(grant);
  const ssh = releaseSshAccess(dependencies, tx, now, {
    identity,
    claim: null,
    subject: {
      kind: SshIdentitySubjectKind.RequestEvidence,
      evidence_id: evidenceId,
    },
  });
  assert.equal(ssh.binding_id, facts.repository.binding_id);
  assert.equal(ssh.address, facts.repository.address);
  hold.ssh = ssh.access;
  return { facts };
}

function foldReply(
  tx: Transaction,
  projectId: string,
  facts: Readonly<ReplyRequestFacts>,
): CheckFold {
  const requestKey = replyRequestKey(
    facts.node_id,
    facts.attempt,
    facts.frozen_action.configuration.external_link,
  );
  const request = REPLY_OPERATIONS.map((operation) =>
    findByKey(tx, projectId, operation, requestKey),
  ).find((found) => found !== null);
  return {
    end_state:
      request?.state === OutboundRequestState.Succeeded
        ? CheckEndState.Expected
        : CheckEndState.None,
    landed_commits: [],
  };
}

async function inspect(
  dependencies: ActionCheckDependencies,
  caller: CallerContext,
  facts: Readonly<RequestFacts>,
  hold: Hold,
): Promise<CheckFold> {
  const { material, ssh } = hold;
  const expected = expectedEndStateSchema.parse(
    facts.frozen_action.expected_end_state,
  );
  const deadlineAt = Date.now() + PLATFORM_CALL_DEADLINE_MS;
  const address = facts.address;
  if (address.kind === PlatformAddressKind.PullRequest) {
    assert.ok(material, "A pull request check holds a released material.");
    return inspectPullRequest(
      dependencies.github,
      caller,
      { facts, number: address.number, expected, deadlineAt },
      material,
    );
  }
  assert.equal(material, null, "A branch push check holds no material.");
  assert.ok(ssh, "A branch push check holds the SSH access.");
  assert.ok(facts.assessed_commit, "A branch push check names its commit.");
  const landing = await landedOn(dependencies.gitWriter, caller.context, {
    address: facts.repository.address,
    branch: facts.frozen_action.configuration.base_branch,
    commit: facts.assessed_commit,
    deadlineAt,
    ssh,
  });
  return foldBranchPush(landing, expected, facts.human_landing);
}

async function inspectPullRequest(
  github: GitHubPlatform,
  caller: CallerContext,
  request: {
    facts: Readonly<RequestFacts>;
    number: number;
    expected: ExpectedEndState;
    deadlineAt: number;
  },
  material: Material,
): Promise<CheckFold> {
  assert.ok(caller.identity);
  const token = apiKeySecretSchema.parse(material.value()).key;
  const { signal } = caller.context;
  const call = {
    token,
    requester: caller.identity,
    signal,
    deadlineAt: request.deadlineAt,
  };
  const target = {
    kind: GitHubTargetKind.Binding,
    address: request.facts.repository.address,
  } as const;
  const answer = await github.getSettledPullRequest(call, target, {
    number: request.number,
  });
  if (!answer.ok) throw platformFailure(answer);
  const reviews = await github.listReviews(call, target, {
    number: request.number,
  });
  if (!reviews.ok) throw platformFailure(reviews);
  const checks = openPullRequestSchema.safeParse(answer.value).success
    ? await github.getRequiredChecks(call, target, { number: request.number })
    : { ok: true as const, value: NO_CHECKS };
  if (!checks.ok) throw platformFailure(checks);
  return foldBody(
    github,
    answer.value,
    reviews.value,
    checks.value,
    request.expected,
    request.facts.link_trust.actor_ids,
  );
}

function foldBody(
  github: GitHubPlatform,
  body: unknown,
  reviews: unknown,
  checks: Pick<RequiredCheckRead, "head_commit" | "pending" | "failed">,
  expected: ExpectedEndState,
  trustedActorIds: readonly string[],
): CheckFold {
  assert.equal(expected, ExpectedEndState.PullRequestMerged);
  try {
    return github.foldPullRequest(
      body,
      reviews,
      checks,
      expected,
      trustedActorIds,
    );
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw platformFailure({
      ok: false,
      class: ResultClass.RetryableRefusal,
      code: GITHUB_RESULT_CODE_PREFIX + ResultClass.RetryableRefusal,
      status: null,
      message: UNEXPECTED_BODY_MESSAGE,
    });
  }
}

export function platformFailure(failure: GitHubFailure): OperationError {
  assert.equal(failure.ok, false);
  assert.ok(Object.values(ResultClass).includes(failure.class));
  return new OperationError(
    BAD_GATEWAY_STATUS,
    GITHUB_RESULT_CODE_PREFIX + failure.class,
    failure.message,
    { status: failure.status },
  );
}

async function landedOn(
  gitWriter: GitWriter,
  context: Context,
  input: {
    address: string;
    branch: string;
    commit: string;
    deadlineAt: number;
    ssh: SshAccess;
  },
) {
  assert.ok(input.address.length);
  assert.ok(input.branch.length);
  try {
    return await gitWriter.landedOn(
      { address: input.address, branch: input.branch, commit: input.commit },
      context,
      input.deadlineAt,
      input.ssh,
    );
  } catch (error) {
    if (!isGitTransportFailure(error)) throw error;
    throw new OperationError(BAD_GATEWAY_STATUS, error.code, error.message);
  }
}
