import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  sealEnvelope,
  openEnvelope,
} from "../../kernel/handover.ts";
import { workerApi } from "./api.ts";
import { takeHandover } from "./handover.ts";
import { testClaim } from "./test-support.ts";

const SECRET = Buffer.alloc(32, 5).toString("base64");
const CREDENTIAL = { type: "api_key" as const, key: "test_handover_key" };
const ITEM = {
  credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  provider_id: "anthropic",
  credential: CREDENTIAL,
};
const ONCE = 1;
test("handover retries a lost answer with a fresh key and reports refresh and release", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const api = workerApi("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const requestKeys: string[] = [];
  t.mock.method(
    api.worker,
    "handover",
    async (
      _input: unknown,
      options: Parameters<typeof api.worker.handover>[1],
    ) => {
      requestKeys.push(options!.idempotencyKey!);
      return requestKeys.length === ONCE
        ? { type: OperationResultType.Indeterminate }
        : {
            type: OperationResultType.Completed,
            status: 200,
            data: sealEnvelope(keys.handover, aad, { items: [ITEM] }),
          };
    },
  );
  const reports: unknown[] = [];
  t.mock.method(
    api.worker,
    "credential",
    async (input: Parameters<typeof api.worker.credential>[0]) => {
      reports.push(
        openEnvelope(keys.report, aad, {
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
        }),
      );
      return { type: OperationResultType.Completed, status: 204, data: null };
    },
  );
  const pending = takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(new Set(requestKeys).size, requestKeys.length);
  assert.deepEqual(
    await result.credentials.items[0]!.store.read(ITEM.provider_id),
    CREDENTIAL,
  );
  await result.credentials.items[0]!.store.modify(
    ITEM.provider_id,
    async () => ({
      type: "api_key",
      key: "test_refreshed_key",
    }),
  );
  assert.equal(reports.length, ONCE);
  await result.credentials.release();
  const twice = 2;
  assert.equal(reports.length, twice);
  result.credentials.discard();
  assert.equal(
    await result.credentials.items[0]!.store.read(ITEM.provider_id),
    undefined,
  );
});

test("another client secret refuses handover without exposing material", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const claim = testClaim();
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(
      deriveHandoverKeys(SECRET).handover,
      handoverAad(claim.execution_id, claim.claimant.runtime_identity),
      { items: [ITEM] },
    ),
  }));
  await assert.rejects(
    takeHandover({
      api,
      claim,
      clientSecret: Buffer.alloc(32, 6).toString("base64"),
      context: background,
    }),
    {
      code: "worker.handover.decryption_failed",
      message: "worker: credential handover could not be decrypted.",
    },
  );
});

test("handover builds one store per item and reports a refresh of the second item", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const second = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAB",
    provider_id: "openai",
    credential: { type: "api_key" as const, key: "test_second_key" },
  };
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, { items: [ITEM, second] }),
  }));
  const reports: { credential_id: string }[] = [];
  t.mock.method(
    api.worker,
    "credential",
    async (input: Parameters<typeof api.worker.credential>[0]) => {
      reports.push(
        openEnvelope(keys.report, aad, {
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
        }) as { credential_id: string },
      );
      return { type: OperationResultType.Completed, status: 204, data: null };
    },
  );
  const result = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  const [first, other] = result.credentials.items;
  assert.ok(first && other);
  assert.deepEqual(
    [first.credential_id, other.credential_id],
    [ITEM.credential_id, second.credential_id],
  );
  assert.equal(await first.store.read(second.provider_id), undefined);
  assert.deepEqual(
    await other.store.read(second.provider_id),
    second.credential,
  );
  await other.store.modify(second.provider_id, async () => ({
    type: "api_key",
    key: "test_second_refreshed",
  }));
  assert.deepEqual(
    reports.map((report) => report.credential_id),
    [second.credential_id],
  );
  result.credentials.discard();
});
