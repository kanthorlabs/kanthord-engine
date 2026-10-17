import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  writeFile,
  symlink,
  mkdir,
  open,
  lstat,
  realpath,
  rename,
  unlink,
  truncate,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { httpTransport } from "./transport.ts";
import {
  uploadEvidence,
  openEvidence,
  WorkerErrorCode,
  PathRefusal,
} from "./evidence-upload.ts";
import { testClaim } from "./test-support.ts";
import { isString } from "../../kernel/values.ts";
import { IntakeErrorCode, ResultClass } from "../../intake/contract.ts";
import { MissionErrorCode, OBJECT_SIZE_MAX } from "../../mission/contract.ts";
import { S3_RESULT_CODE_PREFIX } from "../../storage/contract.ts";
const FILE_CONTENT = "test bytes";
const GRANT_HEADER = "test_grant_header";
const PRIMARY = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const SECONDARY = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const UNREACHABLE_PUT = "http://127.0.0.1:1/test_private_grant";
const CONFLICT = 409;
const TRANSFER_ACCEPTED = 200;
const FAILED_STORES = 2;
const SINGLE_CHECK = 1;
const REFUSED = MissionErrorCode.AuthorizationRefused;

function refusal(code: string) {
  return {
    type: OperationResultType.Failure,
    status: CONFLICT,
    error: {
      error: { code, message: "Refused.", details: null },
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    },
  };
}

function granted(assetId: string, bindingId: string, putUrl: string) {
  return {
    type: OperationResultType.Completed,
    status: 200,
    data: {
      evidence: {
        id: `evidence_${assetId.slice(-26)}`,
        assets: [
          { id: assetId, kind: "object", storage_binding_id: bindingId },
        ],
      },
      uploads: [
        { asset_id: assetId, put_url: putUrl, headers: {}, expires_at: 0 },
      ],
    },
  };
}

test("evidence open refuses a parent swap even when pathname checks would see a restored parent", async (t) => {
  const workspace = temporary(t);
  const outside = temporary(t);
  const directory = join(workspace, "directory");
  const held = join(workspace, "held");
  await mkdir(directory);
  await writeFile(join(directory, "a.txt"), "inside");
  await writeFile(join(outside, "a.txt"), "outside");
  const io = { open, lstat, realpath };
  let swapped = false;
  let parentReads = 0;
  t.mock.method(io, "lstat", async (...args: Parameters<typeof lstat>) => {
    if (!swapped) {
      await rename(directory, held);
      await symlink(outside, directory);
      swapped = true;
    }
    return lstat(...args);
  });
  t.mock.method(
    io,
    "realpath",
    async (...args: Parameters<typeof realpath>) => {
      const restoreAt = 3;
      if (++parentReads === restoreAt && swapped) {
        await unlink(directory);
        await rename(held, directory);
        swapped = false;
      }
      return realpath(...args);
    },
  );
  await assert.rejects(openEvidence(workspace, "directory/a.txt", io));
  assert.ok(swapped);
});

test("oversized sparse evidence refuses before allocating or submitting metadata", async (t) => {
  const workspace = temporary(t);
  const path = join(workspace, "large");
  await writeFile(path, "");
  await truncate(path, OBJECT_SIZE_MAX + 1);
  const api = httpTransport("http://127.0.0.1:1");
  const submit = t.mock.method(api.mission, "evidence.submit", () =>
    assert.fail("Oversized object submitted"),
  );
  await assert.rejects(
    uploadEvidence({
      workspace,
      path: "large",
      claim: testClaim(),
      api,
      context: background,
    }),
    { code: WorkerErrorCode.EvidenceUploadTransferFailed },
  );
  const noCalls = 0;
  assert.equal(submit.mock.callCount(), noCalls);
});

test("safe evidence open refuses traversal, absolute paths, symlinks and directories", async (t) => {
  const workspace = temporary(t);
  await writeFile(join(workspace, "a.txt"), "test bytes");
  await symlink(join(workspace, "a.txt"), join(workspace, "link"));
  await mkdir(join(workspace, "directory"));
  for (const [path, reason] of [
    ["../escape", PathRefusal.OutsideWorkspace],
    [join(workspace, "a.txt"), PathRefusal.OutsideWorkspace],
    ["link", PathRefusal.SymbolicLink],
    ["directory", PathRefusal.NotRegular],
  ]) {
    await assert.rejects(openEvidence(workspace, path!), {
      code: WorkerErrorCode.EvidenceUploadPathRefused,
      details: { reason },
    });
  }
  const file = await openEvidence(workspace, "a.txt");
  try {
    assert.equal((await file.readFile()).toString(), FILE_CONTENT);
  } finally {
    await file.close();
  }
});

