import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import pino from "pino";
import {
  type ActionFacts,
  GrantKind,
  type GrantRequest,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import {
  ExpectedEndState,
  GITHUB_RESULT_CODE_PREFIX,
  GitHubPlatform,
} from "../repository/github.ts";
import { GIT_FAILED_CODE, GIT_PUSH_REFUSED } from "./action-check.ts";
import {
  FOREIGN_MERGE_ANSWER_MESSAGE,
  mergeAction,
  type MergeBody,
} from "./action-merge.ts";
import {
  AddressKind,
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
  SERVICE_MERGE_REQUEST_KEY_PREFIX,
} from "./contract.ts";
import { insertPending, succeed } from "./outbound-store.ts";
import { runOutbound } from "./outbound.ts";
import {
  SSH_CREDENTIAL,
  SSH_HOST,
  sshAccessOf,
  sshCustody,
  sshStore,
} from "./test-support.ts";
import {
  BaseMovedError,
  GIT_BASE_MOVED,
  GitStage,
  GitWriteError,
  type GitWriter,
} from "../repository/index.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LANDED_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const ADDRESS = `git@${SSH_HOST}:owner/pushed.git`;
const RESOURCE_IDENTITY = "repository:github:owner/pushed";
const TESTED_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const API_CREDENTIAL = "github";
const PULL_NUMBER = 7;
const OTHER_PULL_NUMBER = 8;
const REVOKED_CODE = "credential.revision.revoked";
const SETTINGS_ROUTE = "GET /repos/owner/pushed";
const PULL_ROUTE = `GET /repos/owner/pushed/pulls/${PULL_NUMBER}`;
const MERGE_ROUTE = `PUT /repos/owner/pushed/pulls/${PULL_NUMBER}/merge`;
const HTTP_OK = 200;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const ONE_REQUEST = 1;
const REQUEST_KEY = "request-key";

const Platform = {
  Merges: "merges",
  LosesMergeAnswer: "loses_merge_answer",
  RefusesMerge: "refuses_merge",
} as const;
type Platform = (typeof Platform)[keyof typeof Platform];

const mergeAddress = {
  kind: AddressKind.PullRequest,
  resource_identity: RESOURCE_IDENTITY,
  number: PULL_NUMBER,
} as const;

const facts: ActionFacts = {
  frozen_action: {
    key: "pushed.pull_request",
    binding_id: BINDING_ID,
    action: "pull_request",
    expected_end_state: ExpectedEndState.PullRequestMerged,
    follows: null,
    configuration: { base_branch: "main", landing: "kanthord" },
  },
  repository: {
    binding_id: BINDING_ID,
    address: ADDRESS,
    resource_identity: RESOURCE_IDENTITY,
    base_branch: "main",
  },
  node: { id: NODE_ID, name: "Ship accounts", commit_type: "feat" },
  snapshot_commit: TESTED_COMMIT,
  reused_address: null,
  merge_address: mergeAddress,
  gate_files: [],
};

const branchPushAddress = {
  kind: AddressKind.BranchPush,
  resource_identity: RESOURCE_IDENTITY,
  branch: "main",
  commit: TESTED_COMMIT,
} as const;

const pushFacts: ActionFacts = {
  ...facts,
  frozen_action: {
    ...facts.frozen_action,
    key: "pushed.push",
    action: "push",
    expected_end_state: ExpectedEndState.BaseBranchPushed,
  },
  merge_address: branchPushAddress,
};

const unexpectedGit = (): never => {
  throw new Error("A merge touches no git remote.");
};
const gitWriter: GitWriter = {
  squashPushFresh: unexpectedGit,
  pushSnapshotFresh: unexpectedGit,
  landedOn: unexpectedGit,
  changedGateFiles: unexpectedGit,
  sshAccessOf: unexpectedGit,
};

async function gitHubServer(
  t: TestContext,
  options: { platform: Platform; head: string },
) {
  const requests: { route: string; body: string }[] = [];
  const state = { merged: false };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const route = `${request.method} ${request.url}`;
      requests.push({ route, body: Buffer.concat(chunks).toString("utf8") });
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (route === SETTINGS_ROUTE)
        return answer(HTTP_OK, { allow_merge_commit: true });
      if (route === PULL_ROUTE)
        return answer(HTTP_OK, {
          merged: state.merged,
          head: { sha: options.head },
        });
      if (route !== MERGE_ROUTE) return answer(404, { message: "not found" });
      if (options.platform === Platform.RefusesMerge)
        return answer(HTTP_METHOD_NOT_ALLOWED, { message: "not allowed" });
      const sha = (JSON.parse(requests.at(-1)!.body) as { sha: string }).sha;
      if (sha !== options.head)
        return answer(HTTP_CONFLICT, { message: "Head branch was modified" });
      state.merged = true;
      if (options.platform === Platform.LosesMergeAnswer)
        return request.socket.destroy();
      return answer(HTTP_OK, { merged: true });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  stopAfter(t, () => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    state,
    merges: () => requests.filter(({ route }) => route === MERGE_ROUTE).length,
    calls: () => requests.map(({ route }) => route),
  };
}

async function harness(
  t: TestContext,
  options: {
    platform: Platform;
    head?: string;
    refusal?: Error;
    facts?: ActionFacts;
    credential?: string | null;
    gitWriter?: GitWriter;
  },
) {
  const { store, pin } = sshStore(t);
  pin(SSH_HOST);
  const gitHub = await gitHubServer(t, {
    platform: options.platform,
    head: options.head ?? TESTED_COMMIT,
  });
  const fake = sshCustody({
    facts: options.facts ?? facts,
    credential:
      options.credential === undefined ? API_CREDENTIAL : options.credential,
    platform: "github",
    project_id: PROJECT_ID,
    execution: null as never,
    secret: { key: "api-key" },
    refusal: options.refusal ?? null,
  });
  const caller: CallerContext = {
    identity: testServiceIdentity("mission"),
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const inFlight = new Set<string>();
  const logger = pino({ enabled: false });
  const merge = (body: Partial<MergeBody> = {}) =>
    mergeAction(
      {
        store,
        custody: fake.custody,
        github: new GitHubPlatform({ baseUrl: gitHub.baseUrl }),
        gitWriter: options.gitWriter ?? gitWriter,
      },
      (request) => runOutbound({ store, logger, inFlight }, caller, request),
      caller,
      {
        evidence_id: EVIDENCE_ID,
        commit: TESTED_COMMIT,
        request_key: REQUEST_KEY,
        ...body,
      },
    );
  const rows = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT operation, request_key, state, credential FROM intake_outbound_request ORDER BY request_key",
          )
          .all() as {
          operation: string;
          request_key: string;
          state: string;
          credential: string;
        }[]
      ).map((row) => ({ ...row })),
    );
  const seed = (requestKey: string) =>
    store.transaction((tx) => {
      const id = insertPending(tx, {
        project_id: PROJECT_ID,
        operation: OutboundOperation.GitHubPullRequestMerge,
        request_key: requestKey,
        credential: API_CREDENTIAL,
        created_at: Date.now(),
      });
      succeed(tx, id, { ...mergeAddress, number: OTHER_PULL_NUMBER }, [
        OutboundRequestState.Pending,
      ]);
    });
  return { ...fake, gitHub, merge, rows, seed };
}

