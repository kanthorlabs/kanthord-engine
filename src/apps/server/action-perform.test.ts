import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import type { Material } from "../../custody/contract.ts";
import { directClient } from "../../gateway/index.ts";
import {
  CheckEndState,
  IntakeErrorCode,
  intakeOperations,
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
  SERVICE_MERGE_REQUEST_KEY_PREFIX,
} from "../../intake/contract.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  stopAfter,
  SUITE_CONCURRENCY,
  temporary,
} from "../../kernel/test-support.ts";
import {
  Intent,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  missionOperations,
  type PlatformAddress,
  PlatformAddressKind,
  type Revision,
  StartPoint,
} from "../../mission/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { GitStage, GitWriteError } from "../../repository/index.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { environment, kanthord } from "./cli-test-support.ts";
import {
  bareRepository,
  createFakeSshCredential,
  FAKE_SSH_CREDENTIAL,
  fakeGitHub,
  type FakeGitHubCall,
  gatewayFixture,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const SUCCESSFUL_EXIT = 0;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const PUSHED_PRIORITY = 2;
const GATED_PRIORITY = 3;
const FIRST_INDEX = 0;
const SINGLE_INSTANCE = 1;
const NO_ROWS = 0;
const NO_PUSHES = 0;
const ONE_CREATE = 1;
const ONE_SSH_RELEASE = 1;
const TWO_SSH_RELEASES = 2;
const CREATE_RELEASES = 2;
const CREATE_PINS = 2;
const SSH_REVISION_REVOKED = "credential.revision.revoked";
const WAIT_STEP_MS = 25;
const UNPROCESSABLE_STATUS = 422;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const ONE_PUSH = 1;
const TWO_PUSHES = 2;
const EXECUTABLE_MODE = 0o755;
const REJECTING_HOOK = "#!/bin/sh\nexit 1\n";
const SNAPSHOT_BRANCH = "work";
const LANDED = "landed";
const NOT_LANDED = "not_landed";
const THREW = "threw";
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
const KANTHORD_LANDING = "kanthord";
const MERGE_REFUSED_STATUS = 405;
const OTHER_MERGE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const MAIN_REF = "refs/heads/main";
const UNMAPPED_PLATFORM = "unmapped";
const GITLAB_PLATFORM = "gitlab";
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

async function mergeIntoMain(t: TestContext, bare: string, branch: string) {
  const directory = join(temporary(t), "merge");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Merge");
  await git.addConfig("user.email", "test_merge@example.invalid");
  await git.raw(["merge", "--no-ff", "-m", "merge", `origin/${branch}`]);
  const merge = (await git.revparse(["HEAD"])).trim();
  writeFileSync(join(directory, "later.md"), "later work\n");
  await git.add("later.md");
  await git.commit("later work");
  await git.push("origin", "main");
  return merge;
}

async function commitOnBranch(
  t: TestContext,
  bare: string,
  branch: string,
  content = "node work\n",
) {
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", branch]);
  writeFileSync(join(directory, "node.md"), content);
  await git.add("node.md");
  await git.commit("node work");
  await git.push("origin", branch);
  return (await git.revparse(["HEAD"])).trim();
}

function readOf(calls: readonly FakeGitHubCall[], number: number) {
  return calls.some(
    (call) =>
      call.method === HttpMethod.Get &&
      call.path.endsWith(`/pulls/${number}`) &&
      call.status !== null,
  );
}

async function until(condition: () => boolean, signal: AbortSignal) {
  while (!condition()) await delay(WAIT_STEP_MS, undefined, { signal });
}

async function setup(t: TestContext, landing = "human") {
  const gitHub = await fakeGitHub(t);
  const pushed = await bareRepository(t, "pushed");
  const gated = await bareRepository(t, "gated");
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({
      [PUSHED_ADDRESS]: pushed.bare,
      [GATED_ADDRESS]: gated.bare,
    }),
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
  await createFakeSshCredential(read);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "performs",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const repository = (
    address: string,
    action: string,
    choice: { landing?: string } = {},
  ) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address,
      ssh_credential: FAKE_SSH_CREDENTIAL,
      credential: "github",
      strategy: {
        base_branch: "main",
        action: {
          name: action,
          follows: { type: "assessment_passed" },
          ...choice,
        },
      },
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repository(GATED_ADDRESS, "pull_request", { landing }),
      pushed: repository(PUSHED_ADDRESS, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: SINGLE_INSTANCE },
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
  const create = async (filename: string, names: string[]) => {
    const answer = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        content: {
          ...CONTENT,
          intent: Intent.Implement,
          bindings: names.map((name) => binding(name).id),
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: await version(),
      },
    );
    return answer.revisions[FIRST_INDEX]!.node_id;
  };
  const gatedNode = await create("gated.md", ["gated"]);
  const pushedNode = await create("pushed.md", ["pushed"]);
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
  await simpleGit(pushed.bare).raw([
    "push",
    gated.bare,
    "main:refs/heads/pushed",
  ]);
  const gatedSnapshot = await commitOnBranch(
    t,
    gated.bare,
    "snapshot",
    "snapshot work\n",
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
        dependency_outcome_ids: [],
        result: "success",
        rationale: "met",
        tested_input: tested,
      },
      W,
    );
    return evaluation;
  };
  const request = async (
    nodeId: string,
    execution: ExecutionRecord,
    key: string,
    address: PlatformAddress,
  ) =>
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
    ).id;
  const requested = async (
    nodeId: string,
    execution: ExecutionRecord,
    key: string,
    address: PlatformAddress,
  ) => {
    const evidenceId = await request(nodeId, execution, key, address);
    await release(execution);
    return evidenceId;
  };
  const intake = directClient(intakeOperations, fixture.invocation);
  const perform = (
    execution: ExecutionRecord,
    body: { key: string; commit: string; request_key: string },
    reusedEvidenceId: string | null = null,
    mergeEvidenceId: string | null = null,
  ) =>
    intake["action.perform"](
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: {
          ...body,
          reused_evidence_id: reusedEvidenceId,
          merge_evidence_id: mergeEvidenceId,
        },
      },
      { identity, idempotencyKey: createIdempotencyKey() },
    ) as Promise<OperationResult<Answer>>;
  const check = (evidenceId: string) =>
    intake["action.check"](
      { params: {}, query: {}, body: { evidence_id: evidenceId } },
      { identity: mintServiceIdentity(MISSION_SERVICE_NAME) },
    );
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
  const sshRevision = (revision: number) =>
    fixture.store.transaction((tx) => {
      const found = tx.database
        .prepare("SELECT id FROM credential WHERE name = ? AND revision = ?")
        .get(FAKE_SSH_CREDENTIAL, revision) as { id: string } | undefined;
      assert.ok(found);
      return found.id;
    });
  return {
    fixture,
    identity,
    gitHub,
    pushed,
    gated,
    gatedSnapshot,
    snapshot,
    nodes: { gated: gatedNode, pushed: pushedNode },
    resource: (name: string) => binding(name).resource_identity,
    write,
    version,
    evaluated,
    request,
    requested,
    perform,
    check,
    materials,
    rows,
    row,
    pins,
    sshRevision,
    read,
  };
}

