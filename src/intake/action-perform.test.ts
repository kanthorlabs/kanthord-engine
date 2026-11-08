import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import {
  type ActionFacts,
  GrantKind,
  type GrantRequest,
  type ReplyActionFacts,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import {
  background,
  DEADLINE_EXCEEDED_CODE,
  DeadlineExceeded,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { HostKeyErrorCode } from "../repository/contract.ts";
import { SshAgentErrorCode } from "../repository/ssh-agent.ts";
import {
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubPlatform,
} from "../repository/github.ts";
import {
  GitStage,
  GitWriteError,
  type GitWriter,
  type SshAccess,
} from "../repository/index.ts";
import {
  AddressKind,
  OutboundOperation,
  OutboundRequestState,
  replyRequestKey,
  ResultClass,
} from "./contract.ts";
import { performAction, type PerformBody } from "./action-perform.ts";
import {
  JIRA_API_ORIGIN,
  JIRA_BASIC_AUTHORIZATION,
  JIRA_COMMENT_ID,
  JIRA_ISSUE_KEY,
  JIRA_METADATA,
  JIRA_MYSELF_URL,
  JIRA_POST_URL,
  JIRA_RESOURCE,
  JIRA_RESOURCE_IDENTITY,
  JIRA_TOKEN,
  JIRA_TOKEN_ACCOUNT_ID,
  JIRA_UPDATE_KEY,
  jsonResponse,
  mockJiraFetch,
  okResponse,
} from "./jira-test-support.ts";
import { runOutbound } from "./outbound.ts";
import {
  mockSlackFetch,
  SLACK_AUTH_TEST_URL,
  SLACK_CHANNEL,
  SLACK_POST_URL,
  SLACK_REPLY_TS,
  SLACK_RESOURCE_IDENTITY,
  SLACK_SECOND_REPLY_TS,
  SLACK_SECOND_UPDATE_KEY,
  SLACK_TEAM_ID,
  SLACK_THREAD_TS,
  SLACK_TOKEN_ACCOUNT_ID,
  SLACK_UPDATE_KEY,
  SLACK_USER_TOKEN,
  slackErrorResponse,
  slackOkResponse,
  slackPostedMessage,
  slackResponse,
} from "./slack-test-support.ts";
import { insertPending, recordResult } from "./outbound-store.ts";
import {
  SSH_CREDENTIAL,
  SSH_HOST,
  sshAccessOf,
  sshCustody,
  sshStore,
} from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXECUTION_ID = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUNTIME_IDENTITY = "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKER_BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = `git@${SSH_HOST}:owner/pushed.git`;
const RESOURCE_IDENTITY = "repository:github:owner/pushed";
const SNAPSHOT = "0123456789abcdef0123456789abcdef01234567";
const MERGED = "89abcdef0123456789abcdef0123456789abcdef";
const API_CREDENTIAL = "github";
const API_KEY = "api-key";
const FIRST_REVISION = 1;
const PULL_NUMBER = 7;
const GATE_FILE_PATHS = ["package.json", "scripts/affected-tests.mjs"];
const GATE_FILE_BODY = [
  "KanthorD does not merge this pull request. The change set of the node changes these gate files of the affected test declaration:",
  "- `package.json`\n- `scripts/affected-tests.mjs`",
  "A human reviews and merges this pull request.",
].join("\n\n");
const MERGE_PUSH_ACTION = "push";
const PULL_REQUEST_ACTION = "pull_request";
const ONE_RELEASE = 1;
const TWO_RELEASES = 2;
const NO_MATERIALS = 0;
const REVOKED_CODE = "credential.revision.revoked";
const GIT_FAILED_CODE = "repository.connector.git_failed";
const GIT_PUSH_REFUSED = "git.push_refused";
const MERGE_EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REUSED_EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const GitCall = {
  Push: "push",
  SnapshotPush: "snapshot_push",
  Landing: "landing",
} as const;
type GitCall = (typeof GitCall)[keyof typeof GitCall];

const claim: ExecutionClaim = {
  executionId: EXECUTION_ID,
  projectId: PROJECT_ID,
  nodeId: NODE_ID,
  attempt: FIRST_REVISION,
  pinnedRevision: FIRST_REVISION,
  nodeBranch: `kanthord/${NODE_ID}`,
  runtimeIdentity: RUNTIME_IDENTITY,
  workerBindingId: WORKER_BINDING_ID,
};
const machine = testMachineIdentity(
  {
    clientId: "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectId: PROJECT_ID,
    resourceIdentity: "worker:kanthord:general",
    name: "harness",
    issuedAt: 0,
  },
  "jti",
  RUNTIME_IDENTITY,
);

function actionFacts(
  action: string,
  overrides: Partial<ActionFacts> = {},
): ActionFacts {
  return {
    frozen_action: {
      key: `pushed.${action}`,
      binding_id: BINDING_ID,
      action,
      expected_end_state:
        action === MERGE_PUSH_ACTION
          ? ExpectedEndState.BaseBranchPushed
          : ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { base_branch: "main", landing: "human" },
    },
    repository: {
      binding_id: BINDING_ID,
      address: ADDRESS,
      resource_identity: RESOURCE_IDENTITY,
      base_branch: "main",
    },
    node: { id: NODE_ID, name: "Ship accounts", commit_type: "feat" },
    snapshot_commit: SNAPSHOT,
    reused_address: null,
    merge_address: null,
    gate_files: [],
    ...overrides,
  };
}

interface Options {
  facts: ActionFacts;
  credential?: string | null;
  pinned?: boolean;
  refusal?: Error | null;
  landed?: boolean;
  landingFailure?: Error;
  mergePush?: () => Promise<{ commit: string }>;
}

function harness(t: TestContext, options: Options) {
  const { store, pin } = sshStore(t);
  const knownHosts = options.pinned === false ? null : pin(SSH_HOST);
  const fake = sshCustody({
    facts: options.facts,
    credential: options.credential ?? null,
    platform: "github",
    project_id: PROJECT_ID,
    execution: {
      execution_id: EXECUTION_ID,
      project_id: PROJECT_ID,
      worker_binding_id: WORKER_BINDING_ID,
      resource_identity: "worker:kanthord:general",
      runtime_identity: RUNTIME_IDENTITY,
      credentials: [],
    },
    secret: { key: API_KEY },
    refusal: options.refusal ?? null,
  });
  const git: { call: GitCall; ssh: SshAccess | undefined }[] = [];
  const gitWriter: GitWriter = {
    squashPushFresh: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.Push, ssh });
      return (options.mergePush ?? (async () => ({ commit: MERGED })))();
    },
    pushSnapshotFresh: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.SnapshotPush, ssh });
    },
    landedOn: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.Landing, ssh });
      if (options.landingFailure !== undefined) throw options.landingFailure;
      return options.landed
        ? { landed: true, first_parent: MERGED, base_moved: false }
        : { landed: false, first_parent: null, base_moved: false };
    },
    changedGateFiles: () => {
      throw new Error("A perform computes no gate file.");
    },
    sshAccessOf: sshAccessOf(),
  };
  const githubCalls: string[] = [];
  const pullRequests: unknown[] = [];
  const refused = async (name: string) => {
    githubCalls.push(name);
    return {
      ok: false as const,
      class: ResultClass.FinalRefusal,
      code: GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
      status: null,
      message: "refused",
    };
  };
  const github = {
    mergeMethodOf: () => refused("merge_method"),
    createPullRequest: (
      _call: unknown,
      _target: unknown,
      pullRequest: unknown,
    ) => {
      pullRequests.push(pullRequest);
      return refused("create");
    },
    openPullRequests: () => refused("open"),
  } as unknown as GitHubPlatform;
  const caller: CallerContext = {
    identity: machine,
    execution: claim,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const inFlight = new Set<string>();
  const logger = pino({ enabled: false });
  const perform = (body: Partial<PerformBody> = {}) =>
    performAction(
      { store, custody: fake.custody, github, gitWriter },
      (request) => runOutbound({ store, logger, inFlight }, caller, request),
      caller,
      {
        key: options.facts.frozen_action.key,
        commit: SNAPSHOT,
        comment: null,
        reused_evidence_id: null,
        merge_evidence_id: null,
        request_key: "request-key",
        ...body,
      },
    );
  const rows = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT operation, state, credential FROM intake_outbound_request",
          )
          .all() as { operation: string; state: string; credential: string }[]
      ).map((row) => ({ ...row })),
    );
  const sshRequests = () =>
    fake.requests.filter(
      (
        request,
      ): request is Extract<
        GrantRequest,
        { kind: typeof GrantKind.SshIdentity }
      > => request.kind === GrantKind.SshIdentity,
    );
  return {
    ...fake,
    knownHosts,
    git,
    githubCalls,
    pullRequests,
    perform,
    rows,
    sshRequests,
  };
}

