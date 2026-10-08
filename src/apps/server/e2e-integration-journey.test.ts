import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  OutboundRequestState,
} from "../../intake/contract.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { isString } from "../../kernel/values.ts";
import {
  ActorKind,
  ActorService,
  AssessmentResult,
  AssetKind,
  NodeState,
  missionOperations,
  type Evidence,
  type Revision,
} from "../../mission/contract.ts";
import { type ExecutionRecord } from "../../scheduler/contract.ts";
import {
  ActionResultKind,
  PlatformAddressKind,
  workerOperations,
} from "../../worker/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  bareRepository,
  deliver,
  fakeGitHub,
  fakeS3,
  gatewayFixture,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  completed,
  createCredentials,
  executionContext,
  passingEvaluation,
  pushNodeBranch,
  repositoryBinding,
  repositorySnapshot,
  until,
} from "./cli-support.ts";

const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const WORKER_INSTANCE_COUNT = 1;
const SINGLE_ITEM = 1;
const FIRST_PULL_REQUEST = 1;
const POLL_INTERVAL_MS = 50;
const PASSING_EXIT_CODE = 0;
const JOURNEY_TIMEOUT = 120000;
const SECRET = "test-secret";
const STORAGE_SECRET = "e2e-journey-storage-secret";
const PROJECT_NAME = "journey";
const GATED = "gated";
const MERGE = "merge";
const GATED_RESOURCE = "owner/gated";
const MERGE_RESOURCE = "owner/merge";
const MERGE_IDENTITY = "repository:github:owner/merge";
const MAIN_BRANCH = "main";
const MAIN_REF = "refs/heads/main";
const MERGED_COMMIT = "e".repeat(40);
const PUSH_EVENT_ID = "500";
const MERGED_DELIVERY = "d-1";
const WEBHOOK_CAPABILITY = "webhook";
const POLL_CAPABILITY = "poll acquisition";
const REGION = "eu-central-1";
const STORAGE_PREFIX = "kanthord";
const OBJECT_BODY = "hello";
const OBJECT_MEDIA = "text/plain";
const SIGNATURE_PARAMETER = "X-Amz-Signature";
const PULL_REQUEST_OPERATION = "github.pull_request";
const MERGE_PUSH_OPERATION = "git.merge_push";
const DELETE_OBJECT_OPERATION = "s3.delete_object";
const EVENTS_PATH = /^\/repos\/owner\/merge\/events(\?|$)/;
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Event = { id: string; event_id: string; state: string; error: unknown };
type Outbound = { request_key: string; state: string; result: unknown };
type Stored = { evidenceId: string; assetId: string; key: string };

function closed(number: number): string {
  return JSON.stringify({
    action: "closed",
    number,
    pull_request: { merged: true },
    repository: { full_name: GATED_RESOURCE },
  });
}

