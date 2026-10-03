import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, symlink, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { workerApi } from "./api.ts";
import {
  uploadEvidence,
  openEvidence,
  WorkerErrorCode,
  PathRefusal,
} from "./evidence-upload.ts";
import { testClaim } from "./test-support.ts";
import { isString } from "../../kernel/values.ts";
const FILE_CONTENT = "test bytes";
const GRANT_HEADER = "test_grant_header";

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
  let status = 200;
  const listener = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
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
  const api = workerApi("http://127.0.0.1:1");
  const result = {
    evidenceId: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    assetId: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
          mediaType: "application/octet-stream",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ]);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: {
          evidence: { id: result.evidenceId },
          uploads: [
            {
              assetId: result.assetId,
              putUrl,
              headers: { "x-test-header": "test_grant_header" },
              expiresAt: Date.now() + 60000,
            },
          ],
        },
      };
    },
  );
  t.mock.method(api.mission, "evidence.asset.complete", async () => {
    events.push("complete");
    return { type: OperationResultType.Completed, status: 200, data: result };
  });
  const input = {
    workspace,
    path: "a.txt",
    claim: testClaim(),
    api,
    context: background,
  };
  assert.deepEqual(await uploadEvidence(input), result);
  assert.deepEqual(events, ["submit", "PUT", "complete"]);
  status = 500;
  await assert.rejects(uploadEvidence(input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!JSON.stringify(error).includes(putUrl));
    return (
      "code" in error &&
      error.code === WorkerErrorCode.EvidenceUploadTransferFailed
    );
  });
  assert.deepEqual(events, ["submit", "PUT", "complete", "submit", "PUT"]);
});