function assertAccess(
  h: ReturnType<typeof harness>,
  ssh: SshAccess | undefined,
) {
  assert.ok(ssh, "A network git call holds the SSH access.");
  assert.ok("private_key" in ssh);
  assert.equal(ssh.private_key, h.privateKey);
  assert.match(ssh.public_key, /^ssh-ed25519 /);
  assert.equal(ssh.known_hosts, `${h.knownHosts}\n`);
}

function assertBindingRelease(h: ReturnType<typeof harness>) {
  for (const request of h.sshRequests())
    assert.deepEqual(request, {
      kind: GrantKind.SshIdentity,
      identity: machine,
      subject: { kind: SshIdentitySubjectKind.Binding, binding_id: BINDING_ID },
      claim,
    });
}

test("git.push releases the SSH identity of the binding under the execution claim and records the ssh_credential name", async (t) => {
  const h = harness(t, { facts: actionFacts(MERGE_PUSH_ACTION) });
  const answer = await h.perform();
  assert.deepEqual(answer, {
    kind: AddressKind.BranchPush,
    resource_identity: RESOURCE_IDENTITY,
    branch: "main",
    commit: MERGED,
  });
  assert.equal(h.sshRequests().length, ONE_RELEASE);
  assertBindingRelease(h);
  assert.deepEqual(
    h.git.map((item) => item.call),
    [GitCall.Push],
  );
  assertAccess(h, h.git[0]?.ssh);
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitPush,
      state: OutboundRequestState.Succeeded,
      credential: SSH_CREDENTIAL,
    },
  ]);
  assert.ok(h.materials.length > NO_MATERIALS);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("the read-back of a merge push takes its own SSH release under the execution claim", async (t) => {
  const h = harness(t, {
    facts: actionFacts(MERGE_PUSH_ACTION),
    landed: true,
    mergePush: async () => {
      throw new GitWriteError(
        GitStage.Push,
        new Diagnostic(GIT_FAILED_CODE, "The push answer is lost."),
      );
    },
  });
  const lost = await h.perform();
  assert.equal("class" in lost && lost.class, ResultClass.UnknownOutcome);
  const found = await h.perform();
  assert.equal("kind" in found && found.kind, AddressKind.BranchPush);
  assert.deepEqual(
    h.git.map((item) => item.call),
    [GitCall.Push, GitCall.Landing],
  );
  for (const item of h.git) assertAccess(h, item.ssh);
  assert.equal(h.sshRequests().length, TWO_RELEASES);
  assertBindingRelease(h);
  assert.equal(h.rows()[0]?.credential, SSH_CREDENTIAL);
});

