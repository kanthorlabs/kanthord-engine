import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
  intakeOperations,
} from "../../intake/contract.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  AssetKind,
  MissionErrorCode,
  missionOperations,
} from "../../mission/contract.ts";
import { STORAGE_SECRET, storageProject } from "./test-support.ts";

const FIRST_INDEX = 0;
const SINGLE_ROW = 1;
const STORE_CREDENTIAL = "store";
const ASSET_COUNT = 7;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 180000;
const BUCKET = "evidence";
const MEDIA = "text/plain";
const HELLO = Buffer.from("hello");
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const S3_PREFIX = "storage.platform.s3.";
const DELETE = "DELETE";
const HEAD = "HEAD";
const RECORDED_VERSION = "v1";
const NEWER_VERSION = "v2";
const RAW_AUTHORIZATION = "AWS4-HMAC-SHA256 storage-delete";
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

async function setup(t: TestContext) {
  const p = await storageProject(t);
  const { fixture, execution } = p;
  const human = await p.human();
  const api = httpClient(missionOperations, fixture.endpoint, p.token);
  const submitted = await api["evidence.submit"]({
    params: { node_id: p.nodeId },
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
  const { uploads } = submitted.data;
  assert.equal(uploads.length, ASSET_COUNT);
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
  const upload = async (assetId: string) => {
    const found = uploads.find((item) => item.asset_id === assetId);
    assert.ok(found);
    await storePut(found.put_url, found.headers);
  };
  return {
    fixture,
    s3: p.s3,
    assets: uploads.map((item) => item.asset_id),
    keyOf: p.keyOf,
    rows,
    upload,
    rowOf: (assetId: string) => {
      const found = rows().filter((row) => row.request_key === assetId);
      assert.equal(found.length, SINGLE_ROW);
      return found[FIRST_INDEX]!;
    },
    complete: async (assetId: string) => {
      const answer = await api["evidence.asset.complete"]({
        params: { asset_id: assetId },
        query: {},
        body: {
          execution_id: execution.execution_id,
          attempt: execution.attempt,
          node_revision: execution.pinned_revision,
        },
      });
      assert.ok(
        answer.type === OperationResultType.Completed,
        JSON.stringify(answer),
      );
    },
    disableStorage: async () => {
      const { binding_set_version: current } = await p.cli.read<{
        binding_set_version: number;
      }>(["project", "get", p.project.id]);
      await p.applyBindings(current, false);
    },
    remove: (assetId: string) =>
      intake["storage.delete"](
        { params: { asset_id: assetId }, query: {}, body: null },
        { identity: human },
      ),
  };
}

async function storePut(url: string, headers: Record<string, string>) {
  const answer = await fetch(url, {
    method: HttpMethod.Put,
    headers,
    body: HELLO,
  });
  assert.equal(answer.status, HttpStatus.OK);
  await answer.arrayBuffer();
}

test(
  "the object delete runs as an outbound request through the direct adapter",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const [refused, lost, removed, gone, absent, kept, versioned] = h.assets;
    assert.ok(refused && lost && removed && gone && absent && kept);
    assert.ok(versioned);
    const deletes = () =>
      h.s3.calls.filter((call) => call.method === DELETE).length;

    await t.test(
      "a failed delete commits failed and answers its result class",
      async () => {
        await h.upload(refused);
        h.s3.failNext(HttpStatus.Forbidden);
        const error = failed(
          await h.remove(refused),
          BAD_GATEWAY_STATUS,
          S3_PREFIX + ResultClass.FinalRefusal,
        );
        assert.deepEqual(error.details, { status: HttpStatus.Forbidden });
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
        assert.deepEqual(h.s3.calls.at(-1), {
          method: HEAD,
          key: h.keyOf(refused),
          version: null,
        });
        assert.equal(h.rowOf(refused).state, OutboundRequestState.Failed);
      },
    );

    await t.test("a lost delete answer has no status", async () => {
      await h.upload(lost);
      h.s3.loseNext();
      const error = failed(
        await h.remove(lost),
        BAD_GATEWAY_STATUS,
        S3_PREFIX + ResultClass.UnknownOutcome,
      );
      assert.deepEqual(error.details, { status: null });
      assert.equal(h.rowOf(lost).state, OutboundRequestState.Failed);
    });

    await t.test(
      "a delete records one succeeded request keyed by the asset",
      async () => {
        await h.upload(removed);
        deleted(await h.remove(removed));
        assert.deepEqual(h.s3.objects(h.keyOf(removed)), []);
        assert.deepEqual(h.s3.calls.at(-1), {
          method: DELETE,
          key: h.keyOf(removed),
          version: null,
        });
        const row = h.rowOf(removed);
        assert.equal(row.operation, OutboundOperation.S3DeleteObject);
        assert.equal(row.state, OutboundRequestState.Succeeded);
        assert.equal(row.credential, STORE_CREDENTIAL);
        assert.deepEqual(JSON.parse(row.result ?? "null"), {
          location: `s3://${BUCKET}/${h.keyOf(removed)}`,
          version: null,
        });
      },
    );

    await t.test("a repeat answers with no second delete", async () => {
      const calls = h.s3.calls.length;
      deleted(await h.remove(removed));
      assert.equal(h.s3.calls.length, calls);
      assert.equal(h.rowOf(removed).state, OutboundRequestState.Succeeded);
    });

    await t.test(
      "a lost delete of a gone object answers at the repeat through the read-back",
      async () => {
        h.s3.loseNext();
        failed(
          await h.remove(gone),
          BAD_GATEWAY_STATUS,
          S3_PREFIX + ResultClass.UnknownOutcome,
        );
        const before = deletes();
        deleted(await h.remove(gone));
        assert.equal(deletes(), before);
        assert.deepEqual(h.s3.calls.at(-1), {
          method: HEAD,
          key: h.keyOf(gone),
          version: null,
        });
        assert.equal(h.rowOf(gone).state, OutboundRequestState.Succeeded);
      },
    );

    await t.test(
      "a delete at a recorded version removes that version alone",
      async () => {
        const key = h.keyOf(versioned);
        await h.upload(versioned);
        await h.complete(versioned);
        await storePut(`${h.s3.endpoint}/${BUCKET}/${key}`, {
          authorization: RAW_AUTHORIZATION,
        });
        deleted(await h.remove(versioned));
        assert.deepEqual(h.s3.calls.at(-1), {
          method: DELETE,
          key,
          version: RECORDED_VERSION,
        });
        assert.deepEqual(
          h.s3.objects(key).map((item) => item.version),
          [NEWER_VERSION],
        );
        assert.deepEqual(JSON.parse(h.rowOf(versioned).result ?? "null"), {
          location: `s3://${BUCKET}/${key}`,
          version: RECORDED_VERSION,
        });
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
      const calls = h.s3.calls.length;
      const error = failed(
        await h.remove(absent),
        HttpStatus.Forbidden,
        MissionErrorCode.AuthorizationRefused,
      );
      assert.deepEqual(error.details, { reason: "binding_disabled" });
      assert.equal(h.rows().length, count);
      assert.equal(h.s3.calls.length, calls);
    });

    await t.test("no log holds the secret", () => {
      for (const line of h.fixture.logs)
        assert.ok(!line.includes(STORAGE_SECRET));
    });
  },
);
