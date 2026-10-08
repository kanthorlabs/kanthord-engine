import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import type { Material } from "../../custody/contract.ts";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  CheckEndState,
  INTAKE_SERVICE_NAME,
  intakeOperations,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  PlatformAddressKind,
  missionOperations,
  type Evidence,
  type PlatformAddress,
  type Revision,
} from "../../mission/contract.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  bareRepository,
  fakeGitHub,
  gatewayFixture,
  mappedTransport,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const PUSHED_PRIORITY = 2;
const GATED_PRIORITY = 3;
const FIRST_INDEX = 0;
const SINGLE_INSTANCE = 1;
const NO_ROWS = 0;
const BAD_GATEWAY_STATUS = 502;
const UNAUTHORIZED_STATUS = 401;
const TIMEOUT = 180000;
const GITHUB_KEY = "test-secret";
const GATED_ADDRESS = "git@github.com:owner/gated.git";
const PUSHED_ADDRESS = "git@github.com:owner/pushed.git";
const MERGE_SHA = "e".repeat(40);
const RETRYABLE_CODE = "repository.platform.github.retryable_refusal";
const FINAL_CODE = "repository.platform.github.final_refusal";
const GIT_FAILED_CODE = "repository.connector.git_failed";
const UNKNOWN_CODE = "gateway.invocation.unknown";
const CONTENT = {
  name: "Check actions",
  requirement: "Check actions",
  criterion: "Actions land",
  verifications: ["true"],
};
type Page<T> = { items: T[] };
type Fold = { end_state: string; landed_commits: string[] };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}

function failed<T>(
  result: OperationResult<T>,
  status: number,
  code: string,
  details?: unknown,
) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  if (details !== undefined)
    assert.deepEqual(result.error.error.details, details);
}

async function rewriteMain(t: TestContext, bare: string) {
  const directory = join(temporary(t), "rewrite");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Rewrite");
  await git.addConfig("user.email", "test_rewrite@example.invalid");
  await git.raw(["checkout", "--orphan", "rewritten"]);
  writeFileSync(join(directory, "README.md"), "rewritten\n");
  await git.add("README.md");
  await git.commit("rewritten");
  await git.raw(["push", "--force", "origin", "rewritten:main"]);
}

