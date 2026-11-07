import assert from "node:assert/strict";
import type { Credential } from "@earendil-works/pi-ai";
import { test } from "node:test";
import { digest } from "../kernel/json.ts";
import { type RefreshReport, SecretShape } from "./contract.ts";
import {
  type ExecutionCredentials,
  executionCredentialStore,
  ExecutionStoreError,
} from "./client.ts";

const ID = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROVIDER = "anthropic";
const FIRST = { type: SecretShape.ApiKey, key: "first" };
const SECOND = { type: SecretShape.ApiKey, key: "second" };
const THIRD = { type: SecretShape.ApiKey, key: "third" };
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const THREE_CALLS = 3;
const LEASED = { type: SecretShape.ApiKey, key: "leased" };
const payload = () => ({
  items: [
    { credential_id: ID, provider_id: PROVIDER, credential: { ...FIRST } },
  ],
});

test("execution views isolate material and report each normalized credential", async () => {
  const reports: RefreshReport[] = [];
  const view: ExecutionCredentials = executionCredentialStore(
    payload(),
    async (report) => {
      reports.push(report);
    },
    async () => ({ ...FIRST }),
  );
  const other = executionCredentialStore(
    payload(),
    async () => {},
    async () => ({ ...FIRST }),
  );
  assert.equal(await view.store.read("other"), undefined);
  assert.deepEqual(await view.store.list(), [
    { providerId: PROVIDER, type: FIRST.type },
  ]);
  await view.store.modify(PROVIDER, async () => ({ ...FIRST }));
  assert.equal(reports.length, ONE_CALL);
  await view.store.modify(PROVIDER, async () => undefined);
  assert.equal(reports.length, TWO_CALLS);
  reports.length = NO_CALLS;
  await view.release();
  reports.length = NO_CALLS;
  const leases: Credential[] = [FIRST, SECOND];
  const sequenced = executionCredentialStore(
    payload(),
    async (report) => {
      reports.push(report);
    },
    async () => leases.shift()!,
  );
  await Promise.all([
    sequenced.store.modify(PROVIDER, async (current) => {
      assert.deepEqual(current, FIRST);
      await Promise.resolve();
      return SECOND;
    }),
    sequenced.store.modify(PROVIDER, async (current) => {
      assert.deepEqual(current, SECOND);
      return THIRD;
    }),
  ]);
  assert.deepEqual(reports, [
    { credential_id: ID, digest: digest(FIRST), credential: SECOND },
    { credential_id: ID, digest: digest(SECOND), credential: THIRD },
  ]);
  await sequenced.release();
  assert.deepEqual(reports.at(-1), {
    credential_id: ID,
    digest: digest(THIRD),
    credential: THIRD,
  });
  assert.deepEqual(await other.store.read(PROVIDER), FIRST);
  const copy = await sequenced.store.read(PROVIDER);
  assert(copy);
  if (copy.type === SecretShape.ApiKey) copy.key = "mutated";
  assert.deepEqual(await sequenced.store.read(PROVIDER), THIRD);
});

