import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
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
  ResultClass,
  Uncertainty,
  WorkerErrorCode,
  PlatformAddressKind,
  ActionReadMethod,
} from "../../worker/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  scriptedActions,
  fakeGitHub,
} from "./test-support.ts";
import { environment, kanthord } from "./cli-support.ts";

const INITIAL_SEQUENCE = 0;
const SUCCESSFUL_EXIT = 0;
const FIRST_INDEX = 0;
const NO_CALLS = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_CALL = 1;
const SINGLE_ITEM = 1;
const FAILURE_EXIT = 1;
const SECOND_REVISION = 2;
const PUSHED_PRIORITY = 2;
const TWO_CALLS = 2;
const SECOND_ATTEMPT = 2;
const THIRD_MISSION_VERSION = 3;
const GATED_PRIORITY = 3;
const FOURTH_MISSION_VERSION = 4;
const FOUR_CALLS = 4;
const NO_OUTPUT = "";
const TIMEOUT = 180000;
const GATED = "gated";
const PUSHED = "pushed";
const GATED_KEY = "gated.pull_request";
const PUSHED_KEY = "pushed.merge_push";
const B = "b".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
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

async function setup(t: TestContext) {
  const actions = scriptedActions();
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    standIns: { intakeActions: actions.seam },
  });
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
  await write(["repository", "credential", "create"], {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_rsa",
    },
    secret: {},
  });
  const repository = (name: string, action: string) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      ssh_credential: "github-ssh",
      credential: "github",
      strategy: {
        base_branch: "main",
        action: { name: action, follows: { type: "assessment_passed" } },
      },
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repository(GATED, "pull_request"),
      pushed: repository(PUSHED, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await read<
    Page<{ id: string; name: string; resource_identity: string }>
  >(["project", "binding", "list", project.id]);
  const gated = bindings.items.find((item) => item.name === GATED)!;
  const pushed = bindings.items.find((item) => item.name === PUSHED)!;
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    version: number,
    parentId?: string,
  ) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map(
            (name) => bindings.items.find((item) => item.name === name)!.id,
          ),
        },
        reason: "plan",
        expected_mission_version: version,
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return result.revisions[FIRST_INDEX]!.node_id;
  };
  const initiative = await create(
    "initiative-1.md",
    "initiative",
    [],
    FIRST_REVISION,
  );
  const G = await create(
    "objective-g.md",
    "objective",
    [GATED],
    SECOND_REVISION,
    initiative,
  );
  const P = await create(
    "objective-p.md",
    "objective",
    [PUSHED],
    THIRD_MISSION_VERSION,
    initiative,
  );
  await write(["mission", "node", "priority", "set", G], {
    value: GATED_PRIORITY,
    expected_mission_version: FOURTH_MISSION_VERSION,
  });
  await write(["mission", "node", "priority", "set", P], {
    value: PUSHED_PRIORITY,
    expected_mission_version: FOURTH_MISSION_VERSION,
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
  const request = (execution: ExecutionRecord) =>
    client["action.request"](
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: null,
      },
      { idempotencyKey: ulid() },
    );
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
        child_outcome_ids: [],
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
    actions,
    gitHub,
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
    work,
    run,
    pass,
    release,
    node,
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
  const pr = {
    kind: PlatformAddressKind.PullRequest,
    resource_identity: h.gated.resource_identity,
    number: h.gitHub.open({
      owner: "owner",
      repo: GATED,
      head: `kanthord/${h.G}`,
      base: "main",
    }),
  };

  await t.test("E06.1 steps claim selects G attempt 1", async () => {
    e1 = await h.pull(h.G, FIRST_ATTEMPT);
  });
  await t.test("E06.2 steps claim cannot request actions", async () => {
    refused(
      await h.request(e1),
      HttpStatus.Conflict,
      WorkerErrorCode.ClaimNotEvaluation,
    );
    assert.equal(h.actions.performCalls.length, NO_CALLS);
  });
  await t.test(
    "E06.3 steps publishes the repository snapshot and releases",
    async () => {
      gWork1 = (await h.work(e1, h.gated.id, B)).evidence;
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
      const run = (await h.run(e2, h.gated.id, B)).evidence;
      const assessment = await h.pass(e2, [run.id, gWork1.id], h.gated.id, B);
      assert.equal(assessment.node.state, NodeState.Evaluating);
      assert.equal(assessment.outcome, null);
    },
  );
  await t.test("E06.6 no-effect refusal returns derived operands", async () => {
    h.actions.performAnswers.push({
      class: RefusalClass.FinalRefusal,
      code: "repository.platform.github.final_refusal",
      message: "Bad credentials",
    });
    const result = completed(await h.request(e2));
    assert.equal(result.tool_name, ACTION_REQUEST_TOOL_NAME);
    assert.deepEqual(result.items[0], {
      kind: ActionResultKind.FailedBeforeEffect,
      action: { key: GATED_KEY, binding_id: h.gated.id },
      refusal: {
        class: RefusalClass.FinalRefusal,
        code: "repository.platform.github.final_refusal",
        message: "Bad credentials",
      },
    });
    assert.deepEqual(h.actions.performCalls[0]?.operands, {
      nodeBranch: "kanthord/" + h.G,
      baseBranch: "main",
      commit: B,
      reusedAddress: null,
    });
  });
  await t.test(
    "E06.7 human removes the failed fake outbound request before a successful write",
    async () => {
      const requestKey = `${h.G}/${FIRST_ATTEMPT}/${GATED_KEY}`;
      assert.equal(h.actions.performCalls[0]?.requestKey, requestKey);
      assert.equal(
        completed(await h.request(e2)).items[0]?.kind,
        ActionResultKind.FailedBeforeEffect,
      );
      assert.deepEqual(h.actions.readBackCalls, [requestKey]);
      assert.equal(h.actions.performCalls.length, SINGLE_CALL);
      // Intake is a stand-in: model the human removal of its failed request.
      assert.equal(
        h.actions.requests.delete(`pull_request/${requestKey}`),
        true,
      );
      h.actions.performAnswers.push(pr);
      const item = completed(await h.request(e2)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      request1 = item.evidence as Evidence;
      assert.equal(request1.requirement_key, GATED_KEY);
      assert.equal(request1.attempt, FIRST_ATTEMPT);
      assert.deepEqual(request1.assets[0]?.address, pr);
      assert.equal(h.actions.performCalls.length, TWO_CALLS);
    },
  );
  await t.test(
    "E06.8 repeat dispatches nothing and reviewer releases externally",
    async () => {
      assert.deepEqual(completed(await h.request(e2)).items, []);
      assert.equal(h.actions.performCalls.length, TWO_CALLS);
      await h.release(e2);
      assert.equal((await h.node(h.G)).state, NodeState.ExternalRequested);
    },
  );
  await t.test("E06.9 other end state blocks the objective", async () => {
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
    h.gitHub.close(pr.number);
    const check = await h.write<{ results: { resolution: string }[] }>(
      ["mission", "node", "check", h.G],
      { expected_mission_version: h.M },
    );
    assert.equal(check.results[0]?.resolution, Resolution.OtherEnd);
    assert.equal((await h.node(h.G)).state, NodeState.Blocked);
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
      gWork2 = (await h.work(e3, h.gated.id, D)).evidence;
      await h.release(e3);
    },
  );
  await t.test(
    "E06.11 attempt 2 publishes its own passing assessment",
    async () => {
      e4 = await h.pull(h.G, SECOND_ATTEMPT);
      const run = (await h.run(e4, h.gated.id, D)).evidence;
      assert.equal(
        (await h.pass(e4, [run.id, gWork2.id], h.gated.id, D)).node.state,
        NodeState.Evaluating,
      );
    },
  );
  await t.test(
    "E06.12 open earlier request is reused with the new commit",
    async () => {
      h.actions.readAnswers.push({
        body: {
          state: "open",
          head: { ref: "kanthord/" + h.G, repo: { full_name: "owner/gated" } },
          base: { ref: "main", repo: { full_name: "owner/gated" } },
        },
      });
      h.actions.performAnswers.push(pr);
      const item = completed(await h.request(e4)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      const evidence = item.evidence as Evidence;
      assert.equal(evidence.attempt, SECOND_ATTEMPT);
      assert.deepEqual(evidence.assets[0]?.address, pr);
      assert.equal(
        h.actions.readCalls[0]?.method,
        ActionReadMethod.PullRequestGet,
      );
      assert.deepEqual(h.actions.readCalls[0]?.address, pr);
      assert.deepEqual(h.actions.performCalls[2]?.operands.reusedAddress, pr);
      assert.equal(h.actions.performCalls[2]?.operands.commit, D);
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
    const work = (await h.work(e5, h.pushed.id, E)).evidence;
    await h.release(e5);
    e6 = await h.pull(h.P, FIRST_ATTEMPT);
    const run = (await h.run(e6, h.pushed.id, E)).evidence;
    assert.equal(
      (await h.pass(e6, [run.id, work.id], h.pushed.id, E)).node.state,
      NodeState.Evaluating,
    );
  });
  await t.test("E06.15 unknown effect is not redispatched", async () => {
    h.actions.performAnswers.push({
      class: ResultClass.UnknownOutcome,
      code: "repository.platform.github.unknown_outcome",
      message: "No response",
    });
    const expected = {
      kind: ActionResultKind.Uncertain,
      action: { key: PUSHED_KEY, binding_id: h.pushed.id },
      uncertainty: Uncertainty.Effect,
    };
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.equal(h.actions.performCalls.length, FOUR_CALLS);
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
      assert.equal(h.actions.performCalls.length, FOUR_CALLS);
      refused(
        await h.request(e1),
        HttpStatus.Forbidden,
        "gateway.invocation.execution_proof_failed",
      );
    },
  );
});
