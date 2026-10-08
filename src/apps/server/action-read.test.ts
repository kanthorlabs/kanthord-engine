import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Material } from "../../custody/contract.ts";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  ActionReadMethod,
  ResultClass,
  intakeOperations,
  type ActionReadMethodValue,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
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
const ONE_PIN = 1;
const FAILED_READS = 2;
const BAD_GATEWAY_STATUS = 502;
const PAGE_LIMIT = 30;
const OUT_OF_RANGE_LIMIT = 101;
const TIMEOUT = 180000;
const GITHUB_KEY = "test-secret";
const GATED_ADDRESS = "git@github.com:owner/gated.git";
const PUSHED_ADDRESS = "git@github.com:owner/pushed.git";
const GITHUB_PREFIX = "repository.platform.github.";
const UNKNOWN_CODE = "gateway.invocation.unknown";
const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CONTENT = {
  name: "Read actions",
  requirement: "Read actions",
  criterion: "Actions land",
  verifications: ["true"],
};
const COMMENTS = [{ id: 7, body: "nit", extra: { nested: [1, "two"] } }];
type Page<T> = { items: T[] };
type Answer =
  | { body: unknown; next_cursor: string | null }
  | { class: string; code: string; message: string };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}

function failed<T>(result: OperationResult<T>, status: number, code: string) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
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
    "reads",
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
  const identity = await fixture.invocation.authentication.authenticate(
    `Bearer ${token}`,
  );
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
    return { evaluation, evidenceId: evidence.id };
  };
  const intake = directClient(intakeOperations, fixture.invocation);
  const readAction = (
    execution: ExecutionRecord,
    evidenceId: string,
    query: {
      method: ActionReadMethodValue;
      limit?: number;
      cursor?: string;
    },
  ) =>
    intake["action.read"](
      {
        params: {
          execution_id: execution.execution_id,
          evidence_id: evidenceId,
        },
        query,
        body: null,
      },
      { identity },
    ) as Promise<OperationResult<Answer>>;
  const materials: Material[] = [];
  const releaseMaterial = fixture.custody.release.bind(fixture.custody);
  fixture.custody.release = (...args) => {
    const material = releaseMaterial(...args);
    materials.push(material);
    return material;
  };
  const pins = (execution: ExecutionRecord) =>
    fixture.store.transaction((tx) => {
      const found = tx.database
        .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
        .get(execution.execution_id) as { credentials: string };
      return JSON.parse(found.credentials) as string[];
    });
  const outboundCount = () =>
    fixture.store.transaction(
      (tx) =>
        (
          tx.database
            .prepare("SELECT COUNT(*) AS count FROM intake_outbound_request")
            .get() as { count: number }
        ).count,
    );
  return {
    fixture,
    gitHub,
    nodes: { gated: gatedNode, pushed: pushedNode },
    resource: (name: string) => binding(name).resource_identity,
    requested,
    release,
    readAction,
    materials,
    pins,
    outboundCount,
  };
}

function dropped(materials: Material[], count: number) {
  assert.equal(materials.length, count);
  for (const material of materials) assert.throws(() => material.value());
}

