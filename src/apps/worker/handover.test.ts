import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Credential } from "@earendil-works/pi-ai";
import { background } from "../../kernel/context.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
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
  type WireReport,
} from "../../custody/contract.ts";
import { executionCredentialStore } from "../../custody/client.ts";
import { httpTransport } from "./transport.ts";
import { takeHandover } from "./handover.ts";
import { testClaim } from "./test-support.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { WorkerErrorCode } from "../../worker/contract.ts";

const SECRET = Buffer.alloc(32, 5).toString("base64");
const CREDENTIAL = { type: "api_key" as const, key: "test_handover_key" };
const ITEM = {
  credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  provider_id: "anthropic",
  credential: CREDENTIAL,
};
const ONCE = 1;
const NO_REPORTS = 0;
const BOTH_VIEWS = 2;
const LEASE_EXPIRES_AT = 40000;
const REFRESHED = { type: "api_key" as const, key: "test_refreshed_key" };
const SECOND_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const SETTLE_ROUNDS = 200;
const BACKOFF_STEP_MS = 1000;
const TICK_ROUNDS = 5;

function leaseAnswer(
  keys: ReturnType<typeof deriveHandoverKeys>,
  aad: Buffer,
  item: unknown,
) {
  return {
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      item,
      expires_at: LEASE_EXPIRES_AT,
    }),
  };
}

function leaseHeldFailure() {
  return {
    type: OperationResultType.Failure,
    status: HttpStatus.ServiceUnavailable,
    error: {
      error: {
        code: WorkerErrorCode.CredentialLeaseHeld,
        message: "Another execution holds the refresh lease; retry the lease.",
        details: null,
      },
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
  };
}

function reportFailure() {
  return {
    type: OperationResultType.Failure,
    status: HttpStatus.InternalServerError,
    error: {
      error: {
        code: WorkerErrorCode.CredentialLeaseHeld,
        message: "The report failed.",
        details: null,
      },
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    },
  };
}

async function settled(done: () => boolean): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS && !done(); round++)
    await nextTurn();
  assert.ok(done());
}
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
  t.mock.method(api.worker, "credential.lease", async () =>
    leaseAnswer(keys, aad, ITEM),
  );
  const pending = takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  await new Promise((resolve) => setImmediate(resolve));
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
  t.mock.method(api.worker, "credential.lease", async () =>
    leaseAnswer(keys, aad, second),
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
    holder: "relay-a",
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
  t.mock.method(api.worker, "credential.lease", async () =>
    leaseAnswer(keys, aad, item),
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

test("handover retries a refresh-in-flight refusal until the envelope arrives", async (t) => {
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
        ? {
            type: OperationResultType.Failure,
            status: HttpStatus.ServiceUnavailable,
            error: {
              error: {
                code: WorkerErrorCode.HandoverRefreshInFlight,
                message:
                  "A credential refresh is in flight; retry the handover.",
                details: null,
              },
              request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
          }
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
  const pending = takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await pending;
  const twice = 2;
  assert.equal(requestKeys.length, twice);
  assert.deepEqual(
    await result.credentials.items[0]!.store.read(ITEM.provider_id),
    CREDENTIAL,
  );
  result.credentials.discard();
});

test("handover ends after one call on a 503 with another code", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  let calls = 0;
  t.mock.method(api.worker, "handover", async () => {
    calls++;
    return {
      type: OperationResultType.Failure,
      status: HttpStatus.ServiceUnavailable,
      error: {
        error: {
          code: "gateway.invocation.stopping",
          message: "The server is stopping.",
          details: null,
        },
        request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    };
  });
  await assert.rejects(
    takeHandover({ api, claim, clientSecret: SECRET, context: background }),
  );
  assert.equal(calls, ONCE);
});

test("a refused sealed item discards every credential view that the handover opened before it", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const pair = await generateX25519KeyPair();
  const sealed = await sealJSON(
    pair.public_key,
    CREDENTIAL_SEAL_INFO,
    credentialSealAad({
      name: "anthro-1",
      platform: "anthropic",
      holder: "relay-a",
      sealed_to: keyFingerprint(pair.public_key),
    }),
    { key: CREDENTIAL.key },
  );
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [
        ITEM,
        {
          credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAB",
          provider_id: ITEM.provider_id,
          name: "anthro-1",
          platform: "anthropic",
          holder: "relay-a",
          sealed,
        },
      ],
      ssh_identities: [],
    }),
  }));
  const discard = t.mock.method(
    Object.getPrototypeOf(
      executionCredentialStore(
        { items: [ITEM] },
        async () => {},
        async () => CREDENTIAL,
      ),
    ) as { discard(): void },
    "discard",
  );
  await assert.rejects(
    takeHandover({ api, claim, clientSecret: SECRET, context: background }),
    { code: "worker.handover.sealed_unopened" },
  );
  assert.equal(discard.mock.callCount(), ONCE);
});