test("upload submits metadata then transfers bytes then completes without exposing the grant", async (t) => {
  const workspace = temporary(t);
  const bytes = Buffer.from("test uploaded bytes");
  await writeFile(join(workspace, "a.txt"), bytes);
  const events: string[] = [];
  let mutateAfterHash = false;
  let transferred = Buffer.alloc(0);
  let status = 200;
  const listener = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    transferred = Buffer.concat(chunks);
    if (!mutateAfterHash) assert.deepEqual(transferred, bytes);
    assert.equal(request.headers["x-test-header"], GRANT_HEADER);
    events.push("PUT");
    response.writeHead(status).end();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const putUrl = `http://127.0.0.1:${address.port}/test_private_grant`;
  const api = httpTransport("http://127.0.0.1:1");
  const result = {
    evidence_id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    asset_id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    uri: "s3://test-bucket/object",
  };
  t.mock.method(
    api.mission,
    "evidence.submit",
    async (input: Parameters<(typeof api.mission)["evidence.submit"]>[0]) => {
      events.push("submit");
      assert.deepEqual(input.body.assets, [
        {
          kind: "object",
          size: bytes.length,
          media_type: "application/octet-stream",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ]);
      if (mutateAfterHash)
        await writeFile(
          join(workspace, "a.txt"),
          Buffer.alloc(bytes.length, 120),
        );
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: {
          evidence: {
            id: result.evidence_id,
            assets: [
              {
                id: result.asset_id,
                kind: "object",
                storage_binding_id: PRIMARY,
              },
            ],
          },
          uploads: [
            {
              asset_id: result.asset_id,
              put_url: putUrl,
              headers: { "x-test-header": "test_grant_header" },
              expires_at: Date.now() + 60000,
            },
          ],
        },
      };
    },
  );
  t.mock.method(api.mission, "evidence.asset.complete", async () => {
    events.push("complete");
    if (status !== TRANSFER_ACCEPTED) return refusal(REFUSED);
    if (
      createHash("sha256").update(transferred).digest("hex") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("object checksum mismatch");
    return { type: OperationResultType.Completed, status: 200, data: result };
  });
  const input = {
    workspace,
    path: "a.txt",
    claim: testClaim(),
    api,
    context: background,
  };
  assert.deepEqual(await uploadEvidence(input), {
    evidence_id: result.evidence_id,
    asset_id: result.asset_id,
    uri: result.uri,
  });
  assert.deepEqual(events, ["submit", "PUT", "complete"]);
  status = 500;
  await assert.rejects(uploadEvidence(input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!JSON.stringify(error).includes(putUrl));
    return "code" in error && error.code === REFUSED;
  });
  assert.deepEqual(events, [
    "submit",
    "PUT",
    "complete",
    "submit",
    "PUT",
    "complete",
  ]);
  status = 200;
  mutateAfterHash = true;
  await assert.rejects(uploadEvidence(input), /object checksum mismatch/);
  assert.equal(transferred.length, bytes.length);
  assert.notDeepEqual(transferred, bytes);
});

async function failoverInput(t: TestContext) {
  const workspace = temporary(t);
  await writeFile(join(workspace, "a.txt"), FILE_CONTENT);
  const api = httpTransport("http://127.0.0.1:1");
  const received: string[] = [];
  const listener = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks).toString());
    response.writeHead(TRANSFER_ACCEPTED).end();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  return {
    api,
    received,
    reachablePut: `http://127.0.0.1:${address.port}/test_private_grant`,
    input: {
      workspace,
      path: "a.txt",
      claim: testClaim(),
      api,
      context: background,
    },
  };
}

test("an unreachable first store publishes through the second binding", async (t) => {
  const { api, received, reachablePut, input } = await failoverInput(t);
  const assets = [
    "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAB",
  ];
  const submits = [
    granted(assets[0]!, PRIMARY, UNREACHABLE_PUT),
    granted(assets[1]!, SECONDARY, reachablePut),
  ];
  const completes: string[] = [];
  t.mock.method(api.mission, "evidence.submit", async () => submits.shift());
  t.mock.method(
    api.mission,
    "evidence.asset.complete",
    async (
      request: Parameters<(typeof api.mission)["evidence.asset.complete"]>[0],
    ) => {
      completes.push(request.params.asset_id);
      if (request.params.asset_id === assets[0])
        return refusal(IntakeErrorCode.StorageObjectMismatch);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: {
          asset_id: assets[1],
          evidence_id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAB",
          uri: "s3://second/object",
        },
      };
    },
  );
  const result = await uploadEvidence(input);
  assert.deepEqual(result, {
    evidence_id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAB",
    asset_id: assets[1],
    uri: "s3://second/object",
  });
  assert.ok(!JSON.stringify(result).includes("test_private_grant"));
  assert.deepEqual(completes, assets);
  assert.deepEqual(received, [FILE_CONTENT]);
  assert.deepEqual(submits, []);
});

test("two failed stores answer mission.evidence.storage_exhausted", async (t) => {
  const { api, input } = await failoverInput(t);
  const submits = [
    granted(
      "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      PRIMARY,
      UNREACHABLE_PUT,
    ),
    granted(
      "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      SECONDARY,
      UNREACHABLE_PUT,
    ),
    refusal(MissionErrorCode.EvidenceStorageExhausted),
  ];
  let completes = 0;
  t.mock.method(api.mission, "evidence.submit", async () => submits.shift());
  t.mock.method(api.mission, "evidence.asset.complete", async () => {
    completes++;
    return refusal(S3_RESULT_CODE_PREFIX + ResultClass.UnknownOutcome);
  });
  await assert.rejects(uploadEvidence(input), {
    code: MissionErrorCode.EvidenceStorageExhausted,
  });
  assert.equal(completes, FAILED_STORES);
  assert.deepEqual(submits, []);
});

test("a repeated grant after a failed check stops the upload", async (t) => {
  const { api, input } = await failoverInput(t);
  const submits = [
    granted(
      "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      PRIMARY,
      UNREACHABLE_PUT,
    ),
    granted(
      "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      PRIMARY,
      UNREACHABLE_PUT,
    ),
  ];
  let completes = 0;
  t.mock.method(api.mission, "evidence.submit", async () => submits.shift());
  t.mock.method(api.mission, "evidence.asset.complete", async () => {
    completes++;
    return refusal(IntakeErrorCode.StorageObjectMismatch);
  });
  await assert.rejects(uploadEvidence(input), {
    code: IntakeErrorCode.StorageObjectMismatch,
  });
  assert.equal(completes, SINGLE_CHECK);
  assert.deepEqual(submits, []);
});
