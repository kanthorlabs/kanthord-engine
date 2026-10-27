import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type RequestFacts,
} from "../custody/contract.ts";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import {
  background,
  DEADLINE_EXCEEDED_CODE,
  DeadlineExceeded,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  MISSION_SERVICE_NAME,
  PlatformAddressKind,
} from "../mission/contract.ts";
import { HostKeyErrorCode } from "../repository/contract.ts";
import {
  CheckEndState,
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubPlatform,
} from "../repository/github.ts";
import type { GitWriter, SshAccess } from "../repository/index.ts";
import { SshAgentErrorCode } from "../repository/ssh-agent.ts";
import { checkAction } from "./action-check.ts";
import { ResultClass } from "./contract.ts";
import { SSH_HOST, sshAccessOf, sshCustody, sshStore } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = `git@${SSH_HOST}:owner/pushed.git`;
const OTHER_ADDRESS = `git@${SSH_HOST}:owner/other.git`;
const RESOURCE_IDENTITY = "repository:github:owner/pushed";
const PUSHED = "0123456789abcdef0123456789abcdef01234567";
const PULL_NUMBER = 7;
type ResultClassValue = (typeof ResultClass)[keyof typeof ResultClass];
const BAD_GATEWAY_STATUS = 502;

const ONE_LANDING = 1;
const mission: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: MISSION_SERVICE_NAME,
};

function requestFacts(
  address: RequestFacts["address"],
  humanLanding = false,
): RequestFacts {
  return {
    frozen_action: {
      key: "pushed.merge_push",
      binding_id: BINDING_ID,
      action:
        address.kind === PlatformAddressKind.BranchPush
          ? "merge_push"
          : "pull_request",
      expected_end_state:
        address.kind === PlatformAddressKind.BranchPush
          ? ExpectedEndState.BaseBranchPushed
          : ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { base_branch: "main", landing: "human" },
    },
    address,
    repository: {
      binding_id: BINDING_ID,
      address: ADDRESS,
      resource_identity: RESOURCE_IDENTITY,
      base_branch: "main",
    },
    human_landing: humanLanding,
  };
}

const OPEN_PULL_REQUEST = {
  state: "open",
  merged: false,
  merge_commit_sha: null,
  head: { sha: PUSHED },
};

const branchPush: RequestFacts["address"] = {
  kind: "branch_push",
  resource_identity: RESOURCE_IDENTITY,
  branch: "main",
  commit: PUSHED,
};

