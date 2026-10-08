import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ActorKind,
  ActorService,
  AssetKind,
  NodeState,
  type Evidence,
  type Revision,
} from "../../mission/contract.ts";
import { type ExecutionRecord } from "../../scheduler/contract.ts";
import { ActionResultKind, workerOperations } from "../../worker/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  bareRepository,
  deliver,
  fakeGitHub,
  gatewayFixture,
  mappedTransport,
} from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  completed,
  createCredentials,
  kanthord,
  passingEvaluation,
  pushNodeBranch,
  repositoryBinding,
  until,
} from "./cli-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const FIRST_PULL_REQUEST = 1;
const SECOND_PULL_REQUEST = 2;
const SETTLED_COUNT = 3;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 300000;
const ROWS_TIMEOUT = 60000;
const SECRET = "test-secret";
const GATED = "gated";
const RESOURCE = "owner/gated";
const PULL_REQUEST_EVENT = "pull_request";
const MERGED_COMMIT = "e".repeat(40);
const RETRYABLE_REFUSAL = "repository.platform.github.retryable_refusal";
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Result = { code: number; stdout: string; stderr: string };
type ErrorItem = { code: string; message: string; created_at: number };
type Event = {
  id: string;
  event_id: string;
  state: string;
  error: ErrorItem[] | null;
};

function closed(number: number): string {
  return JSON.stringify({
    action: "closed",
    number,
    pull_request: { merged: true },
    repository: { full_name: RESOURCE },
  });
}

function refused(result: Result, code: string): void {
  assert.equal(result.code, ExitCode.Failure, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
}

async function setup(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: mappedTransport({
      [`git@github.com:owner/${GATED}.git`]: gatedBare.bare,
    }),
  });
  const session = cliSession(t, fixture.endpoint, fixture.token, SECRET);
  const { read, write } = session;
  await createCredentials(session, SECRET);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "handoff",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const missionVersion = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repositoryBinding(GATED, "pull_request"),
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
  const create = async (filename: string, parentId?: string) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind: parentId ? "objective" : "initiative",
        content: {
          ...CONTENT,
          bindings: parentId ? [binding(GATED).id] : [],
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
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding("harness").resource_identity,
  });
  const performer = httpClient(
    workerOperations,
    fixture.endpoint,
    machine.token,
  );
  const requested = async (filename: string, parentId: string) => {
    const nodeId = await create(filename, parentId);
    const head = await pushNodeBranch(t, gatedBare.bare, nodeId, filename);
    const x2: ExecutionRecord = await passingEvaluation(session, machine, {
      nodeId,
      bindingId: binding(GATED).id,
      commit: head,
    });
    const action = completed(
      await performer["action.request"](
        { params: { execution_id: x2.execution_id }, query: {}, body: null },
        { idempotencyKey: ulid() },
      ),
    );
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await machine.release(x2.execution_id);
    assert.equal(
      (await machine.node(nodeId)).state,
      NodeState.ExternalRequested,
    );
    return nodeId;
  };
  const I = await create("initiative-1.md");
  const P = await requested("objective-p.md", I);
  const P2 = await requested("objective-p2.md", I);
  const hook = join(temporary(t), "hook.json");
  writePrivate(
    hook,
    JSON.stringify({
      project_id: project.id,
      kind: InboundKind.Webhook,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      configuration: { resource: RESOURCE },
    }),
  );
  const W = (
    await read<{ id: string }>(["intake", "inbound", "create", "--file", hook])
  ).id;
  const S = (await read<{ secret: string }>(["intake", "inbound", "get", W]))
    .secret;
  return { gitHub, fixture, session, node: machine.node, P, P2, W, S };
}

