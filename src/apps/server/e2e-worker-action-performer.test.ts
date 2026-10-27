import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { OutboundRequestState } from "../../intake/contract.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  NodeState,
  Resolution,
  type Evidence,
  type Revision,
  type ExternalAction,
  Intent,
  missionOperations,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  workerOperations,
  ACTION_REQUEST_TOOL_NAME,
  ActionResultKind,
  RefusalClass,
  Uncertainty,
  WorkerErrorCode,
  PlatformAddressKind,
  type PlatformAddress,
} from "../../worker/contract.ts";
import { ReviewState } from "../../repository/github.ts";
import {
  FAKE_SSH_CREDENTIAL,
  FakePullState,
  createFakeSshCredential,
  gatewayFixture,
  fakeGitHub,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { environment, kanthord, until } from "./cli-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const INITIAL_SEQUENCE = 0;
const SUCCESSFUL_EXIT = 0;
const FIRST_INDEX = 0;
const NO_CALLS = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const REVIEWER = 1;
const SINGLE_CALL = 1;
const SINGLE_ITEM = 1;
const FAILURE_EXIT = 1;
const PUSHED_PRIORITY = 2;
const TWO_CALLS = 2;
const UNAUTHORIZED_STATUS = 401;
const HOOK_MODE = 0o755;
const SECOND_ATTEMPT = 2;
const FIRST_MISSION_VERSION = 1;
const SECOND_MISSION_VERSION = 2;
const THIRD_MISSION_VERSION = 3;
const GATED_PRIORITY = 3;
const NO_OUTPUT = "";
const BINDING_MISMATCH = "mission.evidence.binding_mismatch";
const TIMEOUT = 180000;
const GATED = "gated";
const PUSHED = "pushed";
const GATED_KEY = "gated.pull_request";
const PUSHED_KEY = "pushed.merge_push";
const GITHUB_KEY = "test-secret";
const FINAL_REFUSAL_CODE = "repository.platform.github.final_refusal";
const PULL_REQUEST_OPERATION = "github.pull_request";
const PUSH_COUNTER = "pre-receive.count";
const MAIN_REF = "refs/heads/main";
const KANTHORD_LANDING = "kanthord";
const CHECK_RUNS_SEGMENT = "/check-runs";
const REQUESTED_CHANGE = "Rename the account route.";
const REQUESTED_COMMENT = {
  path: "node.md",
  line: 1,
  body: "Name the attempt.",
};
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type PullRequestAddress = Extract<
  PlatformAddress,
  { kind: typeof PlatformAddressKind.PullRequest }
>;
type Submission = { evidence: Evidence };
type Assessment = { node: { state: string }; outcome: unknown };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}
function refused<T>(result: OperationResult<T>, status: number, code: string) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
}

async function commitOnBranch(
  t: TestContext,
  bare: string,
  branch: string,
  content: string,
) {
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", branch]);
  writeFileSync(join(directory, "node.md"), content);
  await git.add("node.md");
  await git.commit(content);
  await git.push("origin", branch);
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  return head;
}