test("a revoked pinned SSH revision refuses before any git call and records no request", async (t) => {
  const revoked = new OperationError(
    HttpStatus.Conflict,
    REVOKED_CODE,
    "The pinned credential revision is revoked.",
  );
  const h = harness(t, {
    facts: actionFacts(MERGE_PUSH_ACTION),
    refusal: revoked,
  });
  await assert.rejects(h.perform(), (error) => error === revoked);
  assertBindingRelease(h);
  assert.deepEqual(h.git, []);
  assert.deepEqual(h.rows(), []);
});

test("an unpinned address host refuses before any git call, records no request and drops the SSH material", async (t) => {
  const h = harness(t, {
    facts: actionFacts(MERGE_PUSH_ACTION),
    pinned: false,
  });
  await assert.rejects(
    h.perform(),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === HostKeyErrorCode.Unpinned,
  );
  assert.deepEqual(h.git, []);
  assert.deepEqual(h.rows(), []);
  assert.equal(h.materials.length, ONE_RELEASE);
  assert.ok(h.materials[0]?.dropped);
});

test("a reuse pushes the snapshot with the SSH identity and records no credential", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION, {
      reused_address: {
        kind: "pull_request",
        resource_identity: RESOURCE_IDENTITY,
        number: PULL_NUMBER,
      },
    }),
  });
  const answer = await h.perform({ reused_evidence_id: REUSED_EVIDENCE_ID });
  assert.deepEqual(answer, {
    kind: AddressKind.PullRequest,
    resource_identity: RESOURCE_IDENTITY,
    number: PULL_NUMBER,
  });
  assert.deepEqual(
    h.git.map((item) => item.call),
    [GitCall.SnapshotPush],
  );
  assertAccess(h, h.git[0]?.ssh);
  assertBindingRelease(h);
  assert.equal(h.rows()[0]?.credential, null);
});

test("a pull request create reads the base landing with the SSH identity and records the API credential", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION),
    credential: API_CREDENTIAL,
    landed: true,
  });
  const answer = await h.perform();
  assert.equal("kind" in answer && answer.kind, AddressKind.BranchPush);
  assert.deepEqual(
    h.git.map((item) => item.call),
    [GitCall.Landing],
  );
  assertAccess(h, h.git[0]?.ssh);
  assertBindingRelease(h);
  assert.deepEqual(h.githubCalls, []);
  assert.equal(h.rows()[0]?.credential, API_CREDENTIAL);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a pull request merge takes no SSH release", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION, {
      merge_address: {
        kind: "pull_request",
        resource_identity: RESOURCE_IDENTITY,
        number: PULL_NUMBER,
      },
    }),
    credential: API_CREDENTIAL,
  });
  const answer = await h.perform({ merge_evidence_id: MERGE_EVIDENCE_ID });
  assert.equal("class" in answer && answer.class, ResultClass.FinalRefusal);
  assert.deepEqual(h.sshRequests(), []);
  assert.deepEqual(h.git, []);
  assert.deepEqual(h.githubCalls, ["merge_method"]);
  assert.equal(
    h.rows()[0]?.operation,
    OutboundOperation.GitHubPullRequestMerge,
  );
});

test("an SSH agent failure of a merge push answers confirmed_failure with ssh_agent_failed", async (t) => {
  const h = harness(t, {
    facts: actionFacts(MERGE_PUSH_ACTION),
    mergePush: async () => {
      throw new GitWriteError(
        GitStage.BeforePush,
        new Diagnostic(SshAgentErrorCode.Failed, "agent failed"),
      );
    },
  });
  const answer = await h.perform();
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.ConfirmedFailure);
  assert.equal(answer.code, SshAgentErrorCode.Failed);
  assert.equal(h.rows()[0]?.state, OutboundRequestState.Failed);
});

test("an SSH agent failure of the base landing read of a pull request create answers confirmed_failure with ssh_agent_failed", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION),
    credential: API_CREDENTIAL,
    landingFailure: new Diagnostic(SshAgentErrorCode.Failed, "agent failed"),
  });
  const answer = await h.perform();
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.ConfirmedFailure);
  assert.equal(answer.code, SshAgentErrorCode.Failed);
  assert.deepEqual(h.githubCalls, []);
  assert.ok(h.materials.every((material) => material.dropped));
});

const PUSH_FAILURES = [
  {
    stderr: " ! [rejected]        abc -> main (non-fast-forward)",
    class: ResultClass.RetryableRefusal,
    code: GIT_FAILED_CODE,
  },
  {
    stderr: "remote: error: GH013: Repository rule violations found.\nTo host",
    class: ResultClass.FinalRefusal,
    code: GIT_PUSH_REFUSED,
  },
  {
    stderr: "fatal: the remote end hung up unexpectedly",
    class: ResultClass.UnknownOutcome,
    code: GIT_FAILED_CODE,
  },
];

