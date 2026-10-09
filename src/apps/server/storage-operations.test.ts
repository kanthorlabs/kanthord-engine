import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  AssetKind,
  MissionErrorCode,
  missionOperations,
} from "../../mission/contract.ts";
import { READ_ATTEMPT_LIMIT } from "../../storage/s3.ts";
import { STORAGE_SECRET, storageProject } from "./test-support.ts";

const NO_ROWS = 0;
const NO_LOSSES = 0;
const ONE_PIN = 1;
const MS_PER_S = 1000;
const LOST_DEADLINE_MS = 600;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 180000;
const BUCKET = "evidence";
const CHECKED_VERSION = "v3";
const PLAIN_VERSION = "v1";
const MEDIA = "text/plain";
const HELLO = Buffer.from("hello");
const WORLD = Buffer.from("world");
const SHORT = Buffer.from("hell");
const PLAIN = Buffer.from("abcde");
const HELLO_SHA256 = createHash("sha256").update(HELLO).digest("hex");
const SIGNATURE_PARAMETER = "X-Amz-Signature";
const SIGNED_HEADERS_PARAMETER = "X-Amz-SignedHeaders";
const CHECKSUM_HEADER = "x-amz-checksum-sha256";
const RAW_AUTHORIZATION = "AWS4-HMAC-SHA256 storage-operations";
const ROUTE_NOT_FOUND_CODE = "gateway.routing.not_found";
const S3_PREFIX = "storage.platform.s3.";
const HEAD = "HEAD";
const PUBLISHED_CHECK_REFUSAL = "node_mismatch";

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

async function setup(t: TestContext) {
  const p = await storageProject(t);
  const { fixture, execution } = p;
  const machine = await p.machine();
  const human = await p.human();
  const api = httpClient(missionOperations, fixture.endpoint, p.token);
  const submitted = completed(
    await api["evidence.submit"]({
      params: { node_id: p.nodeId },
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
  const recordedVersion = (assetId: string) =>
    fixture.store.transaction((tx) => {
      const found = tx.database
        .prepare("SELECT content FROM mission_evidence_asset WHERE id = ?")
        .get(assetId) as { content: string };
      return (JSON.parse(found.content) as { object_version?: string })
        .object_version;
    });
  const intake = directClient(intakeOperations, fixture.invocation);
  const executionId = execution.execution_id;
  const [checkedUpload, plainUpload] = submitted.uploads;
  assert.ok(checkedUpload && plainUpload);
  return {
    fixture,
    s3: p.s3,
    token: p.token,
    nodeId: p.nodeId,
    executionId,
    storageBindingId: p.storageBindingId,
    checked: checkedUpload.asset_id,
    plain: plainUpload.asset_id,
    uploads: [checkedUpload, plainUpload],
    keyOf: p.keyOf,
    materials,
    pins,
    outboundCount,
    recordedVersion,
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

async function storePut(
  url: string,
  headers: Record<string, string>,
  bytes: Buffer,
) {
  const answer = await fetch(url, {
    method: HttpMethod.Put,
    headers,
    body: bytes,
  });
  assert.equal(answer.status, HttpStatus.OK);
  await answer.arrayBuffer();
}

function rawPut(endpoint: string, key: string, bytes: Buffer) {
  const url = new URL(
    `${endpoint}/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`,
  );
  url.searchParams.set(SIGNED_HEADERS_PARAMETER, CHECKSUM_HEADER);
  return storePut(
    url.href,
    {
      authorization: RAW_AUTHORIZATION,
      [CHECKSUM_HEADER]: createHash("sha256").update(bytes).digest("base64"),
    },
    bytes,
  );
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
        assert.equal(url.origin, h.s3.endpoint);
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
        assert.deepEqual(h.s3.calls, []);
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
      assert.deepEqual(h.s3.calls.at(-1), {
        method: HEAD,
        key: h.keyOf(h.checked),
        version: null,
      });
    });

    await t.test(
      "a short object and a wrong checksum answer the mismatch",
      async () => {
        for (const bytes of [SHORT, WORLD]) {
          await rawPut(h.s3.endpoint, h.keyOf(h.checked), bytes);
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
        const [checked, plain] = h.uploads;
        assert.ok(checked && plain);
        await storePut(checked.put_url, checked.headers, HELLO);
        await storePut(plain.put_url, plain.headers, PLAIN);
        for (const [assetId, version] of [
          [h.checked, CHECKED_VERSION],
          [h.plain, PLAIN_VERSION],
        ] as const)
          assert.deepEqual(completed(await h.check(assetId)), {
            location: `s3://${BUCKET}/${h.keyOf(assetId)}`,
            version,
          });
      },
    );

    await t.test(
      "an execution GET and a human GET sign the object",
      async () => {
        const calls = h.s3.calls.length;
        const before = Date.now();
        for (const answer of [
          completed(await h.executionGet(h.checked)),
          completed(await h.get(h.checked)),
        ]) {
          urls.push(answer.get_url);
          const url = new URL(answer.get_url);
          assert.equal(url.origin, h.s3.endpoint);
          assert.equal(url.pathname, `/${BUCKET}/${h.keyOf(h.checked)}`);
          assert.ok(url.searchParams.get(SIGNATURE_PARAMETER));
          assertWithinLifetime(answer.expires_at, before);
        }
        assert.equal(h.s3.calls.length, calls);
        assert.equal(h.pins().length, ONE_PIN);
      },
    );

    await t.test(
      "a repeat complete answers the recorded result and a check of a published asset refuses",
      async () => {
        const location = `s3://${BUCKET}/${h.keyOf(h.checked)}`;
        assert.equal(completed(await h.complete(h.checked)).uri, location);
        assert.equal(h.recordedVersion(h.checked), CHECKED_VERSION);
        const calls = h.s3.calls.length;
        assert.equal(completed(await h.complete(h.checked)).uri, location);
        const error = failed(
          await h.check(h.checked),
          HttpStatus.Forbidden,
          MissionErrorCode.AuthorizationRefused,
        );
        assert.deepEqual(error.details, {
          reason: PUBLISHED_CHECK_REFUSAL,
        });
        assert.equal(h.s3.calls.length, calls);
      },
    );

    await t.test("a refused HEAD answers its result class", async () => {
      h.s3.failNext(HttpStatus.Forbidden);
      const error = failed(
        await h.check(h.plain),
        BAD_GATEWAY_STATUS,
        S3_PREFIX + ResultClass.FinalRefusal,
      );
      assert.deepEqual(error.details, { status: HttpStatus.Forbidden });
    });

    await t.test(
      "a lost HEAD answer has no status before the caller deadline",
      async () => {
        const context = new CancellationContext(
          background,
          Date.now() + READ_ANSWER_MARGIN_MS + LOST_DEADLINE_MS,
        );
        h.s3.loseNext(READ_ATTEMPT_LIMIT);
        try {
          const error = failed(
            await h.check(h.plain, context),
            BAD_GATEWAY_STATUS,
            S3_PREFIX + ResultClass.RetryableRefusal,
          );
          assert.deepEqual(error.details, { status: null });
          assert.equal(context.err(), null);
        } finally {
          h.s3.loseNext(NO_LOSSES);
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
        assert.ok(!line.includes(STORAGE_SECRET), line);
        assert.ok(!line.includes(SIGNATURE_PARAMETER), line);
        for (const url of urls) assert.ok(!line.includes(url), line);
      }
    });

    await t.test("no call records an outbound request", () => {
      assert.equal(h.outboundCount(), NO_ROWS);
    });
  },
);