function dropped(materials: Material[]) {
  for (const material of materials) assert.throws(() => material.value());
}

test(
  "intake.action.perform refuses a request key of the service merge namespace",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const gated = await h.evaluated(h.nodes.gated, "gated", h.gatedSnapshot);
    const body = (requestKey: string) => ({
      key: "gated.pull_request",
      commit: h.gatedSnapshot,
      reused_evidence_id: null,
      merge_evidence_id: null,
      request_key: requestKey,
    });
    const invoke = (requestKey: string) =>
      h.fixture.invocation.invoke(
        "intake.action.perform",
        {
          params: { execution_id: gated.execution_id },
          query: {},
          body: body(requestKey),
        },
        { identity: h.identity, idempotencyKey: createIdempotencyKey() },
      );
    const refused = await invoke(`${SERVICE_MERGE_REQUEST_KEY_PREFIX}key`);
    assert.equal(refused.status, HttpStatus.BadRequest);
    assert.equal(
      (refused.body as { error: { code: string } }).error.code,
      VALIDATION_FAILED_CODE,
    );
    assert.deepEqual(h.rows(), []);
    assert.equal((await invoke("key")).status, HttpStatus.OK);
    assert.equal(h.rows().length, ONE_CREATE);
  },
);

test(
  "intake.action.perform creates a pull request and merges a branch through the outbound record",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const posts = () =>
      h.gitHub.calls.filter(
        (call) => call.method === HttpMethod.Post && call.path === PULLS_PATH,
      ).length;
    const gated = await h.evaluated(h.nodes.gated, "gated", h.gatedSnapshot);
    const evaluationReleases = h.materials.length;
    const evaluationPins = h.pins(gated);
    const gatedBody = (requestKey: string) => ({
      key: "gated.pull_request",
      commit: h.gatedSnapshot,
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
        assert.equal(h.materials.length, evaluationReleases);
        assert.equal(h.rows().length, NO_ROWS);
        assert.deepEqual(h.pins(gated), evaluationPins);
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
        assert.equal(h.materials.length, evaluationReleases);
      },
    );

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
        await until(() => posts() === before + ONE_CREATE, t.signal);
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
      "a git failure of the contained check answers git_failed and opens no pull request",
      async () => {
        const landedOn = h.fixture.gitWriter.landedOn;
        h.fixture.gitWriter.landedOn = async () => {
          throw new Diagnostic(GIT_FAILED_CODE, "landing read failed");
        };
        const before = posts();
        try {
          const answer = completed(
            await h.perform(gated, gatedBody("landing")),
          );
          assert.ok("class" in answer);
          assert.equal(answer.class, ResultClass.ConfirmedFailure);
          assert.equal(answer.code, GIT_FAILED_CODE);
        } finally {
          h.fixture.gitWriter.landedOn = landedOn;
        }
        assert.equal(h.row("landing")?.state, OutboundRequestState.Failed);
        assert.equal(posts(), before);
        dropped(h.materials);
      },
    );

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
        assert.equal(h.materials.length, before + CREATE_RELEASES);
        dropped(h.materials);
        assert.equal(h.row("thrown")?.state, OutboundRequestState.Pending);
        assert.equal(h.pins(gated).length, CREATE_PINS);
        assert.ok(h.pins(gated).includes(h.sshRevision(FIRST_REVISION)));
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
        const scratch = mkdtempSync(join(tmpdir(), "kd-perform-"));
        stopAfter(t, () => rmSync(scratch, { recursive: true, force: true }));
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
          if (previous === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = previous;
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
        assert.equal(stored?.credential, FAKE_SSH_CREDENTIAL);
        assert.equal(stored?.state, OutboundRequestState.Succeeded);
        assert.deepEqual(JSON.parse(stored!.result!), answer);
        assert.deepEqual(
          completed(await h.perform(merged, mergeBody("merge"))),
          answer,
        );
        assert.equal(await remoteHead(h.pushed.bare, MAIN_REF), head);
        assert.equal(h.materials.length, before + TWO_SSH_RELEASES);
        dropped(h.materials);
        assert.deepEqual(h.pins(merged), [h.sshRevision(FIRST_REVISION)]);
      },
    );

    await t.test(
      "a merge push on a gitlab binding answers a branch_push address",
      async () => {
        const authorize = h.fixture.mission.authorizeFrozenAction;
        h.fixture.mission.authorizeFrozenAction = (...args) => ({
          ...authorize.apply(h.fixture.mission, args),
          platform: GITLAB_PLATFORM,
        });
        let answer: Answer;
        try {
          answer = completed(await h.perform(merged, mergeBody("gitlab")));
        } finally {
          h.fixture.mission.authorizeFrozenAction = authorize;
        }
        assert.deepEqual(answer, {
          kind: PlatformAddressKind.BranchPush,
          resource_identity: h.resource("pushed"),
          branch: "main",
          commit: await remoteHead(h.pushed.bare, MAIN_REF),
        });
        const stored = h.row("gitlab");
        assert.equal(stored?.operation, OutboundOperation.GitMergePush);
        assert.equal(stored?.state, OutboundRequestState.Succeeded);
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

    await t.test(
      "a revoked pinned SSH revision refuses before any git call and records no request",
      async () => {
        await h.read([
          "repository",
          "credential",
          "ssh-key-rotate",
          FAKE_SSH_CREDENTIAL,
          "--expected-revision",
          String(FIRST_REVISION),
        ]);
        await h.read([
          "repository",
          "credential",
          "revoke",
          FAKE_SSH_CREDENTIAL,
          String(FIRST_REVISION),
        ]);
        const writer = h.fixture.gitWriter;
        const mergePushFresh = writer.mergePushFresh;
        let pushes = 0;
        writer.mergePushFresh = (...args) => {
          pushes += ONE_PUSH;
          return mergePushFresh(...args);
        };
        try {
          failed(
            await h.perform(merged, mergeBody("revoked")),
            HttpStatus.Conflict,
            SSH_REVISION_REVOKED,
          );
        } finally {
          writer.mergePushFresh = mergePushFresh;
        }
        assert.equal(pushes, NO_PUSHES);
        assert.equal(h.row("revoked"), undefined);
        assert.deepEqual(h.pins(merged), [h.sshRevision(FIRST_REVISION)]);
      },
    );
  },
);

