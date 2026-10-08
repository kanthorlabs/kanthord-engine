import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import type { Material } from "../../custody/contract.ts";
import { directClient } from "../../gateway/index.ts";
import {
  IntakeErrorCode,
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
  intakeOperations,
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
  type PlatformAddress,
  type Revision,
} from "../../mission/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  bareRepository,
  fakeGitHub,
  gatewayFixture,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const PUSHED_PRIORITY = 2;
const GATED_PRIORITY = 3;
const FIRST_INDEX = 0;
const SINGLE_INSTANCE = 1;
const NO_ROWS = 0;
const ONE_CREATE = 1;
const WAIT_ATTEMPTS = 400;
const WAIT_STEP_MS = 25;
const UNPROCESSABLE_STATUS = 422;
const TIMEOUT = 240000;
const GITHUB_KEY = "test-secret";
const GITHUB_CREDENTIAL = "github";
const GATED_ADDRESS = "git@github.com:owner/gated.git";
const PUSHED_ADDRESS = "git@github.com:owner/pushed.git";
const GITHUB_PREFIX = "repository.platform.github.";
const GIT_FAILED_CODE = "repository.connector.git_failed";
const UNKNOWN_CODE = "gateway.invocation.unknown";
const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const PULLS_PATH = "/repos/owner/gated/pulls";
const MAIN_REF = "refs/heads/main";
const UNMAPPED_PLATFORM = "gitlab";
const CONTENT = {
  name: "Perform actions",
  requirement: "Perform actions",
  criterion: "Actions land",
  verifications: ["true"],
};
type Page<T> = { items: T[] };
type Answer =
  PlatformAddress | { class: string; code: string; message: string };
type OutboundRow = {
  operation: string;
  request_key: string;
  state: string;
  credential: string | null;
  result: string | null;
};

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

async function commitOnBranch(t: TestContext, bare: string, branch: string) {
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", branch]);
  writeFileSync(join(directory, "node.md"), "node work\n");
  await git.add("node.md");
  await git.commit("node work");
  await git.push("origin", branch);
  return (await git.revparse(["HEAD"])).trim();
}

async function until(condition: () => boolean) {
  for (let attempt = FIRST_INDEX; attempt < WAIT_ATTEMPTS; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  assert.fail("The condition did not hold in time.");
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
    name: GITHUB_CREDENTIAL,
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
    "performs",
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
  const snapshot = await commitOnBranch(
    t,
    pushed.bare,
    `kanthord/${pushedNode}`,
  );
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
  const evaluated = async (nodeId: string, name: string, commit: string) => {
    const tested = { kind: "repository", binding_id: binding(name).id, commit };
    const steps = await pull(nodeId);
    await write(
      ["mission", "evidence", "submit", nodeId],
      {
        ...context(steps),
        subject: "head commit",
        assets: [{ kind: "repository", address: tested }],
      },
      W,
    );
    await release(steps);
    const evaluation = await pull(nodeId);
    const run = await write<{ evidence: { id: string } }>(
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
          tested_input: tested,
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
        tested_input: tested,
      },
      W,
    );
    return evaluation;
  };
  const requested = async (
    nodeId: string,
    execution: ExecutionRecord,
    key: string,
    address: PlatformAddress,
  ) => {
    completed(
      await api["evidence.request"]({
        params: { node_id: nodeId },
        query: {},
        body: {
          ...context(execution),
          requirement_key: key,
          subject: key,
          address,
        },
      }),
    );
    await release(execution);
  };
  const intake = directClient(intakeOperations, fixture.invocation);
  const perform = (
    execution: ExecutionRecord,
    body: { key: string; commit: string; request_key: string },
    reusedEvidenceId: string | null = null,
  ) =>
    intake["action.perform"](
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: { ...body, reused_evidence_id: reusedEvidenceId },
      },
      { identity, idempotencyKey: ulid() },
    ) as Promise<OperationResult<Answer>>;
  const materials: Material[] = [];
  const releaseMaterial = fixture.custody.release.bind(fixture.custody);
  fixture.custody.release = (...args) => {
    const material = releaseMaterial(...args);
    materials.push(material);
    return material;
  };
  const rows = () =>
    fixture.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT operation, request_key, state, credential, result FROM intake_outbound_request ORDER BY id",
          )
          .all() as OutboundRow[],
    );
  const row = (requestKey: string) =>
    rows().find((item) => item.request_key === requestKey);
  const pins = (execution: ExecutionRecord) =>
    fixture.store.transaction((tx) => {
      const found = tx.database
        .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
        .get(execution.execution_id) as { credentials: string };
      return JSON.parse(found.credentials) as string[];
    });
  return {
    fixture,
    gitHub,
    pushed,
    snapshot,
    nodes: { gated: gatedNode, pushed: pushedNode },
    resource: (name: string) => binding(name).resource_identity,
    evaluated,
    requested,
    perform,
    materials,
    rows,
    row,
    pins,
  };
}

