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
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
  sealedObjectSchema,
  sealJSON,
} from "../../kernel/hpke.ts";
import { digest } from "../../kernel/json.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
} from "../../custody/contract.ts";
import { httpTransport } from "./transport.ts";
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
  const api = httpTransport("http://127.0.0.1:1");
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
            data: sealEnvelope(keys.handover, aad, {
              items: [ITEM],
              ssh_identities: [],
            }),
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
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(
      deriveHandoverKeys(SECRET).handover,
      handoverAad(claim.execution_id, claim.claimant.runtime_identity),
      { items: [ITEM], ssh_identities: [] },
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
  const api = httpTransport("http://127.0.0.1:1");
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
    data: sealEnvelope(keys.handover, aad, {
      items: [ITEM, second],
      ssh_identities: [],
    }),
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

test("a unit opens a sealed handover item with the instance key, reports a sealed refresh and refuses the item without the key", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const pair = await generateX25519KeyPair();
  const instanceKey = {
    holder: "relay-a",
    sealed_to: keyFingerprint(pair.public_key),
    public_key: pair.public_key,
    private_key: () => Buffer.from(pair.private_key),
  };
  const sealAad = credentialSealAad({
    name: "anthro-1",
    platform: "anthropic",
    holder: instanceKey.holder,
    sealed_to: instanceKey.sealed_to,
  });
  const sealed = await sealJSON(
    pair.public_key,
    CREDENTIAL_SEAL_INFO,
    sealAad,
    { key: CREDENTIAL.key },
  );
  const item = {
    credential_id: ITEM.credential_id,
    provider_id: ITEM.provider_id,
    name: "anthro-1",
    platform: "anthropic",
    sealed,
  };
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [item],
      ssh_identities: [],
    }),
  }));
  const reports: { digest: string; sealed: unknown }[] = [];
  t.mock.method(
    api.worker,
    "credential",
    async (input: Parameters<typeof api.worker.credential>[0]) => {
      reports.push(
        openEnvelope(keys.report, aad, {
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
        }) as { digest: string; sealed: unknown },
      );
      return { type: OperationResultType.Completed, status: 204, data: null };
    },
  );
  await assert.rejects(
    takeHandover({ api, claim, clientSecret: SECRET, context: background }),
    { code: "worker.handover.sealed_unopened" },
  );
  const result = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    instanceKey,
    context: background,
  });
  assert.deepEqual(
    await result.credentials.items[0]!.store.read(ITEM.provider_id),
    CREDENTIAL,
  );
  const refreshed = { type: "api_key" as const, key: "test_refreshed_key" };
  await result.credentials.items[0]!.store.modify(
    ITEM.provider_id,
    async () => refreshed,
  );
  assert.equal(reports.length, ONCE);
  assert.equal(reports[0]!.digest, digest(sealed));
  assert.deepEqual(
    await openJSON(
      pair.private_key,
      CREDENTIAL_SEAL_INFO,
      sealAad,
      sealedObjectSchema.parse(reports[0]!.sealed),
    ),
    { key: refreshed.key },
  );
  assert.equal(JSON.stringify(reports).includes(refreshed.key), false);
  result.credentials.discard();
});
