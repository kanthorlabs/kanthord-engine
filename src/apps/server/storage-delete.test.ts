import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
  intakeOperations,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
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
  objectSink,
  sinkStorage,
} from "./test-support.ts";

const SUCCESSFUL_EXIT = 0;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const FIRST_INDEX = 0;
const SINGLE_INSTANCE = 1;
const SINGLE_ROW = 1;
const STORE_CREDENTIAL = "store";
const ASSET_COUNT = 6;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 180000;
const BUCKET = "evidence";
const PREFIX = "kanthord";
const REGION = "eu-central-1";
const ACCESS_KEY_ID = "AKIASTORAGEDELETE";
const SECRET = "storage-delete-secret";
const MEDIA = "text/plain";
const HELLO = Buffer.from("hello");
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const S3_PREFIX = "storage.platform.s3.";
const DELETE = "DELETE";
const HEAD = "HEAD";
const CONTENT = {
  name: "Delete objects",
  requirement: "Delete objects",
  criterion: "Objects go",
  verifications: ["true"],
};
type Page<T> = { items: T[] };
type StoreCall = { method: string; path: string };
type Lose = "lose";
const LOSE: Lose = "lose";
type OutboundRow = {
  operation: string;
  request_key: string;
  state: string;
  credential: string | null;
  result: string | null;
};

function failed<T>(result: OperationResult<T>, status: number, code: string) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  return result.error.error;
}

function deleted(result: OperationResult<null>) {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.NoContent);
  assert.equal(result.data, null);
}

async function objectStore(t: TestContext) {
  const objects = new Set<string>();
  const calls: StoreCall[] = [];
  const script: { next: number | Lose | null } = { next: null };
  const answer = (request: IncomingMessage) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "";
    calls.push({ method, path });
    const scripted = script.next;
    if (scripted === LOSE) return null;
    if (scripted !== null) return scripted;
    if (method === DELETE) {
      objects.delete(path);
      return HttpStatus.NoContent;
    }
    return objects.has(path) ? HttpStatus.OK : HttpStatus.NotFound;
  };
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      const status = answer(request);
      if (status === null) {
        request.socket.destroy();
        return;
      }
      response.writeHead(status, { "content-length": "0" });
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
  return { endpoint: `http://127.0.0.1:${port}`, objects, calls, script };
}

async function setup(t: TestContext) {
  const store = await objectStore(t);
  const sink = await objectSink(t);
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
    standIns: { intakeStorage: sinkStorage(sink) },
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
    name: STORE_CREDENTIAL,
    platform: "s3",
    metadata: { endpoint: store.endpoint, bucket: BUCKET, region: REGION },
    secret: { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET },
  });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "delete",
  ]);
  const mission = await read<{ id: string }>(["mission", "get", project.id]);
  const applyBindings = (version: number, available: boolean) =>
    write(["project", "binding", "apply", project.id], {
      version,
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
            available,
            endpoint: store.endpoint,
            bucket: BUCKET,
            region: REGION,
            prefix: PREFIX,
            credential: STORE_CREDENTIAL,
          },
        },
        harness: {
          kind: "worker",
          config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
        },
      },
    });
  await applyBindings(FIRST_REVISION, true);
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
  const human = await fixture.invocation.authentication.authenticate(
    `Bearer ${fixture.token}`,
  );
  const submitted = await httpClient(
    missionOperations,
    fixture.endpoint,
    token,
  )["evidence.submit"]({
    params: { node_id: nodeId },
    query: {},
    body: {
      execution_id: execution.execution_id,
      attempt: execution.attempt,
      node_revision: execution.pinned_revision,
      subject: "objects",
      assets: Array.from({ length: ASSET_COUNT }, () => ({
        kind: AssetKind.Object,
        size: HELLO.byteLength,
        media_type: MEDIA,
      })),
    },
  });
  assert.ok(submitted.type === OperationResultType.Completed);
  const assets = submitted.data.uploads.map((upload) => upload.asset_id);
  assert.equal(assets.length, ASSET_COUNT);
  const pathOf = (assetId: string) =>
    `/${BUCKET}/` +
    [PREFIX, project.id, mission.id, nodeId, execution.attempt, assetId].join(
      "/",
    );
  const rows = () =>
    fixture.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT operation, request_key, state, credential, result FROM intake_outbound_request ORDER BY id",
          )
          .all() as OutboundRow[],
    );
  const intake = directClient(intakeOperations, fixture.invocation);
  return {
    fixture,
    store,
    assets,
    pathOf,
    rows,
    rowOf: (assetId: string) => {
      const found = rows().filter((row) => row.request_key === assetId);
      assert.equal(found.length, SINGLE_ROW);
      return found[FIRST_INDEX]!;
    },
    disableStorage: async () => {
      const { binding_set_version: current } = await read<{
        binding_set_version: number;
      }>(["project", "get", project.id]);
      await applyBindings(current, false);
    },
    remove: (assetId: string) =>
      intake["storage.delete"](
        { params: { asset_id: assetId }, query: {}, body: null },
        { identity: human },
      ),
  };
}

