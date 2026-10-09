import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssetKind,
  Disposition,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
  Resolution,
  missionOperations,
  type Evidence,
  type ExternalAction,
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
  fakeGitHub,
  gatewayFixture,
  mappedTransport,
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
} from "./cli-support.ts";

const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const FIRST_PULL_REQUEST = 1;
const UNMATCHED_PULL_REQUEST = 9;
const SHARED_PULL_REQUEST = 7;
const ISSUE_NUMBER = 3;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 300000;
const SECRET = "test-secret";
const GATED = "gated";
const GATED_KEY = "gated.pull_request";
const GATED_RESOURCE = "repository:github:owner/gated";
const RESOURCE = "owner/gated";
const MERGED_COMMIT = "e".repeat(40);
const SERVICE_MISMATCH = "service_mismatch";
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
type Check = { results: { resolution: string }[]; failures: unknown[] };
type Webhook = { event: string; payload: unknown };

function issue(): Webhook {
  return {
    event: "issues",
    payload: {
      action: "opened",
      issue: { number: ISSUE_NUMBER },
      repository: { full_name: RESOURCE },
    },
  };
}

function closed(number: number, merged: boolean): Webhook {
  return {
    event: "pull_request",
    payload: {
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    },
  };
}

async function cli(t: TestContext) {
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
  return { t, gitHub, gatedBare, fixture, session, ...session };
}

type Cli = Awaited<ReturnType<typeof cli>>;

