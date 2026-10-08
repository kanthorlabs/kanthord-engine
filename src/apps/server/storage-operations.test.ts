import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Material } from "../../custody/contract.ts";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  IntakeErrorCode,
  PRESIGN_LIFETIME_S,
  READ_ANSWER_MARGIN_MS,
  ResultClass,
  intakeOperations,
} from "../../intake/contract.ts";
import {
  CancellationContext,
  background,
  type Context,
} from "../../kernel/context.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  AssetKind,
  MissionErrorCode,
  missionOperations,
  type Revision,
} from "../../mission/contract.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  fakeGitHub,
  gatewayFixture,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const SINGLE_INSTANCE = 1;
const NO_ROWS = 0;
const ONE_PIN = 1;
const MS_PER_S = 1000;
const LOST_DEADLINE_MS = 600;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 180000;
const BUCKET = "evidence";
const PREFIX = "kanthord";
const REGION = "eu-central-1";
const ACCESS_KEY_ID = "AKIASTORAGEOPERATIONS";
const SECRET = "storage-operations-secret";
const VERSION = "version-1";
const MEDIA = "text/plain";
const HELLO = Buffer.from("hello");
const WORLD = Buffer.from("world");
const SHORT = Buffer.from("hell");
const PLAIN = Buffer.from("abcde");
const HELLO_SHA256 = createHash("sha256").update(HELLO).digest("hex");
const SIGNATURE_PARAMETER = "X-Amz-Signature";
const VERSION_ID_PARAMETER = "versionId";
const CHECKSUM_MODE_HEADER = "x-amz-checksum-mode";
const CHECKSUM_MODE_ENABLED = "ENABLED";
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const S3_PREFIX = "storage.platform.s3.";
const CONTENT = {
  name: "Store objects",
  requirement: "Store objects",
  criterion: "Objects land",
  verifications: ["true"],
};
type Page<T> = { items: T[] };
type StoreCall = { method: string; path: string; version: string | null };
type Lose = "lose";
const LOSE: Lose = "lose";
const HEAD = "HEAD";

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
  return result.error.error;
}

async function objectStore(t: TestContext) {
  const objects = new Map<string, Buffer>();
  const calls: StoreCall[] = [];
  const script: { next: number | Lose | null } = { next: null };
  const answer = (request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    calls.push({
      method: request.method ?? "",
      path: url.pathname,
      version: url.searchParams.get(VERSION_ID_PARAMETER),
    });
    const scripted = script.next;
    if (scripted === LOSE) return null;
    if (scripted !== null) return { status: scripted, headers: {} };
    const bytes = objects.get(url.pathname);
    if (!bytes) return { status: HttpStatus.NotFound, headers: {} };
    const headers: Record<string, string> = {
      "content-length": String(bytes.byteLength),
      "x-amz-version-id": VERSION,
    };
    if (request.headers[CHECKSUM_MODE_HEADER] === CHECKSUM_MODE_ENABLED) {
      headers["x-amz-checksum-sha256"] = createHash("sha256")
        .update(bytes)
        .digest("base64");
      headers["x-amz-checksum-type"] = "FULL_OBJECT";
    }
    return { status: HttpStatus.OK, headers };
  };
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      const result = answer(request);
      if (result === null) {
        request.socket.destroy();
        return;
      }
      response.writeHead(result.status, result.headers);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    calls,
    script,
  };
}