async function setup(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const s3 = await fakeS3(t);
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
    intake: { pollIntervalMs: POLL_INTERVAL_MS },
  });
  const session = cliSession(t, fixture.endpoint, fixture.token, SECRET);
  const { read, write } = session;
  session.secrets.push(STORAGE_SECRET);
  await createCredentials(session, SECRET);
  await write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: { endpoint: s3.endpoint, bucket: s3.bucket, region: REGION },
    secret: { access_key_id: "AKIAEXAMPLE", secret_access_key: STORAGE_SECRET },
  });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    PROJECT_NAME,
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const missionVersion = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repositoryBinding(GATED, "pull_request"),
      merge: repositoryBinding(MERGE, "merge_push"),
      store: {
        kind: "storage",
        config: {
          available: true,
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          region: REGION,
          prefix: STORAGE_PREFIX,
          credential: "store",
        },
      },
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
  const binding = (name: string) => {
    const row = bindings.items.find((item) => item.name === name);
    assert.ok(row, name);
    return row;
  };
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
  const P = await create("objective-p.md", "objective", [GATED, "store"], I);
  const p = await pushNodeBranch(t, gatedBare.bare, P, "objective p\n");
  const inbound = async (kind: string, resource: string) => {
    const created = await write<{ id: string }>(
      ["intake", "inbound", "create"],
      {
        project_id: project.id,
        kind,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        ...(kind === InboundKind.Poll ? { credential: "github" } : {}),
        configuration: { resource },
      },
    );
    return { id: created.id, output: JSON.stringify(created) };
  };
  const W = await inbound(InboundKind.Webhook, GATED_RESOURCE);
  const S = (await read<{ secret: string }>(["intake", "inbound", "get", W.id]))
    .secret;
  assert.ok(!W.output.includes(S));
  session.secrets.push(S);
  const L = await inbound(InboundKind.Poll, MERGE_RESOURCE);
  const V = await inbound(InboundKind.Webhook, GATED_RESOURCE);
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding("harness").resource_identity,
  });
  session.secrets.push(machine.client_secret);
  return {
    t,
    gitHub,
    s3,
    gatedBare,
    mergeBare,
    fixture,
    session,
    machine,
    projectId: project.id,
    missionId: mission.id,
    missionVersion,
    create,
    I,
    P,
    p,
    W: W.id,
    S,
    L: L.id,
    V: V.id,
    gated: binding(GATED),
    merge: binding(MERGE),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function journey(h: Harness) {
  const { read, write, secrets } = h.session;
  const clean = (value: unknown) => {
    const text = isString(value) ? value : JSON.stringify(value);
    for (const secret of secrets) assert.ok(!text.includes(secret));
  };
  const performer = httpClient(
    workerOperations,
    h.fixture.endpoint,
    h.machine.token,
  );
  const api = httpClient(
    missionOperations,
    h.fixture.endpoint,
    h.machine.token,
  );
  const health = async () => {
    const response = await h.fixture.request(
      gatewayOperations.healthcheck.path,
      { headers: { authorization: `Bearer ${h.fixture.token}` } },
    );
    assert.equal(response.status, HttpStatus.OK);
    const text = await response.text();
    clean(text);
    return gatewayOperations.healthcheck.output.parse(JSON.parse(text));
  };
  const store = async (x: ExecutionRecord): Promise<Stored> => {
    const submitted = completed(
      await api["evidence.submit"](
        {
          params: { node_id: h.P },
          query: {},
          body: {
            ...executionContext(x),
            subject: "hello object",
            assets: [
              {
                kind: AssetKind.Object,
                media_type: OBJECT_MEDIA,
                size: OBJECT_BODY.length,
              },
            ],
          },
        },
        { idempotencyKey: ulid() },
      ),
    );
    const upload = submitted.uploads[FIRST_INDEX];
    assert.ok(upload);
    const prefix = `${STORAGE_PREFIX}/${h.projectId}/${h.missionId}/${h.P}/${FIRST_ATTEMPT}/`;
    assert.ok(
      upload.put_url.startsWith(`${h.s3.endpoint}/${h.s3.bucket}/${prefix}`),
    );
    clean(submitted);
    secrets.push(upload.put_url, SIGNATURE_PARAMETER);
    const put = await fetch(upload.put_url, {
      method: HttpMethod.Put,
      headers: upload.headers,
      body: OBJECT_BODY,
    });
    assert.equal(put.status, HttpStatus.OK);
    await put.arrayBuffer();
    const o = completed(
      await api["evidence.asset.complete"](
        {
          params: { asset_id: upload.asset_id },
          query: {},
          body: executionContext(x),
        },
        { idempotencyKey: ulid() },
      ),
    );
    clean(o);
    const key = `${prefix}${upload.asset_id}`;
    return { evidenceId: submitted.evidence.id, assetId: upload.asset_id, key };
  };
  const objective = async (
    nodeId: string,
    bindingId: string,
    commit: string,
    executing?: (x: ExecutionRecord) => Promise<void>,
  ) => {
    const e = await passingEvaluation(h.session, h.machine, {
      nodeId,
      bindingId,
      commit,
      executing,
    });
    const answer = completed(
      await performer["action.request"](
        { params: { execution_id: e.execution_id }, query: {}, body: null },
        { idempotencyKey: ulid() },
      ),
    );
    clean(answer);
    assert.equal(answer.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await h.machine.release(e.execution_id);
  };
  const outbound = async (operation: string) =>
    (
      await read<Page<Outbound>>([
        "intake",
        "outbound",
        "list",
        "--operation",
        operation,
      ])
    ).items;
  const events = async (inboundId: string) =>
    (
      await read<Page<Event>>([
        "intake",
        "event",
        "list",
        "--inbound",
        inboundId,
      ])
    ).items;
  const state = async (nodeId: string) => (await h.machine.node(nodeId)).state;
  const outcome = async (nodeId: string) => {
    const page = await read<Page<{ id: string }>>([
      "mission",
      "outcome",
      "list",
      nodeId,
    ]);
    assert.equal(page.items.length, SINGLE_ITEM);
    return page.items[FIRST_INDEX]!.id;
  };
  const submit = (nodeId: string, x: ExecutionRecord, body: object) =>
    write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", nodeId],
      { ...executionContext(x), ...body },
      h.machine.T,
    );
  return {
    read,
    write,
    clean,
    health,
    store,
    objective,
    outbound,
    events,
    state,
    outcome,
    submit,
  };
}

test("E10 integration journey", { timeout: JOURNEY_TIMEOUT }, async (t) => {
  const h = await setup(t);
  const j = journey(h);
  const inbounds = (poll: string) => ({
    [h.W]: {
      status: ResourceStatus.Unknown,
      capability: WEBHOOK_CAPABILITY,
    },
    [h.L]: { status: poll, capability: POLL_CAPABILITY },
    [h.V]: {
      status: ResourceStatus.Unknown,
      capability: WEBHOOK_CAPABILITY,
    },
  });
  let stored!: Stored;
  let Q = "";
  let c = "";

  await t.test(
    "EJ10.1 the health report holds the three inbounds",
    async () => {
      const report = await j.health();
      assert.deepEqual(
        report.services.intake.projects[PROJECT_NAME],
        inbounds(ResourceStatus.Healthy),
      );
      assert.equal(
        report.services.project.projects[PROJECT_NAME]?.[GATED]?.status,
        ResourceStatus.Healthy,
      );
    },
  );
  await t.test("EJ10.2 P opens a pull request", async () => {
    await j.objective(h.P, h.gated.id, h.p, async (x) => {
      stored = await j.store(x);
    });
    assert.equal(h.s3.objects(stored.key).length, SINGLE_ITEM);
    assert.equal(await j.state(h.P), NodeState.ExternalRequested);
    const rows = await j.outbound(PULL_REQUEST_OPERATION);
    assert.deepEqual(
      rows.map((row) => row.state),
      [OutboundRequestState.Succeeded],
    );
  });
  await t.test("EJ10.3 a merged pull request event completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const delivered = await deliver(h.fixture, {
      inboundId: h.W,
      secret: h.S,
      event: "pull_request",
      deliveryId: MERGED_DELIVERY,
      body: closed(FIRST_PULL_REQUEST),
    });
    assert.equal(delivered.status, HttpStatus.Accepted);
    j.clean(delivered.body);
    const items = await until(
      () => j.events(h.W),
      (list) =>
        list.some(
          (item) =>
            item.event_id === MERGED_DELIVERY &&
            item.state !== InboundEventState.Pending,
        ),
    );
    const E1 = items.find((item) => item.event_id === MERGED_DELIVERY)!;
    assert.equal(E1.state, InboundEventState.Succeeded);
    assert.equal(E1.error, null);
    assert.equal(await j.state(h.P), NodeState.Completed);
    const evidence = await j.read<Page<Evidence>>([
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
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: E1.id,
    });
  });
  await t.test("EJ10.4 a merge push lands Q on main", async () => {
    Q = await h.create("objective-q.md", "objective", [MERGE], h.I);
    const q = await pushNodeBranch(h.t, h.mergeBare.bare, Q, "objective q\n");
    await j.objective(Q, h.merge.id, q);
    const rows = await j.outbound(MERGE_PUSH_OPERATION);
    assert.equal(rows.length, SINGLE_ITEM);
    const [row] = rows;
    assert.equal(row!.state, OutboundRequestState.Succeeded);
    c = (row!.result as { commit: string }).commit;
    assert.deepEqual(row!.result, {
      kind: PlatformAddressKind.BranchPush,
      branch: MAIN_BRANCH,
      commit: c,
      resource_identity: MERGE_IDENTITY,
    });
    assert.equal(await remoteHead(h.mergeBare.bare, MAIN_REF), c);
  });
  await t.test("EJ10.5 a polled push event completes Q", async () => {
    h.gitHub.events("owner", MERGE, [
      {
        id: PUSH_EVENT_ID,
        type: "PushEvent",
        repo: { name: MERGE_RESOURCE },
        payload: { ref: MAIN_REF, head: c },
      },
    ]);
    const items = await until(
      () => j.events(h.L),
      (list) =>
        list.length === SINGLE_ITEM &&
        list[FIRST_INDEX]!.state !== InboundEventState.Pending,
    );
    assert.deepEqual(
      items.map((item) => [item.event_id, item.state]),
      [[PUSH_EVENT_ID, InboundEventState.Succeeded]],
    );
    assert.equal(await j.state(Q), NodeState.Completed);
  });
  await t.test("EJ10.6 the initiative assessment completes I", async () => {
    const g = await remoteHead(h.gatedBare.bare, MAIN_REF);
    assert.ok(g);
    const oP = await j.outcome(h.P);
    const oQ = await j.outcome(Q);
    const x = await h.machine.pull(h.I, NodeState.Executing);
    const rep = await j.submit(h.I, x, {
      subject: "report",
      assets: [
        {
          kind: "produced",
          content: {
            media_type: "text/markdown",
            encoding: "base64",
            data: Buffer.from("P and Q are complete.").toString("base64"),
          },
        },
      ],
    });
    await h.machine.release(x.execution_id);
    const x2 = await h.machine.pull(h.I, NodeState.Evaluating);
    const testedInput = [
      repositorySnapshot(h.gated.id, g),
      repositorySnapshot(h.merge.id, c),
    ];
    const ir = await j.submit(h.I, x2, {
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
        tested_input: testedInput,
        results: [
          {
            command: "true",
            exit_code: PASSING_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    });
    const assessed = await j.write<{
      node: { state: string };
      outcome: { result: string };
    }>(
      ["mission", "assessment", "submit", h.I],
      {
        ...executionContext(x2),
        evidence_ids: [ir.evidence.id, rep.evidence.id],
        child_outcome_ids: [oP, oQ],
        result: AssessmentResult.Success,
        rationale: "P and Q are complete.",
        tested_input: testedInput,
      },
      h.machine.T,
    );
    assert.equal(assessed.node.state, NodeState.Completed);
    assert.equal(assessed.outcome.result, AssessmentResult.Success);
    assert.equal(await j.state(h.I), NodeState.Completed);
  });
  await t.test(
    "EJ10.7 the health report keeps the inbound checks",
    async () => {
      const report = await j.health();
      assert.deepEqual(
        report.services.intake.projects[PROJECT_NAME],
        inbounds(ResourceStatus.Healthy),
      );
    },
  );
  await t.test("EJ10.8 the evidence delete removes the object", async () => {
    const M = await h.missionVersion();
    await j.read([
      "mission",
      "evidence",
      "delete",
      stored.evidenceId,
      "--force",
      "--reason",
      "journey",
      "--expected-mission-version",
      String(M),
    ]);
    const rows = await j.outbound(DELETE_OBJECT_OPERATION);
    assert.deepEqual(
      rows.map((row) => [row.request_key, row.state]),
      [[stored.assetId, OutboundRequestState.Succeeded]],
    );
    assert.deepEqual(h.s3.objects(stored.key), []);
  });
  await t.test(
    "EJ10.9 the inbound deletes empty the Intake report",
    async () => {
      const gitHubCalls = h.gitHub.calls.length;
      const s3Calls = h.s3.calls.length;
      for (const id of [h.W, h.L, h.V])
        await j.read(["intake", "inbound", "delete", id]);
      const deleteCalls = h.gitHub.calls
        .slice(gitHubCalls)
        .filter(
          (call) =>
            !(call.method === HttpMethod.Get && EVENTS_PATH.test(call.path)),
        );
      assert.deepEqual(deleteCalls, []);
      assert.equal(h.s3.calls.length, s3Calls);
      const report = await j.health();
      assert.deepEqual(report.services.intake.projects, {});
      for (const line of h.fixture.logs) j.clean(line);
    },
  );
});
