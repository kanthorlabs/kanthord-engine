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
  CheckEndState,
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
  gatewayFixture,
  scriptedActions,
  scriptedCheck,
} from "./test-support.ts";
import { environment, kanthord } from "./cli-support.ts";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const EMPTY = "";
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
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
    standIns: {
      intakeActions: actions.seam,
      intakeCheck: scriptedCheck({
        endState: CheckEndState.Other,
        landedCommits: [],
      }),
    },
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let sequence = ZERO;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, ZERO, result.stderr);
    assert.equal(result.stderr, EMPTY);
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
  await write(["credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  const repository = (name: string, action: string) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      credential: "github",
      strategy: {
        baseBranch: "main",
        action: { name: action, follows: { type: "assessment_passed" } },
      },
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: ONE,
    bindings: {
      gated: repository(GATED, "pull_request"),
      pushed: repository(PUSHED, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instanceCount: ONE },
      },
    },
  });
  const bindings = await read<
    Page<{ id: string; name: string; resourceIdentity: string }>
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
        content: { ...CONTENT, bindings: names },
        reason: "plan",
        expectedMissionVersion: version,
        ...(parentId ? { parentId, expectedParentRevision: ONE } : {}),
      },
    );
    return result.revisions[ZERO]!.nodeId;
  };
  const initiative = await create("initiative-1.md", "initiative", [], ONE);
  const G = await create(
    "objective-g.md",
    "objective",
    [GATED],
    TWO,
    initiative,
  );
  const P = await create(
    "objective-p.md",
    "objective",
    [PUSHED],
    THREE,
    initiative,
  );
  await write(["mission", "node", "priority", "set", G], {
    value: THREE,
    expectedMissionVersion: FOUR,
  });
  await write(["mission", "node", "priority", "set", P], {
    value: TWO,
    expectedMissionVersion: FOUR,
  });
  const M = (await read<{ version: number }>(["mission", "get", project.id]))
    .version;
  const token = await fixture.machineToken(project.id, "harness", "Harness");
  const W = { ...H, KANTHORD_TOKEN: token };
  const { runtimeIdentity } = await read<{ runtimeIdentity: string }>(
    ["worker", "register"],
    W,
  );
  const pull = async (nodeId: string, attempt: number) => {
    const result = await write<{ kind: string; execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      { resourceIdentity: "worker:kanthord:harness", runtimeIdentity },
      W,
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.equal(result.execution.nodeId, nodeId);
    assert.equal(result.execution.attempt, attempt);
    return result.execution;
  };
  const client = httpClient(workerOperations, fixture.endpoint, token);
  const request = (execution: ExecutionRecord) =>
    client["action.request"](
      { params: { executionId: execution.executionId }, query: {}, body: null },
      { idempotencyKey: ulid() },
    );
  const context = (execution: ExecutionRecord) => ({
    executionId: execution.executionId,
    attempt: execution.attempt,
    nodeRevision: execution.pinnedRevision,
  });
  const snapshot = (bindingId: string, commit: string) => ({
    kind: "repository",
    bindingId,
    commit,
  });
  const work = (
    execution: ExecutionRecord,
    bindingId: string,
    commit: string,
  ) =>
    write<Submission>(
      ["mission", "evidence", "submit", execution.nodeId],
      {
        ...context(execution),
        subject: "head commit",
        assets: [{ kind: "repository", address: snapshot(bindingId, commit) }],
      },
      W,
    );
  const run = (execution: ExecutionRecord, bindingId: string, commit: string) =>
    write<Submission>(
      ["mission", "evidence", "submit", execution.nodeId],
      {
        ...context(execution),
        subject: "verification run",
        assets: [
          {
            kind: "produced",
            content: {
              mediaType: "text/plain",
              encoding: "base64",
              data: "b2s=",
            },
          },
        ],
        verification: {
          testedInput: snapshot(bindingId, commit),
          results: [
            { command: "true", exitCode: ZERO, signal: null, timedOut: false },
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
      ["mission", "assessment", "submit", execution.nodeId],
      {
        ...context(execution),
        evidenceIds,
        childOutcomeIds: [],
        result: "success",
        rationale: "met",
        testedInput: snapshot(bindingId, commit),
      },
      W,
    );
  const release = (execution: ExecutionRecord) =>
    write(
      ["scheduler", "execution", "release", execution.executionId],
      { furtherWork: false },
      W,
    );
  const node = (nodeId: string) =>
    read<{ state: string }>(["mission", "node", "get", nodeId]);
  return {
    actions,
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
  const pr42 = {
    kind: PlatformAddressKind.PullRequest,
    resourceIdentity: h.gated.resourceIdentity,
    number: 42,
  };

  await t.test("E06.1 steps claim selects G attempt 1", async () => {
    e1 = await h.pull(h.G, ONE);
  });
  await t.test("E06.2 steps claim cannot request actions", async () => {
    refused(
      await h.request(e1),
      HttpStatus.Conflict,
      WorkerErrorCode.ClaimNotEvaluation,
    );
    assert.equal(h.actions.performCalls.length, ZERO);
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
      e2 = await h.pull(h.G, ONE);
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
    assert.equal(result.toolName, ACTION_REQUEST_TOOL_NAME);
    assert.deepEqual(result.items[0], {
      kind: ActionResultKind.FailedBeforeEffect,
      action: { key: GATED_KEY, bindingId: h.gated.id },
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
      const requestKey = `${h.G}/${ONE}/${GATED_KEY}`;
      assert.equal(h.actions.performCalls[0]?.requestKey, requestKey);
      assert.equal(
        completed(await h.request(e2)).items[0]?.kind,
        ActionResultKind.FailedBeforeEffect,
      );
      assert.deepEqual(h.actions.readBackCalls, [requestKey]);
      assert.equal(h.actions.performCalls.length, ONE);
      // Intake is a stand-in: model the human removal of its failed request.
      assert.equal(
        h.actions.requests.delete(`pull_request/${requestKey}`),
        true,
      );
      h.actions.performAnswers.push(pr42);
      const item = completed(await h.request(e2)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      request1 = item.evidence as Evidence;
      assert.equal(request1.requirementKey, GATED_KEY);
      assert.equal(request1.attempt, ONE);
      assert.deepEqual(request1.assets[0]?.address, pr42);
      assert.equal(h.actions.performCalls.length, TWO);
    },
  );
  await t.test(
    "E06.8 repeat dispatches nothing and reviewer releases externally",
    async () => {
      assert.deepEqual(completed(await h.request(e2)).items, []);
      assert.equal(h.actions.performCalls.length, TWO);
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
    assert.equal(actions.items[0]?.requestEvidenceId, request1.id);
    const check = await h.write<{ results: { resolution: string }[] }>(
      ["mission", "node", "check", h.G],
      { expectedMissionVersion: h.M },
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
        blockedAttempt: ONE,
        expectedRevision: ONE,
        expectedMissionVersion: h.M,
      });
      assert.equal(unblock.node.state, NodeState.Available);
      assert.equal(unblock.attempt.attempt, TWO);
      e3 = await h.pull(h.G, TWO);
      gWork2 = (await h.work(e3, h.gated.id, D)).evidence;
      await h.release(e3);
    },
  );
  await t.test(
    "E06.11 attempt 2 publishes its own passing assessment",
    async () => {
      e4 = await h.pull(h.G, TWO);
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
      h.actions.performAnswers.push(pr42);
      const item = completed(await h.request(e4)).items[0];
      assert.ok(item?.kind === ActionResultKind.Submitted);
      const evidence = item.evidence as Evidence;
      assert.equal(evidence.attempt, TWO);
      assert.deepEqual(evidence.assets[0]?.address, pr42);
      assert.equal(
        h.actions.readCalls[0]?.method,
        ActionReadMethod.PullRequestGet,
      );
      assert.deepEqual(h.actions.readCalls[0]?.address, pr42);
      assert.deepEqual(h.actions.performCalls[2]?.operands.reusedAddress, pr42);
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
      (item) => item.requirementKey === GATED_KEY,
    );
    assert.equal(requests.length, ONE);
    assert.deepEqual(requests[0]?.assets[0]?.address, pr42);
  });
  await t.test("E06.14 P reaches a passing evaluation claim", async () => {
    const e5 = await h.pull(h.P, ONE);
    const work = (await h.work(e5, h.pushed.id, E)).evidence;
    await h.release(e5);
    e6 = await h.pull(h.P, ONE);
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
      action: { key: PUSHED_KEY, bindingId: h.pushed.id },
      uncertainty: Uncertainty.Effect,
    };
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.deepEqual(completed(await h.request(e6)).items, [expected]);
    assert.equal(h.actions.performCalls.length, FOUR);
  });
  await t.test(
    "E06.16 uncertain action cannot satisfy reviewer release",
    async () => {
      const result = await kanthord(
        [
          "scheduler",
          "execution",
          "release",
          e6.executionId,
          "--file",
          h.file({ furtherWork: false }),
        ],
        h.W,
      );
      assert.equal(result.code, ONE);
      assert.ok(
        result.stderr.startsWith("mission.release.obligation_unmet:"),
        result.stderr,
      );
      assert.equal(result.stdout, EMPTY);
    },
  );
  await t.test(
    "E06.17 reservation survives execution replacement and stale proof is refused",
    async () => {
      const act = {
        reason: "hold",
        expectedMissionVersion: h.M,
        expectedState: NodeState.Evaluating,
        expectedAttempt: ONE,
      };
      await h.write(["mission", "node", "pause", h.P], act);
      await h.write(["mission", "node", "resume", h.P], {
        ...act,
        expectedState: NodeState.Paused,
        target: NodeState.Waiting,
      });
      const e7 = await h.pull(h.P, ONE);
      const item = completed(await h.request(e7)).items[0];
      assert.ok(item?.kind === ActionResultKind.Uncertain);
      assert.equal(item.uncertainty, Uncertainty.Effect);
      assert.equal(h.actions.performCalls.length, FOUR);
      refused(
        await h.request(e1),
        HttpStatus.Forbidden,
        "gateway.invocation.execution_proof_failed",
      );
    },
  );
});
