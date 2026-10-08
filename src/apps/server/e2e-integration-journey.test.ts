import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  Consumer,
  InboundKind,
  InboundPlatform,
} from "../../intake/contract.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { isString } from "../../kernel/values.ts";
import { type Revision } from "../../mission/contract.ts";
import {
  FAKE_SSH_IDENTITY,
  bareRepository,
  fakeGitHub,
  fakeS3,
  gatewayFixture,
  mappedTransport,
} from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  createCredentials,
  pushNodeBranch,
  repositoryBinding,
} from "./cli-support.ts";

const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const WORKER_INSTANCE_COUNT = 1;
const POLL_INTERVAL_MS = 50;
const JOURNEY_TIMEOUT = 120000;
const SECRET = "test-secret";
const STORAGE_SECRET = "e2e-journey-storage-secret";
const PROJECT_NAME = "journey";
const GATED = "gated";
const MERGE = "merge";
const GATED_RESOURCE = "owner/gated";
const MERGE_RESOURCE = "owner/merge";
const WEBHOOK_CAPABILITY = "webhook";
const POLL_CAPABILITY = "poll acquisition";
const REGION = "eu-central-1";
const STORAGE_PREFIX = "kanthord";
const CONTENT = {
  name: "Ship accounts",
  requirement: "Ship accounts",
  criterion: "Accounts ship",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };

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
  const { read, secrets } = h.session;
  const clean = (value: unknown) => {
    const text = isString(value) ? value : JSON.stringify(value);
    for (const secret of secrets) assert.ok(!text.includes(secret));
  };
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
  return {
    read,
    clean,
    health,
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
});