function mergeRequests(requests: GrantRequest[]) {
  return requests.filter(
    (request): request is Extract<GrantRequest, { kind: "service_merge" }> =>
      request.kind === GrantKind.ServiceMerge,
  );
}

test("a merge calls PUT merge with the tested commit and answers the pull request address", async (t) => {
  const h = await harness(t, { platform: Platform.Merges });
  const answer = await h.merge();
  assert.deepEqual(answer, mergeAddress);
  assert.deepEqual(h.gitHub.calls(), [SETTINGS_ROUTE, MERGE_ROUTE]);
  const merge = h.gitHub.requests.find(({ route }) => route === MERGE_ROUTE);
  assert.deepEqual(JSON.parse(merge!.body), {
    sha: TESTED_COMMIT,
    merge_method: "merge",
  });
  assert.equal(mergeRequests(h.requests).length, ONE_REQUEST);
  assert.equal(mergeRequests(h.requests)[0]?.claim, null);
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitHubPullRequestMerge,
      request_key: SERVICE_MERGE_REQUEST_KEY_PREFIX + REQUEST_KEY,
      state: OutboundRequestState.Succeeded,
      credential: API_CREDENTIAL,
    },
  ]);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a client row under the plain request key does not answer a merge", async (t) => {
  const h = await harness(t, { platform: Platform.Merges });
  h.seed(REQUEST_KEY);
  assert.deepEqual(await h.merge(), mergeAddress);
  assert.equal(h.gitHub.merges(), ONE_REQUEST);
  assert.deepEqual(
    h.rows().map((row) => row.request_key),
    [REQUEST_KEY, SERVICE_MERGE_REQUEST_KEY_PREFIX + REQUEST_KEY].sort(),
  );
});