for (const failure of PUSH_FAILURES)
  test(`a merge push whose stderr is ${failure.class} answers ${failure.class}`, async (t) => {
    const h = harness(t, {
      facts: actionFacts(MERGE_PUSH_ACTION),
      mergePush: async () => {
        throw new GitWriteError(
          GitStage.Push,
          new Diagnostic(GIT_FAILED_CODE, "push: git failed.", {
            cause: new Error(`push: git exited with 1: ${failure.stderr}`),
          }),
        );
      },
    });
    const answer = await h.perform();
    assert.ok("class" in answer, JSON.stringify(answer));
    assert.equal(answer.class, failure.class);
    assert.equal(answer.code, failure.code);
  });

test("a deadline of a merge push answers confirmed_failure with the deadline code", async (t) => {
  const h = harness(t, {
    facts: actionFacts(MERGE_PUSH_ACTION),
    mergePush: async () => {
      throw new GitWriteError(GitStage.BeforePush, new DeadlineExceeded());
    },
  });
  const answer = await h.perform();
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.ConfirmedFailure);
  assert.equal(answer.code, DEADLINE_EXCEEDED_CODE);
  assert.equal(h.rows()[0]?.state, OutboundRequestState.Failed);
});

test("a deadline of the base landing read of a pull request create answers confirmed_failure with the deadline code", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION),
    credential: API_CREDENTIAL,
    landingFailure: new DeadlineExceeded(),
  });
  const answer = await h.perform();
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.ConfirmedFailure);
  assert.equal(answer.code, DEADLINE_EXCEEDED_CODE);
  assert.deepEqual(h.githubCalls, []);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a pull request create names the gate files in its body", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION, { gate_files: GATE_FILE_PATHS }),
    credential: API_CREDENTIAL,
  });
  await h.perform();
  assert.deepEqual(h.pullRequests, [
    {
      head: claim.nodeBranch,
      base: "main",
      title: "feat: ship accounts",
      body: GATE_FILE_BODY,
    },
  ]);
});

test("a pull request create without gate files sends no body", async (t) => {
  const h = harness(t, {
    facts: actionFacts(PULL_REQUEST_ACTION),
    credential: API_CREDENTIAL,
  });
  await h.perform();
  assert.equal(h.pullRequests.length, ONE_RELEASE);
  assert.equal(Object.hasOwn(h.pullRequests[0] as object, "body"), false);
});

const REPLY_RESOURCE_IDENTITY = "conversation:github:owner/pushed";
const REPLY_REPOSITORY = "owner/pushed";
const REPLY_ACTION = "reply";
const REPLY_KEY = "conversation.reply.0";
const REPLY_LINK = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: REPLY_RESOURCE_IDENTITY,
  number: 12,
};
const REPLY_BODY =
  "KanthorD: the review of node Ship accounts passed at attempt 1.";
const FIRST_UPDATE_KEY = "issue_comment:101";
const SECOND_UPDATE_KEY = "issue_comment:102";
const REPLY_ACTOR_ID = "4242";
const SECOND_ATTEMPT = 2;
const ONE_POST = 1;
const TWO_POSTS = 2;
const NO_READS = 0;
const ONE_READ = 1;

function replyFacts(attempt: number): ReplyActionFacts {
  return {
    frozen_action: {
      key: REPLY_KEY,
      binding_id: BINDING_ID,
      action: REPLY_ACTION,
      expected_end_state: "posted",
      follows: null,
      configuration: { external_link: REPLY_LINK },
    },
    conversation: {
      binding_id: BINDING_ID,
      resource_identity: REPLY_RESOURCE_IDENTITY,
      repository: REPLY_REPOSITORY,
    },
    node_id: NODE_ID,
    attempt,
  };
}

type Post = {
  number: number;
  body: string;
  resource: string;
  pending: unknown;
};

