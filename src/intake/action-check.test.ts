import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type RequestFacts,
} from "../custody/contract.ts";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
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
const EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = `git@${SSH_HOST}:owner/pushed.git`;
const RESOURCE_IDENTITY = "repository:github:owner/pushed";
const PUSHED = "0123456789abcdef0123456789abcdef01234567";
const PULL_NUMBER = 7;
const BAD_GATEWAY_STATUS = 502;

const ONE_LANDING = 1;
const mission: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: MISSION_SERVICE_NAME,
};

function requestFacts(address: RequestFacts["address"]): RequestFacts {
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
  };
}

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
  });
  const landings: (SshAccess | undefined)[] = [];
  const gitWriter: GitWriter = {
    mergePushFresh: () => assert.fail("A check pushes nothing."),
    pushSnapshotFresh: () => assert.fail("A check pushes nothing."),
    landedOn: async (_input, _context, _deadline, ssh) => {
      landings.push(ssh);
      if (options.landingFailure !== undefined) throw options.landingFailure;
      return { landed: true, first_parent: PUSHED };
    },
    sshAccessOf: sshAccessOf(),
  };
  const github = {
    getSettledPullRequest: async () => ({
      ok: false as const,
      class: ResultClass.FinalRefusal,
      code: GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
      status: null,
      message: "refused",
    }),
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
  assert.ok(ssh);
  assert.equal(ssh.private_key, h.privateKey);
  assert.match(ssh.public_key, /^ssh-ed25519 /);
  assert.equal(ssh.known_hosts, `${h.knownHosts}\n`);
  assert.ok(h.materials.every((material) => material.dropped));
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