async function setup(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const pushed = await bareRepository(t, "pushed");
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({ [PUSHED_ADDRESS]: pushed.bare }),
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  let sequence = FIRST_INDEX;
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], env);
  };
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: GITHUB_KEY },
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
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "checks",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const repository = (address: string, action: string) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address,
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
      gated: repository(GATED_ADDRESS, "pull_request"),
      pushed: repository(PUSHED_ADDRESS, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await read<
    Page<{ id: string; name: string; resource_identity: string }>
  >(["project", "binding", "list", project.id]);
  const binding = (name: string) => {
    const row = bindings.items.find((item) => item.name === name);
    assert.ok(row);
    return row;
  };
  const version = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    parentId?: string,
  ) => {
    const answer = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map((name) => binding(name).id),
        },
        reason: "plan",
        expected_mission_version: await version(),
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return answer.revisions[FIRST_INDEX]!.node_id;
  };
  const initiative = await create("initiative.md", "initiative", []);
  const gatedNode = await create(
    "gated.md",
    "objective",
    ["gated"],
    initiative,
  );
  const pushedNode = await create(
    "pushed.md",
    "objective",
    ["pushed"],
    initiative,
  );
  for (const [nodeId, value] of [
    [gatedNode, GATED_PRIORITY],
    [pushedNode, PUSHED_PRIORITY],
  ] as const)
    await write(["mission", "node", "priority", "set", nodeId], {
      value,
      expected_mission_version: await version(),
    });
  const token = await fixture.machineToken(project.id, "harness");
  const W = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: runtimeIdentity } = await read<{
    runtime_identity: string;
  }>(["worker", "register"], W);
  const api = httpClient(missionOperations, fixture.endpoint, token);
  const pull = async (nodeId: string) => {
    const answer = await write<{ execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: binding("harness").resource_identity,
        runtime_identity: runtimeIdentity,
      },
      W,
    );
    assert.equal(answer.execution.node_id, nodeId);
    return answer.execution;
  };
  const context = (execution: ExecutionRecord) => ({
    execution_id: execution.execution_id,
    attempt: execution.attempt,
    node_revision: execution.pinned_revision,
  });
  const release = (execution: ExecutionRecord) =>
    write(
      ["scheduler", "execution", "release", execution.execution_id],
      { further_work: false },
      W,
    );
  const requested = async (
    nodeId: string,
    name: string,
    key: string,
    address: PlatformAddress,
  ) => {
    const snapshot = {
      kind: "repository",
      binding_id: binding(name).id,
      commit: pushed.head,
    };
    const steps = await pull(nodeId);
    await write(
      ["mission", "evidence", "submit", nodeId],
      {
        ...context(steps),
        subject: "head commit",
        assets: [{ kind: "repository", address: snapshot }],
      },
      W,
    );
    await release(steps);
    const evaluation = await pull(nodeId);
    const run = await write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", nodeId],
      {
        ...context(evaluation),
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
          tested_input: snapshot,
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
    await write(
      ["mission", "assessment", "submit", nodeId],
      {
        ...context(evaluation),
        evidence_ids: [run.evidence.id],
        child_outcome_ids: [],
        result: "success",
        rationale: "met",
        tested_input: snapshot,
      },
      W,
    );
    const evidence = completed(
      await api["evidence.request"]({
        params: { node_id: nodeId },
        query: {},
        body: {
          ...context(evaluation),
          requirement_key: key,
          subject: key,
          address,
        },
      }),
    );
    await release(evaluation);
    return evidence.id;
  };
  const number = gitHub.open({
    owner: "owner",
    repo: "gated",
    head: `kanthord/${gatedNode}`,
    base: "main",
  });
  const pullRequestId = await requested(
    gatedNode,
    "gated",
    "gated.pull_request",
    {
      kind: PlatformAddressKind.PullRequest,
      resource_identity: binding("gated").resource_identity,
      number,
    },
  );
  const branchPushId = await requested(
    pushedNode,
    "pushed",
    "pushed.merge_push",
    {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: binding("pushed").resource_identity,
      branch: "main",
      commit: pushed.head,
    },
  );
  const intake = directClient(intakeOperations, fixture.invocation);
  const check = (evidenceId: string, service = MISSION_SERVICE_NAME) =>
    intake["action.check"](
      { params: {}, query: {}, body: { evidence_id: evidenceId } },
      { identity: mintServiceIdentity(service) },
    );
  const materials: Material[] = [];
  const releaseMaterial = fixture.custody.release.bind(fixture.custody);
  fixture.custody.release = (...args) => {
    const material = releaseMaterial(...args);
    materials.push(material);
    return material;
  };
  const nodeCheck = async (nodeId: string) =>
    write<{
      results: unknown[];
      failures: { evidence_id: string; error: { error: { code: string } } }[];
    }>(["mission", "node", "check", nodeId], {
      expected_mission_version: await version(),
    });
  const nodes = { gated: gatedNode, pushed: pushedNode };
  return {
    fixture,
    gitHub,
    pushed,
    number,
    pullRequestId,
    branchPushId,
    check,
    materials,
    nodeCheck,
    nodes,
  };
}

function dropped(materials: Material[], count: number) {
  assert.equal(materials.length, count);
  for (const material of materials) assert.throws(() => material.value());
}

