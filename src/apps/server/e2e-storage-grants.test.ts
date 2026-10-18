import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { writeFile } from "node:fs/promises";
import { httpClient } from "../../gateway/client.ts";
import { background } from "../../kernel/context.ts";
import { diagnostic } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import {
  IntakeErrorCode,
  OutboundRequestState,
} from "../../intake/contract.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  AssetKind,
  MissionErrorCode,
  missionOperations,
  Intent,
  type EvidenceAsset,
  type Revision,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  FAKE_SSH_IDENTITY,
  fakeS3,
  gatewayFixture,
} from "./test-support.ts";
import { environment, generateMachineToken, kanthord } from "./cli-support.ts";
import { uploadEvidence } from "../worker/evidence-upload.ts";
import { httpTransport } from "../worker/transport.ts";

const INITIAL_SEQUENCE = 0;
const SUCCESSFUL_EXIT = 0;
const FIRST_INDEX = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const WORKER_INSTANCE_COUNT = 1;
const OUTBOUND_ROWS_PER_DELETE = 1;
const PRESIGN_LIFETIME_MS = 60 * 60 * 1000;
const TIMEOUT = 180000;
const OBJECT_SIZE = 5;
const FIRST_BODY = "hello";
const SECOND_BODY = "world";
const FIRST_VERSION = "v1";
const SECOND_VERSION = "v2";
const MEDIA = "text/plain";
const REGION = "eu-central-1";
const PREFIX = "kanthord";
const SECOND_BUCKET = "second";
const NO_OUTPUT = "";
const SECRET_ACCESS_KEY = "e2e-storage-secret";
const GITHUB_SECRET = "test-secret";
const SIGNATURE_PARAMETER = "X-Amz-Signature";
const DELETE_OPERATION = "s3.delete_object";
const ROUTE_NOT_FOUND = "gateway.routing.not_found";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONTENT = {
  name: "Store evidence",
  requirement: "Store evidence",
  criterion: "Evidence stored",
  verifications: ["true"],
  bindings: [],
};
type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Upload = {
  asset_id: string;
  put_url: string;
  headers: Record<string, string>;
  expires_at: number;
};
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

async function cli(t: TestContext, endpoint: string, token: string) {
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: endpoint,
    KANTHORD_TOKEN: token,
  };
  const secrets = [SECRET_ACCESS_KEY, GITHUB_SECRET, token];
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
  assert.ok(endpoint && token);
  return { H, secrets, read, write };
}

