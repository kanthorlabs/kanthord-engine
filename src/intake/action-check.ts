import assert from "node:assert/strict";
import { z } from "zod";
import {
  apiKeySecretSchema,
  GrantKind,
  SshIdentitySubjectKind,
  type Grant,
  type GrantFacts,
  type GrantOf,
  type GrantRequest,
  type Material,
  type RequestFacts,
  type SshIdentitySubject,
} from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { DEADLINE_EXCEEDED_CODE, type Context } from "../kernel/context.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { PlatformAddressKind } from "../mission/contract.ts";
import {
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  GitHubTargetKind,
  type CheckFold,
  type GitHubFailure,
  type GitHubPlatform,
  type RequiredCheckRead,
} from "../repository/github.ts";
import {
  foldBranchPush,
  type GitWriter,
  type SshAccess,
  type SshKeyAccess,
} from "../repository/index.ts";
import { SshAgentErrorCode } from "../repository/ssh-agent.ts";
import { PLATFORM_CALL_DEADLINE_MS, ResultClass } from "./contract.ts";

const BAD_GATEWAY_STATUS = 502;
const GIT_FAILED_CODE = "repository.connector.git_failed";
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
];

export function isGitTransportFailure(error: unknown): error is CodedError {
  return (
    error instanceof CodedError && GIT_TRANSPORT_CODES.includes(error.code)
  );
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
    const facts = dependencies.store.transaction((tx) =>
      authorizeCheck(dependencies, tx, identity, evidenceId, hold),
    );
    const fold = await inspect(dependencies, caller, facts, hold);
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
): Readonly<RequestFacts> {
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
  if (facts.address.kind === PlatformAddressKind.PullRequest) {
    hold.material = custody.release(tx, grant, now);
    return facts;
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
  return facts;
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
  const landing = await landedOn(dependencies.gitWriter, caller.context, {
    address: facts.repository.address,
    branch: facts.frozen_action.configuration.base_branch,
    commit: address.commit,
    deadlineAt,
    ssh,
  });
  return foldBranchPush(landing.landed, address.commit, expected);
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
  );
}

function foldBody(
  github: GitHubPlatform,
  body: unknown,
  reviews: unknown,
  checks: Pick<RequiredCheckRead, "head_commit" | "pending" | "failed">,
  expected: ExpectedEndState,
): CheckFold {
  assert.equal(expected, ExpectedEndState.PullRequestMerged);
  try {
    return github.foldPullRequest(body, reviews, checks, expected);
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

function platformFailure(failure: GitHubFailure): OperationError {
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