function harness(
  t: TestContext,
  options: {
    facts: RequestFacts;
    credential?: string;
    pinned?: boolean;
    landingFailure?: Error;
    landed?: boolean;
    checksFailure?: ResultClassValue;
    sshFacts?: { binding_id: string; address: string };
  },
) {
  const { store, pin } = sshStore(t);
  const knownHosts = options.pinned === false ? null : pin(SSH_HOST);
  const fake = sshCustody({
    facts: options.facts,
    credential: options.credential ?? null,
    platform: "github",
    project_id: PROJECT_ID,
    execution: null,
    secret: { key: "api-key" },
    refusal: null,
    sshFacts: options.sshFacts,
  });
  const landings: (SshAccess | undefined)[] = [];
  const gitWriter: GitWriter = {
    mergePushFresh: () => assert.fail("A check pushes nothing."),
    pushSnapshotFresh: () => assert.fail("A check pushes nothing."),
    landedOn: async (_input, _context, _deadline, ssh) => {
      landings.push(ssh);
      if (options.landingFailure !== undefined) throw options.landingFailure;
      return { landed: options.landed ?? true, first_parent: PUSHED };
    },
    changedGateFiles: () => assert.fail("A check pushes nothing."),
    sshAccessOf: sshAccessOf(),
  };
  const refusal = (failure: ResultClassValue) => ({
    ok: false as const,
    class: failure,
    code: GITHUB_RESULT_CODE_PREFIX + failure,
    status: null,
    message: "refused",
  });
  const github = {
    getSettledPullRequest: async () =>
      options.checksFailure === undefined
        ? refusal(ResultClass.FinalRefusal)
        : { ok: true as const, value: OPEN_PULL_REQUEST },
    listReviews: async () => ({ ok: true as const, value: [] }),
    getRequiredChecks: async () =>
      refusal(options.checksFailure ?? ResultClass.FinalRefusal),
  } as unknown as GitHubPlatform;
  const caller: CallerContext = {
    identity: mission,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const check = () =>
    checkAction(
      { store, custody: fake.custody, github, gitWriter },
      caller,
      EVIDENCE_ID,
    );
  const sshRequests = () =>
    fake.requests.filter((request) => request.kind === GrantKind.SshIdentity);
  return { ...fake, knownHosts, landings, check, sshRequests };
}

test("a branch push check reads the landing with an SSH release of the request evidence under the Mission identity and no claim", async (t) => {
  const h = harness(t, { facts: requestFacts(branchPush) });
  const fold = await h.check();
  assert.equal(fold.end_state, CheckEndState.Expected);
  assert.deepEqual(h.sshRequests(), [
    {
      kind: GrantKind.SshIdentity,
      identity: mission,
      subject: {
        kind: SshIdentitySubjectKind.RequestEvidence,
        evidence_id: EVIDENCE_ID,
      },
      claim: null,
    },
  ]);
  assert.equal(h.landings.length, ONE_LANDING);
  const ssh = h.landings[0];
  assert.ok(ssh && "private_key" in ssh);
  assert.equal(ssh.private_key, h.privateKey);
  assert.match(ssh.public_key, /^ssh-ed25519 /);
  assert.equal(ssh.known_hosts, `${h.knownHosts}\n`);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a human landing branch push check answers none when the commit did not land", async (t) => {
  const h = harness(t, {
    facts: requestFacts(branchPush, true),
    landed: false,
  });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
});

test("a human landing branch push check answers expected when the commit landed", async (t) => {
  const h = harness(t, { facts: requestFacts(branchPush, true) });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.Expected,
    landed_commits: [PUSHED],
  });
});

test("a branch push check of an unpinned address host refuses before any git call", async (t) => {
  const h = harness(t, { facts: requestFacts(branchPush), pinned: false });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === HostKeyErrorCode.Unpinned,
  );
  assert.deepEqual(h.landings, []);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a pull request check takes no SSH release", async (t) => {
  const h = harness(t, {
    facts: requestFacts({
      kind: "pull_request",
      resource_identity: RESOURCE_IDENTITY,
      number: PULL_NUMBER,
    }),
    credential: "github",
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError && error.status === BAD_GATEWAY_STATUS,
  );
  assert.deepEqual(h.sshRequests(), []);
  assert.deepEqual(h.landings, []);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a pull request check answers 502 with the platform class when the read of the required checks fails", async (t) => {
  const h = harness(t, {
    facts: requestFacts({
      kind: "pull_request",
      resource_identity: RESOURCE_IDENTITY,
      number: PULL_NUMBER,
    }),
    credential: "github",
    checksFailure: ResultClass.RetryableRefusal,
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === GITHUB_RESULT_CODE_PREFIX + ResultClass.RetryableRefusal,
  );
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a branch push check answers 502 with ssh_agent_failed when the SSH agent fails", async (t) => {
  const h = harness(t, {
    facts: requestFacts(branchPush),
    landingFailure: new Diagnostic(SshAgentErrorCode.Failed, "agent failed"),
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === SshAgentErrorCode.Failed,
  );
  assert.equal(h.landings.length, ONE_LANDING);
});

test("a branch push check answers 502 with the deadline code when the deadline elapses", async (t) => {
  const h = harness(t, {
    facts: requestFacts(branchPush),
    landingFailure: new DeadlineExceeded(),
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === DEADLINE_EXCEEDED_CODE,
  );
  assert.equal(h.landings.length, ONE_LANDING);
});

test("a branch push check fails closed before git when the SSH key names another binding or address than the evidence", async (t) => {
  for (const sshFacts of [
    { binding_id: OTHER_BINDING_ID, address: ADDRESS },
    { binding_id: BINDING_ID, address: OTHER_ADDRESS },
  ]) {
    const h = harness(t, { facts: requestFacts(branchPush), sshFacts });
    await assert.rejects(h.check(), assert.AssertionError);
    assert.deepEqual(h.landings, []);
    assert.ok(h.materials.every((material) => material.dropped));
  }
});