test(
  "the object delete runs as an outbound request through the direct adapter",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const [refused, lost, removed, gone, absent, kept] = h.assets;
    assert.ok(refused && lost && removed && gone && absent && kept);
    const deletes = () =>
      h.store.calls.filter((call) => call.method === DELETE).length;

    await t.test(
      "a failed delete commits failed and answers its result class",
      async () => {
        h.store.objects.add(h.pathOf(refused));
        h.store.script.next = HttpStatus.Forbidden;
        try {
          const error = failed(
            await h.remove(refused),
            BAD_GATEWAY_STATUS,
            S3_PREFIX + ResultClass.FinalRefusal,
          );
          assert.deepEqual(error.details, { status: HttpStatus.Forbidden });
        } finally {
          h.store.script.next = null;
        }
        assert.equal(h.rowOf(refused).state, OutboundRequestState.Failed);
      },
    );

    await t.test(
      "a repeat after a failed delete reads back and answers the stored failure",
      async () => {
        const before = deletes();
        const error = failed(
          await h.remove(refused),
          BAD_GATEWAY_STATUS,
          S3_PREFIX + ResultClass.FinalRefusal,
        );
        assert.deepEqual(error.details, { status: HttpStatus.Forbidden });
        assert.equal(deletes(), before);
        assert.deepEqual(h.store.calls.at(-1), {
          method: HEAD,
          path: h.pathOf(refused),
        });
        assert.equal(h.rowOf(refused).state, OutboundRequestState.Failed);
      },
    );

    await t.test("a lost delete answer has no status", async () => {
      h.store.objects.add(h.pathOf(lost));
      h.store.script.next = LOSE;
      try {
        const error = failed(
          await h.remove(lost),
          BAD_GATEWAY_STATUS,
          S3_PREFIX + ResultClass.UnknownOutcome,
        );
        assert.deepEqual(error.details, { status: null });
      } finally {
        h.store.script.next = null;
      }
      assert.equal(h.rowOf(lost).state, OutboundRequestState.Failed);
    });

    await t.test(
      "a delete records one succeeded request keyed by the asset",
      async () => {
        h.store.objects.add(h.pathOf(removed));
        deleted(await h.remove(removed));
        assert.equal(h.store.objects.has(h.pathOf(removed)), false);
        assert.deepEqual(h.store.calls.at(-1), {
          method: DELETE,
          path: h.pathOf(removed),
        });
        const row = h.rowOf(removed);
        assert.equal(row.operation, OutboundOperation.S3DeleteObject);
        assert.equal(row.state, OutboundRequestState.Succeeded);
        assert.equal(row.credential, STORE_CREDENTIAL);
        assert.deepEqual(JSON.parse(row.result ?? "null"), {
          location: `s3:/${h.pathOf(removed)}`,
          version: null,
        });
      },
    );

    await t.test("a repeat answers with no second delete", async () => {
      const calls = h.store.calls.length;
      deleted(await h.remove(removed));
      assert.equal(h.store.calls.length, calls);
      assert.equal(h.rowOf(removed).state, OutboundRequestState.Succeeded);
    });

    await t.test(
      "a lost delete of a gone object answers at the repeat through the read-back",
      async () => {
        h.store.script.next = LOSE;
        try {
          failed(
            await h.remove(gone),
            BAD_GATEWAY_STATUS,
            S3_PREFIX + ResultClass.UnknownOutcome,
          );
        } finally {
          h.store.script.next = null;
        }
        const before = deletes();
        deleted(await h.remove(gone));
        assert.equal(deletes(), before);
        assert.deepEqual(h.store.calls.at(-1), {
          method: HEAD,
          path: h.pathOf(gone),
        });
        assert.equal(h.rowOf(gone).state, OutboundRequestState.Succeeded);
      },
    );

    await t.test("the HTTP adapter answers 404 for the path", async () => {
      const response = await h.fixture.request(
        `/api/intake/storage/asset/${kept}`,
        {
          method: HttpMethod.Delete,
          headers: { authorization: `Bearer ${h.fixture.token}` },
        },
      );
      assert.equal(response.status, HttpStatus.NotFound);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, ROUTE_NOT_FOUND_CODE);
    });

    await t.test("a refusal of the binding records no request", async () => {
      await h.disableStorage();
      const count = h.rows().length;
      const calls = h.store.calls.length;
      const error = failed(
        await h.remove(absent),
        HttpStatus.Forbidden,
        MissionErrorCode.AuthorizationRefused,
      );
      assert.deepEqual(error.details, { reason: "binding_disabled" });
      assert.equal(h.rows().length, count);
      assert.equal(h.store.calls.length, calls);
    });

    await t.test("no log holds the secret", () => {
      for (const line of h.fixture.logs) assert.ok(!line.includes(SECRET));
    });
  },
);
