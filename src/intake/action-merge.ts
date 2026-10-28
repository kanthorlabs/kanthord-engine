import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  type ActionFacts,
  apiKeySecretSchema,
  GrantKind,
  type Material,
} from "../custody/contract.ts";
import { type CallerIdentity, isServiceIdentity } from "../kernel/caller.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubCall,
  type GitHubTarget,
  GitHubTargetKind,
} from "../repository/github.ts";
import {
  type ActionCheckDependencies,
  GIT_TRANSPORT_CODES,
} from "./action-check.ts";
import { addressCodec, decodeAddress } from "./address-codec.ts";
import {
  OutboundOperation,
  PLATFORM_CALL_DEADLINE_MS,
  type PlatformAddress,
  ResultClass,
  type ResultClassAnswer,
  SERVICE_MERGE_REQUEST_KEY_PREFIX,
} from "./contract.ts";
import {
  type CallAnswer,
  type Finalization,
  FinalizationKind,
  type OutboundAnswer,
  type OutboundAuthorization,
  type OutboundRun,
  type OutboundScope,
  type ReadBack,
} from "./outbound.ts";

const EXPIRED_DEADLINE_MS = 0;
export const FOREIGN_MERGE_ANSWER_MESSAGE =
  "The request key holds the answer of another merge.";

export type MergeBody = {
  evidence_id: string;
  commit: string;
  request_key: string;
};
export type MergeAnswer = PlatformAddress | ResultClassAnswer;
export type MergeRunner = (
  request: OutboundRun<MergeAnswer>,
) => Promise<MergeAnswer>;

export function mergeAction(
  dependencies: ActionCheckDependencies,
  run: MergeRunner,
  caller: CallerContext,
  body: MergeBody,
): Promise<MergeAnswer> {
  const identity = caller.identity;
  assert.ok(
    identity && isServiceIdentity(identity),
    "The Mission Service merges.",
  );
  const held: { facts: Readonly<ActionFacts> | null } = { facts: null };
  return run({
    requestKey: SERVICE_MERGE_REQUEST_KEY_PREFIX + body.request_key,
    deadlineMs: PLATFORM_CALL_DEADLINE_MS,
    resultCodec: addressCodec,
    authorize: (tx, now) =>
      authorizeMerge(dependencies, tx, now, { identity, body, held }),
    call: (material, scope) =>
      callMergePullRequest(dependencies, identity, factsOf(held), {
        material,
        scope,
      }),
    readBack: (material, scope) =>
      readBackMergePullRequest(dependencies, identity, factsOf(held), {
        material,
        scope,
      }),
    finalize: (answer) => finalizeMerge(answer, factsOf(held)),
  });
}

function factsOf(held: {
  facts: Readonly<ActionFacts> | null;
}): Readonly<ActionFacts> {
  assert.ok(held.facts !== null, "The authorization holds the facts.");
  return held.facts;
}

function authorizeMerge(
  dependencies: ActionCheckDependencies,
  tx: Transaction,
  now: number,
  request: {
    identity: CallerIdentity;
    body: MergeBody;
    held: { facts: Readonly<ActionFacts> | null };
  },
): OutboundAuthorization {
  const { identity, body, held } = request;
  assert.equal(held.facts, null, "A merge authorizes once.");
  assert.ok(isServiceIdentity(identity));
  const custody = dependencies.custody;
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.ServiceMerge,
      identity,
      evidenceId: body.evidence_id,
      commit: body.commit,
      claim: null,
    },
    now,
  );
  const granted = custody.grantFacts(grant);
  assert.ok(granted.credential !== null, "A merge holds a credential.");
  held.facts = granted.facts;
  return {
    operation: OutboundOperation.GitHubPullRequestMerge,
    project_id: granted.project_id,
    credential: granted.credential,
    material: custody.release(tx, grant, now),
  };
}

export async function callMergePullRequest(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  assert.ok(facts.merge_address !== null, "A merge call names its address.");
  const call = gitHubCall(requester, held.material, held.scope);
  const method = await dependencies.github.mergeMethodOf(call, targetOf(facts));
  if (!method.ok)
    return {
      ok: false,
      class: method.class,
      code: method.code,
      message: method.message,
    };
  if (method.value === null)
    return {
      ok: false,
      class: ResultClass.FinalRefusal,
      code: GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
      message: "The repository allows no merge method.",
    };
  const answer = await dependencies.github.mergePullRequest(
    call,
    targetOf(facts),
    {
      number: facts.merge_address.number,
      sha: facts.snapshot_commit,
      merge_method: method.value,
    },
  );
  if (!answer.ok)
    return {
      ok: false,
      class: answer.class,
      code: answer.code,
      message: answer.message,
    };
  return { ok: true, result: facts.merge_address };
}

export async function readBackMergePullRequest(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<ReadBack> {
  assert.ok(
    facts.merge_address !== null,
    "A merge read-back names its address.",
  );
  const call = gitHubCall(requester, held.material, held.scope);
  const answer = await dependencies.github.pullRequestMergedAt(
    call,
    targetOf(facts),
    { number: facts.merge_address.number, sha: facts.snapshot_commit },
  );
  if (!answer.ok || !answer.value) return { match: false };
  return { match: true, result: facts.merge_address };
}

function finalizeMerge(
  answer: OutboundAnswer,
  facts: Readonly<ActionFacts>,
): Finalization<MergeAnswer> {
  assert.ok(facts.merge_address !== null, "A merge names its address.");
  if (answer.ok) {
    const address = decodeAddress(answer.result);
    if (!isDeepStrictEqual(address, facts.merge_address))
      return {
        kind: FinalizationKind.Answer,
        body: {
          class: ResultClass.FinalRefusal,
          code: GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
          message: FOREIGN_MERGE_ANSWER_MESSAGE,
        },
      };
    return { kind: FinalizationKind.Answer, body: address };
  }
  return {
    kind: FinalizationKind.Answer,
    body: {
      class: answer.class,
      code: GIT_TRANSPORT_CODES.includes(answer.code)
        ? answer.code
        : GITHUB_RESULT_CODE_PREFIX + answer.class,
      message: answer.message,
    },
  };
}

export function gitHubCall(
  requester: CallerIdentity,
  material: Material | null,
  scope: OutboundScope,
): GitHubCall {
  assert.ok(material, "A pull request call holds a released material.");
  return {
    token: apiKeySecretSchema.parse(material.value()).key,
    requester,
    signal: scope.signal,
    deadlineAt: deadlineOf(scope, PLATFORM_CALL_DEADLINE_MS),
  };
}

export function deadlineOf(scope: OutboundScope, boundMs: number): number {
  const deadline = scope.context.deadline;
  assert.ok(deadline !== null, "An outbound scope holds a deadline.");
  assert.ok(boundMs > EXPIRED_DEADLINE_MS);
  return Math.min(deadline, Date.now() + boundMs);
}

export function targetOf(facts: Readonly<ActionFacts>): GitHubTarget {
  assert.ok(facts.repository.address.length, "A binding names its address.");
  return { kind: GitHubTargetKind.Binding, address: facts.repository.address };
}
