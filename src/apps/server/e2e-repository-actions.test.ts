import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
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
  ActorKind,
  ActorService,
  AssessmentResult,
  AssetKind,
  NodeState,
  Resolution,
  type Evidence,
  type Revision,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  workerOperations,
  ActionResultKind,
  PlatformAddressKind,
} from "../../worker/contract.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  fakeGitHub,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { environment, generateMachineToken, kanthord } from "./cli-support.ts";

const INITIAL_SEQUENCE = 0;
const SUCCESSFUL_EXIT = 0;
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_CALL = 1;
const SINGLE_ITEM = 1;
const FIRST_PULL_REQUEST = 1;
const NO_OUTPUT = "";
const TIMEOUT = 180000;
const SECRET = "test-secret";
const GATED = "gated";
const MERGE = "merge";
const GATED_KEY = "gated.pull_request";
const MERGE_KEY = "merge.merge_push";
const GATED_RESOURCE = "repository:github:owner/gated";
const MERGE_RESOURCE = "repository:github:owner/merge";
const PULL_REQUEST_OPERATION = "github.pull_request";
const MERGE_PUSH_OPERATION = "git.merge_push";
const MAIN_REF = "refs/heads/main";
const MERGED_COMMIT = "e".repeat(40);
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Check = { results: { resolution: string }[]; failures: unknown[] };
type Outbound = {
  project_id: string;
  request_key: string;
  state: string;
  result: unknown;
};

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}

async function pushNodeBranch(
  t: TestContext,
  bare: string,
  nodeId: string,
  content: string,
) {
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", `kanthord/${nodeId}`]);
  writeFileSync(join(directory, "node.md"), content);
  await git.add("node.md");
  await git.commit(content);
  await git.push("origin", `kanthord/${nodeId}`);
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(await remoteHead(bare, `refs/heads/kanthord/${nodeId}`), head);
  return head;
}