test(
  "intake.action.read answers the platform body of a request evidence",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const number = h.gitHub.open({
      owner: "owner",
      repo: "gated",
      head: `kanthord/${h.nodes.gated}`,
      base: "main",
    });
    const gated = await h.requested(
      h.nodes.gated,
      "gated",
      "gated.pull_request",
      {
        kind: PlatformAddressKind.PullRequest,
        resource_identity: h.resource("gated"),
        number,
      },
    );
    const get = () =>
      h.readAction(gated.evaluation, gated.evidenceId, {
        method: ActionReadMethod.PullRequestGet,
      });
    const comments = (page: { limit?: number; cursor?: string } = {}) =>
      h.readAction(gated.evaluation, gated.evidenceId, {
        method: ActionReadMethod.ReviewCommentList,
        ...page,
      });

    await t.test(
      "a pull request get passes the body unchanged and pins the credential",
      async () => {
        assert.deepEqual(h.pins(gated.evaluation), []);
        const body = {
          number,
          state: "open",
          merged: false,
          merge_commit_sha: null,
          extra: { kept: [true, null] },
        };
        h.gitHub.respondNext(HttpStatus.OK, body);
        assert.deepEqual(completed(await get()), { body, next_cursor: null });
        assert.equal(h.pins(gated.evaluation).length, ONE_PIN);
        const call = h.gitHub.calls.at(-1);
        assert.equal(call?.method, HttpMethod.Get);
        assert.equal(call?.path, `/repos/owner/gated/pulls/${number}`);
        assert.equal(call?.token, GITHUB_KEY);
        dropped(h.materials, h.gitHub.calls.length);
      },
    );

    await t.test(
      "a review comment list passes the body and its page size",
      async () => {
        h.gitHub.respondNext(HttpStatus.OK, COMMENTS);
        assert.deepEqual(completed(await comments({ limit: PAGE_LIMIT })), {
          body: COMMENTS,
          next_cursor: null,
        });
        const path = h.gitHub.calls.at(-1)?.path ?? "";
        const url = new URL(path, "http://127.0.0.1");
        assert.equal(
          url.pathname,
          `/repos/owner/gated/pulls/${number}/comments`,
        );
        assert.equal(url.searchParams.get("per_page"), String(PAGE_LIMIT));
        assert.equal(h.pins(gated.evaluation).length, ONE_PIN);
        dropped(h.materials, h.gitHub.calls.length);
      },
    );

    await t.test("a GitHub failure answers its result class", async () => {
      h.gitHub.failPulls(BAD_GATEWAY_STATUS);
      try {
        for (const result of [await get(), await comments()]) {
          const answer = completed(result);
          assert.ok("class" in answer, JSON.stringify(answer));
          assert.equal(answer.class, ResultClass.RetryableRefusal);
          assert.equal(
            answer.code,
            GITHUB_PREFIX + ResultClass.RetryableRefusal,
          );
        }
      } finally {
        h.gitHub.failPulls(null);
      }
      dropped(h.materials, h.gitHub.calls.length);
    });

    await t.test("a limit outside 1 to 100 answers 400", async () => {
      const before = h.materials.length;
      failed(
        await comments({ limit: OUT_OF_RANGE_LIMIT }),
        HttpStatus.BadRequest,
        VALIDATION_FAILED_CODE,
      );
      assert.equal(h.materials.length, before);
    });

    await t.test(
      "an invalid cursor and a thrown call drop the material",
      async () => {
        const before = h.materials.length;
        failed(
          await comments({ cursor: "invalid" }),
          HttpStatus.BadRequest,
          CURSOR_INVALID_CODE,
        );
        const getPullRequest = h.fixture.github.getPullRequest;
        h.fixture.github.getPullRequest = async () => {
          throw new Error("thrown read");
        };
        try {
          failed(await get(), HttpStatus.InternalServerError, UNKNOWN_CODE);
        } finally {
          h.fixture.github.getPullRequest = getPullRequest;
        }
        dropped(h.materials, before + FAILED_READS);
      },
    );

    await t.test("the HTTP adapter answers 404 for the path", async () => {
      const response = await h.fixture.request(
        `/api/intake/execution/${gated.evaluation.execution_id}/request/${gated.evidenceId}?method=${ActionReadMethod.PullRequestGet}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${h.fixture.token}` },
        },
      );
      assert.equal(response.status, HttpStatus.NotFound);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, ROUTE_NOT_FOUND_CODE);
    });

    await h.release(gated.evaluation);
    const pushed = await h.requested(
      h.nodes.pushed,
      "pushed",
      "pushed.merge_push",
      {
        kind: PlatformAddressKind.BranchPush,
        resource_identity: h.resource("pushed"),
        branch: "main",
        commit: "a".repeat(40),
      },
    );

    await t.test("another node refuses before the release", async () => {
      const materials = h.materials.length;
      const calls = h.gitHub.calls.length;
      failed(
        await h.readAction(pushed.evaluation, gated.evidenceId, {
          method: ActionReadMethod.PullRequestGet,
        }),
        HttpStatus.Forbidden,
        MissionErrorCode.AuthorizationRefused,
      );
      assert.equal(h.materials.length, materials);
      assert.equal(h.gitHub.calls.length, calls);
      assert.deepEqual(h.pins(pushed.evaluation), []);
    });

    await t.test("a branch push answers 400 before the release", async () => {
      const materials = h.materials.length;
      failed(
        await h.readAction(pushed.evaluation, pushed.evidenceId, {
          method: ActionReadMethod.PullRequestGet,
        }),
        HttpStatus.BadRequest,
        VALIDATION_FAILED_CODE,
      );
      assert.equal(h.materials.length, materials);
      assert.deepEqual(h.pins(pushed.evaluation), []);
    });

    await t.test("a read records no outbound request", () => {
      assert.equal(h.outboundCount(), NO_ROWS);
    });
  },
);