async function setup(t: TestContext) {
  const store = await objectStore(t);
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
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
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await write(["repository", "credential", "create"], {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_rsa",
    },
    secret: {},
  });
  await write(["storage", "credential", "create"], {
    name: "store",
    platform: "s3",
    metadata: { endpoint: store.endpoint, bucket: BUCKET, region: REGION },
    secret: { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET },
  });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "storage",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          ssh_credential: "github-ssh",
          credential: "github",
          strategy: { base_branch: "main" },
        },
      },
      store: {
        kind: "storage",
        config: {
          available: true,
          endpoint: store.endpoint,
          bucket: BUCKET,
          region: REGION,
          prefix: PREFIX,
          credential: "store",
        },
      },
      harness: {
        kind: "worker",
        config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
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
  const create = async (
    filename: string,
    kind: string,
    names: string[],
    parentId?: string,
  ) => {
    const answer = await write<{ revisions: Revision[] }>(
      ["mission", "node", "create", mission.id],
      {
        filename,
        kind,
        content: {
          ...CONTENT,
          bindings: names.map((name) => binding(name).id),
        },
        reason: "plan",
        expected_mission_version: await version(),
        ...(parentId
          ? { parent_id: parentId, expected_parent_revision: FIRST_REVISION }
          : {}),
      },
    );
    return answer.revisions[FIRST_INDEX]!.node_id;
  };
  const initiative = await create("initiative.md", "initiative", []);
  const nodeId = await create(
    "objective.md",
    "objective",
    ["repo", "store"],
    initiative,
  );
  const token = await fixture.machineToken(project.id, "harness");
  const W = { ...H, KANTHORD_TOKEN: token };
  const { runtime_identity: runtimeIdentity } = await read<{
    runtime_identity: string;
  }>(["worker", "register"], W);
  const execution = (
    await write<{ execution: ExecutionRecord }>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: binding("harness").resource_identity,
        runtime_identity: runtimeIdentity,
      },
      W,
    )
  ).execution;
  assert.equal(execution.node_id, nodeId);
  assert.equal(execution.attempt, FIRST_ATTEMPT);
  const machine = await fixture.invocation.authentication.authenticate(
    `Bearer ${token}`,
  );
  const human = await fixture.invocation.authentication.authenticate(
    `Bearer ${fixture.token}`,
  );
  const api = httpClient(missionOperations, fixture.endpoint, token);
  const submitted = completed(
    await api["evidence.submit"]({
      params: { node_id: nodeId },
      query: {},
      body: {
        execution_id: execution.execution_id,
        attempt: execution.attempt,
        node_revision: execution.pinned_revision,
        subject: "objects",
        assets: [
          {
            kind: AssetKind.Object,
            size: HELLO.byteLength,
            media_type: MEDIA,
            sha256: HELLO_SHA256,
          },
          { kind: AssetKind.Object, size: PLAIN.byteLength, media_type: MEDIA },
        ],
      },
    }),
  );
  const keyOf = (assetId: string) =>
    [PREFIX, project.id, mission.id, nodeId, FIRST_ATTEMPT, assetId].join("/");
  const materials: Material[] = [];
  const releaseMaterial = fixture.custody.release.bind(fixture.custody);
  fixture.custody.release = (...args) => {
    const material = releaseMaterial(...args);
    materials.push(material);
    return material;
  };
  const pins = () =>
    fixture.store.transaction((tx) => {
      const found = tx.database
        .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
        .get(execution.execution_id) as { credentials: string };
      return JSON.parse(found.credentials) as string[];
    });
  const outboundCount = () =>
    fixture.store.transaction(
      (tx) =>
        (
          tx.database
            .prepare("SELECT COUNT(*) AS count FROM intake_outbound_request")
            .get() as { count: number }
        ).count,
    );
  const intake = directClient(intakeOperations, fixture.invocation);
  const executionId = execution.execution_id;
  return {
    fixture,
    store,
    token,
    project,
    nodeId,
    executionId,
    storageBindingId: binding("store").id,
    checked: submitted.uploads[FIRST_INDEX]!.asset_id,
    plain: submitted.uploads[SECOND_INDEX]!.asset_id,
    keyOf,
    materials,
    pins,
    outboundCount,
    put: (body: {
      node_id: string;
      asset_id: string;
      storage_binding_id: string;
      size: number;
      sha256: string | null;
    }) =>
      intake["storage.put"](
        { params: { execution_id: executionId }, query: {}, body },
        { identity: machine },
      ),
    check: (assetId: string, context?: Context) =>
      intake["storage.check"](
        {
          params: { execution_id: executionId, asset_id: assetId },
          query: {},
          body: null,
        },
        { identity: machine, ...(context ? { context } : {}) },
      ),
    executionGet: (assetId: string) =>
      intake["execution.storage.get"](
        {
          params: { execution_id: executionId, asset_id: assetId },
          query: {},
          body: null,
        },
        { identity: machine },
      ),
    get: (assetId: string) =>
      intake["storage.get"](
        { params: { asset_id: assetId }, query: {}, body: null },
        { identity: human },
      ),
    complete: (assetId: string) =>
      api["evidence.asset.complete"]({
        params: { asset_id: assetId },
        query: {},
        body: {
          execution_id: execution.execution_id,
          attempt: execution.attempt,
          node_revision: execution.pinned_revision,
        },
      }),
  };
}

