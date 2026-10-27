import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  missionOperations,
  Intent,
  type Revision,
} from "../../mission/contract.ts";
import { type ExecutionRecord } from "../../scheduler/contract.ts";
import {
  PlatformAddressKind,
  workerOperations,
} from "../../worker/contract.ts";
import {
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
import { createIdempotencyKey } from "../../kernel/identity.ts";

export const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const WORKER_INSTANCE_COUNT = 1;
const SECRET = "test-secret";
const GATED = "gated";
export const MERGE_KEY = "gated.merge_push";
const BASE_BRANCH = "main";
const PULL_REQUEST_ACTION = "pull_request";
export const GATED_KEY = "gated.pull_request";
const GATED_RESOURCE = "repository:github:owner/gated";
export const RESOURCE = "owner/gated";
const HARNESS_BINDING = {
  kind: "worker",
  config: {
    worker: "claude-code@1",
    instance_count: WORKER_INSTANCE_COUNT,
  },
};
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
export type Page<T> = { items: T[] };
type BindingSetApplied = { binding_set_version: number };
type Binding = { id: string; name: string; resource_identity: string };
type Check = { results: { resolution: string }[]; failures: unknown[] };
export type Webhook = { event: string; payload: unknown };

async function cli(t: TestContext, pollIntervalMs?: number) {
  const gitHub = await fakeGitHub(t);
  const gatedBare = await bareRepository(t, GATED);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
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

async function project(c: Cli, action: string, landing?: string) {
  await createCredentials(c.session, SECRET);
  const created = await c.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "admission",
  ]);
  const mission = await c.read<{ id: string }>(["mission", "get", created.id]);
  const applied = await c.write<BindingSetApplied>(
    ["project", "binding", "apply", created.id],
    {
      version: FIRST_REVISION,
      bindings: {
        gated: repositoryBinding(GATED, action, landing),
        harness: HARNESS_BINDING,
      },
    },
  );
  const bindings = await c.read<Page<Binding>>([
    "project",
    "binding",
    "list",
    created.id,
  ]);
  assert.equal(
    bindings.items.find((item) => item.name === GATED)?.resource_identity,
    GATED_RESOURCE,
  );
  return {
    projectId: created.id,
    missionId: mission.id,
    bindings,
    bindingSetVersion: applied.binding_set_version,
  };
}

export interface SetupOptions {
  pollIntervalMs?: number;
  action?: string;
  landing?: string;
}

export async function setup(t: TestContext, options: SetupOptions = {}) {
  const c = await cli(t, options.pollIntervalMs);
  const { projectId, missionId, ...applied } = await project(
    c,
    options.action ?? PULL_REQUEST_ACTION,
    options.landing,
  );
  let bindingSetVersion = applied.bindingSetVersion;
  let page = applied.bindings;
  const binding = (name: string) =>
    page.items.find((item) => item.name === name)!;
  const rebind = async (action: string) => {
    const next = await c.write<BindingSetApplied>(
      ["project", "binding", "apply", projectId],
      {
        version: bindingSetVersion,
        bindings: {
          gated: repositoryBinding(GATED, action),
          harness: HARNESS_BINDING,
        },
      },
    );
    bindingSetVersion = next.binding_set_version;
    page = await c.read<Page<Binding>>([
      "project",
      "binding",
      "list",
      projectId,
    ]);
  };
  const missionVersion = async () =>
    (await c.read<{ version: number }>(["mission", "get", projectId])).version;
  const create = async (filename: string, dependentId?: string) => {
    const result = await c.write<{ revisions: Revision[] }>(
      ["mission", "node", "create", missionId],
      {
        filename,
        content: {
          ...CONTENT,
          intent: dependentId ? Intent.Implement : Intent.Examine,
          bindings: dependentId ? [binding(GATED).id] : [],
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: await missionVersion(),
      },
    );
    const nodeId = result.revisions[FIRST_INDEX]!.node_id;
    if (dependentId)
      await c.write(["mission", "dependency", "add", dependentId, nodeId], {
        reason: "plan",
        expected_mission_version: await missionVersion(),
      });
    return nodeId;
  };
  const machine = await cliMachine(c.session, {
    masterKey: c.fixture.config.master_key,
    projectId,
    resourceIdentity: binding("harness").resource_identity,
  });
  const { token, node, release } = machine;
  const implement = async (
    filename: string,
    dependentId: string,
    opts?: {
      executing?: (execution: ExecutionRecord) => Promise<void>;
      afterSteps?: () => Promise<void>;
    },
  ) => {
    const nodeId = await create(filename, dependentId);
    const head = await pushNodeBranch(
      c.t,
      c.gatedBare.bare,
      nodeId,
      `${filename}\n`,
    );
    c.gitHub.branchHead(`kanthord/${nodeId}`, head);
    const x2 = await passingEvaluation(c.session, machine, {
      nodeId,
      bindingId: binding(GATED).id,
      commit: head,
      executing: opts?.executing,
      afterSteps: opts?.afterSteps,
    });
    return { nodeId, x2, head };
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
        { idempotencyKey: createIdempotencyKey() },
      ),
    );
  const requestMergePush = async (x: ExecutionRecord, commit: string) =>
    completed(
      await worker["evidence.request"](
        {
          params: { node_id: x.node_id },
          query: {},
          body: {
            ...executionContext(x),
            requirement_key: MERGE_KEY,
            subject: MERGE_KEY,
            address: {
              kind: PlatformAddressKind.BranchPush,
              resource_identity: GATED_RESOURCE,
              branch: BASE_BRANCH,
              commit,
            },
          },
        },
        { idempotencyKey: createIdempotencyKey() },
      ),
    );
  const performer = httpClient(workerOperations, c.fixture.endpoint, token);
  const actionRequest = async (x: ExecutionRecord) =>
    completed(
      await performer["action.request"](
        { params: { execution_id: x.execution_id }, query: {}, body: null },
        { idempotencyKey: createIdempotencyKey() },
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
      {
        identity: mintServiceIdentity(service),
        idempotencyKey: createIdempotencyKey(),
      },
    );
  const rework = (nodeId: string, commit: string) => {
    c.gitHub.branchHead(`kanthord/${nodeId}`, commit);
    return passingEvaluation(c.session, machine, {
      nodeId,
      bindingId: binding(GATED).id,
      commit,
    });
  };
  return {
    ...c,
    projectId,
    rebind,
    create,
    implement,
    node,
    release,
    requestPullRequest,
    requestMergePush,
    actionRequest,
    check,
    admit,
    rework,
  };
}