function replyHarness(t: TestContext) {
  const { store } = sshStore(t);
  const script = {
    facts: replyFacts(FIRST_REVISION),
    credential: API_CREDENTIAL,
    platform: "github",
    project_id: PROJECT_ID,
    execution: {
      execution_id: EXECUTION_ID,
      project_id: PROJECT_ID,
      worker_binding_id: WORKER_BINDING_ID,
      resource_identity: "worker:kanthord:general",
      runtime_identity: RUNTIME_IDENTITY,
      credentials: [],
    },
    secret: { key: API_KEY },
    refusal: null,
  };
  const fake = sshCustody(script);
  const posts: Post[] = [];
  const answers: (() => unknown)[] = [];
  let accountReads = NO_READS;
  const pendingResult = () =>
    store.transaction(
      (tx) =>
        (
          tx.database
            .prepare(
              "SELECT result FROM intake_outbound_request WHERE state != 'succeeded' ORDER BY created_at DESC",
            )
            .get() as { result: string | null } | undefined
        )?.result ?? null,
    );
  const github = {
    readTokenAccount: async () => {
      accountReads++;
      return { ok: true as const, value: REPLY_ACTOR_ID };
    },
    postIssueComment: async (
      _call: unknown,
      target: { resource: string },
      number: number,
      body: string,
    ) => {
      posts.push({
        number,
        body,
        resource: target.resource,
        pending: pendingResult(),
      });
      const answer = answers.shift();
      assert.ok(answer !== undefined, "Each post has a scripted answer.");
      return answer();
    },
  } as unknown as GitHubPlatform;
  const caller: CallerContext = {
    identity: machine,
    execution: claim,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const inFlight = new Set<string>();
  const logger = pino({ enabled: false });
  const perform = (
    attempt = FIRST_REVISION,
    requestKey = replyRequestKey(NODE_ID, attempt, REPLY_LINK),
  ) => {
    script.facts = replyFacts(attempt);
    return performAction(
      {
        store,
        custody: fake.custody,
        github,
        gitWriter: {
          squashPushFresh: () => assert.fail("A reply pushes nothing."),
          pushSnapshotFresh: () => assert.fail("A reply pushes nothing."),
          landedOn: () => assert.fail("A reply pushes nothing."),
          changedGateFiles: () => assert.fail("A reply pushes nothing."),
          sshAccessOf: () => assert.fail("A reply holds no SSH access."),
        },
      },
      (request) => runOutbound({ store, logger, inFlight }, caller, request),
      caller,
      {
        key: REPLY_KEY,
        commit: null,
        comment: REPLY_BODY,
        reused_evidence_id: null,
        merge_evidence_id: null,
        request_key: requestKey,
      },
    );
  };
  const rows = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT operation, state, credential, result FROM intake_outbound_request ORDER BY created_at, id",
          )
          .all() as {
          operation: string;
          state: string;
          credential: string;
          result: string | null;
        }[]
      ).map((row) => ({
        ...row,
        result: row.result === null ? null : JSON.parse(row.result),
      })),
    );
  const posted = (update_key: string) => () => ({
    ok: true as const,
    value: { update_key, actor_id: REPLY_ACTOR_ID },
  });
  return {
    ...fake,
    store,
    posts,
    answers,
    accountReads: () => accountReads,
    perform,
    rows,
    posted,
  };
}

test("a reply action of a github conversation binding posts one comment and answers its comment address", async (t) => {
  const h = replyHarness(t);
  h.answers.push(h.posted(FIRST_UPDATE_KEY));
  assert.deepEqual(await h.perform(), {
    kind: AddressKind.Comment,
    resource_identity: REPLY_RESOURCE_IDENTITY,
    update_key: FIRST_UPDATE_KEY,
  });
  assert.deepEqual(
    h.posts.map(({ number, body, resource }) => ({ number, body, resource })),
    [
      {
        number: REPLY_LINK.number,
        body: REPLY_BODY,
        resource: REPLY_REPOSITORY,
      },
    ],
  );
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitHubIssueComment,
      state: OutboundRequestState.Succeeded,
      credential: API_CREDENTIAL,
      result: { update_key: FIRST_UPDATE_KEY, actor_id: REPLY_ACTOR_ID },
    },
  ]);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("the first reply on a link reads the token account once and records it in the pending row, and a later reply on the link reads it no more", async (t) => {
  const h = replyHarness(t);
  h.answers.push(h.posted(FIRST_UPDATE_KEY), h.posted(SECOND_UPDATE_KEY));
  await h.perform();
  assert.equal(h.accountReads(), ONE_READ);
  assert.deepEqual(JSON.parse(h.posts[0]!.pending as string), {
    actor_id: REPLY_ACTOR_ID,
  });
  await h.perform(SECOND_ATTEMPT);
  assert.equal(h.accountReads(), ONE_READ);
  assert.equal(h.posts.length, TWO_POSTS);
  assert.equal(h.posts[1]!.pending, null);
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Succeeded, OutboundRequestState.Succeeded],
  );
});

test("a reply call with no answer sets the request failed, and a repeat posts again", async (t) => {
  const h = replyHarness(t);
  h.answers.push(
    () => ({
      ok: false,
      class: ResultClass.UnknownOutcome,
      code: GITHUB_RESULT_CODE_PREFIX + ResultClass.UnknownOutcome,
      status: null,
      message: "no answer",
    }),
    h.posted(FIRST_UPDATE_KEY),
  );
  const lost = await h.perform();
  assert.equal("class" in lost && lost.class, ResultClass.UnknownOutcome);
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Failed],
  );
  const repeated = await h.perform();
  assert.equal("kind" in repeated && repeated.kind, AddressKind.Comment);
  assert.equal(h.posts.length, TWO_POSTS);
  assert.equal(h.accountReads(), ONE_READ);
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitHubIssueComment,
      state: OutboundRequestState.Succeeded,
      credential: API_CREDENTIAL,
      result: { update_key: FIRST_UPDATE_KEY, actor_id: REPLY_ACTOR_ID },
    },
  ]);
});

test("a pending reply request with no running call posts again on a repeat without reading the account again", async (t) => {
  const h = replyHarness(t);
  h.store.transaction((tx) => {
    const id = insertPending(tx, {
      project_id: PROJECT_ID,
      operation: OutboundOperation.GitHubIssueComment,
      request_key: replyRequestKey(NODE_ID, FIRST_REVISION, REPLY_LINK),
      credential: API_CREDENTIAL,
      created_at: Date.now(),
    });
    assert.ok(recordResult(tx, id, { actor_id: REPLY_ACTOR_ID }));
  });
  h.answers.push(h.posted(FIRST_UPDATE_KEY));
  const answer = await h.perform();
  assert.equal("kind" in answer && answer.kind, AddressKind.Comment);
  assert.equal(h.posts.length, ONE_POST);
  assert.equal(h.accountReads(), NO_READS);
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Succeeded],
  );
});

