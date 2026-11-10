import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  type ActionFacts,
  apiKeySecretSchema,
  GrantKind,
  type Material,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import { type CallerIdentity, isServiceIdentity } from "../kernel/caller.ts";
import { commitHeader } from "../kernel/commit-message.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { SshAccess } from "../repository/index.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubCall,
  type GitHubFailure,
  type GitHubTarget,
  GitHubTargetKind,
} from "../repository/github.ts";
import {
  type ActionCheckDependencies,
  GIT_FAILED_CODE,
  GIT_TRANSPORT_CODES,
  gitFailure,
  releaseSshAccess,
} from "./action-check.ts";
import { addressCodec, decodeAddress } from "./address-codec.ts";
import {
  AddressKind,
  GIT_WRITE_DEADLINE_MS,
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
const RETRIED_MERGE_STATUSES: readonly number[] = [HttpStatus.MethodNotAllowed];
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

interface Held {
  facts: Readonly<ActionFacts> | null;
  ssh: SshAccess | null;
}

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
  const held: Held = { facts: null, ssh: null };
  return run({
    requestKey: SERVICE_MERGE_REQUEST_KEY_PREFIX + body.request_key,
    deadlineMs: GIT_WRITE_DEADLINE_MS,
    resultCodec: addressCodec,
    authorize: (tx, now) =>
      authorizeMerge(dependencies, tx, now, { identity, body, held }),
    call: (material, scope) => {
      const facts = factsOf(held);
      return landsByPush(facts)
        ? callSquashPush(dependencies, facts, sshOf(held), scope)
        : callMergePullRequest(dependencies, identity, facts, {
            material,
            scope,
          });
    },
    readBack: (material, scope) => {
      const facts = factsOf(held);
      return landsByPush(facts)
        ? readBackSquashPush(dependencies, facts, sshOf(held), scope)
        : readBackMergePullRequest(dependencies, identity, facts, {
            material,
            scope,
          });
    },
    finalize: (answer) => {
      const facts = factsOf(held);
      return landsByPush(facts)
        ? finalizeSquashPush(answer)
        : finalizeMerge(answer, facts);
    },
  });
}

function factsOf(held: Held): Readonly<ActionFacts> {
  assert.ok(held.facts !== null, "The authorization holds the facts.");
  return held.facts;
}

function sshOf(held: Held): SshAccess {
  assert.ok(held.ssh !== null, "A branch push merge holds its SSH access.");
  return held.ssh;
}

function landsByPush(facts: Readonly<ActionFacts>): boolean {
  assert.ok(facts.merge_address !== null, "A merge names its address.");
  return facts.merge_address.kind === AddressKind.BranchPush;
}

function pullRequestOf(facts: Readonly<ActionFacts>) {
  assert.ok(
    facts.merge_address?.kind === AddressKind.PullRequest,
    "A pull request merge names its pull request.",
  );
  return facts.merge_address;
}

function authorizeMerge(
  dependencies: ActionCheckDependencies,
  tx: Transaction,
  now: number,
  request: {
    identity: CallerIdentity;
    body: MergeBody;
    held: Held;
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
  held.facts = granted.facts;
  if (landsByPush(granted.facts)) {
    custody.consume(grant);
    const ssh = releaseSshAccess(dependencies, tx, now, {
      identity,
      claim: null,
      subject: {
        kind: SshIdentitySubjectKind.RequestEvidence,
        evidence_id: body.evidence_id,
      },
    });
    assert.equal(ssh.binding_id, granted.facts.repository.binding_id);
    assert.equal(ssh.address, granted.facts.repository.address);
    held.ssh = ssh.access;
    return {
      operation: OutboundOperation.GitPush,
      project_id: granted.project_id,
      credential: ssh.credential,
      material: null,
    };
  }
  assert.ok(granted.credential !== null, "A merge holds a credential.");
  return {
    operation: OutboundOperation.GitHubPullRequestMerge,
    project_id: granted.project_id,
    credential: granted.credential,
    material: custody.release(tx, grant, now),
  };
}

export async function callSquashPush(
  dependencies: ActionCheckDependencies,
  facts: Readonly<ActionFacts>,
  ssh: SshAccess,
  scope: OutboundScope,
): Promise<CallAnswer> {
  try {
    const { commit } = await dependencies.gitWriter.squashPushFresh(
      {
        address: facts.repository.address,
        base_branch: facts.frozen_action.configuration.base_branch,
        commit: facts.snapshot_commit,
        node_id: facts.node.id,
        header: commitHeader(facts.node.commit_type, facts.node.name),
      },
      scope.context,
      deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
      ssh,
    );
    return { ok: true, result: branchPushAddress(facts, commit) };
  } catch (error) {
    return gitFailure(error);
  }
}

async function readBackSquashPush(
  dependencies: ActionCheckDependencies,
  facts: Readonly<ActionFacts>,
  ssh: SshAccess,
  scope: OutboundScope,
): Promise<ReadBack> {
  const landing = await dependencies.gitWriter.landedOn(
    {
      address: facts.repository.address,
      branch: facts.frozen_action.configuration.base_branch,
      commit: facts.snapshot_commit,
    },
    scope.context,
    deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
    ssh,
  );
  if (!landing.landed) return { match: false };
  assert.ok(landing.first_parent !== null, "A landing names its commit.");
  return {
    match: true,
    result: branchPushAddress(facts, landing.first_parent),
  };
}

function finalizeSquashPush(answer: OutboundAnswer): Finalization<MergeAnswer> {
  if (answer.ok)
    return {
      kind: FinalizationKind.Answer,
      body: decodeAddress(answer.result),
    };
  return {
    kind: FinalizationKind.Answer,
    body: {
      class: answer.class,
      code: GIT_TRANSPORT_CODES.includes(answer.code)
        ? answer.code
        : GIT_FAILED_CODE,
      message: answer.message,
    },
  };
}

export function branchPushAddress(
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

export async function callMergePullRequest(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  const merge = pullRequestOf(facts);
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
      number: merge.number,
      sha: facts.snapshot_commit,
      merge_method: method.value,
    },
  );
  if (!answer.ok) return mergeRefusal(answer);
  return { ok: true, result: merge };
}

function mergeRefusal(answer: GitHubFailure): CallAnswer {
  const resultClass =
    answer.status !== null && RETRIED_MERGE_STATUSES.includes(answer.status)
      ? ResultClass.RetryableRefusal
      : answer.class;
  return {
    ok: false,
    class: resultClass,
    code: GITHUB_RESULT_CODE_PREFIX + resultClass,
    message:
      answer.status === null
        ? answer.message
        : `${answer.status} ${answer.message}`,
  };
}

export async function readBackMergePullRequest(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<ReadBack> {
  const merge = pullRequestOf(facts);
  const call = gitHubCall(requester, held.material, held.scope);
  const answer = await dependencies.github.pullRequestMergedAt(
    call,
    targetOf(facts),
    { number: merge.number, sha: facts.snapshot_commit },
  );
  if (!answer.ok || !answer.value) return { match: false };
  return { match: true, result: merge };
}

function finalizeMerge(
  answer: OutboundAnswer,
  facts: Readonly<ActionFacts>,
): Finalization<MergeAnswer> {
  const merge = pullRequestOf(facts);
  if (answer.ok) {
    const address = decodeAddress(answer.result);
    if (!isDeepStrictEqual(address, merge))
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
