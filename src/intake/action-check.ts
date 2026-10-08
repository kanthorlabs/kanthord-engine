import assert from "node:assert/strict";
import { z } from "zod";
import {
  apiKeySecretSchema,
  GrantKind,
  type Grant,
  type GrantFacts,
  type GrantOf,
  type GrantRequest,
  type Material,
  type RequestFacts,
} from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { abortSignal, type Context } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { PlatformAddressKind } from "../mission/contract.ts";
import {
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  GitHubTargetKind,
  type CheckFold,
  type GitHubFailure,
  type GitHubPlatform,
} from "../repository/github.ts";
import { foldBranchPush, type GitWriter } from "../repository/index.ts";
import { PLATFORM_CALL_DEADLINE_MS, ResultClass } from "./contract.ts";

const BAD_GATEWAY_STATUS = 502;
const GIT_FAILED_CODE = "repository.connector.git_failed";
const UNEXPECTED_BODY_MESSAGE = "the GitHub answer holds an unexpected body";
const expectedEndStateSchema = z.enum(ExpectedEndState);

export interface IntakeCustody {
  authorizeOperation<R extends GrantRequest>(
    tx: Transaction,
    request: R,
    now: number,
  ): GrantOf<R["kind"]>;
  release(tx: Transaction, grant: Grant, now: number): Material;
  consume(grant: Grant): void;
  grantFacts<G extends Grant>(grant: G): GrantFacts<G>;
}

export interface ActionCheckDependencies {
  store: Store;
  custody: IntakeCustody;
  github: GitHubPlatform;
  gitWriter: GitWriter;
}

interface Hold {
  material: Material | null;
}

export async function checkAction(
  dependencies: ActionCheckDependencies,
  caller: CallerContext,
  evidenceId: string,
): Promise<CheckFold> {
  assert.ok(caller.identity, "A service operation holds an identity.");
  assert.ok(evidenceId.length);
  const identity = caller.identity;
  const hold: Hold = { material: null };
  try {
    const facts = dependencies.store.transaction((tx) =>
      authorizeCheck(dependencies.custody, tx, identity, evidenceId, hold),
    );
    const fold = await inspect(dependencies, caller, facts, hold.material);
    return caller.commit(() => fold);
  } finally {
    hold.material?.drop();
  }
}

function authorizeCheck(
  custody: IntakeCustody,
  tx: Transaction,
  identity: CallerIdentity,
  evidenceId: string,
  hold: Hold,
): Readonly<RequestFacts> {
  assert.equal(hold.material, null);
  const now = Date.now();
  const grant = custody.authorizeOperation(
    tx,
    { kind: GrantKind.RequestEvidence, identity, evidenceId, claim: null },
    now,
  );
  const { facts } = custody.grantFacts(grant);
  assert.equal(grant.execution, null, "A service check pins nothing.");
  if (facts.address.kind === PlatformAddressKind.PullRequest)
    hold.material = custody.release(tx, grant, now);
  else custody.consume(grant);
  return facts;
}

async function inspect(
  dependencies: ActionCheckDependencies,
  caller: CallerContext,
  facts: Readonly<RequestFacts>,
  material: Material | null,
): Promise<CheckFold> {
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
  const landing = await landedOn(dependencies.gitWriter, caller.context, {
    address: facts.repository.address,
    branch: facts.frozen_action.configuration.base_branch,
    commit: address.commit,
    deadlineAt,
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
  const { signal, dispose } = abortSignal(caller.context);
  try {
    const answer = await github.getPullRequest(
      {
        token,
        requester: caller.identity,
        signal,
        deadlineAt: request.deadlineAt,
      },
      {
        kind: GitHubTargetKind.Binding,
        address: request.facts.repository.address,
      },
      { number: request.number },
    );
    if (!answer.ok) throw platformFailure(answer);
    return foldBody(github, answer.value, request.expected);
  } finally {
    dispose();
  }
}

function foldBody(
  github: GitHubPlatform,
  body: unknown,
  expected: ExpectedEndState,
): CheckFold {
  assert.equal(expected, ExpectedEndState.PullRequestMerged);
  try {
    return github.foldPullRequest(body, expected);
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
  },
) {
  assert.ok(input.address.length);
  assert.ok(input.branch.length);
  try {
    return await gitWriter.landedOn(
      { address: input.address, branch: input.branch, commit: input.commit },
      context,
      input.deadlineAt,
    );
  } catch (error) {
    if (!(error instanceof Diagnostic) || error.code !== GIT_FAILED_CODE)
      throw error;
    throw new OperationError(BAD_GATEWAY_STATUS, error.code, error.message);
  }
}