test("a reply request key that does not name its node, attempt and link refuses before any call", async (t) => {
  const h = replyHarness(t);
  await assert.rejects(
    h.perform(
      FIRST_REVISION,
      replyRequestKey(NODE_ID, SECOND_ATTEMPT, REPLY_LINK),
    ),
    (error) =>
      error instanceof OperationError && error.status === HttpStatus.BadRequest,
  );
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.rows(), []);
});

const JIRA_CREDENTIAL = "jira-conversation";
const JIRA_REPLY_LINK = {
  kind: ExternalLinkKind.JiraIssue,
  resource_identity: JIRA_RESOURCE_IDENTITY,
  key: JIRA_ISSUE_KEY,
};
const JIRA_SECOND_UPDATE_KEY = "jira_comment:acme.atlassian.net:10044";
const JIRA_SERVER_ERROR = 503;
const JIRA_CREATED = 201;

function jiraReplyFacts(attempt: number): ReplyActionFacts {
  return {
    ...replyFacts(attempt),
    frozen_action: {
      ...replyFacts(attempt).frozen_action,
      configuration: { external_link: JIRA_REPLY_LINK },
    },
    conversation: {
      binding_id: BINDING_ID,
      resource_identity: JIRA_RESOURCE_IDENTITY,
      repository: JIRA_RESOURCE,
    },
  };
}

function jiraReplyHarness(
  t: TestContext,
  metadata: Record<string, unknown> = JIRA_METADATA,
) {
  const { store } = sshStore(t);
  const script = {
    facts: jiraReplyFacts(FIRST_REVISION),
    credential: JIRA_CREDENTIAL,
    platform: "jira",
    project_id: PROJECT_ID,
    execution: {
      execution_id: EXECUTION_ID,
      project_id: PROJECT_ID,
      worker_binding_id: WORKER_BINDING_ID,
      resource_identity: "worker:kanthord:general",
      runtime_identity: RUNTIME_IDENTITY,
      credentials: [],
    },
    secret: { key: JIRA_TOKEN },
    metadata,
    refusal: null,
  };
  const fake = sshCustody(script);
  const script_ = {
    posts: [] as (() => Response | Promise<Response>)[],
  };
  const fetched = mockJiraFetch(t, (request) => {
    if (request.url === JIRA_MYSELF_URL)
      return okResponse({ accountId: JIRA_TOKEN_ACCOUNT_ID });
    assert.equal(request.url, JIRA_POST_URL);
    const answer = script_.posts.shift();
    assert.ok(answer !== undefined, "Each post has a scripted answer.");
    return answer();
  });
  const caller: CallerContext = {
    identity: machine,
    execution: claim,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const inFlight = new Set<string>();
  const logger = pino({ enabled: false });
  const unexpected = () => assert.fail("A Jira reply calls no GitHub.");
  const perform = (attempt = FIRST_REVISION) => {
    script.facts = jiraReplyFacts(attempt);
    return performAction(
      {
        store,
        custody: fake.custody,
        github: {
          readTokenAccount: unexpected,
          postIssueComment: unexpected,
        } as unknown as GitHubPlatform,
        gitWriter: {
          squashPushFresh: unexpected,
          pushSnapshotFresh: unexpected,
          landedOn: unexpected,
          changedGateFiles: unexpected,
          sshAccessOf: unexpected,
        },
      },
      (request) => runOutbound({ store, logger, inFlight }, caller, request),
      caller,
      {
        key: REPLY_KEY,
        commit: null,
        comment: REPLY_BODY,
        reused_evidence_id: null,
        merge_evidence_id: null,
        request_key: replyRequestKey(NODE_ID, attempt, JIRA_REPLY_LINK),
      },
    );
  };
  const rows = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT operation, state, credential, result FROM intake_outbound_request ORDER BY created_at, id",
          )
          .all() as {
          operation: string;
          state: string;
          credential: string;
          result: string | null;
        }[]
      ).map((row) => ({
        ...row,
        result: row.result === null ? null : JSON.parse(row.result),
      })),
    );
  const posted = (id: string) => () =>
    jsonResponse(JIRA_CREATED, {
      id,
      author: { accountId: JIRA_TOKEN_ACCOUNT_ID },
    });
  return {
    ...fake,
    posts: script_.posts,
    requests: fetched.requests,
    perform,
    rows,
    posted,
  };
}

test("a reply action of a jira binding posts one ADF comment and answers its comment address", async (t) => {
  const h = jiraReplyHarness(t);
  h.posts.push(h.posted(JIRA_COMMENT_ID));
  assert.deepEqual(await h.perform(), {
    kind: AddressKind.Comment,
    resource_identity: JIRA_RESOURCE_IDENTITY,
    update_key: JIRA_UPDATE_KEY,
  });
  assert.deepEqual(
    h.requests.map(({ method, url, authorization }) => [
      method,
      url,
      authorization,
    ]),
    [
      ["GET", JIRA_MYSELF_URL, JIRA_BASIC_AUTHORIZATION],
      ["POST", JIRA_POST_URL, JIRA_BASIC_AUTHORIZATION],
    ],
  );
  assert.deepEqual(h.requests[1]!.body, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: REPLY_BODY }] },
      ],
    },
  });
  assert.ok(h.requests.every(({ url }) => url.startsWith(JIRA_API_ORIGIN)));
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.JiraIssueComment,
      state: OutboundRequestState.Succeeded,
      credential: JIRA_CREDENTIAL,
      result: { update_key: JIRA_UPDATE_KEY, actor_id: JIRA_TOKEN_ACCOUNT_ID },
    },
  ]);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("the first Jira reply on a link reads the accountId of myself once and a later reply reads it no more", async (t) => {
  const h = jiraReplyHarness(t);
  h.posts.push(h.posted(JIRA_COMMENT_ID), h.posted("10044"));
  await h.perform();
  const second = await h.perform(SECOND_ATTEMPT);
  assert.equal(
    "update_key" in second && second.update_key,
    JIRA_SECOND_UPDATE_KEY,
  );
  assert.deepEqual(
    h.requests.map(({ method, url }) => `${method} ${url}`),
    [
      `GET ${JIRA_MYSELF_URL}`,
      `POST ${JIRA_POST_URL}`,
      `POST ${JIRA_POST_URL}`,
    ],
  );
});