test("a lease_held answer retries the lease with a new key until the lease ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [ITEM],
      ssh_identities: [],
    }),
  }));
  const requestKeys: string[] = [];
  const held = 2;
  t.mock.method(
    api.worker,
    "credential.lease",
    async (
      _input: unknown,
      options: Parameters<(typeof api.worker)["credential.lease"]>[1],
    ) => {
      requestKeys.push(options!.idempotencyKey!);
      return requestKeys.length <= held
        ? leaseHeldFailure()
        : leaseAnswer(keys, aad, ITEM);
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
  const result = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  let refreshed: Credential | undefined;
  const modifying = result.credentials.items[0]!.store.modify(
    ITEM.provider_id,
    async () => REFRESHED,
  ).then((value) => {
    refreshed = value;
  });
  for (let round = 0; round < held; round++) {
    await settled(() => requestKeys.length > round);
    t.mock.timers.tick(BACKOFF_STEP_MS * 2 ** round);
  }
  await modifying;
  assert.deepEqual(refreshed, REFRESHED);
  assert.equal(requestKeys.length, held + ONCE);
  assert.equal(new Set(requestKeys).size, requestKeys.length);
  assert.equal(reports.length, ONCE);
  result.credentials.discard();
});

test("an abort of the modify signal ends the lease_held retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [ITEM],
      ssh_identities: [],
    }),
  }));
  let calls = 0;
  t.mock.method(api.worker, "credential.lease", async () => {
    calls++;
    return leaseHeldFailure();
  });
  const credential = t.mock.method(api.worker, "credential", async () => ({
    type: OperationResultType.Completed,
    status: 204,
    data: null,
  }));
  const result = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  const controller = new AbortController();
  const modifying = result.credentials.items[0]!.store.modify(
    ITEM.provider_id,
    async () => REFRESHED,
    { signal: controller.signal },
  );
  const rejected = assert.rejects(modifying);
  await settled(() => calls === ONCE);
  controller.abort();
  await rejected;
  t.mock.timers.tick(claim.expired_at);
  await nextTurn();
  assert.equal(calls, ONCE);
  assert.equal(credential.mock.callCount(), NO_REPORTS);
  result.credentials.discard();
});

test("the lease after the first envelope opens with the handover key and discard zeroes the key", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const handoverKey = Buffer.from(keys.handover);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [ITEM],
      ssh_identities: [],
    }),
  }));
  t.mock.method(api.worker, "credential.lease", async () =>
    leaseAnswer(keys, aad, ITEM),
  );
  t.mock.method(api.worker, "credential", async () => ({
    type: OperationResultType.Completed,
    status: 204,
    data: null,
  }));
  const original = Buffer.prototype.fill;
  let zeroed = false;
  t.mock.method(
    Buffer.prototype,
    "fill",
    function (this: Buffer, ...args: Parameters<typeof original>) {
      if (this.equals(handoverKey)) zeroed = true;
      return Reflect.apply(original, this, args);
    },
  );
  const result = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    context: background,
  });
  assert.equal(zeroed, false);
  const leased = await result.credentials.items[0]!.store.modify(
    ITEM.provider_id,
    async () => undefined,
  );
  assert.deepEqual(leased, CREDENTIAL);
  assert.equal(zeroed, false);
  result.credentials.discard();
  assert.equal(zeroed, true);
});

test("the error path zeroes the handover key", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const keys = deriveHandoverKeys(SECRET);
  const handoverKey = Buffer.from(keys.handover);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const pair = await generateX25519KeyPair();
  const sealed = await sealJSON(
    pair.public_key,
    CREDENTIAL_SEAL_INFO,
    credentialSealAad({
      name: "anthro-1",
      platform: "anthropic",
      holder: "relay-a",
      sealed_to: keyFingerprint(pair.public_key),
    }),
    { key: CREDENTIAL.key },
  );
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(keys.handover, aad, {
      items: [
        {
          credential_id: ITEM.credential_id,
          provider_id: ITEM.provider_id,
          name: "anthro-1",
          platform: "anthropic",
          holder: "relay-a",
          sealed,
        },
      ],
      ssh_identities: [],
    }),
  }));
  const original = Buffer.prototype.fill;
  let zeroed = false;
  t.mock.method(
    Buffer.prototype,
    "fill",
    function (this: Buffer, ...args: Parameters<typeof original>) {
      if (this.equals(handoverKey)) zeroed = true;
      return Reflect.apply(original, this, args);
    },
  );
  await assert.rejects(
    takeHandover({ api, claim, clientSecret: SECRET, context: background }),
    { code: "worker.handover.sealed_unopened" },
  );
  assert.equal(zeroed, true);
});

