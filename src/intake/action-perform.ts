import assert from "node:assert/strict";
import {
  type ActionFacts,
  type GrantFacts,
  GrantKind,
  type GrantOf,
  type Material,
  type ReplyActionFacts,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import { isMachineIdentity, type MachineIdentity } from "../kernel/caller.ts";
import { commitHeader } from "../kernel/commit-message.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { GITHUB_RESULT_CODE_PREFIX } from "../repository/github.ts";
import type { SshAccess } from "../repository/index.ts";
import {
  branchPushAddress,
  callMergePullRequest,
  callSquashPush,
  deadlineOf,
  gitHubCall,
  readBackMergePullRequest,
  targetOf,
} from "./action-merge.ts";
import {
  type ActionCheckDependencies,
  GIT_FAILED_CODE,
  GIT_TRANSPORT_CODES,
  gitFailure,
  isGitTransportFailure,
  releaseSshAccess,
  type SshRelease,
} from "./action-check.ts";
import {
  callReply,
  finalizeReply,
  isReplyFacts,
  isReplyKey,
  replyCodec,
  type ReplyHeld,
} from "./action-reply.ts";
import { addressCodec, decodeAddress } from "./address-codec.ts";
import {
  ACTION_TABLE,
  AddressKind,
  GIT_WRITE_DEADLINE_MS,
  IntakeErrorCode,
  OutboundOperation,
  type OutboundOperationValue,
  type PlatformAddress,
  REPLY_OPERATIONS,
  replyRequestKey,
  ResultClass,
  type ResultClassAnswer,
  type ResultClassValue,
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

const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const ACTION_UNMAPPED_STATUS = 422;
const MATCHED_PULL_REQUEST_COUNT = 1;
const PULL_NUMBER_FLOOR = 0;
const NO_GATE_FILES = 0;
const GATE_FILE_BODY_INTRO =
  "KanthorD does not merge this pull request. The change set of the node changes these gate files of the affected test declaration:";
const GATE_FILE_BODY_OUTRO = "A human reviews and merges this pull request.";
const GATE_FILE_BODY_PART_SEPARATOR = "\n\n";
const GATE_FILE_LINE_SEPARATOR = "\n";

export type PerformBody = {
  key: string;
  commit: string | null;
  comment: string | null;
  reused_evidence_id: string | null;
  merge_evidence_id: string | null;
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
  reply: ReplyHeld | null;
  ssh: SshAccess | null;
}

interface Bound {
  operation: OutboundOperationValue;
  facts: Readonly<ActionFacts>;
  ssh: SshAccess | null;
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
  const performer: Performer = { identity, claim };
  const held: Held = { operation: null, facts: null, reply: null, ssh: null };
  const replies = isReplyKey(body.key);
  return run({
    requestKey: body.request_key,
    deadlineMs: GIT_WRITE_DEADLINE_MS,
    resultCodec: replies ? replyCodec : addressCodec,
    authorize: (tx, now) =>
      authorizePerform(dependencies, tx, now, {
        performer,
        body,
        held,
      }),
    call: (material, scope) =>
      held.reply === null
        ? callAction(dependencies, performer, bound(held), material, scope)
        : callReply(dependencies, performer.identity, held.reply, {
            material,
            scope,
          }),
    readBack: replies
      ? null
      : (material, scope) =>
          readBackAction(dependencies, performer, bound(held), material, scope),
    finalize: (answer) =>
      held.reply === null
        ? finalizePerform(bound(held), answer)
        : finalizeReply(held.reply, answer),
  });
}

function bound(held: Held): Bound {
  assert.ok(held.operation !== null, "The authorization names the operation.");
  assert.ok(held.facts !== null, "The authorization holds the facts.");
  return { operation: held.operation, facts: held.facts, ssh: held.ssh };
}

function authorizePerform(
  dependencies: ActionCheckDependencies,
  tx: Transaction,
  now: number,
  request: { performer: Performer; body: PerformBody; held: Held },
): OutboundAuthorization {
  const { performer, body, held } = request;
  assert.equal(held.operation, null, "A perform authorizes once.");
  const custody = dependencies.custody;
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.FrozenAction,
      identity: performer.identity,
      claim: performer.claim,
      key: body.key,
      commit: body.commit,
      reusedEvidenceId: body.reused_evidence_id,
      mergeEvidenceId: body.merge_evidence_id,
    },
    now,
  );
  const granted = custody.grantFacts(grant);
  if (isReplyFacts(granted.facts))
    return authorizeReplyPerform(custody, tx, now, {
      grant,
      granted: { ...granted, facts: granted.facts },
      body,
      held,
    });
  assert.ok(!isReplyKey(body.key), "A reply key names a reply action.");
  const operation =
    body.merge_evidence_id !== null
      ? OutboundOperation.GitHubPullRequestMerge
      : operationOf(granted.facts.frozen_action.action, grant.platform);
  const ssh = sshReleaseOf(dependencies, tx, now, {
    performer,
    operation,
    binding_id: granted.facts.repository.binding_id,
  });
  held.operation = operation;
  held.facts = granted.facts;
  held.ssh = ssh?.access ?? null;
  const material =
    granted.credential === null ? null : custody.release(tx, grant, now);
  if (material === null) custody.consume(grant);
  return {
    operation,
    project_id: granted.project_id,
    credential:
      operation === OutboundOperation.GitPush
        ? sshCredentialOf(ssh)
        : granted.credential,
    material,
  };
}