test("a Jira reply call with no answer sets the request failed and answers the Jira result code, and a repeat posts again", async (t) => {
  const h = jiraReplyHarness(t);
  h.posts.push(
    () => jsonResponse(JIRA_SERVER_ERROR, {}),
    h.posted(JIRA_COMMENT_ID),
  );
  const lost = await h.perform();
  assert.ok("class" in lost);
  assert.equal(lost.class, ResultClass.UnknownOutcome);
  assert.equal(lost.code, `intake.platform.jira.${ResultClass.UnknownOutcome}`);
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Failed],
  );
  const repeated = await h.perform();
  assert.equal("kind" in repeated && repeated.kind, AddressKind.Comment);
  assert.deepEqual(
    h.requests.map(({ method }) => method),
    ["GET", "POST", "POST"],
  );
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Succeeded],
  );
});

const SLACK_CREDENTIAL = "slack-conversation";
const SLACK_REPLY_LINK = {
  kind: ExternalLinkKind.SlackThread,
  resource_identity: SLACK_RESOURCE_IDENTITY,
  channel: SLACK_CHANNEL,
  thread_ts: SLACK_THREAD_TS,
};
const SLACK_SERVER_ERROR = 503;
const SLACK_BEARER = `Bearer ${SLACK_USER_TOKEN}`;
const SLACK_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function slackReplyFacts(attempt: number): ReplyActionFacts {
  return {
    ...replyFacts(attempt),
    frozen_action: {
      ...replyFacts(attempt).frozen_action,
      configuration: { external_link: SLACK_REPLY_LINK },
    },
    conversation: {
      binding_id: BINDING_ID,
      resource_identity: SLACK_RESOURCE_IDENTITY,
      repository: SLACK_TEAM_ID,
    },
  };
}

function slackReplyHarness(t: TestContext) {
  const { store } = sshStore(t);
  const script = {
    facts: slackReplyFacts(FIRST_REVISION),
    credential: SLACK_CREDENTIAL,
    platform: "slack",
    project_id: PROJECT_ID,
    execution: {
      execution_id: EXECUTION_ID,
      project_id: PROJECT_ID,
      worker_binding_id: WORKER_BINDING_ID,
      resource_identity: "worker:kanthord:general",
      runtime_identity: RUNTIME_IDENTITY,
      credentials: [],
    },
    secret: { key: SLACK_USER_TOKEN },
    metadata: null,
    refusal: null,
  };
  const fake = sshCustody(script);
  const posts: (() => Response | Promise<Response>)[] = [];
  const fetched = mockSlackFetch(t, (request) => {
    if (request.url === SLACK_AUTH_TEST_URL)
      return slackOkResponse({ user_id: SLACK_TOKEN_ACCOUNT_ID });
    assert.equal(request.url, SLACK_POST_URL);
    const answer = posts.shift();
    assert.ok(answer !== undefined, "Each post has a scripted answer.");
    return answer();
  });
  const caller: CallerContext = {
    identity: machine,
    execution: claim,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const inFlight = new Set<string>();
  const logger = pino({ enabled: false });
  const unexpected = () => assert.fail("A Slack reply calls no GitHub.");
  const perform = (attempt = FIRST_REVISION) => {
    script.facts = slackReplyFacts(attempt);
    return performAction(
      {
        store,
        custody: fake.custody,
        github: {
          readTokenAccount: unexpected,
          postIssueComment: unexpected,
        } as unknown as GitHubPlatform,
        gitWriter: {
          squashPushFresh: unexpected,
          pushSnapshotFresh: unexpected,
          landedOn: unexpected,
          changedGateFiles: unexpected,
          sshAccessOf: unexpected,
        },
      },
      (request) => runOutbound({ store, logger, inFlight }, caller, request),
      caller,
      {
        key: REPLY_KEY,
        commit: null,
        comment: REPLY_BODY,
        reused_evidence_id: null,
        merge_evidence_id: null,
        request_key: replyRequestKey(NODE_ID, attempt, SLACK_REPLY_LINK),
      },
    );
  };
  const rows = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT operation, state, credential, result FROM intake_outbound_request ORDER BY created_at, id",
          )
          .all() as {
          operation: string;
          state: string;
          credential: string;
          result: string | null;
        }[]
      ).map((row) => ({
        ...row,
        result: row.result === null ? null : JSON.parse(row.result),
      })),
    );
  const posted = (ts: string, user?: string) => () =>
    slackOkResponse(slackPostedMessage(ts, user));
  return {
    ...fake,
    posts,
    requests: fetched.requests,
    perform,
    rows,
    posted,
  };
}