async function project(c: Cli) {
  await createCredentials(c.session, SECRET);
  const created = await c.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "admission",
  ]);
  const mission = await c.read<{ id: string }>(["mission", "get", created.id]);
  await c.write(["project", "binding", "apply", created.id], {
    version: FIRST_REVISION,
    bindings: {
      gated: repositoryBinding(GATED, "pull_request"),
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
      },
    },
  });
  const bindings = await c.read<Page<Binding>>([
    "project",
    "binding",
    "list",
    created.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((item) => item.name === name)!;
  assert.equal(binding(GATED).resource_identity, GATED_RESOURCE);
  return { projectId: created.id, missionId: mission.id, binding };
}

async function setup(t: TestContext) {
  const c = await cli(t);
  const { projectId, missionId, binding } = await project(c);
  const missionVersion = async () =>
    (await c.read<{ version: number }>(["mission", "get", projectId])).version;
  const create = async (filename: string, parentId?: string) => {
    const result = await c.write<{ revisions: Revision[] }>(
      ["mission", "node", "create", missionId],
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
  const machine = await cliMachine(c.session, {
    masterKey: c.fixture.config.master_key,
    projectId,
    resourceIdentity: binding("harness").resource_identity,
  });
  const { token, node, release } = machine;
  const objective = async (filename: string, parentId: string) => {
    const nodeId = await create(filename, parentId);
    const head = await pushNodeBranch(
      c.t,
      c.gatedBare.bare,
      nodeId,
      `${filename}\n`,
    );
    const x2 = await passingEvaluation(c.session, machine, {
      nodeId,
      bindingId: binding(GATED).id,
      commit: head,
    });
    return { nodeId, x2 };
  };
  const worker = httpClient(missionOperations, c.fixture.endpoint, token);
  const requestPullRequest = async (x: ExecutionRecord, number: number) =>
    completed(
      await worker["evidence.request"](
        {
          params: { node_id: x.node_id },
          query: {},
          body: {
            ...executionContext(x),
            requirement_key: GATED_KEY,
            subject: GATED_KEY,
            address: {
              kind: PlatformAddressKind.PullRequest,
              resource_identity: GATED_RESOURCE,
              number,
            },
          },
        },
        { idempotencyKey: ulid() },
      ),
    );
  const performer = httpClient(workerOperations, c.fixture.endpoint, token);
  const actionRequest = async (x: ExecutionRecord) =>
    completed(
      await performer["action.request"](
        { params: { execution_id: x.execution_id }, query: {}, body: null },
        { idempotencyKey: ulid() },
      ),
    );
  const check = async (nodeId: string) =>
    c.write<Check>(["mission", "node", "check", nodeId], {
      expected_mission_version: await missionVersion(),
    });
  const mission = directClient(missionOperations, c.fixture.invocation);
  const admit = (
    webhook: Webhook,
    inboundEventId: string,
    service = INTAKE_SERVICE_NAME,
  ) =>
    mission["delivery.admit"](
      {
        params: {},
        query: {},
        body: {
          inbound_event_id: inboundEventId,
          project_id: projectId,
          platform: "github",
          resource: RESOURCE,
          event: Buffer.from(JSON.stringify(webhook.payload)).toString(
            "base64",
          ),
          metadata: { event: webhook.event },
        },
      },
      { identity: mintServiceIdentity(service), idempotencyKey: ulid() },
    );
  return {
    ...c,
    create,
    objective,
    node,
    release,
    requestPullRequest,
    actionRequest,
    check,
    admit,
  };
}

test("E08 delivery admission journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const I = await h.create("initiative-1.md");
  const P = await h.objective("objective-p.md", I);
  const action = await h.actionRequest(P.x2);
  assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
  await h.release(P.x2.execution_id);
  assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  const check = await h.check(P.nodeId);
  assert.equal(check.results[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  const shared = [];
  for (const filename of ["objective-r.md", "objective-u.md"]) {
    const o = await h.objective(filename, I);
    const request = await h.requestPullRequest(o.x2, SHARED_PULL_REQUEST);
    assert.equal(request.requirement_key, GATED_KEY);
    await h.release(o.x2.execution_id);
    assert.equal((await h.node(o.nodeId)).state, NodeState.ExternalRequested);
    shared.push(o.nodeId);
  }
  const R = shared[FIRST_INDEX]!;

  await t.test("E08.1 an issue event is undecodable", async () => {
    const answer = completed(
      await h.admit(issue(), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Undecodable,
    });
  });
  await t.test("E08.2 an unknown pull request is unmatched", async () => {
    const answer = completed(
      await h.admit(
        closed(UNMATCHED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Unmatched,
    });
  });
  await t.test("E08.3 a failed platform read fails the admission", async () => {
    h.gitHub.failPulls(BAD_GATEWAY_STATUS);
    const result = await h.admit(
      closed(FIRST_PULL_REQUEST, true),
      createIdentity("inbound_event"),
    );
    h.gitHub.failPulls(null);
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.error.error.code, RETRYABLE_REFUSAL);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  });
  await t.test("E08.4 a merged pull request completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const i4 = createIdentity("inbound_event");
    const answer = completed(
      await h.admit(closed(FIRST_PULL_REQUEST, true), i4),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) => item.provenance.kind === ActorKind.Service,
    );
    assert.equal(landed.length, SINGLE_ITEM);
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: i4,
    });
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
  });
  await t.test("E08.5 a repeat event is a duplicate", async () => {
    const answer = completed(
      await h.admit(
        closed(FIRST_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Duplicate,
      reason: null,
    });
  });
  await t.test("E08.6 two requests of one address are ambiguous", async () => {
    const answer = completed(
      await h.admit(
        closed(SHARED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Ambiguous,
    });
    const actions = await h.read<Page<ExternalAction>>([
      "mission",
      "external-action",
      "list",
      R,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    assert.equal(actions.items[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  });
  await t.test("E08.7 a service other than intake is refused", async () => {
    const result = await h.admit(
      closed(SHARED_PULL_REQUEST, true),
      createIdentity("inbound_event"),
      MISSION_SERVICE_NAME,
    );
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.status, HttpStatus.Forbidden);
    assert.equal(
      result.error.error.code,
      MissionErrorCode.AuthorizationRefused,
    );
    assert.deepEqual(result.error.error.details, {
      reason: SERVICE_MISMATCH,
    });
  });
});
