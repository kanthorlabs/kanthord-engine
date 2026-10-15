import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { missionOperations, type Revision } from "../../mission/contract.ts";
import { type ExecutionRecord } from "../../scheduler/contract.ts";
import {
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

export const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const WORKER_INSTANCE_COUNT = 1;
const SECRET = "test-secret";
const GATED = "gated";
export const GATED_KEY = "gated.pull_request";
const GATED_RESOURCE = "repository:github:owner/gated";
export const RESOURCE = "owner/gated";
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
export type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Check = { results: { resolution: string }[]; failures: unknown[] };
export type Webhook = { event: string; payload: unknown };

async function cli(t: TestContext, pollIntervalMs?: number) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    github: { baseUrl: gitHub.endpoint, mergeabilityRetryDelayMs: 1 },
    ...(pollIntervalMs === undefined ? {} : { intake: { pollIntervalMs } }),
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
        config: {
          worker: "claude-code@1",
          instance_count: WORKER_INSTANCE_COUNT,
        },
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

export async function setup(t: TestContext, pollIntervalMs?: number) {
  const c = await cli(t, pollIntervalMs);
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
    projectId,
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