function dropped(materials: Material[]) {
  for (const material of materials) assert.throws(() => material.value());
}

test(
  "intake.action.perform creates a pull request and merges a branch through the outbound record",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const posts = () =>
      h.gitHub.calls.filter(
        (call) => call.method === HttpMethod.Post && call.path === PULLS_PATH,
      ).length;
    const gated = await h.evaluated(h.nodes.gated, "gated", h.pushed.head);
    const gatedBody = (requestKey: string) => ({
      key: "gated.pull_request",
      commit: h.pushed.head,
      request_key: requestKey,
    });
    let created: PlatformAddress | null = null;

    await t.test(
      "a refusal of another node reaches no release, no material and no row",
      async () => {
        failed(
          await h.perform(gated, {
            key: "pushed.merge_push",
            commit: h.pushed.head,
            request_key: "refused",
          }),
          HttpStatus.Forbidden,
          MissionErrorCode.AuthorizationRefused,
        );
        assert.equal(h.materials.length, NO_ROWS);
        assert.equal(h.rows().length, NO_ROWS);
        assert.deepEqual(h.pins(gated), []);
        assert.equal(h.gitHub.calls.length, NO_ROWS);
      },
    );

    await t.test(
      "an unmapped action answers 422 and records no request",
      async () => {
        const authorize = h.fixture.mission.authorizeFrozenAction;
        h.fixture.mission.authorizeFrozenAction = (...args) => ({
          ...authorize.apply(h.fixture.mission, args),
          platform: UNMAPPED_PLATFORM,
        });
        try {
          failed(
            await h.perform(gated, gatedBody("unmapped")),
            UNPROCESSABLE_STATUS,
            IntakeErrorCode.OutboundRequestActionUnmapped,
          );
        } finally {
          h.fixture.mission.authorizeFrozenAction = authorize;
        }
        assert.equal(h.rows().length, NO_ROWS);
        assert.equal(h.materials.length, NO_ROWS);
      },
    );

    await t.test("a reused evidence answers 400 until the reuse", async () => {
      failed(
        await h.perform(gated, gatedBody("reused"), `evidence_${ulid()}`),
        HttpStatus.BadRequest,
        VALIDATION_FAILED_CODE,
      );
      assert.equal(h.rows().length, NO_ROWS);
    });

    await t.test(
      "a lost create answers unknown_outcome and a repeat finds the pull request",
      async () => {
        h.gitHub.dropNextAfterApply();
        const lost = completed(await h.perform(gated, gatedBody("create")));
        assert.deepEqual(
          {
            class: "class" in lost ? lost.class : null,
            code: "code" in lost ? lost.code : null,
          },
          {
            class: ResultClass.UnknownOutcome,
            code: GITHUB_PREFIX + ResultClass.UnknownOutcome,
          },
        );
        assert.equal(h.row("create")?.state, OutboundRequestState.Failed);
        const found = completed(await h.perform(gated, gatedBody("create")));
        assert.equal(posts(), ONE_CREATE);
        const number = h.gitHub.pulls.at(-1)?.number;
        assert.ok(number);
        assert.deepEqual(found, {
          kind: PlatformAddressKind.PullRequest,
          resource_identity: h.resource("gated"),
          number,
        });
        const stored = h.row("create");
        assert.equal(stored?.state, OutboundRequestState.Succeeded);
        assert.equal(stored?.operation, OutboundOperation.GitHubPullRequest);
        assert.equal(stored?.credential, GITHUB_CREDENTIAL);
        assert.deepEqual(JSON.parse(stored!.result!), found);
        assert.deepEqual(
          completed(await h.perform(gated, gatedBody("create"))),
          found,
        );
        assert.equal(posts(), ONE_CREATE);
        assert.ok(
          h.gitHub.calls.every(
            (call) =>
              call.token === GITHUB_KEY &&
              (call.method !== HttpMethod.Post ||
                (call.body as { head: string }).head ===
                  `kanthord/${h.nodes.gated}`),
          ),
        );
        created = found as PlatformAddress;
        dropped(h.materials);
      },
    );

    await t.test(
      "two concurrent calls with one key create once and answer one 409",
      async () => {
        const before = posts();
        const open = h.gitHub.hold();
        const first = h.perform(gated, gatedBody("concurrent"));
        await until(() => posts() === before + ONE_CREATE);
        failed(
          await h.perform(gated, gatedBody("concurrent")),
          HttpStatus.Conflict,
          IntakeErrorCode.OutboundRequestInFlight,
        );
        open();
        const answer = completed(await first);
        assert.equal(
          "kind" in answer && answer.kind,
          PlatformAddressKind.PullRequest,
        );
        assert.equal(posts(), before + ONE_CREATE);
        assert.equal(
          h.row("concurrent")?.state,
          OutboundRequestState.Succeeded,
        );
      },
    );

    await t.test("a GitHub refusal answers its result class", async () => {
      h.gitHub.respondNext(UNPROCESSABLE_STATUS, {
        message: "Validation Failed",
      });
      const answer = completed(await h.perform(gated, gatedBody("refusal")));
      assert.ok("class" in answer);
      assert.equal(answer.class, ResultClass.FinalRefusal);
      assert.equal(answer.code, GITHUB_PREFIX + ResultClass.FinalRefusal);
      assert.equal(h.row("refusal")?.state, OutboundRequestState.Failed);
      dropped(h.materials);
    });

    await t.test(
      "a thrown call keeps the pending row and the pin and drops the material",
      async () => {
        const create = h.fixture.github.createPullRequest;
        h.fixture.github.createPullRequest = async () => {
          throw new Error("thrown create");
        };
        const before = h.materials.length;
        try {
          failed(
            await h.perform(gated, gatedBody("thrown")),
            HttpStatus.InternalServerError,
            UNKNOWN_CODE,
          );
        } finally {
          h.fixture.github.createPullRequest = create;
        }
        assert.equal(h.materials.length, before + ONE_CREATE);
        dropped(h.materials);
        assert.equal(h.row("thrown")?.state, OutboundRequestState.Pending);
        assert.equal(h.pins(gated).length, ONE_CREATE);
      },
    );

    await t.test("the HTTP adapter answers 404 for the path", async () => {
      const response = await h.fixture.request(
        `/api/intake/execution/${gated.execution_id}/action/perform`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${h.fixture.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(gatedBody("http")),
        },
      );
      assert.equal(response.status, HttpStatus.NotFound);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, ROUTE_NOT_FOUND_CODE);
    });

    assert.ok(created);
    await h.requested(h.nodes.gated, gated, "gated.pull_request", created);
    const merged = await h.evaluated(h.nodes.pushed, "pushed", h.snapshot);
    const mergeBody = (requestKey: string) => ({
      key: "pushed.merge_push",
      commit: h.snapshot,
      request_key: requestKey,
    });

    await t.test(
      "git.merge_push merges the snapshot and leaves no clone",
      async () => {
        const before = h.materials.length;
        const scratch = mkdtempSync(join(temporary(t), "tmp-"));
        const previous = process.env.TMPDIR;
        process.env.TMPDIR = scratch;
        const writer = h.fixture.gitWriter;
        const mergePushFresh = writer.mergePushFresh;
        const roots: string[] = [];
        writer.mergePushFresh = (...args) => {
          roots.push(tmpdir());
          return mergePushFresh(...args);
        };
        let answer: Answer;
        try {
          answer = completed(await h.perform(merged, mergeBody("merge")));
        } finally {
          process.env.TMPDIR = previous;
          writer.mergePushFresh = mergePushFresh;
        }
        assert.deepEqual(roots, [scratch]);
        assert.deepEqual(readdirSync(scratch), []);
        const head = await remoteHead(h.pushed.bare, MAIN_REF);
        assert.ok(head && head !== h.snapshot);
        assert.deepEqual(answer, {
          kind: PlatformAddressKind.BranchPush,
          resource_identity: h.resource("pushed"),
          branch: "main",
          commit: head,
        });
        const stored = h.row("merge");
        assert.equal(stored?.operation, OutboundOperation.GitMergePush);
        assert.equal(stored?.credential, null);
        assert.equal(stored?.state, OutboundRequestState.Succeeded);
        assert.deepEqual(JSON.parse(stored!.result!), answer);
        assert.deepEqual(
          completed(await h.perform(merged, mergeBody("merge"))),
          answer,
        );
        assert.equal(await remoteHead(h.pushed.bare, MAIN_REF), head);
        assert.equal(h.materials.length, before);
      },
    );

    await t.test(
      "a failure before the push answers confirmed_failure with git_failed",
      async () => {
        rmSync(h.pushed.bare, { recursive: true, force: true });
        const answer = completed(await h.perform(merged, mergeBody("lost")));
        assert.ok("class" in answer);
        assert.equal(answer.class, ResultClass.ConfirmedFailure);
        assert.equal(answer.code, GIT_FAILED_CODE);
        assert.equal(h.row("lost")?.state, OutboundRequestState.Failed);
        const repeat = completed(await h.perform(merged, mergeBody("lost")));
        assert.ok("class" in repeat);
        assert.equal(repeat.class, ResultClass.ConfirmedFailure);
        assert.equal(repeat.code, GIT_FAILED_CODE);
        assert.equal(h.row("lost")?.state, OutboundRequestState.Failed);
      },
    );
  },
);