function dropped(materials: Material[], count: number) {
  assert.equal(materials.length, count);
  for (const material of materials) assert.throws(() => material.value());
}

function assertWithinLifetime(expiresAt: number, before: number) {
  assert.ok(expiresAt >= before + PRESIGN_LIFETIME_S * MS_PER_S);
  assert.ok(expiresAt <= Date.now() + PRESIGN_LIFETIME_S * MS_PER_S);
}

test(
  "the presign and check operations reach the store through the direct adapter",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const urls: string[] = [];

    await t.test(
      "a PUT signs the server key of the claim attempt",
      async () => {
        const assetId = createIdentity("evidence_asset");
        const before = Date.now();
        const answer = completed(
          await h.put({
            node_id: h.nodeId,
            asset_id: assetId,
            storage_binding_id: h.storageBindingId,
            size: HELLO.byteLength,
            sha256: HELLO_SHA256,
          }),
        );
        urls.push(answer.put_url);
        const url = new URL(answer.put_url);
        assert.equal(url.origin, h.store.endpoint);
        assert.equal(url.pathname, `/${BUCKET}/${h.keyOf(assetId)}`);
        assert.ok(url.searchParams.get(SIGNATURE_PARAMETER));
        assert.equal(
          answer.headers["content-length"],
          String(HELLO.byteLength),
        );
        assert.equal(
          answer.headers["x-amz-checksum-sha256"],
          Buffer.from(HELLO_SHA256, "hex").toString("base64"),
        );
        assertWithinLifetime(answer.expires_at, before);
        assert.equal(h.pins().length, ONE_PIN);
        assert.deepEqual(h.store.calls, []);
        dropped(h.materials, 1);
      },
    );

    await t.test("a PUT of a recorded asset refuses", async () => {
      const before = h.materials.length;
      failed(
        await h.put({
          node_id: h.nodeId,
          asset_id: h.checked,
          storage_binding_id: h.storageBindingId,
          size: HELLO.byteLength,
          sha256: null,
        }),
        HttpStatus.Forbidden,
        MissionErrorCode.AuthorizationRefused,
      );
      assert.equal(h.materials.length, before);
    });

    await t.test("an absent object answers the mismatch", async () => {
      failed(
        await h.check(h.checked),
        HttpStatus.Conflict,
        IntakeErrorCode.StorageObjectMismatch,
      );
      const call = h.store.calls.at(-1);
      assert.equal(call?.method, HEAD);
      assert.equal(call?.path, `/${BUCKET}/${h.keyOf(h.checked)}`);
      assert.equal(call?.version, null);
    });

    await t.test(
      "a short object and a wrong checksum answer the mismatch",
      async () => {
        const path = `/${BUCKET}/${h.keyOf(h.checked)}`;
        for (const bytes of [SHORT, WORLD]) {
          h.store.objects.set(path, bytes);
          failed(
            await h.check(h.checked),
            HttpStatus.Conflict,
            IntakeErrorCode.StorageObjectMismatch,
          );
        }
      },
    );

    await t.test(
      "a matching object answers its location and version",
      async () => {
        h.store.objects.set(`/${BUCKET}/${h.keyOf(h.checked)}`, HELLO);
        h.store.objects.set(`/${BUCKET}/${h.keyOf(h.plain)}`, PLAIN);
        for (const assetId of [h.checked, h.plain])
          assert.deepEqual(completed(await h.check(assetId)), {
            location: `s3://${BUCKET}/${h.keyOf(assetId)}`,
            version: VERSION,
          });
      },
    );

    await t.test(
      "an execution GET and a human GET sign the object",
      async () => {
        const calls = h.store.calls.length;
        const before = Date.now();
        for (const answer of [
          completed(await h.executionGet(h.checked)),
          completed(await h.get(h.checked)),
        ]) {
          urls.push(answer.get_url);
          const url = new URL(answer.get_url);
          assert.equal(url.origin, h.store.endpoint);
          assert.equal(url.pathname, `/${BUCKET}/${h.keyOf(h.checked)}`);
          assert.ok(url.searchParams.get(SIGNATURE_PARAMETER));
          assertWithinLifetime(answer.expires_at, before);
        }
        assert.equal(h.store.calls.length, calls);
        assert.equal(h.pins().length, ONE_PIN);
      },
    );

    await t.test(
      "a check of a published asset answers its recorded version",
      async () => {
        const location = `s3://${BUCKET}/${h.keyOf(h.checked)}`;
        assert.equal(completed(await h.complete(h.checked)).uri, location);
        assert.deepEqual(completed(await h.check(h.checked)), {
          location,
          version: VERSION,
        });
        assert.equal(h.store.calls.at(-1)?.version, VERSION);
      },
    );

    await t.test("a refused HEAD answers its result class", async () => {
      h.store.script.next = HttpStatus.Forbidden;
      try {
        const error = failed(
          await h.check(h.checked),
          BAD_GATEWAY_STATUS,
          S3_PREFIX + ResultClass.FinalRefusal,
        );
        assert.deepEqual(error.details, { status: HttpStatus.Forbidden });
      } finally {
        h.store.script.next = null;
      }
    });

    await t.test(
      "a lost HEAD answer has no status before the caller deadline",
      async () => {
        const context = new CancellationContext(
          background,
          Date.now() + READ_ANSWER_MARGIN_MS + LOST_DEADLINE_MS,
        );
        h.store.script.next = LOSE;
        try {
          const error = failed(
            await h.check(h.checked, context),
            BAD_GATEWAY_STATUS,
            S3_PREFIX + ResultClass.RetryableRefusal,
          );
          assert.deepEqual(error.details, { status: null });
          assert.equal(context.err(), null);
        } finally {
          h.store.script.next = null;
          context.cancel();
        }
      },
    );

    await t.test("every released material drops", () => {
      assert.ok(h.materials.length > ONE_PIN);
      dropped(h.materials, h.materials.length);
    });

    await t.test("the HTTP adapter answers 404 for each path", async () => {
      const paths = [
        [
          HttpMethod.Post,
          `/api/intake/execution/${h.executionId}/storage/put`,
          h.token,
        ],
        [
          HttpMethod.Get,
          `/api/intake/execution/${h.executionId}/storage/asset/${h.checked}/check`,
          h.token,
        ],
        [
          HttpMethod.Get,
          `/api/intake/execution/${h.executionId}/storage/asset/${h.checked}`,
          h.token,
        ],
        [
          HttpMethod.Get,
          `/api/intake/storage/asset/${h.checked}`,
          h.fixture.token,
        ],
      ] as const;
      for (const [method, path, token] of paths) {
        const response = await h.fixture.request(path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(method === HttpMethod.Post ? { body: "{}" } : {}),
        });
        assert.equal(response.status, HttpStatus.NotFound, path);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, ROUTE_NOT_FOUND_CODE);
      }
    });

    await t.test("no log holds a presigned URL or the secret", () => {
      assert.ok(urls.length);
      for (const line of h.fixture.logs) {
        assert.ok(!line.includes(SECRET), line);
        assert.ok(!line.includes(SIGNATURE_PARAMETER), line);
        for (const url of urls) assert.ok(!line.includes(url), line);
      }
    });

    await t.test("no call records an outbound request", () => {
      assert.equal(h.outboundCount(), NO_ROWS);
    });
  },
);