async function setup(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const mergeBare = await bareRepository(t, MERGE);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({
      [`git@github.com:owner/${GATED}.git`]: gatedBare.bare,
      [`git@github.com:owner/${MERGE}.git`]: mergeBare.bare,
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
  const secrets = [SECRET, fixture.token];
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
    for (const secret of secrets) assert.ok(!result.stdout.includes(secret));
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: SECRET },
  });
  await write(["repository", "credential", "create"], FAKE_SSH_CREDENTIAL_BODY);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "actions",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const missionVersion = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  const repository = (name: string, action: string) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      strategy: {
        base_branch: "main",
        action: { name: action, follows: { type: "assessment_passed" } },
      },
      ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
      credential: "github",
    },
  });
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repository(GATED, "pull_request"),
      merge: repository(MERGE, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await read<Page<Binding>>([
    "project",
    "binding",
    "list",
    project.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((item) => item.name === name)!;
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    parentId?: string,
  ) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map((name) => binding(name).id),
        },
        reason: "plan",
        expected_mission_version: await missionVersion(),
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return result.revisions[FIRST_INDEX]!.node_id;
  };
  const I = await create("initiative-1.md", "initiative", []);
  const P = await create("objective-p.md", "objective", [GATED], I);
  const p = await pushNodeBranch(t, gatedBare.bare, P, "objective p\n");
  const token = generateMachineToken({
    env: H,
    masterKey: fixture.config.master_key,
    projectId: project.id,
    bindingName: "harness",
    name: "Harness",
  }).token;
  secrets.push(token);
  const T = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: rid } = await read<{ runtime_identity: string }>(
    ["worker", "register"],
    T,
  );
  const harness = binding("harness");
  const node = (nodeId: string) =>
    read<{ state: string }>(["mission", "node", "get", nodeId]);
  const pull = async (nodeId: string, state: string) => {
    const result = await write<{ kind: string; execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      { resource_identity: harness.resource_identity, runtime_identity: rid },
      T,
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.equal(result.execution.node_id, nodeId);
    assert.equal(result.execution.attempt, FIRST_ATTEMPT);
    assert.equal((await node(nodeId)).state, state);
    return result.execution;
  };
  const client = httpClient(workerOperations, fixture.endpoint, token);
  const request = async (execution: ExecutionRecord) =>
    completed(
      await client["action.request"](
        {
          params: { execution_id: execution.execution_id },
          query: {},
          body: null,
        },
        { idempotencyKey: ulid() },
      ),
    );
  const ctx = (execution: ExecutionRecord) => ({
    execution_id: execution.execution_id,
    attempt: FIRST_ATTEMPT,
    node_revision: execution.pinned_revision,
  });
  const snapshot = (bindingId: string, commit: string) => ({
    kind: "repository",
    binding_id: bindingId,
    commit,
  });
  const work = (x: ExecutionRecord, bindingId: string, commit: string) =>
    write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", x.node_id],
      {
        ...ctx(x),
        subject: "head commit",
        assets: [{ kind: "repository", address: snapshot(bindingId, commit) }],
      },
      T,
    );
  const run = (x: ExecutionRecord, bindingId: string, commit: string) =>
    write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", x.node_id],
      {
        ...ctx(x),
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
      T,
    );
  const pass = (
    x: ExecutionRecord,
    bindingId: string,
    commit: string,
    evidenceIds: string[],
  ) =>
    write<{ assessment: { result: string } }>(
      ["mission", "assessment", "submit", x.node_id],
      {
        ...ctx(x),
        evidence_ids: evidenceIds,
        child_outcome_ids: [],
        result: "success",
        rationale: "verified",
        tested_input: snapshot(bindingId, commit),
      },
      T,
    );
  const release = (executionId: string) =>
    write<{ ended_at: number }>(
      ["scheduler", "execution", "release", executionId],
      { further_work: false },
      T,
    );
  const passingEvaluation = async (
    nodeId: string,
    bindingId: string,
    commit: string,
  ) => {
    const x1 = await pull(nodeId, NodeState.Executing);
    const w1 = (await work(x1, bindingId, commit)).evidence;
    await release(x1.execution_id);
    const x2 = await pull(nodeId, NodeState.Evaluating);
    const r1 = (await run(x2, bindingId, commit)).evidence;
    const assessment = await pass(x2, bindingId, commit, [r1.id, w1.id]);
    assert.equal(assessment.assessment.result, AssessmentResult.Success);
    return x2;
  };
  const check = async (nodeId: string) =>
    write<Check>(["mission", "node", "check", nodeId], {
      expected_mission_version: await missionVersion(),
    });
  const outbound = (operation: string) =>
    read<Page<Outbound>>([
      "intake",
      "outbound",
      "list",
      "--operation",
      operation,
    ]);
  return {
    t,
    gitHub,
    creates,
    mergeBare,
    project,
    I,
    P,
    p,
    gated: binding(GATED),
    merge: binding(MERGE),
    read,
    create,
    node,
    request,
    release,
    passingEvaluation,
    check,
    outbound,
  };
}