function authorizeReplyPerform(
  custody: ActionCheckDependencies["custody"],
  tx: Transaction,
  now: number,
  request: {
    grant: GrantOf<typeof GrantKind.FrozenAction>;
    granted: GrantFacts<GrantOf<typeof GrantKind.FrozenAction>> & {
      facts: ReplyActionFacts;
    };
    body: PerformBody;
    held: Held;
  },
): OutboundAuthorization {
  const { grant, granted, body, held } = request;
  const { facts } = granted;
  const operation = operationOf(facts.frozen_action.action, grant.platform);
  assert.ok(
    REPLY_OPERATIONS.some((candidate) => candidate === operation),
    "A reply maps to a comment operation.",
  );
  assert.ok(granted.credential !== null, "A reply names its credential.");
  const link = facts.frozen_action.configuration.external_link;
  if (
    body.comment === null ||
    body.request_key !== replyRequestKey(facts.node_id, facts.attempt, link)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      VALIDATION_FAILED_CODE,
      "Request validation failed.",
    );
  held.operation = operation;
  held.reply = {
    facts,
    project_id: granted.project_id,
    request_key: body.request_key,
    comment: body.comment,
    operation,
    metadata:
      operation === OutboundOperation.JiraIssueComment
        ? (custody.credentialMetadata(tx, granted.credential)?.metadata ?? null)
        : null,
  };
  return {
    operation,
    project_id: granted.project_id,
    credential: granted.credential,
    material: custody.release(tx, grant, now),
  };
}

function sshReleaseOf(
  dependencies: ActionCheckDependencies,
  tx: Transaction,
  now: number,
  request: {
    performer: Performer;
    operation: OutboundOperationValue;
    binding_id: string;
  },
): SshRelease | null {
  if (request.operation === OutboundOperation.GitHubPullRequestMerge)
    return null;
  return releaseSshAccess(dependencies, tx, now, {
    identity: request.performer.identity,
    claim: request.performer.claim,
    subject: {
      kind: SshIdentitySubjectKind.Binding,
      binding_id: request.binding_id,
    },
  });
}

function sshCredentialOf(ssh: SshRelease | null): string {
  assert.ok(ssh !== null, "A merge push releases its SSH identity.");
  return ssh.credential;
}

function sshOf(action: Bound): SshAccess {
  assert.ok(action.ssh !== null, "A network git call holds its SSH access.");
  return action.ssh;
}

