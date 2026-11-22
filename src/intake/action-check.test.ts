import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import {
  GrantKind,
  type ReplyRequestFacts,
  type RequestFacts,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { background } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  MISSION_SERVICE_NAME,
  PlatformAddressKind,
} from "../mission/contract.ts";
import {
  HostKeyErrorCode,
  RepositoryErrorCode,
} from "../repository/contract.ts";
import {
  CheckEndState,
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  GitHubPlatform,
} from "../repository/github.ts";
import { GitStage, GitWriteError } from "../repository/index.ts";
import type {
  BranchCommitInput,
  GitWriter,
  Landing,
  SshAccess,
} from "../repository/index.ts";
import { SshAgentErrorCode } from "../repository/ssh-agent.ts";
import { checkAction, GIT_PUSH_REFUSED, gitFailure } from "./action-check.ts";
import {
  OutboundOperation,
  OutboundRequestState,
  replyRequestKey,
  ResultClass,
} from "./contract.ts";
import { insertPending, succeed } from "./outbound-store.ts";
import { SSH_HOST, sshAccessOf, sshCustody, sshStore } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = `git@${SSH_HOST}:owner/pushed.git`;
const OTHER_ADDRESS = `git@${SSH_HOST}:owner/other.git`;
const RESOURCE_IDENTITY = "repository:github:owner/pushed";
const PUSHED = "0123456789abcdef0123456789abcdef01234567";
const ASSESSED = "89abcdef0123456789abcdef0123456789abcdef";
const LANDED = "fedcba9876543210fedcba9876543210fedcba98";
const PULL_NUMBER = 7;
type ResultClassValue = (typeof ResultClass)[keyof typeof ResultClass];
const BAD_GATEWAY_STATUS = 502;

const ONE_LANDING = 1;
const LANDED_COMMIT: Landing = {
  landed: true,
  first_parent: LANDED,
  base_moved: false,
};
const NOT_LANDED: Landing = {
  landed: false,
  first_parent: null,
  base_moved: false,
};
const BASE_MOVED: Landing = {
  landed: false,
  first_parent: null,
  base_moved: true,
};
const NO_MATERIALS = 0;
const mission: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: MISSION_SERVICE_NAME,
};