test(
  "intake.action.check folds the platform state of a request evidence",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const pullRequest = () => h.check(h.pullRequestId);
    const branchPush = () => h.check(h.branchPushId);
    const closed = {
      number: h.number,
      state: "closed",
      merged: false,
      merge_commit_sha: null,
    };

    await t.test(
      "a pull request answers none, other and expected",
      async () => {
        assert.deepEqual(completed<Fold>(await pullRequest()), {
          end_state: CheckEndState.None,
          landed_commits: [],
        });
        h.gitHub.respondNext(HttpStatus.OK, closed);
        assert.deepEqual(completed<Fold>(await pullRequest()), {
          end_state: CheckEndState.Other,
          landed_commits: [],
        });
        h.gitHub.merge(h.number, MERGE_SHA);
        assert.deepEqual(completed<Fold>(await pullRequest()), {
          end_state: CheckEndState.Expected,
          landed_commits: [MERGE_SHA],
        });
        assert.ok(
          h.gitHub.calls.every(
            (call) =>
              call.method === HttpMethod.Get &&
              call.path === `/repos/owner/gated/pulls/${h.number}` &&
              call.token === GITHUB_KEY,
          ),
        );
        dropped(h.materials, h.gitHub.calls.length);
      },
    );

    await t.test(
      "a branch push answers expected while landed and other after a rewrite",
      async () => {
        const before = h.materials.length;
        assert.deepEqual(completed<Fold>(await branchPush()), {
          end_state: CheckEndState.Expected,
          landed_commits: [h.pushed.head],
        });
        await rewriteMain(t, h.pushed.bare);
        assert.deepEqual(completed<Fold>(await branchPush()), {
          end_state: CheckEndState.Other,
          landed_commits: [],
        });
        assert.equal(h.materials.length, before);
      },
    );

    await t.test(
      "a GitHub result class answers 502 with the status",
      async () => {
        h.gitHub.failPulls(BAD_GATEWAY_STATUS);
        failed(await pullRequest(), BAD_GATEWAY_STATUS, RETRYABLE_CODE, {
          status: BAD_GATEWAY_STATUS,
        });
        h.gitHub.failPulls(UNAUTHORIZED_STATUS);
        failed(await pullRequest(), BAD_GATEWAY_STATUS, FINAL_CODE, {
          status: UNAUTHORIZED_STATUS,
        });
        h.gitHub.failPulls(null);
        h.gitHub.respondNext(HttpStatus.OK, {});
        failed(await pullRequest(), BAD_GATEWAY_STATUS, RETRYABLE_CODE, {
          status: null,
        });
        dropped(h.materials, h.materials.length);
      },
    );

    await t.test("a thrown error drops the material", async () => {
      const before = h.materials.length;
      h.gitHub.respondNext(HttpStatus.OK, {
        ...closed,
        merged: true,
      });
      failed(await pullRequest(), HttpStatus.InternalServerError, UNKNOWN_CODE);
      assert.equal(h.materials.length, before + SINGLE_INSTANCE);
      dropped(h.materials, h.materials.length);
    });

    await t.test(
      "the Intake service identity refuses with service_mismatch",
      async () => {
        const before = h.gitHub.calls.length;
        failed(
          await h.check(h.pullRequestId, INTAKE_SERVICE_NAME),
          HttpStatus.Forbidden,
          MissionErrorCode.AuthorizationRefused,
          { reason: "service_mismatch" },
        );
        assert.equal(h.gitHub.calls.length, before);
      },
    );

    await t.test("the HTTP adapter answers 404 for the path", async () => {
      const response = await h.fixture.request("/api/intake/action/check", {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.fixture.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ evidence_id: h.pullRequestId }),
      });
      assert.equal(response.status, HttpStatus.NotFound);
      await response.body?.cancel();
    });

    await t.test(
      "a failed inspection answers a failure, never other",
      async () => {
        h.gitHub.failPulls(BAD_GATEWAY_STATUS);
        rmSync(h.pushed.bare, { recursive: true, force: true });
        failed(await branchPush(), BAD_GATEWAY_STATUS, GIT_FAILED_CODE);
        for (const [nodeId, evidenceId, code] of [
          [h.nodes.gated, h.pullRequestId, RETRYABLE_CODE],
          [h.nodes.pushed, h.branchPushId, GIT_FAILED_CODE],
        ] as const) {
          const answer = await h.nodeCheck(nodeId);
          assert.deepEqual(answer.results, []);
          assert.deepEqual(
            answer.failures.map((item) => [
              item.evidence_id,
              item.error.error.code,
            ]),
            [[evidenceId, code]],
          );
        }
        h.gitHub.failPulls(null);
      },
    );

    await t.test("a check records no outbound request", () => {
      const { count } = h.fixture.store.transaction(
        (tx) =>
          tx.database
            .prepare("SELECT COUNT(*) AS count FROM intake_outbound_request")
            .get() as { count: number },
      );
      assert.equal(count, NO_ROWS);
    });
  },
);