test("a stored answer that names another pull request answers final_refusal and calls no merge", async (t) => {
  const h = await harness(t, { platform: Platform.Merges });
  h.seed(SERVICE_MERGE_REQUEST_KEY_PREFIX + REQUEST_KEY);
  const before = h.rows();
  assert.deepEqual(await h.merge(), {
    class: ResultClass.FinalRefusal,
    code: GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
    message: FOREIGN_MERGE_ANSWER_MESSAGE,
  });
  assert.deepEqual(h.gitHub.calls(), []);
  assert.deepEqual(h.rows(), before);
});

test("a refused release writes no outbound row, makes no call and releases no material", async (t) => {
  const revoked = new OperationError(
    HttpStatus.Conflict,
    REVOKED_CODE,
    "The pinned credential revision is revoked.",
  );
  const h = await harness(t, { platform: Platform.Merges, refusal: revoked });
  await assert.rejects(h.merge(), (error) => error === revoked);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(h.gitHub.calls(), []);
  assert.deepEqual(h.materials, []);
});

test("a repeat of the key after a lost merge answer reads back only", async (t) => {
  const h = await harness(t, { platform: Platform.LosesMergeAnswer });
  const lost = await h.merge();
  assert.equal("class" in lost && lost.class, ResultClass.UnknownOutcome);
  assert.equal(h.gitHub.merges(), ONE_REQUEST);
  const repeat = await h.merge();
  assert.deepEqual(repeat, mergeAddress);
  assert.equal(h.gitHub.merges(), ONE_REQUEST);
  assert.equal(h.gitHub.calls().at(-1), PULL_ROUTE);
  const calls = h.gitHub.calls().length;
  assert.deepEqual(await h.merge(), mergeAddress);
  assert.equal(h.gitHub.calls().length, calls);
  assert.equal(h.rows()[0]?.state, OutboundRequestState.Succeeded);
});

test("a refused merge answers its result class", async (t) => {
  const h = await harness(t, { platform: Platform.RefusesMerge });
  const answer = await h.merge();
  assert.ok("class" in answer);
  assert.equal(answer.class, ResultClass.FinalRefusal);
  assert.equal(
    answer.code,
    GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
  );
  assert.equal(h.gitHub.state.merged, false);
});

test("a pull request whose head differs from the tested commit answers final_refusal and merges nothing", async (t) => {
  const h = await harness(t, {
    platform: Platform.Merges,
    head: OTHER_HEAD,
  });
  const answer = await h.merge();
  assert.ok("class" in answer);
  assert.equal(answer.class, ResultClass.FinalRefusal);
  assert.equal(
    answer.code,
    GITHUB_RESULT_CODE_PREFIX + ResultClass.FinalRefusal,
  );
  assert.equal(h.gitHub.merges(), ONE_REQUEST);
  assert.equal(h.gitHub.state.merged, false);
});

test("a branch push land squashes through the SSH release of the request evidence and uses no API credential", async (t) => {
  const pushes: { input: unknown; ssh: unknown }[] = [];
  const h = await harness(t, {
    platform: Platform.Merges,
    facts: pushFacts,
    credential: null,
    gitWriter: {
      ...gitWriter,
      sshAccessOf: sshAccessOf(),
      squashPushFresh: async (input, _context, _deadline, ssh) => {
        pushes.push({ input, ssh });
        return { commit: LANDED_COMMIT };
      },
    },
  });
  assert.deepEqual(await h.merge(), {
    ...branchPushAddress,
    commit: LANDED_COMMIT,
  });
  assert.equal(pushes.length, ONE_REQUEST);
  assert.deepEqual(pushes[0]?.input, {
    address: ADDRESS,
    base_branch: "main",
    commit: TESTED_COMMIT,
    node_id: NODE_ID,
    header: "feat: ship accounts",
  });
  const ssh = pushes[0]?.ssh as { private_key: string };
  assert.equal(ssh.private_key, h.privateKey);
  assert.deepEqual(
    h.requests.filter((request) => request.kind === GrantKind.SshIdentity),
    [
      {
        kind: GrantKind.SshIdentity,
        identity: testServiceIdentity("mission"),
        subject: {
          kind: SshIdentitySubjectKind.RequestEvidence,
          evidence_id: EVIDENCE_ID,
        },
        claim: null,
      },
    ],
  );
  assert.deepEqual(h.gitHub.calls(), []);
  assert.deepEqual(h.rows(), [
    {
      operation: OutboundOperation.GitPush,
      request_key: SERVICE_MERGE_REQUEST_KEY_PREFIX + REQUEST_KEY,
      state: OutboundRequestState.Succeeded,
      credential: SSH_CREDENTIAL,
    },
  ]);
  assert.ok(h.materials.every((material) => material.dropped));
});