test("a reply action of a slack binding posts one message with the thread and the user token and answers its comment address", async (t) => {
  const h = slackReplyHarness(t);
  h.posts.push(h.posted(SLACK_REPLY_TS, SLACK_TOKEN_ACCOUNT_ID));
  assert.deepEqual(await h.perform(), {
    kind: AddressKind.Comment,
    resource_identity: SLACK_RESOURCE_IDENTITY,
    update_key: SLACK_UPDATE_KEY,
  });
  assert.deepEqual(
    h.requests.map(({ method, url, authorization }) => [
      method,
      url,
      authorization,
    ]),
    [
      ["POST", SLACK_AUTH_TEST_URL, SLACK_BEARER],
      ["POST", SLACK_POST_URL, SLACK_BEARER],
    ],
  );
  assert.equal(h.requests[1]!.contentType, SLACK_JSON_CONTENT_TYPE);
  assert.deepEqual(h.requests[1]!.body, {
    channel: SLACK_CHANNEL,
    thread_ts: SLACK_THREAD_TS,
    text: REPLY_BODY,
  });
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.SlackThreadReply,
      state: OutboundRequestState.Succeeded,
      credential: SLACK_CREDENTIAL,
      result: {
        update_key: SLACK_UPDATE_KEY,
        actor_id: SLACK_TOKEN_ACCOUNT_ID,
      },
    },
  ]);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a Slack post answer without a user keeps the account of auth.test as the actor", async (t) => {
  const h = slackReplyHarness(t);
  h.posts.push(h.posted(SLACK_REPLY_TS));
  await h.perform();
  assert.deepEqual(
    h.rows().map((row) => row.result),
    [{ update_key: SLACK_UPDATE_KEY, actor_id: SLACK_TOKEN_ACCOUNT_ID }],
  );
});

test("the first Slack reply on a link reads the user_id of auth.test once and a later reply reads it no more", async (t) => {
  const h = slackReplyHarness(t);
  h.posts.push(h.posted(SLACK_REPLY_TS), h.posted(SLACK_SECOND_REPLY_TS));
  await h.perform();
  const second = await h.perform(SECOND_ATTEMPT);
  assert.equal(
    "update_key" in second && second.update_key,
    SLACK_SECOND_UPDATE_KEY,
  );
  assert.deepEqual(
    h.requests.map(({ method, url }) => `${method} ${url}`),
    [
      `POST ${SLACK_AUTH_TEST_URL}`,
      `POST ${SLACK_POST_URL}`,
      `POST ${SLACK_POST_URL}`,
    ],
  );
});

test("a Slack reply call with no answer sets the request failed and answers the Slack result code, and a repeat posts again", async (t) => {
  const h = slackReplyHarness(t);
  h.posts.push(
    () => slackResponse(SLACK_SERVER_ERROR, {}),
    h.posted(SLACK_REPLY_TS),
  );
  const lost = await h.perform();
  assert.ok("class" in lost);
  assert.equal(lost.class, ResultClass.UnknownOutcome);
  assert.equal(
    lost.code,
    `intake.platform.slack.${ResultClass.UnknownOutcome}`,
  );
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Failed],
  );
  const repeated = await h.perform();
  assert.equal("kind" in repeated && repeated.kind, AddressKind.Comment);
  assert.deepEqual(
    h.requests.map(({ method }) => method),
    ["POST", "POST", "POST"],
  );
  assert.deepEqual(
    h.rows().map((row) => row.state),
    [OutboundRequestState.Succeeded],
  );
});

test("a Slack refusal with ok false answers the Slack result code and a lost server answer stays unknown", async (t) => {
  const h = slackReplyHarness(t);
  h.posts.push(() => slackErrorResponse("channel_not_found"));
  const refused = await h.perform();
  assert.ok("class" in refused);
  assert.equal(refused.class, ResultClass.FinalRefusal);
  assert.equal(
    refused.code,
    `intake.platform.slack.${ResultClass.FinalRefusal}`,
  );
  h.posts.push(() => slackErrorResponse("internal_error"));
  const lost = await h.perform();
  assert.ok("class" in lost);
  assert.equal(lost.class, ResultClass.UnknownOutcome);
});

const REPLY_REQUESTS = 2;
const OTHER_JIRA_SITE = "other.atlassian.net";
const UPPER_CASE_JIRA_SITE = "ACME.atlassian.net";

test("a Jira reply with a credential of another site calls no Jira URL and answers the final refusal", async (t) => {
  const h = jiraReplyHarness(t, { ...JIRA_METADATA, site: OTHER_JIRA_SITE });
  const refused = await h.perform();
  assert.ok("class" in refused);
  assert.equal(refused.class, ResultClass.FinalRefusal);
  assert.equal(
    refused.code,
    `intake.platform.jira.${ResultClass.FinalRefusal}`,
  );
  assert.deepEqual(h.requests, []);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a Jira reply with a credential of the same site in upper case posts", async (t) => {
  const h = jiraReplyHarness(t, {
    ...JIRA_METADATA,
    site: UPPER_CASE_JIRA_SITE,
  });
  h.posts.push(h.posted(JIRA_COMMENT_ID));
  const answer = await h.perform();
  assert.equal("kind" in answer && answer.kind, AddressKind.Comment);
  assert.equal(h.requests.length, REPLY_REQUESTS);
});
