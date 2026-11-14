import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { type Operation, OperationResultType } from "../kernel/operation.ts";
import { missionOperations } from "../mission/contract.ts";
import { EVIDENCE_TEXT_MAX_BYTES, evidenceReadTool } from "./evidence.ts";
import type { InvokeOperation } from "./tools.ts";

const COMPLETED_STATUS = 200;
const ATTEMPT = 1;
const OVERSIZE_BYTES = EVIDENCE_TEXT_MAX_BYTES + 1000;
const SMALL_TEXT = "line one";
const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";
const IMAGE_MEDIA_TYPE = "image/png";
const IMAGE_MARKER = "PNGDATA-MARKER";
const NO_CALLS = 0;

const requester = () =>
  testHumanIdentity(createIdentity("account"), "owner", "jti");

function fixture(mediaType: string, body: string) {
  const evidenceId = createIdentity("evidence");
  const assetId = createIdentity("evidence_asset");
  const nodeId = createIdentity("node");
  const downloads: unknown[] = [];
  const invoke: InvokeOperation = async (operation: Operation, input) => {
    if (operation.id === missionOperations["evidence.get"].id)
      return {
        type: OperationResultType.Completed,
        status: COMPLETED_STATUS,
        data: {
          id: evidenceId,
          node_id: nodeId,
          attempt: ATTEMPT,
          assets: [{ id: assetId, address: { kind: "produced" } }],
        },
      };
    downloads.push(input);
    return {
      type: OperationResultType.Completed,
      status: COMPLETED_STATUS,
      data: new Response(body, {
        headers: {
          "X-Evidence-Media-Type": mediaType,
          "X-Evidence-Size": String(Buffer.byteLength(body)),
        },
      }),
    };
  };
  const read = (grants: ReadonlySet<string>) =>
    evidenceReadTool(invoke, requester, { grants }).execute(
      "call_evidence",
      { evidence_id: evidenceId, asset_id: assetId },
      undefined,
      undefined,
      undefined as never,
    );
  return { nodeId, downloads, read };
}

test("security, argument guard: text above 64 KiB gives block 1 with truncated true and length 65536", async () => {
  const f = fixture(TEXT_MEDIA_TYPE, "a".repeat(OVERSIZE_BYTES));
  const result = await f.read(new Set([f.nodeId]));
  const block1 = JSON.parse(
    (result.content[0] as { text: string }).text,
  ) as Record<string, unknown>;
  assert.equal(block1.truncated, true);
  assert.equal(block1.length, EVIDENCE_TEXT_MAX_BYTES);
  assert.equal(block1.size, OVERSIZE_BYTES);
});

test("security, argument guard: an image media type is refused with no content", async () => {
  const f = fixture(IMAGE_MEDIA_TYPE, IMAGE_MARKER);
  const failure: Error = await f.read(new Set([f.nodeId])).then(
    () => assert.fail("The read must fail."),
    (error: Error) => error,
  );
  assert.match(failure.message, /^workbench\.evidence\.media_refused: /);
  assert.ok(!failure.message.includes(IMAGE_MARKER));
});

test("security: a node outside the grants gives not_granted and no download call", async () => {
  const f = fixture(TEXT_MEDIA_TYPE, SMALL_TEXT);
  const failure: Error = await f.read(new Set()).then(
    () => assert.fail("The read must fail."),
    (error: Error) => error,
  );
  assert.match(failure.message, /^workbench\.evidence\.not_granted: /);
  assert.equal(f.downloads.length, NO_CALLS);
});

test("security: details equals block 1 and holds no content text", async () => {
  const f = fixture(TEXT_MEDIA_TYPE, SMALL_TEXT);
  const result = await f.read(new Set([f.nodeId]));
  const block1 = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(result.details, block1);
  assert.ok(!JSON.stringify(result.details).includes(SMALL_TEXT));
  assert.ok((result.content[1] as { text: string }).text.includes(SMALL_TEXT));
});