test("E03 repository actions CLI journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  let e2: ExecutionRecord, e4: ExecutionRecord;
  let Q: string, q: string;

  await t.test("E03.1 P reaches a passing evaluation claim", async () => {
    e2 = await h.passingEvaluation(h.P, h.gated.id, h.p);
  });
  await t.test("E03.2 the action request opens a pull request", async () => {
    const result = await h.request(e2);
    const item = result.items[FIRST_INDEX];
    assert.ok(item?.kind === ActionResultKind.Submitted, JSON.stringify(item));
    const evidence = item.evidence as Evidence;
    assert.equal(evidence.requirement_key, GATED_KEY);
    assert.deepEqual(evidence.assets[FIRST_INDEX]?.address, {
      kind: PlatformAddressKind.PullRequest,
      resource_identity: GATED_RESOURCE,
      number: FIRST_PULL_REQUEST,
    });
    assert.equal(h.gated.resource_identity, GATED_RESOURCE);
    const posts = h.gitHub.calls.filter(
      (call) => call.method === HttpMethod.Post,
    );
    assert.equal(posts.length, SINGLE_CALL);
    const [create] = posts;
    assert.equal(create!.path, `/repos/owner/${GATED}/pulls`);
    assert.deepEqual(create!.body, {
      head: `kanthord/${h.P}`,
      base: "main",
      title: `kanthord ${h.P}`,
    });
    assert.equal(create!.token, SECRET);
  });
  await t.test("E03.3 the outbound request succeeded", async () => {
    const page = await h.outbound(PULL_REQUEST_OPERATION);
    assert.equal(page.items.length, SINGLE_ITEM);
    const [row] = page.items;
    assert.equal(row!.state, OutboundRequestState.Succeeded);
    assert.equal(row!.request_key, `${h.P}/${FIRST_ATTEMPT}/${GATED_KEY}`);
    assert.deepEqual(row!.result, {
      kind: PlatformAddressKind.PullRequest,
      number: FIRST_PULL_REQUEST,
      resource_identity: GATED_RESOURCE,
    });
    assert.equal(row!.project_id, h.project.id);
  });
  await t.test(
    "E03.4 a repeat creates nothing and the release waits externally",
    async () => {
      await h.request(e2);
      assert.equal(h.creates(), SINGLE_CALL);
      const released = await h.release(e2.execution_id);
      assert.ok(Number.isInteger(released.ended_at));
      assert.equal((await h.node(h.P)).state, NodeState.ExternalRequested);
    },
  );
  await t.test("E03.5 an open pull request stays unresolved", async () => {
    const answer = await h.check(h.P);
    assert.equal(
      answer.results[FIRST_INDEX]?.resolution,
      Resolution.Unresolved,
    );
    assert.deepEqual(answer.failures, []);
  });
  await t.test("E03.6 a merged pull request completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const answer = await h.check(h.P);
    assert.equal(
      answer.results[FIRST_INDEX]?.resolution,
      Resolution.ExpectedEnd,
    );
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      h.P,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) =>
        item.provenance.kind === ActorKind.Service &&
        item.provenance.service === ActorService.Mission,
    );
    assert.equal(landed.length, SINGLE_ITEM);
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
    assert.equal((await h.node(h.P)).state, NodeState.Completed);
  });
  await t.test("E03.7 a merge push lands Q on main", async () => {
    Q = await h.create("objective-q.md", "objective", [MERGE], h.I);
    q = await pushNodeBranch(h.t, h.mergeBare.bare, Q, "objective q\n");
    e4 = await h.passingEvaluation(Q, h.merge.id, q);
    const result = await h.request(e4);
    const c = await remoteHead(h.mergeBare.bare, MAIN_REF);
    assert.ok(c && c !== h.mergeBare.head);
    const item = result.items[FIRST_INDEX];
    assert.ok(item?.kind === ActionResultKind.Submitted, JSON.stringify(item));
    assert.deepEqual((item.evidence as Evidence).assets[FIRST_INDEX]?.address, {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: MERGE_RESOURCE,
      branch: "main",
      commit: c,
    });
    await h.release(e4.execution_id);
    const page = await h.outbound(MERGE_PUSH_OPERATION);
    assert.deepEqual(
      page.items.map((row) => [row.request_key, row.state]),
      [
        [
          `${Q}/${FIRST_ATTEMPT}/${MERGE_KEY}/${q}`,
          OutboundRequestState.Succeeded,
        ],
      ],
    );
    const parent = (
      await simpleGit(h.mergeBare.bare).raw(["rev-parse", `${c}^2`])
    ).trim();
    assert.equal(parent, q);
  });
  await t.test("E03.8 the landed merge push completes Q", async () => {
    const answer = await h.check(Q);
    assert.equal(
      answer.results[FIRST_INDEX]?.resolution,
      Resolution.ExpectedEnd,
    );
    assert.equal((await h.node(Q)).state, NodeState.Completed);
  });
});