test("modify takes the lease once, passes the leased value to the function and sends one report", async () => {
  const reports: RefreshReport[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const view = executionCredentialStore(
    payload(),
    async (report) => {
      reports.push(report);
    },
    async (signal) => {
      signals.push(signal);
      return { ...LEASED };
    },
  );
  const controller = new AbortController();
  const seen: unknown[] = [];
  const answer = await view.store.modify(
    PROVIDER,
    async (current) => {
      seen.push(current);
      return SECOND;
    },
    { signal: controller.signal },
  );
  assert.deepEqual(signals, [controller.signal]);
  assert.deepEqual(seen, [LEASED]);
  assert.deepEqual(answer, SECOND);
  assert.deepEqual(reports, [
    { credential_id: ID, digest: digest(LEASED), credential: SECOND },
  ]);
  assert.deepEqual(await view.store.read(PROVIDER), SECOND);
});

test("a function that answers undefined still sends one report of the leased value and two modify calls run in order", async () => {
  const reports: RefreshReport[] = [];
  const order: string[] = [];
  const view = executionCredentialStore(
    payload(),
    async (report) => {
      order.push("report");
      reports.push(report);
    },
    async () => {
      order.push("lease");
      return { ...LEASED };
    },
  );
  const { gate, release } = gated();
  const first = view.store.modify(PROVIDER, async () => {
    order.push("first");
    await gate;
    return undefined;
  });
  const second = view.store.modify(PROVIDER, async () => {
    order.push("second");
    return undefined;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["lease", "first"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [LEASED, LEASED]);
  assert.deepEqual(order, [
    "lease",
    "first",
    "report",
    "lease",
    "second",
    "report",
  ]);
  assert.deepEqual(reports, [
    { credential_id: ID, digest: digest(LEASED), credential: LEASED },
    { credential_id: ID, digest: digest(LEASED), credential: LEASED },
  ]);
});

test("the store renews the lease before each retry of its report and keeps the value of the report", async () => {
  let leases = NO_CALLS;
  let failures = TWO_CALLS;
  const reports: RefreshReport[] = [];
  const view = executionCredentialStore(
    payload(),
    async (report) => {
      reports.push(report);
      if (failures-- > NO_CALLS) throw new Error("report unavailable");
    },
    async () => {
      leases++;
      return { ...LEASED };
    },
  );
  await assert.rejects(view.store.modify(PROVIDER, async () => SECOND));
  assert.equal(leases, ONE_CALL);
  await assert.rejects(view.release());
  assert.equal(leases, TWO_CALLS);
  await view.release();
  assert.equal(leases, THREE_CALLS);
  assert.deepEqual(
    reports.map(({ credential }) => credential),
    [SECOND, SECOND, SECOND],
  );
  assert.deepEqual(await view.store.read(PROVIDER), SECOND);
  await view.release();
  assert.equal(leases, THREE_CALLS);
});

function gated() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

test("report failure propagates and retains the last acknowledged digest for retry", async () => {
  const failure = new Error("report unavailable");
  let reject = true;
  const reports: RefreshReport[] = [];
  const view = executionCredentialStore(
    payload(),
    async (report) => {
      if (reject) throw failure;
      reports.push(report);
    },
    async () => ({ ...FIRST }),
  );
  await assert.rejects(
    view.store.modify(PROVIDER, async () => SECOND),
    failure,
  );
  reject = false;
  await view.release();
  assert.deepEqual(reports, [
    { credential_id: ID, digest: digest(FIRST), credential: SECOND },
  ]);
  await assert.rejects(view.store.delete(PROVIDER), ExecutionStoreError);
  await assert.rejects(
    view.store.modify("other", async () => SECOND),
    ExecutionStoreError,
  );
  await assert.rejects(
    view.store.modify(PROVIDER, async () => ({
      type: SecretShape.OAuth,
      refresh: "r",
      access: "a",
      expires: 1,
    })),
    ExecutionStoreError,
  );
  view.discard();
  assert.equal(await view.store.read(PROVIDER), undefined);
  assert.deepEqual(await view.store.list(), []);
  await assert.rejects(
    view.store.modify(PROVIDER, async () => THIRD),
    ExecutionStoreError,
  );
  await assert.rejects(view.release(), ExecutionStoreError);
});

test("discard during refresh or reporting cannot restore material", async () => {
  const view = executionCredentialStore(
    payload(),
    async () => {},
    async () => ({ ...FIRST }),
  );
  await assert.rejects(
    view.store.modify(PROVIDER, async () => {
      view.discard();
      return SECOND;
    }),
    ExecutionStoreError,
  );
  assert.equal(await view.store.read(PROVIDER), undefined);
  const reporting = executionCredentialStore(
    payload(),
    async () => {
      reporting.discard();
    },
    async () => ({ ...FIRST }),
  );
  await assert.rejects(reporting.release(), ExecutionStoreError);
  assert.equal(await reporting.store.read(PROVIDER), undefined);
  assert.throws(() =>
    executionCredentialStore(
      { items: [] },
      async () => {},
      async () => ({ ...FIRST }),
    ),
  );
});