async function setup(t: TestContext) {
  const s3 = await fakeS3(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const { H, secrets, read, write } = await cli(
    t,
    fixture.endpoint,
    fixture.token,
  );
  await write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: { endpoint: s3.endpoint, bucket: s3.bucket, region: REGION },
    secret: {
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: SECRET_ACCESS_KEY,
    },
  });
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: GITHUB_SECRET },
  });
  await write(["repository", "credential", "create"], FAKE_SSH_CREDENTIAL_BODY);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "storage",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const missionVersion = async () =>
    (await read<{ version: number }>(["mission", "get", project.id])).version;
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          strategy: { base_branch: "main" },
          ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
          credential: "github",
        },
      },
      store: {
        kind: "storage",
        config: {
          available: true,
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          region: REGION,
          prefix: PREFIX,
          credential: "store",
        },
      },
      "store-b": {
        kind: "storage",
        config: {
          available: true,
          endpoint: s3.endpoint,
          bucket: SECOND_BUCKET,
          region: REGION,
          prefix: PREFIX,
          credential: "store",
        },
      },
      harness: {
        kind: "worker",
        config: {
          worker: "claude-code@1",
          instance_count: WORKER_INSTANCE_COUNT,
        },
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
    intent: Intent,
    names: string[],
    dependentId?: string,
  ) => {
    const result = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        content: {
          ...CONTENT,
          intent,
          bindings: names.map((name) => binding(name).id),
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: await missionVersion(),
      },
    );
    const nodeId = result.revisions[FIRST_INDEX]!.node_id;
    if (dependentId)
      await write(["mission", "dependency", "add", dependentId, nodeId], {
        reason: "plan",
        expected_mission_version: await missionVersion(),
      });
    return nodeId;
  };
  const E = await create("examine-1.md", Intent.Examine, []);
  const A = await create(
    "implement-a.md",
    Intent.Implement,
    ["repo", "store", "store-b"],
    E,
  );
  const token = (
    await generateMachineToken({
      env: H,
      masterKey: fixture.config.master_key,
      projectId: project.id,
      bindingName: "harness",
      name: "Harness",
    })
  ).token;
  secrets.push(token);
  const T = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: rid } = await read<{ runtime_identity: string }>(
    ["worker", "register"],
    T,
  );
  const pulled = await write<{ kind: string; execution: ExecutionRecord }>(
    ["scheduler", "work", "pull"],
    {
      resource_identity: binding("harness").resource_identity,
      runtime_identity: rid,
    },
    T,
  );
  assert.equal(pulled.kind, WorkPullKind.Claimed);
  assert.equal(pulled.execution.node_id, A);
  return {
    s3,
    fixture,
    H,
    T,
    token,
    secrets,
    read,
    write,
    missionVersion,
    projectId: project.id,
    missionId: mission.id,
    A,
    storeId: binding("store").id,
    x: pulled.execution,
    api: httpClient(missionOperations, fixture.endpoint, token),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function journey(h: Harness) {
  const ctx = () => ({
    execution_id: h.x.execution_id,
    attempt: FIRST_ATTEMPT,
    node_revision: h.x.pinned_revision,
  });
  const submit = () =>
    h.api["evidence.submit"](
      {
        params: { node_id: h.A },
        query: {},
        body: {
          ...ctx(),
          subject: "hello object",
          assets: [
            { kind: AssetKind.Object, media_type: MEDIA, size: OBJECT_SIZE },
          ],
        },
      },
      { idempotencyKey: ulid() },
    );
  const complete = (assetId: string) =>
    h.api["evidence.asset.complete"](
      { params: { asset_id: assetId }, query: {}, body: ctx() },
      { idempotencyKey: ulid() },
    );
  const prefix = `${PREFIX}/${h.projectId}/${h.missionId}/${h.A}/${FIRST_ATTEMPT}/`;
  const objectUrl = (key: string) =>
    `${h.s3.endpoint}/${h.s3.bucket}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  assert.ok(h.A && h.x.execution_id);
  return { submit, complete, prefix, objectUrl };
}

async function directGet(h: Harness, assetId: string, token: string) {
  const response = await fetch(
    new URL(`/api/intake/storage/asset/${assetId}`, h.fixture.endpoint),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(body.error.code, ROUTE_NOT_FOUND);
}

test("E04 storage grants CLI journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const j = journey(h);
  let upload!: Upload;
  let key = "";

  await t.test("E04.1 an object submit answers a presigned PUT", async () => {
    const before = Date.now();
    const answer = completed(await j.submit());
    upload = answer.uploads[FIRST_INDEX]!;
    assert.ok(
      upload.put_url.startsWith(`${h.s3.endpoint}/${h.s3.bucket}/${j.prefix}`),
      upload.put_url,
    );
    assert.ok(new URL(upload.put_url).searchParams.has(SIGNATURE_PARAMETER));
    assert.ok(upload.expires_at > before);
    assert.ok(upload.expires_at <= Date.now() + PRESIGN_LIFETIME_MS);
    key = `${j.prefix}${upload.asset_id}`;
  });
  await t.test("EF03.9 the asset pins the first storage binding", async () => {
    const page = await h.read<Page<{ assets: EvidenceAsset[] }>>([
      "mission",
      "evidence",
      "list",
      h.A,
    ]);
    const asset = page.items
      .flatMap((item) => item.assets)
      .find((item) => item.id === upload.asset_id);
    assert.ok(asset?.kind === AssetKind.Object, JSON.stringify(page));
    assert.equal(asset.storage_binding_id, h.storeId);
  });
  await t.test("E04.2 a complete before the PUT mismatches", async () => {
    const result = await j.complete(upload.asset_id);
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.status, HttpStatus.Conflict);
    assert.equal(
      result.error.error.code,
      IntakeErrorCode.StorageObjectMismatch,
    );
  });
  await t.test("E04.3 the PUT and the complete publish v1", async () => {
    const put = await fetch(upload.put_url, {
      method: HttpMethod.Put,
      headers: upload.headers,
      body: FIRST_BODY,
    });
    assert.equal(put.status, HttpStatus.OK);
    await put.arrayBuffer();
    const answer = completed(await j.complete(upload.asset_id));
    assert.equal(
      answer.uri,
      `s3://${h.s3.bucket}/${j.prefix}${upload.asset_id}`,
    );
    const stored = h.s3.objects(key);
    assert.deepEqual(
      stored.map((item) => item.version),
      [FIRST_VERSION],
    );
  });
  await t.test(
    "E04.4 the content read signs v1 after a second PUT",
    async () => {
      const put = await fetch(j.objectUrl(key), {
        method: HttpMethod.Put,
        headers: { Authorization: "AWS4-HMAC-SHA256 e2e" },
        body: SECOND_BODY,
      });
      assert.equal(put.status, HttpStatus.OK);
      await put.arrayBuffer();
      const answer = await h.read<{ get_url: string }>([
        "mission",
        "evidence",
        "asset",
        "content",
        "get",
        upload.asset_id,
      ]);
      assert.equal(
        new URL(answer.get_url).searchParams.get("versionId"),
        FIRST_VERSION,
      );
      const response = await fetch(answer.get_url);
      assert.equal(response.status, HttpStatus.OK);
      assert.equal(await response.text(), FIRST_BODY);
    },
  );
  await t.test("E04.5 the asset delete removes v1 only", async () => {
    const M = await h.missionVersion();
    const result = await kanthord(
      [
        "mission",
        "evidence",
        "asset",
        "delete",
        upload.asset_id,
        "--force",
        "--reason",
        "e2e",
        "--expected-mission-version",
        String(M),
      ],
      h.H,
    );
    assert.equal(result.code, SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    assert.ok(!result.stdout.includes(SIGNATURE_PARAMETER));
    const answer = JSON.parse(result.stdout) as { idempotency_key: string };
    assert.match(answer.idempotency_key, ULID_PATTERN);
    assert.deepEqual(
      h.s3.objects(key).map((item) => item.version),
      [SECOND_VERSION],
    );
  });
  await t.test("E04.6 the delete records one outbound request", async () => {
    const page = await h.read<Page<Outbound>>([
      "intake",
      "outbound",
      "list",
      "--operation",
      DELETE_OPERATION,
    ]);
    assert.equal(page.items.length, OUTBOUND_ROWS_PER_DELETE);
    const [row] = page.items;
    assert.equal(row!.state, OutboundRequestState.Succeeded);
    assert.equal(row!.request_key, upload.asset_id);
    assert.equal(row!.project_id, h.projectId);
    assert.deepEqual(row!.result, {
      location: `s3://${h.s3.bucket}/${key}`,
      version: FIRST_VERSION,
    });
  });
  await t.test("E04.7 the direct storage GET has no route", async () => {
    await directGet(h, upload.asset_id, h.token);
    await directGet(h, upload.asset_id, h.fixture.token);
  });
  await t.test("E04.8 the release ends the execution", async () => {
    const released = await h.write<{ ended_at: number }>(
      ["scheduler", "execution", "release", h.x.execution_id],
      { further_work: true },
      h.T,
    );
    assert.ok(Number.isInteger(released.ended_at));
    for (const line of h.fixture.logs) {
      for (const secret of h.secrets) assert.ok(!line.includes(secret));
      assert.ok(!line.includes(SIGNATURE_PARAMETER));
    }
  });
});

