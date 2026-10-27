import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type ActionFacts,
  type GrantRequest,
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
  ResultClass,
} from "./contract.ts";
import { performAction, type PerformBody } from "./action-perform.ts";
import { runOutbound } from "./outbound.ts";
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
const MERGE_PUSH_ACTION = "merge_push";
const PULL_REQUEST_ACTION = "pull_request";
const ONE_RELEASE = 1;
const TWO_RELEASES = 2;
const NO_MATERIALS = 0;
const REVOKED_CODE = "credential.revision.revoked";
const GIT_FAILED_CODE = "repository.connector.git_failed";
const MERGE_EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REUSED_EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const GitCall = {
  MergePush: "merge_push",
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
    node: { name: "Ship accounts", commit_type: "feat" },
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
    mergePushFresh: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.MergePush, ssh });
      return (options.mergePush ?? (async () => ({ commit: MERGED })))();
    },
    pushSnapshotFresh: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.SnapshotPush, ssh });
    },
    landedOn: async (_input, _context, _deadline, ssh) => {
      git.push({ call: GitCall.Landing, ssh });
      if (options.landingFailure !== undefined) throw options.landingFailure;
      return options.landed
        ? { landed: true, first_parent: MERGED }
        : { landed: false, first_parent: null };
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

test("git.merge_push releases the SSH identity of the binding under the execution claim and records the ssh_credential name", async (t) => {
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
    [GitCall.MergePush],
  );
  assertAccess(h, h.git[0]?.ssh);
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitMergePush,
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
    [GitCall.MergePush, GitCall.Landing],
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