function reusesPullRequest(action: Bound): boolean {
  return (
    action.operation === OutboundOperation.GitHubPullRequest &&
    action.facts.reused_address !== null
  );
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

async function callAction(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  material: Material | null,
  scope: OutboundScope,
): Promise<CallAnswer> {
  if (action.operation === OutboundOperation.GitHubPullRequestMerge)
    return callMergePullRequest(
      dependencies,
      performer.identity,
      action.facts,
      {
        material,
        scope,
      },
    );
  if (reusesPullRequest(action))
    return pushSnapshot(dependencies, performer, action, scope);
  if (action.operation === OutboundOperation.GitHubPullRequest)
    return createPullRequest(dependencies, performer, action, {
      material,
      scope,
    });
  assert.equal(action.operation, OutboundOperation.GitPush);
  assert.equal(material, null, "A merge push holds no material.");
  return callSquashPush(dependencies, action.facts, sshOf(action), scope);
}

async function createPullRequest(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  held: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  const facts = action.facts;
  let contained: string | null;
  try {
    contained = await baseLandingOf(dependencies, action, held.scope);
  } catch (error) {
    return landingFailure(error);
  }
  if (contained !== null)
    return { ok: true, result: branchPushAddress(facts, contained) };
  const call = gitHubCall(performer.identity, held.material, held.scope);
  const answer = await dependencies.github.createPullRequest(
    call,
    targetOf(facts),
    {
      head: performer.claim.nodeBranch,
      base: facts.frozen_action.configuration.base_branch,
      title: commitHeader(facts.node.commit_type, facts.node.name),
      ...gateFileBodyOf(facts),
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

function gateFileBodyOf(facts: Readonly<ActionFacts>): { body?: string } {
  if (facts.gate_files.length === NO_GATE_FILES) return {};
  const lines = facts.gate_files.map((path) => `- \`${path}\``);
  return {
    body: [
      GATE_FILE_BODY_INTRO,
      lines.join(GATE_FILE_LINE_SEPARATOR),
      GATE_FILE_BODY_OUTRO,
    ].join(GATE_FILE_BODY_PART_SEPARATOR),
  };
}

async function pushSnapshot(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  scope: OutboundScope,
): Promise<CallAnswer> {
  const facts = action.facts;
  const reused = reusedAddressOf(facts);
  try {
    await dependencies.gitWriter.pushSnapshotFresh(
      {
        address: facts.repository.address,
        branch: performer.claim.nodeBranch,
        commit: facts.snapshot_commit,
      },
      scope.context,
      deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
      sshOf(action),
    );
    return { ok: true, result: reused };
  } catch (error) {
    return gitFailure(error);
  }
}

function readBackAction(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  material: Material | null,
  scope: OutboundScope,
): Promise<ReadBack> {
  if (action.operation === OutboundOperation.GitHubPullRequestMerge)
    return readBackMergePullRequest(
      dependencies,
      performer.identity,
      action.facts,
      {
        material,
        scope,
      },
    );
  if (reusesPullRequest(action))
    return landedSnapshot(dependencies, performer, action, scope);
  if (action.operation === OutboundOperation.GitHubPullRequest)
    return openPullRequest(dependencies, performer, action.facts, {
      material,
      scope,
    });
  assert.equal(action.operation, OutboundOperation.GitPush);
  assert.equal(material, null, "A merge push holds no material.");
  return landedMerge(dependencies, action, scope);
}

async function openPullRequest(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  facts: Readonly<ActionFacts>,
  held: { material: Material | null; scope: OutboundScope },
): Promise<ReadBack> {
  const call = gitHubCall(performer.identity, held.material, held.scope);
  const answer = await dependencies.github.openPullRequests(
    call,
    targetOf(facts),
    {
      head: performer.claim.nodeBranch,
      base: facts.frozen_action.configuration.base_branch,
    },
  );
  if (!answer.ok || answer.value.length !== MATCHED_PULL_REQUEST_COUNT)
    return { match: false };
  const [number] = answer.value;
  assert.ok(number !== undefined);
  return { match: true, result: pullRequestAddress(facts, number) };
}

async function baseLandingOf(
  dependencies: ActionCheckDependencies,
  action: Bound,
  scope: OutboundScope,
): Promise<string | null> {
  const facts = action.facts;
  const baseBranch = facts.frozen_action.configuration.base_branch;
  assert.ok(baseBranch.length, "An action names its base branch.");
  const landing = await dependencies.gitWriter.landedOn(
    {
      address: facts.repository.address,
      branch: baseBranch,
      commit: facts.snapshot_commit,
    },
    scope.context,
    deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
    sshOf(action),
  );
  if (!landing.landed) return null;
  assert.ok(landing.first_parent !== null, "A landing names its commit.");
  return landing.first_parent;
}

function landingFailure(error: unknown): CallAnswer {
  if (!isGitTransportFailure(error)) throw error;
  return {
    ok: false,
    class: ResultClass.ConfirmedFailure,
    code: error.code,
    message: error.message,
  };
}

async function landedMerge(
  dependencies: ActionCheckDependencies,
  action: Bound,
  scope: OutboundScope,
): Promise<ReadBack> {
  const landed = await baseLandingOf(dependencies, action, scope);
  if (landed === null) return { match: false };
  return { match: true, result: branchPushAddress(action.facts, landed) };
}

async function landedSnapshot(
  dependencies: ActionCheckDependencies,
  performer: Performer,
  action: Bound,
  scope: OutboundScope,
): Promise<ReadBack> {
  const facts = action.facts;
  const reused = reusedAddressOf(facts);
  const landing = await dependencies.gitWriter.landedOn(
    {
      address: facts.repository.address,
      branch: performer.claim.nodeBranch,
      commit: facts.snapshot_commit,
    },
    scope.context,
    deadlineOf(scope, GIT_WRITE_DEADLINE_MS),
    sshOf(action),
  );
  if (!landing.landed) return { match: false };
  return { match: true, result: reused };
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
      code: GIT_TRANSPORT_CODES.includes(answer.code)
        ? answer.code
        : resultCodeOf(action, answer.class),
      message: answer.message,
    },
  };
}

function resultCodeOf(action: Bound, resultClass: ResultClassValue): string {
  assert.ok(Object.values(ResultClass).includes(resultClass));
  if (action.operation === OutboundOperation.GitHubPullRequestMerge)
    return GITHUB_RESULT_CODE_PREFIX + resultClass;
  if (reusesPullRequest(action)) return GIT_FAILED_CODE;
  if (action.operation === OutboundOperation.GitHubPullRequest)
    return GITHUB_RESULT_CODE_PREFIX + resultClass;
  assert.equal(action.operation, OutboundOperation.GitPush);
  return GIT_FAILED_CODE;
}

function pullRequestAddress(
  facts: Readonly<ActionFacts>,
  number: number,
): PlatformAddress {
  assert.ok(Number.isSafeInteger(number) && number > PULL_NUMBER_FLOOR);
  return {
    kind: AddressKind.PullRequest,
    resource_identity: facts.repository.resource_identity,
    number,
  };
}

function reusedAddressOf(facts: Readonly<ActionFacts>): PlatformAddress {
  const reused = facts.reused_address;
  assert.ok(reused !== null, "A reuse names its pull request.");
  assert.equal(reused.resource_identity, facts.repository.resource_identity);
  return pullRequestAddress(facts, reused.number);
}