const FAILED_PUT_STATUS = 500;
const EVIDENCE_FILE = "evidence.txt";

function failoverBindings(
  bucket: string,
  primary: string,
  secondary: string,
  available: boolean,
) {
  const storage = (endpoint: string, enabled: boolean) => ({
    kind: "storage",
    config: {
      available: enabled,
      endpoint,
      bucket,
      region: REGION,
      prefix: PREFIX,
      credential: "store",
    },
  });
  return {
    repo: {
      kind: "repository",
      config: {
        available: true,
        platform: "github",
        address: "git@github.com:owner/repo.git",
        strategy: { base_branch: "main" },
        ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
        credential: "github",
      },
    },
    primary: storage(primary, available),
    secondary: storage(secondary, true),
    harness: {
      kind: "worker",
      config: {
        worker: "claude-code@1",
        instance_count: WORKER_INSTANCE_COUNT,
      },
    },
  };
}

async function failoverSetup(t: TestContext) {
  const primary = await fakeS3(t);
  const secondary = await fakeS3(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  const { H, read, write } = await cli(t, fixture.endpoint, fixture.token);
  await write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: {
      endpoint: primary.endpoint,
      bucket: primary.bucket,
      region: REGION,
    },
    secret: {
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: SECRET_ACCESS_KEY,
    },
  });
  await write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: GITHUB_SECRET },
  });
  await write(["repository", "credential", "create"], FAKE_SSH_CREDENTIAL_BODY);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "failover",
  ]);
  const mission = await read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  const apply = async (available: boolean) => {
    const { binding_set_version: version } = await read<{
      binding_set_version: number;
    }>(["project", "get", project.id]);
    await write(["project", "binding", "apply", project.id], {
      version,
      bindings: failoverBindings(
        primary.bucket,
        primary.endpoint,
        secondary.endpoint,
        available,
      ),
    });
  };
  await apply(true);
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
  const created = await write<{ revisions: Revision[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "implement-a.md",
      content: {
        ...CONTENT,
        intent: Intent.Implement,
        bindings: ["repo", "primary", "secondary"].map(
          (name) => binding(name).id,
        ),
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  const nodeId = created.revisions[FIRST_INDEX]!.node_id;
  const token = (
    await generateMachineToken({
      env: H,
      masterKey: fixture.config.master_key,
      projectId: project.id,
      bindingName: "harness",
      name: "Harness",
    })
  ).token;
  const T = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: rid } = await read<{ runtime_identity: string }>(
    ["worker", "register"],
    T,
  );
  const pulled = await write<{ kind: string; execution: ExecutionRecord }>(
    ["scheduler", "work", "pull"],
    {
      resource_identity: binding("harness").resource_identity,
      runtime_identity: rid,
    },
    T,
  );
  assert.equal(pulled.kind, WorkPullKind.Claimed);
  assert.equal(pulled.execution.node_id, nodeId);
  const workspace = temporary(t);
  await writeFile(join(workspace, EVIDENCE_FILE), FIRST_BODY);
  const upload = () =>
    uploadEvidence({
      workspace,
      path: EVIDENCE_FILE,
      claim: pulled.execution,
      api: httpTransport(fixture.endpoint, token),
      context: background,
    });
  const pinnedOf = async (assetId: string) => {
    const page = await read<Page<{ assets: EvidenceAsset[] }>>([
      "mission",
      "evidence",
      "list",
      nodeId,
    ]);
    const asset = page.items
      .flatMap((item) => item.assets)
      .find((item) => item.id === assetId);
    assert.ok(asset?.kind === AssetKind.Object, JSON.stringify(page));
    assert.notEqual(asset.published_at, null);
    return asset.storage_binding_id;
  };
  const failures = () =>
    fixture.store.database
      .prepare(
        "SELECT storage_binding_id FROM mission_evidence_upload_failure WHERE node_id = ? ORDER BY failed_at",
      )
      .all(nodeId)
      .map((row) => row.storage_binding_id);
  return {
    primary,
    secondary,
    read,
    apply,
    upload,
    pinnedOf,
    failures,
    primaryId: binding("primary").id,
    secondaryId: binding("secondary").id,
  };
}

test("EF03b storage failover journey", { timeout: TIMEOUT }, async (t) => {
  const h = await failoverSetup(t);
  let recovered = "";

  await t.test("EF03b.1 a disabled primary pins secondary", async () => {
    await h.apply(false);
    const result = await h.upload();
    assert.equal(await h.pinnedOf(result.asset_id), h.secondaryId);
    assert.deepEqual(h.failures(), []);
    await h.apply(true);
  });
  await t.test("EF03b.2 a primary with no object pins secondary", async () => {
    h.primary.failNext(FAILED_PUT_STATUS);
    const result = await h.upload();
    assert.ok(result.uri.startsWith(`s3://${h.secondary.bucket}/${PREFIX}/`));
    assert.equal(await h.pinnedOf(result.asset_id), h.secondaryId);
    assert.deepEqual(h.failures(), [h.primaryId]);
    recovered = result.asset_id;
  });
  await t.test(
    "EF03b.3 a failed secondary after a failed primary exhausts the storage",
    async () => {
      const primaryPuts = () =>
        h.primary.calls.filter((call) => call.method === HttpMethod.Put).length;
      const before = primaryPuts();
      h.secondary.failNext(FAILED_PUT_STATUS);
      const failure = await h.upload().then(
        () => assert.fail("The upload publishes."),
        (error: unknown) => error,
      );
      assert.ok(
        diagnostic(failure).startsWith(
          `${MissionErrorCode.EvidenceStorageExhausted}:`,
        ),
        diagnostic(failure),
      );
      assert.deepEqual(h.failures(), [h.primaryId, h.secondaryId]);
      assert.equal(primaryPuts(), before);
    },
  );
  await t.test(
    "EF03b.4 the read of a failed-over asset uses secondary",
    async () => {
      const answer = await h.read<{ get_url: string }>([
        "mission",
        "evidence",
        "asset",
        "content",
        "get",
        recovered,
      ]);
      assert.ok(
        answer.get_url.startsWith(
          `${h.secondary.endpoint}/${h.secondary.bucket}/`,
        ),
        answer.get_url,
      );
      const response = await fetch(answer.get_url);
      assert.equal(response.status, HttpStatus.OK);
      assert.equal(await response.text(), FIRST_BODY);
    },
  );
});