test("E09 event handoff journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const { read, H } = h.session;
  const run = (args: string[]) => kanthord(args, H);
  const send = async (deliveryId: string, number: number) => {
    const delivered = await deliver(h.fixture, {
      inboundId: h.W,
      secret: h.S,
      event: PULL_REQUEST_EVENT,
      deliveryId,
      body: closed(number),
    });
    assert.equal(delivered.status, HttpStatus.Accepted);
  };
  const events = async () =>
    (await read<Page<Event>>(["intake", "event", "list", "--inbound", h.W]))
      .items;
  const ev = async (deliveryId: string) =>
    (
      await until(events, (items) =>
        items.some((item) => item.event_id === deliveryId),
      )
    ).find((item) => item.event_id === deliveryId)!.id;
  const get = (id: string) => read<Event>(["intake", "event", "get", id]);
  const settled = (id: string) =>
    until(
      () => get(id),
      (event) => event.state !== InboundEventState.Pending,
    );
  const nodeState = async (nodeId: string) => (await h.node(nodeId)).state;
  const landed = async () =>
    (
      await read<Page<Evidence>>([
        "mission",
        "evidence",
        "list",
        h.P,
        "--attempt",
        String(FIRST_ATTEMPT),
      ])
    ).items.filter(
      (item) =>
        item.provenance.kind === ActorKind.Service &&
        item.provenance.service === ActorService.Mission,
    );
  let release = () => {};
  t.after(() => release());

  await t.test("E09.1 to E09.8", { timeout: ROWS_TIMEOUT }, async () => {
    h.gitHub.failPulls(BAD_GATEWAY_STATUS);
    await send("d-1", FIRST_PULL_REQUEST);
    const E1 = await ev("d-1");
    const first = await settled(E1);
    assert.equal(first.state, InboundEventState.Failed);
    assert.ok(first.error);
    assert.equal(first.error.length, SINGLE_ITEM);
    assert.equal(first.error[FIRST_INDEX]!.code, RETRYABLE_REFUSAL);
    assert.equal(await nodeState(h.P), NodeState.ExternalRequested);

    const discarded = await read<Event>(["intake", "event", "discard", E1]);
    assert.equal(discarded.state, InboundEventState.Discarded);
    refused(
      await run(["intake", "event", "retry", E1]),
      IntakeErrorCode.InboundEventStateConflict,
    );

    h.gitHub.failPulls(null);
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    await send("d-2", FIRST_PULL_REQUEST);
    const E2 = await ev("d-2");
    const second = await settled(E2);
    assert.equal(second.state, InboundEventState.Succeeded);
    assert.equal(second.error, null);
    assert.equal(await nodeState(h.P), NodeState.Completed);
    const evidence = await landed();
    assert.equal(evidence.length, SINGLE_ITEM);
    assert.deepEqual(evidence[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: E2,
    });
    const asset = evidence[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);

    await send("d-3", FIRST_PULL_REQUEST);
    const E3 = await ev("d-3");
    const third = await settled(E3);
    assert.equal(third.state, InboundEventState.Succeeded);
    assert.equal(third.error, null);
    assert.equal((await landed()).length, SINGLE_ITEM);

    const before = h.gitHub.calls.length;
    release = h.gitHub.hold();
    await send("d-4", SECOND_PULL_REQUEST);
    await until(
      async () => h.gitHub.calls.slice(before),
      (calls) =>
        calls.some(
          (call) =>
            call.method === HttpMethod.Get &&
            call.path === `/repos/${RESOURCE}/pulls/${SECOND_PULL_REQUEST}`,
        ),
    );
    const E4 = await ev("d-4");
    refused(
      await run(["intake", "event", "discard", E4]),
      IntakeErrorCode.InboundEventInFlight,
    );
    release();
    const fourth = await settled(E4);
    assert.equal(fourth.state, InboundEventState.Succeeded);
    assert.equal(await nodeState(h.P2), NodeState.ExternalRequested);

    refused(
      await run([
        "intake",
        "event",
        "delete",
        "--state",
        InboundEventState.Pending,
        "--from",
        E1,
        "--to",
        E4,
      ]),
      IntakeErrorCode.InboundEventFilterInvalid,
    );
    refused(
      await run(["intake", "event", "delete"]),
      IntakeErrorCode.InboundEventFilterInvalid,
    );

    const ranged = await read<{ count: number }>([
      "intake",
      "event",
      "delete",
      "--state",
      InboundEventState.Succeeded,
      "--from",
      E1,
      "--to",
      E4,
    ]);
    assert.equal(ranged.count, SETTLED_COUNT);
    assert.deepEqual(
      (await events()).map((item) => [item.id, item.state]),
      [[E1, InboundEventState.Discarded]],
    );

    const calls = h.gitHub.calls.length;
    const listed = await read<{ count: number }>([
      "intake",
      "event",
      "delete",
      "--id",
      E1,
    ]);
    assert.equal(listed.count, SINGLE_ITEM);
    await read(["intake", "inbound", "delete", h.W]);
    assert.equal(h.gitHub.calls.length, calls);
  });
});