function rejectPushes(bare: string) {
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\necho push >> "${join(bare, PUSH_COUNTER)}"\nexit 1\n`,
  );
  chmodSync(hook, HOOK_MODE);
  assert.equal(existsSync(join(bare, PUSH_COUNTER)), false);
}

function rejectedPushes(bare: string): number {
  const counter = join(bare, PUSH_COUNTER);
  assert.ok(bare.startsWith("/"));
  if (!existsSync(counter)) return NO_CALLS;
  return readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
}

async function setup(t: TestContext, landing?: string) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const pushedBare = await bareRepository(t, PUSHED);
  const B = await commitOnBranch(t, gatedBare.bare, "work-1", "attempt 1\n");
  const D = await commitOnBranch(t, gatedBare.bare, "work-2", "attempt 2\n");
  const E = await commitOnBranch(t, pushedBare.bare, "work", "pushed\n");
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({
      [`git@github.com:owner/${GATED}.git`]: gatedBare.bare,
      [`git@github.com:owner/${PUSHED}.git`]: pushedBare.bare,
    }),
  });
  const creates = () =>
    gitHub.calls.filter((call) => call.method === HttpMethod.Post).length;
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let sequence = INITIAL_SEQUENCE;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "actions",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await createFakeSshCredential(read);
  const repository = (name: string, action: string, landing?: string) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      ssh_credential: FAKE_SSH_CREDENTIAL,
      credential: "github",
      strategy: {
        base_branch: "main",
        action: {
          name: action,
          follows: { type: "assessment_passed" },
          ...(landing === undefined ? {} : { landing }),
        },
      },
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repository(GATED, "pull_request", landing),
      pushed: repository(PUSHED, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await read<
    Page<{ id: string; name: string; resource_identity: string }>
  >(["project", "binding", "list", project.id]);
  const gated = bindings.items.find((item) => item.name === GATED)!;
  const pushed = bindings.items.find((item) => item.name === PUSHED)!;
  const create = async (filename: string, names: string[], version: number) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        content: {
          ...CONTENT,
          intent: Intent.Implement,
          bindings: names.map(
            (name) => bindings.items.find((item) => item.name === name)!.id,
          ),
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: version,
      },
    );
    return result.revisions[FIRST_INDEX]!.node_id;
  };
  const G = await create("implement-g.md", [GATED], FIRST_MISSION_VERSION);
  const P = await create("implement-p.md", [PUSHED], SECOND_MISSION_VERSION);
  await write(["mission", "node", "priority", "set", G], {
    value: GATED_PRIORITY,
    expected_mission_version: THIRD_MISSION_VERSION,
  });
  await write(["mission", "node", "priority", "set", P], {
    value: PUSHED_PRIORITY,
    expected_mission_version: THIRD_MISSION_VERSION,
  });
  const M = (await read<{ version: number }>(["mission", "get", project.id]))
    .version;
  const token = await fixture.machineToken(project.id, "harness", "Harness");
  const W = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: runtimeIdentity } = await read<{
    runtime_identity: string;
  }>(["worker", "register"], W);
  const pull = async (nodeId: string, attempt: number) => {
    const result = await write<{ kind: string; execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: "worker:kanthord:harness",
        runtime_identity: runtimeIdentity,
      },
      W,
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.equal(result.execution.node_id, nodeId);
    assert.equal(result.execution.attempt, attempt);
    return result.execution;
  };
  const client = httpClient(workerOperations, fixture.endpoint, token);
  const missionApi = httpClient(missionOperations, fixture.endpoint, token);
  const request = (execution: ExecutionRecord) =>
    client["action.request"](
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: null,
      },
      { idempotencyKey: createIdempotencyKey() },
    );
  const changeRequest = (execution: ExecutionRecord) =>
    client["execution.change_request.get"]({
      params: { execution_id: execution.execution_id },
      query: {},
      body: null,
    });
  const context = (execution: ExecutionRecord) => ({
    execution_id: execution.execution_id,
    attempt: execution.attempt,
    node_revision: execution.pinned_revision,
  });
  const snapshot = (bindingId: string, commit: string) => ({
    kind: "repository",
    binding_id: bindingId,
    commit,
  });
  const work = (
    execution: ExecutionRecord,
    bindingId: string,
    commit: string,
  ) =>
    write<Submission>(
      ["mission", "evidence", "submit", execution.node_id],
      {
        ...context(execution),
        subject: "head commit",
        assets: [{ kind: "repository", address: snapshot(bindingId, commit) }],
      },
      W,
    );
  const run = (execution: ExecutionRecord, bindingId: string, commit: string) =>
    write<Submission>(
      ["mission", "evidence", "submit", execution.node_id],
      {
        ...context(execution),
        subject: "verification run",
        assets: [
          {
            kind: "produced",
            content: {
              media_type: "text/plain",
              encoding: "base64",
              data: "b2s=",
            },
          },
        ],
        verification: {
          tested_input: snapshot(bindingId, commit),
          results: [
            {
              command: "true",
              exit_code: SUCCESSFUL_EXIT,
              signal: null,
              timed_out: false,
            },
          ],
        },
      },
      W,
    );
  const pass = (
    execution: ExecutionRecord,
    evidenceIds: string[],
    bindingId: string,
    commit: string,
  ) =>
    write<Assessment>(
      ["mission", "assessment", "submit", execution.node_id],
      {
        ...context(execution),
        evidence_ids: evidenceIds,
        dependency_outcome_ids: [],
        result: "success",
        rationale: "met",
        tested_input: snapshot(bindingId, commit),
      },
      W,
    );
  const release = (execution: ExecutionRecord) =>
    write(
      ["scheduler", "execution", "release", execution.execution_id],
      { further_work: false },
      W,
    );
  const node = (nodeId: string) =>
    read<{ state: string }>(["mission", "node", "get", nodeId]);
  return {
    gitHub,
    creates,
    gatedBare,
    pushedBare,
    B,
    D,
    E,
    file,
    read,
    write,
    W,
    G,
    P,
    M,
    gated,
    pushed,
    pull,
    request,
    changeRequest,
    work,
    run,
    pass,
    release,
    node,
    missionApi,
  };
}

test("E06 action performer CLI journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  let e1: ExecutionRecord,
    e2: ExecutionRecord,
    e3: ExecutionRecord,
    e4: ExecutionRecord,
    e6: ExecutionRecord;
  let gWork1: Evidence, gWork2: Evidence, request1: Evidence;
  let pr: PullRequestAddress;

  await t.test("E06.1 steps claim selects G attempt 1", async () => {
    e1 = await h.pull(h.G, FIRST_ATTEMPT);
    assert.deepEqual(completed(await h.changeRequest(e1)), { items: [] });
  });
  await t.test("E06.2 steps claim cannot request actions", async () => {
    refused(
      await h.request(e1),
      HttpStatus.Conflict,
      WorkerErrorCode.ClaimNotEvaluation,
    );
    assert.equal(h.gitHub.calls.length, NO_CALLS);
  });
  await t.test(
    "E06.3 steps publishes the repository snapshot and releases",
    async () => {
      gWork1 = (await h.work(e1, h.gated.id, h.B)).evidence;
      await h.release(e1);
    },
  );
  await t.test(
    "E06.4 evaluation without assessment cannot request actions",
    async () => {
      e2 = await h.pull(h.G, FIRST_ATTEMPT);
      refused(
        await h.request(e2),
        HttpStatus.Conflict,
        WorkerErrorCode.AssessmentNotCurrent,
      );
    },
  );
  await t.test(
    "E06.5 passing assessment keeps the required action eligible",
    async () => {
      const run = (await h.run(e2, h.gated.id, h.B)).evidence;
      const assessment = await h.pass(e2, [run.id, gWork1.id], h.gated.id, h.B);
      assert.equal(assessment.node.state, NodeState.Evaluating);
      assert.equal(assessment.outcome, null);
    },
  );
  await t.test("E06.6 no-effect refusal returns derived operands", async () => {
    h.gitHub.respondNext(UNAUTHORIZED_STATUS, { message: "Bad credentials" });
    const result = completed(await h.request(e2));
    assert.equal(result.tool_name, ACTION_REQUEST_TOOL_NAME);
    const [item] = result.items;
    assert.ok(item?.kind === ActionResultKind.FailedBeforeEffect);
    assert.deepEqual(item.action, { key: GATED_KEY, binding_id: h.gated.id });
    assert.equal(item.refusal.class, RefusalClass.FinalRefusal);
    assert.equal(item.refusal.code, FINAL_REFUSAL_CODE);
    assert.deepEqual(h.gitHub.calls, [
      {
        method: HttpMethod.Post,
        path: `/repos/owner/${GATED}/pulls`,
        body: {
          head: `kanthord/${h.G}`,
          base: "main",
          title: "feat: ship accounts",
        },
        token: GITHUB_KEY,
        if_none_match: null,
        status: UNAUTHORIZED_STATUS,
      },
    ]);
  });
  await t.test(
    "E06.7 human removes the failed outbound request before a successful write",
    async () => {
      const requestKey = `${h.G}/${FIRST_ATTEMPT}/${GATED_KEY}`;
      assert.equal(
        completed(await h.request(e2)).items[0]?.kind,
        ActionResultKind.FailedBeforeEffect,
      );
      assert.equal(h.creates(), SINGLE_CALL);
      const outbound = await h.read<
        Page<{ id: string; request_key: string; state: string }>
      >(["intake", "outbound", "list", "--operation", PULL_REQUEST_OPERATION]);
      assert.deepEqual(
        outbound.items.map((item) => [item.request_key, item.state]),
        [[requestKey, OutboundRequestState.Failed]],
      );
      await h.read([
        "intake",
        "outbound",
        "delete",
        "--force",
        "--id",
        outbound.items[0]!.id,
      ]);
      const item = completed(await h.request(e2)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      pr = {
        kind: PlatformAddressKind.PullRequest,
        resource_identity: h.gated.resource_identity,
        number: h.gitHub.pulls[FIRST_INDEX]!.number,
      };
      request1 = item.evidence as Evidence;
      assert.equal(request1.requirement_key, GATED_KEY);
      assert.equal(request1.attempt, FIRST_ATTEMPT);
      assert.deepEqual(request1.assets[0]?.address, pr);
      assert.equal(h.creates(), TWO_CALLS);
      assert.equal(h.gitHub.pulls.length, SINGLE_ITEM);
    },
  );
  await t.test(
    "E06.8 repeat dispatches nothing and reviewer releases externally",
    async () => {
      assert.deepEqual(completed(await h.request(e2)).items, []);
      assert.equal(h.creates(), TWO_CALLS);
      await h.release(e2);
      assert.equal((await h.node(h.G)).state, NodeState.ExternalRequested);
    },
  );
  await t.test("E06.9 a change request blocks the implement node", async () => {
    const actions = await h.read<Page<ExternalAction>>([
      "mission",
      "external-action",
      "list",
      h.G,
      "--attempt",
      "1",
    ]);
    assert.equal(actions.items[0]?.resolution, Resolution.Unresolved);
    assert.equal(actions.items[0]?.request_evidence_id, request1.id);
    h.gitHub.review(pr.number, {
      reviewer: REVIEWER,
      state: ReviewState.ChangesRequested,
      body: REQUESTED_CHANGE,
      comments: [REQUESTED_COMMENT],
    });
    const check = await h.write<{ results: { resolution: string }[] }>(
      ["mission", "node", "check", h.G],
      { expected_mission_version: h.M },
    );
    assert.equal(check.results[0]?.resolution, Resolution.OtherEnd);
    assert.equal((await h.node(h.G)).state, NodeState.Blocked);
    assert.equal(h.gitHub.pulls[FIRST_INDEX]?.state, FakePullState.Open);
  });
  await t.test(
    "E06.10 unblock starts attempt 2 with a new snapshot",
    async () => {
      const unblock = await h.write<{
        node: { state: string };
        attempt: { attempt: number };
      }>(["mission", "node", "unblock", h.G], {
        blocked_attempt: FIRST_ATTEMPT,
        expected_revision: FIRST_REVISION,
        expected_mission_version: h.M,
      });
      assert.equal(unblock.node.state, NodeState.Available);
      assert.equal(unblock.attempt.attempt, SECOND_ATTEMPT);
      e3 = await h.pull(h.G, SECOND_ATTEMPT);
      const read = completed(await h.changeRequest(e3));
      assert.deepEqual(
        read.items.map((item) => item.evidence_id),
        [request1.id],
      );
      const [change] = read.items[FIRST_INDEX]!.change_requests;
      assert.equal(change?.reviewer, `reviewer-${REVIEWER}`);
      assert.equal(change?.body, REQUESTED_CHANGE);
      assert.equal(change?.commit_id, read.items[FIRST_INDEX]!.head_commit);
      assert.deepEqual(change?.comments, [REQUESTED_COMMENT]);
      gWork2 = (await h.work(e3, h.gated.id, h.D)).evidence;
      await h.release(e3);
    },
  );
  await t.test(
    "E06.11 attempt 2 publishes its own passing assessment",
    async () => {
      e4 = await h.pull(h.G, SECOND_ATTEMPT);
      const run = (await h.run(e4, h.gated.id, h.D)).evidence;
      assert.equal(
        (await h.pass(e4, [run.id, gWork2.id], h.gated.id, h.D)).node.state,
        NodeState.Evaluating,
      );
    },
  );
  await t.test(
    "E06.12 open earlier request is reused with the new commit",
    async () => {
      const before = h.gitHub.calls.length;
      const item = completed(await h.request(e4)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      const evidence = item.evidence as Evidence;
      assert.equal(evidence.attempt, SECOND_ATTEMPT);
      assert.deepEqual(evidence.assets[0]?.address, pr);
      assert.deepEqual(
        h.gitHub.calls
          .slice(before)
          .map((call) => [call.method, call.path, call.token]),
        [
          [
            HttpMethod.Get,
            `/repos/owner/${GATED}/pulls/${pr.number}`,
            GITHUB_KEY,
          ],
        ],
      );
      assert.equal(h.creates(), TWO_CALLS);
      assert.equal(
        await remoteHead(h.gatedBare.bare, `refs/heads/kanthord/${h.G}`),
        h.D,
      );
      const outbound = await h.read<
        Page<{ request_key: string; state: string }>
      >(["intake", "outbound", "list", "--operation", PULL_REQUEST_OPERATION]);
      assert.ok(
        outbound.items.some(
          (row) =>
            row.request_key ===
              `${h.G}/${SECOND_ATTEMPT}/${GATED_KEY}/${pr.number}/${h.D}` &&
            row.state === OutboundRequestState.Succeeded,
        ),
      );
    },
  );
  await t.test("E06.13 reused request belongs to attempt 2", async () => {
    await h.release(e4);
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      h.G,
      "--attempt",
      "2",
    ]);
    const requests = evidence.items.filter(
      (item) => item.requirement_key === GATED_KEY,
    );
    assert.equal(requests.length, SINGLE_ITEM);
    assert.deepEqual(requests[0]?.assets[0]?.address, pr);
  });
  await t.test("E06.14 P reaches a passing evaluation claim", async () => {
    const e5 = await h.pull(h.P, FIRST_ATTEMPT);
    const work = (await h.work(e5, h.pushed.id, h.E)).evidence;
    await h.release(e5);
    e6 = await h.pull(h.P, FIRST_ATTEMPT);
    const run = (await h.run(e6, h.pushed.id, h.E)).evidence;
    assert.equal(
      (await h.pass(e6, [run.id, work.id], h.pushed.id, h.E)).node.state,
      NodeState.Evaluating,
    );
  });
  await t.test("E06.15 unknown effect is not redispatched", async () => {
    rejectPushes(h.pushedBare.bare);
    const expected = {
      kind: ActionResultKind.Uncertain,
      action: { key: PUSHED_KEY, binding_id: h.pushed.id },
      uncertainty: Uncertainty.Effect,
    };
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.equal(rejectedPushes(h.pushedBare.bare), SINGLE_CALL);
    assert.equal(
      await remoteHead(h.pushedBare.bare, MAIN_REF),
      h.pushedBare.head,
    );
  });
  await t.test(
    "E06.16 uncertain action cannot satisfy reviewer release",
    async () => {
      const result = await kanthord(
        [
          "scheduler",
          "execution",
          "release",
          e6.execution_id,
          "--file",
          h.file({ further_work: false }),
        ],
        h.W,
      );
      assert.equal(result.code, FAILURE_EXIT);
      assert.ok(
        result.stderr.startsWith("mission.release.obligation_unmet:"),
        result.stderr,
      );
      assert.equal(result.stdout, NO_OUTPUT);
    },
  );
  await t.test(
    "E06.17 reservation survives execution replacement and stale proof is refused",
    async () => {
      const act = {
        reason: "hold",
        expected_mission_version: h.M,
        expected_state: NodeState.Evaluating,
        expected_attempt: FIRST_ATTEMPT,
      };
      await h.write(["mission", "node", "pause", h.P], act);
      await h.write(["mission", "node", "resume", h.P], {
        ...act,
        expected_state: NodeState.Paused,
        target: NodeState.Waiting,
      });
      const e7 = await h.pull(h.P, FIRST_ATTEMPT);
      const item = completed(await h.request(e7)).items[0];
      assert.ok(item?.kind === ActionResultKind.Uncertain);
      assert.equal(item.uncertainty, Uncertainty.Effect);
      assert.equal(rejectedPushes(h.pushedBare.bare), SINGLE_CALL);
      refused(
        await h.request(e1),
        HttpStatus.Forbidden,
        "gateway.invocation.execution_proof_failed",
      );
    },
  );
});

test(
  "EF09a multi-repository mission rules",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const contained = h.gatedBare.head;
    let steps: ExecutionRecord;

    await t.test(
      "EF09a.1 a repository asset of a foreign binding answers mission.evidence.binding_mismatch",
      async () => {
        steps = await h.pull(h.G, FIRST_ATTEMPT);
        const result = await kanthord(
          [
            "mission",
            "evidence",
            "submit",
            h.G,
            "--file",
            h.file({
              execution_id: steps.execution_id,
              attempt: steps.attempt,
              node_revision: steps.pinned_revision,
              subject: "head commit",
              assets: [
                {
                  kind: "repository",
                  address: {
                    kind: "repository",
                    binding_id: h.pushed.id,
                    commit: contained,
                  },
                },
              ],
            }),
          ],
          h.W,
        );
        assert.equal(result.code, FAILURE_EXIT);
        assert.ok(
          result.stderr.startsWith("mission.evidence.binding_mismatch:"),
          result.stderr,
        );
        assert.equal(result.stdout, NO_OUTPUT);
        const address = {
          kind: "repository" as const,
          binding_id: h.gated.id,
          commit: contained,
        };
        const repeated = await h.missionApi["evidence.submit"](
          {
            params: { node_id: h.G },
            query: {},
            body: {
              execution_id: steps.execution_id,
              attempt: steps.attempt,
              node_revision: steps.pinned_revision,
              subject: "head commit",
              assets: [
                { kind: "repository", address },
                { kind: "repository", address },
              ],
            },
          },
          { idempotencyKey: createIdempotencyKey() },
        );
        refused(repeated, HttpStatus.BadRequest, BINDING_MISMATCH);
        assert.ok(repeated.type === OperationResultType.Failure);
        assert.deepEqual(repeated.error.error.details, {
          binding_id: h.gated.id,
        });
      },
    );
    await t.test(
      "EF09a.2 a snapshot that the base branch contains opens no pull request and folds to pull_request_merged",
      async () => {
        const work = (await h.work(steps, h.gated.id, contained)).evidence;
        await h.release(steps);
        const review = await h.pull(h.G, FIRST_ATTEMPT);
        const run = (await h.run(review, h.gated.id, contained)).evidence;
        await h.pass(review, [run.id, work.id], h.gated.id, contained);
        const [item] = completed(await h.request(review)).items;
        assert.ok(
          item?.kind === ActionResultKind.Submitted,
          JSON.stringify(item),
        );
        assert.deepEqual(
          (item.evidence as Evidence).assets[FIRST_INDEX]?.address,
          {
            kind: PlatformAddressKind.BranchPush,
            resource_identity: h.gated.resource_identity,
            branch: "main",
            commit: contained,
          },
        );
        assert.equal(h.creates(), NO_CALLS);
        await h.release(review);
        const check = await h.write<{ results: { resolution: string }[] }>(
          ["mission", "node", "check", h.G],
          { expected_mission_version: h.M },
        );
        assert.equal(
          check.results[FIRST_INDEX]?.resolution,
          Resolution.ExpectedEnd,
        );
        assert.equal((await h.node(h.G)).state, NodeState.Completed);
      },
    );
  },
);

test(
  "a reviewer release with a pending required check makes no merge call",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, KANTHORD_LANDING);
    h.gitHub.checks({ required: ["check"], commit: h.B, runs: [] });
    const steps = await h.pull(h.G, FIRST_ATTEMPT);
    const work = (await h.work(steps, h.gated.id, h.B)).evidence;
    await h.release(steps);
    const evaluation = await h.pull(h.G, FIRST_ATTEMPT);
    const run = (await h.run(evaluation, h.gated.id, h.B)).evidence;
    await h.pass(evaluation, [run.id, work.id], h.gated.id, h.B);
    const item = completed(await h.request(evaluation)).items[FIRST_INDEX];
    assert.ok(item?.kind === ActionResultKind.Submitted);
    const before = h.gitHub.calls.length;
    await h.release(evaluation);
    await until(
      () =>
        h.gitHub.calls
          .slice(before)
          .filter((call) => call.path.includes(CHECK_RUNS_SEGMENT)),
      (reads) => reads.length > NO_CALLS,
      t.signal,
    );
    assert.equal(
      h.gitHub.calls.filter((call) => call.method === HttpMethod.Put).length,
      NO_CALLS,
    );
    assert.equal(h.gitHub.pulls[FIRST_INDEX]?.merged, false);
    assert.equal((await h.node(h.G)).state, NodeState.ExternalRequested);
  },
);