function sharedSealedServer(
  t: TestContext,
  sealed: Awaited<ReturnType<typeof sealJSON>>,
) {
  const state = {
    stored: sealed,
    holder: null as string | null,
    leases: 0,
    leaseHeld: 0,
    failReports: 0,
  };
  const attach = (
    api: ReturnType<typeof httpTransport>,
    claim: ExecutionRecord,
    sealItem: (stored: typeof sealed) => unknown,
  ) => {
    const keys = deriveHandoverKeys(SECRET);
    const aad = handoverAad(
      claim.execution_id,
      claim.claimant.runtime_identity,
    );
    t.mock.method(api.worker, "credential.lease", async () => {
      if (state.holder !== null && state.holder !== claim.execution_id) {
        state.leaseHeld++;
        return leaseHeldFailure();
      }
      state.holder = claim.execution_id;
      state.leases++;
      return leaseAnswer(keys, aad, sealItem(state.stored));
    });
    t.mock.method(
      api.worker,
      "credential",
      async (input: Parameters<typeof api.worker.credential>[0]) => {
        const report = openEnvelope(keys.report, aad, {
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
        }) as WireReport;
        assert.ok("sealed" in report);
        if (state.failReports > NO_REPORTS) {
          state.failReports--;
          return reportFailure();
        }
        if (digest(state.stored) === report.digest)
          state.stored = report.sealed as typeof sealed;
        if (state.holder === claim.execution_id) state.holder = null;
        return { type: OperationResultType.Completed, status: 204, data: null };
      },
    );
    t.mock.method(api.worker, "handover", async () => ({
      type: OperationResultType.Completed,
      status: 200,
      data: sealEnvelope(keys.handover, aad, {
        items: [sealItem(state.stored)],
        ssh_identities: [],
      }),
    }));
  };
  return { state, attach };
}

test("two views of one sealed item make one refresh call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
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
  const sealItem = (stored: typeof sealed) => ({
    credential_id: ITEM.credential_id,
    provider_id: ITEM.provider_id,
    name: "anthro-1",
    platform: "anthropic",
    holder: "relay-a",
    sealed: stored,
  });
  const server = sharedSealedServer(t, sealed);
  const firstApi = httpTransport("http://127.0.0.1:1");
  const secondApi = httpTransport("http://127.0.0.1:1");
  const firstClaim = testClaim();
  const secondClaim = { ...testClaim(), execution_id: SECOND_EXECUTION };
  server.attach(firstApi, firstClaim, sealItem);
  server.attach(secondApi, secondClaim, sealItem);
  const views = await Promise.all(
    [
      { api: firstApi, claim: firstClaim },
      { api: secondApi, claim: secondClaim },
    ].map(({ api, claim }) =>
      takeHandover({
        api,
        claim,
        clientSecret: SECRET,
        instanceKey,
        context: background,
      }),
    ),
  );
  let refreshCalls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = async (current: Credential | undefined) => {
    if (current?.type === REFRESHED.type && current.key === REFRESHED.key)
      return undefined;
    refreshCalls++;
    await gate;
    return REFRESHED;
  };
  const [first, second] = views.map(({ credentials }) => credentials);
  const firstDone = first!.items[0]!.store.modify(ITEM.provider_id, refresh);
  await settled(() => server.state.leases === ONCE);
  const secondDone = second!.items[0]!.store.modify(ITEM.provider_id, refresh);
  await settled(() => server.state.leaseHeld > NO_REPORTS);
  release();
  await firstDone;
  for (
    let round = 0;
    round < TICK_ROUNDS && server.state.leases < BOTH_VIEWS;
    round++
  ) {
    await nextTurn();
    t.mock.timers.tick(BACKOFF_STEP_MS);
  }
  assert.deepEqual(await secondDone, REFRESHED);
  assert.equal(refreshCalls, ONCE);
  assert.equal(server.state.holder, null);
  assert.deepEqual(
    await openJSON(
      pair.private_key,
      CREDENTIAL_SEAL_INFO,
      sealAad,
      server.state.stored,
    ),
    { key: REFRESHED.key },
  );
  for (const { credentials } of views) credentials.discard();
});

test("the renewal before a report retry does not adopt the stored sealed object", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
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
  const sealOf = (key: string) =>
    sealJSON(pair.public_key, CREDENTIAL_SEAL_INFO, sealAad, { key });
  const sealed = await sealOf(CREDENTIAL.key);
  const other = await sealOf("test_other_execution_key");
  const server = sharedSealedServer(t, sealed);
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  server.attach(api, claim, (stored) => ({
    credential_id: ITEM.credential_id,
    provider_id: ITEM.provider_id,
    name: "anthro-1",
    platform: "anthropic",
    holder: "relay-a",
    sealed: stored,
  }));
  const { credentials } = await takeHandover({
    api,
    claim,
    clientSecret: SECRET,
    instanceKey,
    context: background,
  });
  server.state.failReports = ONCE;
  await assert.rejects(
    credentials.items[0]!.store.modify(ITEM.provider_id, async () => REFRESHED),
  );
  server.state.stored = other;
  await credentials.release();
  assert.equal(server.state.stored, other);
  credentials.discard();
});
