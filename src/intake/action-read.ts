import assert from "node:assert/strict";
import {
  apiKeySecretSchema,
  GrantKind,
  type Material,
} from "../custody/contract.ts";
import { isMachineIdentity, type MachineIdentity } from "../kernel/caller.ts";
import { abortSignal } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { PlatformAddressKind } from "../mission/contract.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  GitHubTargetKind,
  type GitHubCall,
  type GitHubFailure,
  type GitHubPlatform,
  type GitHubTarget,
  type ReviewCommentQuery,
} from "../repository/github.ts";
import type { ActionCheckDependencies, IntakeCustody } from "./action-check.ts";
import {
  ActionReadMethod,
  PLATFORM_CALL_DEADLINE_MS,
  ResultClass,
  type ActionReadMethodValue,
  type ActionReadPage,
  type ResultClassAnswer,
} from "./contract.ts";

const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";

export type ReadQuery = {
  method: ActionReadMethodValue;
  limit?: number | undefined;
  cursor?: string | undefined;
};
export type ReadAnswer = ActionReadPage | ResultClassAnswer;

interface Reader {
  identity: MachineIdentity;
  claim: ExecutionClaim;
}

interface ReadTarget {
  target: GitHubTarget;
  number: number;
}

interface Hold {
  material: Material | null;
}

export async function readAction(
  dependencies: ActionCheckDependencies,
  caller: CallerContext,
  evidenceId: string,
  query: ReadQuery,
): Promise<ReadAnswer> {
  const identity = caller.identity;
  const claim = caller.execution;
  assert.ok(identity && isMachineIdentity(identity), "A client reads.");
  assert.ok(claim, "A read holds a proven execution claim.");
  assert.ok(evidenceId.length);
  const reader: Reader = { identity, claim };
  const hold: Hold = { material: null };
  try {
    const read = dependencies.store.transaction((tx) =>
      authorizeRead(dependencies.custody, tx, { reader, evidenceId }, hold),
    );
    assert.ok(hold.material, "A read holds a released material.");
    const answer = await readPlatform(
      dependencies.github,
      caller,
      { reader, read, query },
      hold.material,
    );
    return caller.commit(() => answer);
  } finally {
    hold.material?.drop();
  }
}

function authorizeRead(
  custody: IntakeCustody,
  tx: Transaction,
  request: { reader: Reader; evidenceId: string },
  hold: Hold,
): ReadTarget {
  assert.equal(hold.material, null, "A read releases once.");
  const now = Date.now();
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.RequestEvidence,
      identity: request.reader.identity,
      evidenceId: request.evidenceId,
      claim: request.reader.claim,
    },
    now,
  );
  const { facts } = custody.grantFacts(grant);
  assert.ok(grant.execution !== null, "A client read pins its execution.");
  const address = facts.address;
  if (address.kind !== PlatformAddressKind.PullRequest)
    throw new OperationError(
      HttpStatus.BadRequest,
      VALIDATION_FAILED_CODE,
      "A branch push request evidence has no platform read.",
    );
  hold.material = custody.release(tx, grant, now);
  return {
    target: {
      kind: GitHubTargetKind.Binding,
      address: facts.repository.address,
    },
    number: address.number,
  };
}

async function readPlatform(
  github: GitHubPlatform,
  caller: CallerContext,
  request: { reader: Reader; read: ReadTarget; query: ReadQuery },
  material: Material,
): Promise<ReadAnswer> {
  const { signal, dispose } = abortSignal(caller.context);
  try {
    const call: GitHubCall = {
      token: apiKeySecretSchema.parse(material.value()).key,
      requester: request.reader.identity,
      signal,
      deadlineAt: Date.now() + PLATFORM_CALL_DEADLINE_MS,
    };
    if (request.query.method === ActionReadMethod.PullRequestGet)
      return await pullRequest(github, call, request.read);
    return await reviewComments(github, call, request.read, request.query);
  } finally {
    dispose();
  }
}

async function pullRequest(
  github: GitHubPlatform,
  call: GitHubCall,
  read: ReadTarget,
): Promise<ReadAnswer> {
  assert.ok(call.token.length);
  const answer = await github.getPullRequest(call, read.target, {
    number: read.number,
  });
  if (!answer.ok) return resultClassAnswer(answer);
  return { body: answer.value, next_cursor: null };
}

async function reviewComments(
  github: GitHubPlatform,
  call: GitHubCall,
  read: ReadTarget,
  query: ReadQuery,
): Promise<ReadAnswer> {
  assert.equal(query.method, ActionReadMethod.ReviewCommentList);
  assert.ok(call.token.length);
  const page: ReviewCommentQuery = { number: read.number };
  if (query.limit !== undefined) page.limit = query.limit;
  if (query.cursor !== undefined) page.cursor = query.cursor;
  const answer = await github.listReviewComments(call, read.target, page);
  if (!answer.ok) return resultClassAnswer(answer);
  return { body: answer.value.body, next_cursor: answer.value.next_cursor };
}

function resultClassAnswer(failure: GitHubFailure): ResultClassAnswer {
  assert.equal(failure.ok, false);
  assert.ok(Object.values(ResultClass).includes(failure.class));
  return {
    class: failure.class,
    code: GITHUB_RESULT_CODE_PREFIX + failure.class,
    message: failure.message,
  };
}
