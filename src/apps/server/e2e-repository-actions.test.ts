import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { HttpMethod } from "../../kernel/http.ts";
import { OutboundRequestState } from "../../intake/contract.ts";
import {
  ActorKind,
  ActorService,
  AssetKind,
  NodeState,
  Resolution,
  type Evidence,
  type Revision,
} from "../../mission/contract.ts";
import { type ExecutionRecord } from "../../scheduler/contract.ts";
import {
  workerOperations,
  ActionResultKind,
  PlatformAddressKind,
} from "../../worker/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  fakeGitHub,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  completed,
  createCredentials,
  passingEvaluation,
  pushNodeBranch,
  repositoryBinding,
} from "./cli-support.ts";

const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const WORKER_INSTANCE_COUNT = 1;
const FIRST_ATTEMPT = 1;
const PULL_REQUEST_CREATES = 1;
const OUTBOUND_ROWS_PER_ACTION = 1;
const LANDED_EVIDENCE_COUNT = 1;
const FIRST_PULL_REQUEST = 1;
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
  const session = cliSession(t, fixture.endpoint, fixture.token, SECRET);
  const { read, write } = session;
  await createCredentials(session, SECRET);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "actions",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const missionVersion = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repositoryBinding(GATED, "pull_request"),
      merge: repositoryBinding(MERGE, "merge_push"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: WORKER_INSTANCE_COUNT },
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
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding("harness").resource_identity,
  });
  const client = httpClient(workerOperations, fixture.endpoint, machine.token);
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
  const evaluate = (nodeId: string, bindingId: string, commit: string) =>
    passingEvaluation(session, machine, { nodeId, bindingId, commit });
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
    node: machine.node,
    request,
    release: machine.release,
    passingEvaluation: evaluate,
    check,
    outbound,
  };
}

test("E03 repository actions CLI journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  let e2: ExecutionRecord;

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
    assert.equal(posts.length, PULL_REQUEST_CREATES);
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
    assert.equal(page.items.length, OUTBOUND_ROWS_PER_ACTION);
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
      assert.equal(h.creates(), PULL_REQUEST_CREATES);
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
    assert.equal(landed.length, LANDED_EVIDENCE_COUNT);
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
    assert.equal((await h.node(h.P)).state, NodeState.Completed);
  });
  const Q = await h.create("objective-q.md", "objective", [MERGE], h.I);
  const q = await pushNodeBranch(h.t, h.mergeBare.bare, Q, "objective q\n");
  const e4 = await h.passingEvaluation(Q, h.merge.id, q);
  await t.test("E03.7 a merge push lands Q on main", async () => {
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