suite(
  "intake action perform landings",
  { concurrency: SUITE_CONCURRENCY },
  () => {
    test(
      "intake.action.perform reuses a pull request by a push of the snapshot",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t);
        const G = h.nodes.gated;
        const nodeRef = `refs/heads/kanthord/${G}`;
        const bare = simpleGit(h.gated.bare);
        const open = () =>
          h.gitHub.open({
            owner: "owner",
            repo: "gated",
            head: `kanthord/${G}`,
            base: "main",
          });
        const address = (number: number): PlatformAddress => ({
          kind: PlatformAddressKind.PullRequest,
          resource_identity: h.resource("gated"),
          number,
        });
        const first = await h.evaluated(G, "gated", h.gated.head);
        const closed = open();
        const closedEvidence = await h.requested(
          G,
          first,
          "gated.pull_request",
          address(closed),
        );
        await until(() => readOf(h.gitHub.calls, closed), t.signal);
        h.gitHub.close(closed);
        await h.write(["mission", "node", "check", G], {
          expected_mission_version: await h.version(),
        });
        await h.write(["mission", "node", "unblock", G], {
          blocked_attempt: FIRST_ATTEMPT,
          expected_revision: FIRST_REVISION,
          expected_mission_version: await h.version(),
        });
        const snapshot = await commitOnBranch(t, h.gated.bare, SNAPSHOT_BRANCH);
        const second = await h.evaluated(G, "gated", snapshot);
        assert.equal(second.attempt, SECOND_ATTEMPT);
        const later = open();
        const laterEvidence = await h.request(
          G,
          second,
          "gated.pull_request",
          address(later),
        );
        const keyOf = (number: number) =>
          `${G}/${SECOND_ATTEMPT}/gated.pull_request/${number}/${snapshot}`;
        const body = (requestKey: string) => ({
          key: "gated.pull_request",
          commit: snapshot,
          request_key: requestKey,
        });
        const writer = h.fixture.gitWriter;
        const pushSnapshotFresh = writer.pushSnapshotFresh;
        const landedOn = writer.landedOn;
        const pushes: string[] = [];
        const landings: string[] = [];
        writer.pushSnapshotFresh = (input, ...args) => {
          pushes.push(input.branch);
          return pushSnapshotFresh(input, ...args);
        };
        writer.landedOn = async (input, ...args) => {
          try {
            const landing = await landedOn(input, ...args);
            landings.push(landing.landed ? LANDED : NOT_LANDED);
            return landing;
          } catch (error) {
            landings.push(THREW);
            throw error;
          }
        };
        const refusal = (answer: Answer) => {
          assert.ok("class" in answer, JSON.stringify(answer));
          assert.equal(answer.class, ResultClass.UnknownOutcome);
          assert.equal(answer.code, GIT_FAILED_CODE);
        };

        await t.test(
          "a reuse pushes the snapshot to the node branch and answers the reused address",
          async () => {
            assert.equal(await remoteHead(h.gated.bare, nodeRef), null);
            const calls = h.gitHub.calls.length;
            const released = h.materials.length;
            const answer = completed(
              await h.perform(second, body(keyOf(closed)), closedEvidence),
            );
            assert.deepEqual(answer, address(closed));
            assert.equal(await remoteHead(h.gated.bare, nodeRef), snapshot);
            assert.deepEqual(pushes, [`kanthord/${G}`]);
            const stored = h.row(keyOf(closed));
            assert.equal(
              stored?.operation,
              OutboundOperation.GitHubPullRequest,
            );
            assert.equal(stored?.state, OutboundRequestState.Succeeded);
            assert.equal(stored?.credential, null);
            assert.deepEqual(JSON.parse(stored!.result!), answer);
            assert.equal(h.gitHub.calls.length, calls);
            assert.equal(h.materials.length, released + ONE_SSH_RELEASE);
            dropped(h.materials);
          },
        );

        await t.test(
          "a candidate change with one snapshot gives two keys and two requests",
          async () => {
            const answer = completed(
              await h.perform(second, body(keyOf(later)), laterEvidence),
            );
            assert.deepEqual(answer, address(later));
            assert.deepEqual(
              h
                .rows()
                .filter(
                  (item) =>
                    item.operation === OutboundOperation.GitHubPullRequest,
                )
                .map((item) => item.request_key),
              [keyOf(closed), keyOf(later)],
            );
            assert.equal(pushes.length, TWO_PUSHES);
          },
        );

        await t.test(
          "a landed push that loses its answer repeats to the reused address with one push",
          async () => {
            await bare.raw(["update-ref", "-d", nodeRef]);
            const before = pushes.length;
            writer.pushSnapshotFresh = async (input, ...args) => {
              pushes.push(input.branch);
              await pushSnapshotFresh(input, ...args);
              throw new GitWriteError(
                GitStage.Push,
                new Diagnostic(GIT_FAILED_CODE, "The push answer is lost."),
              );
            };
            try {
              refusal(
                completed(
                  await h.perform(second, body("lost"), closedEvidence),
                ),
              );
            } finally {
              writer.pushSnapshotFresh = (input, ...args) => {
                pushes.push(input.branch);
                return pushSnapshotFresh(input, ...args);
              };
            }
            assert.equal(h.row("lost")?.state, OutboundRequestState.Failed);
            assert.deepEqual(
              completed(await h.perform(second, body("lost"), closedEvidence)),
              address(closed),
            );
            assert.equal(pushes.length, before + ONE_PUSH);
            assert.equal(landings.at(-1), LANDED);
            assert.equal(h.row("lost")?.state, OutboundRequestState.Succeeded);
            assert.equal(await remoteHead(h.gated.bare, nodeRef), snapshot);
          },
        );

        await t.test(
          "a push-stage failure answers unknown_outcome with git_failed and records no credential",
          async () => {
            await bare.raw(["update-ref", "-d", nodeRef]);
            const hook = join(h.gated.bare, "hooks", "pre-receive");
            writeFileSync(hook, REJECTING_HOOK, { mode: EXECUTABLE_MODE });
            try {
              refusal(
                completed(
                  await h.perform(second, body("rejected"), closedEvidence),
                ),
              );
            } finally {
              rmSync(hook);
            }
            assert.equal(await remoteHead(h.gated.bare, nodeRef), null);
            const stored = h.row("rejected");
            assert.equal(stored?.state, OutboundRequestState.Failed);
            assert.equal(stored?.credential, null);
            dropped(h.materials);
          },
        );

        await t.test(
          "a rebased node branch without the snapshot keeps the request failed",
          async () => {
            await bare.raw(["update-ref", nodeRef, h.gated.head]);
            refusal(
              completed(
                await h.perform(second, body("rejected"), closedEvidence),
              ),
            );
            assert.equal(landings.at(-1), NOT_LANDED);
            assert.equal(h.row("rejected")?.state, OutboundRequestState.Failed);
          },
        );

        await t.test(
          "a missing commit object throws and keeps the request failed",
          async () => {
            await bare.raw([
              "update-ref",
              "-d",
              `refs/heads/${SNAPSHOT_BRANCH}`,
            ]);
            await bare.raw(["reflog", "expire", "--expire=now", "--all"]);
            await bare.raw(["gc", "--prune=now"]);
            refusal(
              completed(
                await h.perform(second, body("rejected"), closedEvidence),
              ),
            );
            assert.equal(landings.at(-1), THREW);
            assert.equal(h.row("rejected")?.state, OutboundRequestState.Failed);
          },
        );

        await t.test(
          "a transport failure of the landing read throws and keeps the request failed",
          async () => {
            rmSync(h.gated.bare, { recursive: true, force: true });
            refusal(
              completed(
                await h.perform(second, body("rejected"), closedEvidence),
              ),
            );
            assert.equal(landings.at(-1), THREW);
            assert.equal(h.row("rejected")?.state, OutboundRequestState.Failed);
            writer.pushSnapshotFresh = pushSnapshotFresh;
            writer.landedOn = landedOn;
          },
        );
      },
    );

    test(
      "intake.action.perform uses the node branch of the claim after a restart from the base branch",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t);
        const G = h.nodes.gated;
        const earlierBranch = `kanthord/${G}`;
        const restartBranch = `kanthord/${G}-a2`;
        const address = (number: number): PlatformAddress => ({
          kind: PlatformAddressKind.PullRequest,
          resource_identity: h.resource("gated"),
          number,
        });
        const first = await h.evaluated(G, "gated", h.gated.head);
        assert.equal(first.node_branch, earlierBranch);
        const closed = h.gitHub.open({
          owner: "owner",
          repo: "gated",
          head: earlierBranch,
          base: "main",
        });
        const closedEvidence = await h.requested(
          G,
          first,
          "gated.pull_request",
          address(closed),
        );
        await until(() => readOf(h.gitHub.calls, closed), t.signal);
        h.gitHub.close(closed);
        await h.write(["mission", "node", "check", G], {
          expected_mission_version: await h.version(),
        });
        await h.write(["mission", "node", "unblock", G], {
          blocked_attempt: FIRST_ATTEMPT,
          expected_revision: FIRST_REVISION,
          expected_mission_version: await h.version(),
          start_point: StartPoint.BaseBranch,
        });
        const snapshot = await commitOnBranch(t, h.gated.bare, SNAPSHOT_BRANCH);
        const second = await h.evaluated(G, "gated", snapshot);
        assert.equal(second.attempt, SECOND_ATTEMPT);
        assert.equal(second.node_branch, restartBranch);
        const body = (requestKey: string) => ({
          key: "gated.pull_request",
          commit: snapshot,
          request_key: requestKey,
        });

        await t.test(
          "the create and its read-back name the restart branch",
          async () => {
            h.gitHub.dropNextAfterApply();
            completed(await h.perform(second, body("create")));
            const found = completed(await h.perform(second, body("create")));
            const pull = h.gitHub.pulls.at(-1);
            assert.ok(pull);
            assert.equal(pull.head, restartBranch);
            assert.deepEqual(found, address(pull.number));
            assert.ok(
              h.gitHub.calls
                .filter(
                  (call) =>
                    call.method === HttpMethod.Post && call.path === PULLS_PATH,
                )
                .every(
                  (call) =>
                    (call.body as { head: string }).head === restartBranch,
                ),
            );
          },
        );

        await t.test(
          "the reuse push and its read-back name the restart branch",
          async () => {
            const writer = h.fixture.gitWriter;
            const pushSnapshotFresh = writer.pushSnapshotFresh;
            const landedOn = writer.landedOn;
            const branches: string[] = [];
            writer.pushSnapshotFresh = (input, ...args) => {
              branches.push(input.branch);
              return pushSnapshotFresh(input, ...args);
            };
            writer.landedOn = (input, ...args) => {
              branches.push(input.branch);
              return landedOn(input, ...args);
            };
            try {
              assert.deepEqual(
                completed(
                  await h.perform(second, body("reuse"), closedEvidence),
                ),
                address(closed),
              );
            } finally {
              writer.pushSnapshotFresh = pushSnapshotFresh;
              writer.landedOn = landedOn;
            }
            assert.ok(branches.length > NO_ROWS);
            assert.ok(branches.every((branch) => branch === restartBranch));
            assert.equal(
              await remoteHead(h.gated.bare, `refs/heads/${restartBranch}`),
              snapshot,
            );
            assert.equal(
              await remoteHead(h.gated.bare, `refs/heads/${earlierBranch}`),
              null,
            );
          },
        );
      },
    );

    test(
      "intake.action.perform creates a pull request for a kanthord landing without merging",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t, KANTHORD_LANDING);
        const G = h.nodes.gated;
        const execution = await h.evaluated(G, "gated", h.gatedSnapshot);
        const body = (requestKey: string) => ({
          key: "gated.pull_request",
          commit: h.gatedSnapshot,
          request_key: requestKey,
        });
        const merges = () =>
          h.gitHub.calls.filter((call) => call.method === HttpMethod.Put);
        let created: PlatformAddress | null = null;

        await t.test("a kanthord create sends no PUT", async () => {
          const answer = completed(await h.perform(execution, body("create")));
          assert.ok("kind" in answer, JSON.stringify(answer));
          assert.equal(answer.kind, PlatformAddressKind.PullRequest);
          created = answer;
          assert.equal(h.row("create")?.state, OutboundRequestState.Succeeded);
          assert.equal(merges().length, NO_ROWS);
          assert.equal(h.gitHub.pulls.at(-1)?.merged, false);
        });

        await t.test(
          "a reuse pushes the snapshot with no credential and sends no PUT",
          async () => {
            assert.ok(created?.kind === PlatformAddressKind.PullRequest);
            const evidence = await h.request(
              G,
              execution,
              "gated.pull_request",
              created,
            );
            const mergesBefore = merges().length;
            const answer = completed(
              await h.perform(execution, body("reuse"), evidence),
            );
            assert.deepEqual(answer, created);
            assert.equal(h.row("reuse")?.credential, null);
            assert.equal(merges().length, mergesBefore);
            assert.equal(h.gitHub.pulls.at(-1)?.merged, false);
            dropped(h.materials);
          },
        );
      },
    );

    test(
      "intake.action.perform merges the pull request for a kanthord landing",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t, KANTHORD_LANDING);
        const G = h.nodes.gated;
        const execution = await h.evaluated(G, "gated", h.gatedSnapshot);
        const mergeBody = (requestKey: string) => ({
          key: "gated.pull_request",
          commit: h.gatedSnapshot,
          request_key: requestKey,
        });
        const merges = () =>
          h.gitHub.calls.filter((call) => call.method === HttpMethod.Put);
        let evidenceId!: string;

        await t.test("setup: create and record evidence", async () => {
          const answer = completed(
            await h.perform(execution, mergeBody("create")),
          );
          assert.ok("kind" in answer, JSON.stringify(answer));
          assert.equal(answer.kind, PlatformAddressKind.PullRequest);
          evidenceId = await h.request(
            G,
            execution,
            "gated.pull_request",
            answer,
          );
        });

        await t.test("a mismatched evidence is refused", async () => {
          failed(
            await h.perform(
              execution,
              mergeBody("mismatch"),
              null,
              `evidence_${ulid()}`,
            ),
            HttpStatus.Forbidden,
            MissionErrorCode.AuthorizationRefused,
          );
        });

        await t.test("a 405 sets failed", async () => {
          h.gitHub.refuseMerge(MERGE_REFUSED_STATUS);
          let answer: Answer;
          try {
            answer = completed(
              await h.perform(
                execution,
                mergeBody("refused"),
                null,
                evidenceId,
              ),
            );
          } finally {
            h.gitHub.refuseMerge(null);
          }
          assert.ok("class" in answer, JSON.stringify(answer));
          assert.equal(answer.class, ResultClass.FinalRefusal);
          assert.equal(h.row("refused")?.state, OutboundRequestState.Failed);
          dropped(h.materials);
        });

        await t.test(
          "a pending merge whose pull request merged at the tested head sets succeeded with one PUT",
          async () => {
            const mergesBefore = merges().length;
            const realMerge = h.fixture.github.mergePullRequest.bind(
              h.fixture.github,
            );
            h.fixture.github.mergePullRequest = async (...args) => {
              const result = await realMerge(...args);
              if (!result.ok) throw new Error("dropped merge");
              return result;
            };
            h.gitHub.dropNextAfterApply();
            try {
              failed(
                await h.perform(
                  execution,
                  mergeBody("pending"),
                  null,
                  evidenceId,
                ),
                HttpStatus.InternalServerError,
                UNKNOWN_CODE,
              );
            } finally {
              h.fixture.github.mergePullRequest = realMerge;
            }
            assert.equal(h.row("pending")?.state, OutboundRequestState.Pending);
            const lastMerge = merges().at(-1);
            assert.deepEqual(lastMerge?.body, {
              sha: h.gatedSnapshot,
              merge_method: "merge",
            });
            assert.equal(merges().length, mergesBefore + ONE_CREATE);
            const answer = completed(
              await h.perform(
                execution,
                mergeBody("pending"),
                null,
                evidenceId,
              ),
            );
            assert.ok("kind" in answer, JSON.stringify(answer));
            assert.equal(
              h.row("pending")?.state,
              OutboundRequestState.Succeeded,
            );
            assert.equal(merges().length, mergesBefore + ONE_CREATE);
            dropped(h.materials);
          },
        );

        await t.test("a repeat of succeeded makes no call", async () => {
          const callsBefore = h.gitHub.calls.length;
          const answer = completed(
            await h.perform(execution, mergeBody("pending"), null, evidenceId),
          );
          assert.ok("kind" in answer, JSON.stringify(answer));
          assert.equal(h.gitHub.calls.length, callsBefore);
        });
      },
    );

    test(
      "intake.action.perform: a pending merge at another head stays unresolved",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t, KANTHORD_LANDING);
        const G = h.nodes.gated;
        const execution = await h.evaluated(G, "gated", h.gatedSnapshot);
        const mergeBody = (requestKey: string) => ({
          key: "gated.pull_request",
          commit: h.gatedSnapshot,
          request_key: requestKey,
        });
        const answer = completed(
          await h.perform(execution, mergeBody("create")),
        );
        assert.ok("kind" in answer, JSON.stringify(answer));
        const evidenceId = await h.request(
          G,
          execution,
          "gated.pull_request",
          answer,
        );
        const realMerge = h.fixture.github.mergePullRequest.bind(
          h.fixture.github,
        );
        h.fixture.github.mergePullRequest = async (...args) => {
          const result = await realMerge(...args);
          if (!result.ok) throw new Error("dropped merge");
          return result;
        };
        h.gitHub.mergeAtOtherHead(OTHER_MERGE_SHA);
        h.gitHub.dropNextAfterApply();
        try {
          failed(
            await h.perform(
              execution,
              mergeBody("other-head"),
              null,
              evidenceId,
            ),
            HttpStatus.InternalServerError,
            UNKNOWN_CODE,
          );
        } finally {
          h.fixture.github.mergePullRequest = realMerge;
        }
        assert.equal(h.row("other-head")?.state, OutboundRequestState.Pending);
        const readBack = completed(
          await h.perform(execution, mergeBody("other-head"), null, evidenceId),
        );
        assert.ok("class" in readBack, JSON.stringify(readBack));
        assert.equal(readBack.class, ResultClass.UnknownOutcome);
        assert.equal(h.row("other-head")?.state, OutboundRequestState.Pending);
      },
    );

    test(
      "a pull request whose base branch contains the snapshot opens no pull request and answers the branch push address of the oldest first-parent commit",
      { timeout: TIMEOUT },
      async (t) => {
        const h = await setup(t);
        const merge = await mergeIntoMain(t, h.gated.bare, "snapshot");
        const execution = await h.evaluated(
          h.nodes.gated,
          "gated",
          h.gatedSnapshot,
        );
        const answer = completed(
          await h.perform(execution, {
            key: "gated.pull_request",
            commit: h.gatedSnapshot,
            request_key: "contained",
          }),
        );
        const landed = {
          kind: PlatformAddressKind.BranchPush,
          resource_identity: h.resource("gated"),
          branch: "main",
          commit: merge,
        } as const;
        assert.deepEqual(answer, landed);
        assert.equal(
          h.gitHub.calls.filter((call) => call.method === HttpMethod.Post)
            .length,
          NO_ROWS,
        );
        assert.equal(h.row("contained")?.state, OutboundRequestState.Succeeded);
        const evidenceId = await h.request(
          h.nodes.gated,
          execution,
          "gated.pull_request",
          landed,
        );
        assert.deepEqual(completed(await h.check(evidenceId)), {
          end_state: CheckEndState.Expected,
          landed_commits: [merge],
        });
      },
    );
  },
);