test("a moved base answers confirmed_failure with git.base_moved and a lost push reads the landing back", async (t) => {
  const moved = new BaseMovedError("main");
  const lost = new GitWriteError(
    GitStage.Push,
    new Diagnostic("repository.connector.git_failed", "push lost."),
  );
  const failures = [moved, lost];
  const h = await harness(t, {
    platform: Platform.Merges,
    facts: pushFacts,
    credential: null,
    gitWriter: {
      ...gitWriter,
      sshAccessOf: sshAccessOf(),
      squashPushFresh: async () => {
        throw failures.shift();
      },
      landedOn: async () => ({
        landed: true,
        first_parent: LANDED_COMMIT,
        base_moved: false,
      }),
    },
  });
  assert.deepEqual(await h.merge({ request_key: "first" }), {
    class: ResultClass.ConfirmedFailure,
    code: GIT_BASE_MOVED,
    message: moved.message,
  });
  const unknown = await h.merge({ request_key: "second" });
  assert.equal("class" in unknown && unknown.class, ResultClass.UnknownOutcome);
  assert.deepEqual(await h.merge({ request_key: "second" }), {
    ...branchPushAddress,
    commit: LANDED_COMMIT,
  });
});

const NON_FAST_FORWARD_STDERR = [
  "To ssh://git@host/repo.git",
  " ! [rejected]        abc -> main (fetch first)",
  "error: failed to push some refs",
].join("\n");
const RULE_REFUSAL_FIRST_LINE =
  "remote: error: GH013: Repository rule violations found for refs/heads/main.";
const RULE_REFUSAL_STDERR = [
  RULE_REFUSAL_FIRST_LINE,
  "remote: - Changes must be made through a pull request.",
  " ! [remote rejected] abc -> main (push declined due to repository rule violations)",
].join("\n");

function pushRefusal(stderr: string): GitWriteError {
  return new GitWriteError(
    GitStage.Push,
    new Diagnostic(
      "repository.connector.git_failed",
      "squash push: git failed.",
      {
        cause: new Error(`squash push: git exited with 1: ${stderr}`),
      },
    ),
  );
}

async function pushLandAnswer(t: TestContext, failure: GitWriteError) {
  const h = await harness(t, {
    platform: Platform.Merges,
    facts: pushFacts,
    credential: null,
    gitWriter: {
      ...gitWriter,
      sshAccessOf: sshAccessOf(),
      squashPushFresh: async () => {
        throw failure;
      },
    },
  });
  return h.merge();
}

test("a push land answers retryable_refusal for a non-fast-forward rejection", async (t) => {
  const answer = await pushLandAnswer(t, pushRefusal(NON_FAST_FORWARD_STDERR));
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.RetryableRefusal);
  assert.equal(answer.code, GIT_FAILED_CODE);
});

test("a push land answers final_refusal with git.push_refused and the first stderr line for GH013", async (t) => {
  const answer = await pushLandAnswer(t, pushRefusal(RULE_REFUSAL_STDERR));
  assert.deepEqual(answer, {
    class: ResultClass.FinalRefusal,
    code: GIT_PUSH_REFUSED,
    message: RULE_REFUSAL_FIRST_LINE,
  });
});

test("a push land answers unknown_outcome for another push failure", async (t) => {
  const answer = await pushLandAnswer(
    t,
    pushRefusal("fatal: the remote end hung up unexpectedly"),
  );
  assert.ok("class" in answer, JSON.stringify(answer));
  assert.equal(answer.class, ResultClass.UnknownOutcome);
  assert.equal(answer.code, GIT_FAILED_CODE);
});