function requestFacts(
  address: RequestFacts["address"],
  humanLanding = false,
  trustedActorIds: string[] = [],
  ignoredChecks: string[] = [],
): RequestFacts {
  return {
    frozen_action: {
      key: "pushed.push",
      binding_id: BINDING_ID,
      action:
        address.kind === PlatformAddressKind.BranchPush
          ? "push"
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
    assessed_commit:
      address.kind === PlatformAddressKind.BranchPush ? ASSESSED : null,
    link_trust: { actor_ids: trustedActorIds },
    ignored_checks: ignoredChecks,
  };
}

const SETTLED_CHECKS = { head_commit: PUSHED, pending: [], failed: [] };
const TRUSTED_ID = 9;
const UNTRUSTED_ID = 7;
const CHANGES_REQUESTED = "CHANGES_REQUESTED";
const USER_TYPE = "User";
const BOT_TYPE = "Bot";

function changeRequest(reviewer: number, type = USER_TYPE) {
  return {
    id: reviewer,
    user: { id: reviewer, type },
    state: CHANGES_REQUESTED,
    commit_id: PUSHED,
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
    facts: RequestFacts | ReplyRequestFacts;
    credential?: string;
    pinned?: boolean;
    landingFailure?: Error;
    landing?: Landing;
    checksFailure?: ResultClassValue;
    reviews?: unknown[];
    checks?: { pending: string[]; failed: string[] };
    checksBaseUrl?: string;
    sshFacts?: { binding_id: string; address: string };
    trees?: { base: string; tested: string } | null;
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
  const landingInputs: BranchCommitInput[] = [];
  const gitWriter: GitWriter = {
    squashPushFresh: () => assert.fail("A check pushes nothing."),
    pushSnapshotFresh: () => assert.fail("A check pushes nothing."),
    landedOn: async (input, _context, _deadline, ssh) => {
      landings.push(ssh);
      landingInputs.push(input);
      if (options.landingFailure !== undefined) throw options.landingFailure;
      return options.landing ?? LANDED_COMMIT;
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
  const checkReads: (readonly string[])[] = [];
  const treeReads: string[] = [];
  const logger = pino({ enabled: false });
  const pullRequest = new GitHubPlatform();
  const github = {
    getSettledPullRequest: async () =>
      options.checksFailure === undefined && options.reviews === undefined
        ? refusal(ResultClass.FinalRefusal)
        : { ok: true as const, value: OPEN_PULL_REQUEST },
    listReviews: async () => ({
      ok: true as const,
      value: options.reviews ?? [],
    }),
    getRequiredChecks: async (
      ...input: Parameters<GitHubPlatform["getRequiredChecks"]>
    ) => {
      checkReads.push(input[2].ignoredChecks);
      if (options.checksBaseUrl !== undefined)
        return new GitHubPlatform({
          baseUrl: options.checksBaseUrl,
        }).getRequiredChecks(...input);
      return options.reviews === undefined
        ? refusal(options.checksFailure ?? ResultClass.FinalRefusal)
        : {
            ok: true as const,
            value: { ...SETTLED_CHECKS, ...options.checks },
          };
    },
    commitTreeOf: async (
      ...input: Parameters<GitHubPlatform["commitTreeOf"]>
    ) => {
      const { ref } = input[2];
      treeReads.push(ref);
      if (options.trees === undefined || options.trees === null)
        return refusal(ResultClass.RetryableRefusal);
      const isBase = ref === BASE_BRANCH;
      return {
        ok: true as const,
        value: {
          sha: isBase ? BASE_HEAD : ref,
          tree: isBase ? options.trees.base : options.trees.tested,
        },
      };
    },
    foldPullRequest: (
      ...input: Parameters<GitHubPlatform["foldPullRequest"]>
    ) => pullRequest.foldPullRequest(...input),
  } as unknown as GitHubPlatform;
  const caller: CallerContext = {
    identity: mission,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const check = () =>
    checkAction(
      { store, custody: fake.custody, github, gitWriter, logger },
      caller,
      EVIDENCE_ID,
    );
  const sshRequests = () =>
    fake.requests.filter((request) => request.kind === GrantKind.SshIdentity);
  return {
    ...fake,
    store,
    knownHosts,
    landings,
    landingInputs,
    checkReads,
    treeReads,
    check,
    sshRequests,
  };
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

test("a branch push check reads the assessed commit and not the request commit", async (t) => {
  const h = await harness(t, { facts: requestFacts(branchPush) });
  await h.check();
  assert.deepEqual(h.landingInputs, [
    { address: ADDRESS, branch: "main", commit: ASSESSED },
  ]);
});

test("a branch push check answers none when nothing landed and the base did not move", async (t) => {
  const h = await harness(t, {
    facts: requestFacts(branchPush, true),
    landing: NOT_LANDED,
  });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
});

test("a human landing branch push check answers none when the base moved", async (t) => {
  const h = await harness(t, {
    facts: requestFacts(branchPush, true),
    landing: BASE_MOVED,
  });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.None,
    landed_commits: [],
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

const pullRequestAddress = {
  kind: PlatformAddressKind.PullRequest,
  resource_identity: RESOURCE_IDENTITY,
  number: PULL_NUMBER,
} as const;

async function endStateOf(
  t: TestContext,
  reviews: unknown[],
  trusted: string[],
) {
  const h = harness(t, {
    facts: requestFacts(pullRequestAddress, false, trusted),
    credential: "github",
    reviews,
  });
  return (await h.check()).end_state;
}

test("a change request of a trusted reviewer answers the end state other", async (t) => {
  assert.equal(
    await endStateOf(t, [changeRequest(TRUSTED_ID)], [String(TRUSTED_ID)]),
    CheckEndState.Other,
  );
});

test("a change request of an untrusted reviewer answers no other end state", async (t) => {
  assert.equal(
    await endStateOf(t, [changeRequest(UNTRUSTED_ID)], [String(TRUSTED_ID)]),
    CheckEndState.None,
  );
  assert.equal(
    await endStateOf(t, [changeRequest(TRUSTED_ID)], []),
    CheckEndState.None,
  );
});

test("a change request of a bot never answers the end state other", async (t) => {
  assert.equal(
    await endStateOf(
      t,
      [changeRequest(TRUSTED_ID, BOT_TYPE)],
      [String(TRUSTED_ID)],
    ),
    CheckEndState.None,
  );
});

test("a node check of an open pull request with a failed run that the rules do not require answers no merged end", async (t) => {
  const h = harness(t, {
    facts: requestFacts(pullRequestAddress, false, [], ["lint"]),
    credential: "github",
    reviews: [],
    checks: { pending: [], failed: ["e2e"] },
  });
  assert.equal((await h.check()).end_state, CheckEndState.ChecksFailed);
  assert.deepEqual(h.checkReads, [["lint"]]);
});

const FRESH_PULL_REQUEST_AGE_MS = 10000;

async function emptyHeadServer(t: TestContext, updatedAt: string) {
  const server = createServer((request, response) => {
    const path = new URL(String(request.url), "http://localhost").pathname;
    const body = path.endsWith("/check-runs")
      ? { total_count: 0, check_runs: [] }
      : path.includes("/pulls/")
        ? {
            number: 7,
            state: "open",
            head: { sha: PUSHED },
            base: { ref: "main" },
            updated_at: updatedAt,
          }
        : [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("regression: e10 gate S1 a node check of an open pull request with no check run on a fresh head answers no merged end", async (t) => {
  const checksBaseUrl = await emptyHeadServer(
    t,
    new Date(Date.now() - FRESH_PULL_REQUEST_AGE_MS).toISOString(),
  );
  const h = harness(t, {
    facts: testedPullRequestFacts(),
    credential: "github",
    reviews: [],
    checksBaseUrl,
    trees: { base: "tree-a", tested: "tree-a" },
  });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.ChecksPending,
    landed_commits: [],
  });
  assert.deepEqual(h.treeReads, []);
});

const BASE_BRANCH = "main";
const BASE_HEAD = "9999999999999999999999999999999999999999";
const SAME_TREE = { base: "tree-a", tested: "tree-a" };
const OTHER_TREE = { base: "tree-a", tested: "tree-b" };

function testedPullRequestFacts(trusted: string[] = []): RequestFacts {
  return {
    ...requestFacts(pullRequestAddress, false, trusted),
    assessed_commit: PUSHED,
  };
}

test("regression: F124 an open pull request whose tree landed answers expected with the base head commit", async (t) => {
  const h = harness(t, {
    facts: testedPullRequestFacts(),
    credential: "github",
    reviews: [],
    trees: SAME_TREE,
  });
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.Expected,
    landed_commits: [BASE_HEAD],
  });
  assert.deepEqual(h.treeReads, [BASE_BRANCH, PUSHED]);
});

test("an open pull request with a different tree keeps the answer none", async (t) => {
  const h = harness(t, {
    facts: testedPullRequestFacts(),
    credential: "github",
    reviews: [],
    trees: OTHER_TREE,
  });
  assert.equal((await h.check()).end_state, CheckEndState.None);
});

test("an open pull request with a failed tree read keeps the answer none", async (t) => {
  const h = harness(t, {
    facts: testedPullRequestFacts(),
    credential: "github",
    reviews: [],
  });
  assert.equal((await h.check()).end_state, CheckEndState.None);
});

test("a pull request whose fold answers another end state reads no tree", async (t) => {
  const h = harness(t, {
    facts: testedPullRequestFacts([String(TRUSTED_ID)]),
    credential: "github",
    reviews: [changeRequest(TRUSTED_ID)],
    trees: SAME_TREE,
  });
  assert.equal((await h.check()).end_state, CheckEndState.Other);
  assert.deepEqual(h.treeReads, []);
});

const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPLY_ATTEMPT = 1;
const REPLY_RESOURCE_IDENTITY = "conversation:github:owner/pushed";
const REPLY_UPDATE_KEY = "issue_comment:4242";
const REPLY_LINK = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: REPLY_RESOURCE_IDENTITY,
  number: 12,
};
const REPLY_REQUEST_KEY = replyRequestKey(NODE_ID, REPLY_ATTEMPT, REPLY_LINK);
const POSTED_RESULT = { update_key: REPLY_UPDATE_KEY, actor_id: "4242" };

const replyFacts: ReplyRequestFacts = {
  frozen_action: {
    key: "conversation.reply.0",
    binding_id: BINDING_ID,
    action: "reply",
    expected_end_state: "posted",
    follows: null,
    configuration: { external_link: REPLY_LINK },
  },
  address: {
    kind: PlatformAddressKind.Comment,
    resource_identity: REPLY_RESOURCE_IDENTITY,
    update_key: REPLY_UPDATE_KEY,
  },
  node_id: NODE_ID,
  attempt: REPLY_ATTEMPT,
};

function replyHarness(t: TestContext, settled: boolean) {
  const h = harness(t, { facts: replyFacts });
  h.store.transaction((tx) => {
    const id = insertPending(tx, {
      project_id: PROJECT_ID,
      operation: OutboundOperation.GitHubIssueComment,
      request_key: REPLY_REQUEST_KEY,
      credential: "github",
      created_at: Date.now(),
    });
    if (settled)
      assert.ok(succeed(tx, id, POSTED_RESULT, [OutboundRequestState.Pending]));
  });
  return h;
}

test("a reply evidence check answers expected when its outbound request succeeded and calls no platform", async (t) => {
  const h = replyHarness(t, true);
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.Expected,
    landed_commits: [],
  });
  assert.deepEqual(h.sshRequests(), []);
  assert.deepEqual(h.landings, []);
  assert.equal(h.materials.length, NO_MATERIALS);
});

test("a reply evidence check answers none while its outbound request is pending", async (t) => {
  const h = replyHarness(t, false);
  assert.deepEqual(await h.check(), {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  assert.deepEqual(h.sshRequests(), []);
  assert.equal(h.materials.length, NO_MATERIALS);
});

test("a push refused for the missing workflow scope answers final_refusal that names the workflow scope", () => {
  const detail =
    "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope";
  const answer = gitFailure(
    new GitWriteError(
      GitStage.Push,
      new Diagnostic(RepositoryErrorCode.GitFailed, "push: git failed.", {
        cause: new Error(`push: git exited with 1: ${detail}`),
      }),
    ),
  );
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.FinalRefusal);
  assert.equal(answer.code, GIT_PUSH_REFUSED);
  assert.equal(
    answer.message,
    `The binding credential has no \`workflow\` scope: ${detail}`,
  );
});
