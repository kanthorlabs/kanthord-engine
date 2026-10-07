import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../kernel/json.ts";
import { SecretShape, type RefreshReport } from "./contract.ts";
import {
  executionCredentialStore,
  ExecutionStoreError,
  type ExecutionCredentials,
} from "./client.ts";

const ID = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROVIDER = "anthropic";
const FIRST = { type: SecretShape.ApiKey, key: "first" };
const SECOND = { type: SecretShape.ApiKey, key: "second" };
const THIRD = { type: SecretShape.ApiKey, key: "third" };
const payload = () => ({
  items: [
    { credential_id: ID, provider_id: PROVIDER, credential: { ...FIRST } },
  ],
});

test("execution views isolate material and report only changed normalized credentials", async () => {
  const reports: RefreshReport[] = [];
  const view: ExecutionCredentials = executionCredentialStore(
    payload(),
    async (report) => {
      reports.push(report);
    },
  );
  const other = executionCredentialStore(payload(), async () => {});
  assert.equal(await view.store.read("other"), undefined);
  assert.deepEqual(await view.store.list(), [
    { providerId: PROVIDER, type: FIRST.type },
  ]);
  await view.store.modify(PROVIDER, async () => ({ ...FIRST }));
  assert.deepEqual(reports, []);
  await view.store.modify(PROVIDER, async () => undefined);
  assert.deepEqual(reports, []);
  await Promise.all([
    view.store.modify(PROVIDER, async (current) => {
      assert.deepEqual(current, FIRST);
      await Promise.resolve();
      return SECOND;
    }),
    view.store.modify(PROVIDER, async (current) => {
      assert.deepEqual(current, SECOND);
      return THIRD;
    }),
  ]);
  assert.deepEqual(reports, [
    { credential_id: ID, digest: digest(FIRST), credential: SECOND },
    { credential_id: ID, digest: digest(SECOND), credential: THIRD },
  ]);
  await view.release();
  assert.deepEqual(reports.at(-1), {
    credential_id: ID,
    digest: digest(THIRD),
    credential: THIRD,
  });
  assert.deepEqual(await other.store.read(PROVIDER), FIRST);
  const copy = await view.store.read(PROVIDER);
  assert(copy);
  if (copy.type === SecretShape.ApiKey) copy.key = "mutated";
  assert.deepEqual(await view.store.read(PROVIDER), THIRD);
});

test("report failure propagates and retains the last acknowledged digest for retry", async () => {
  const failure = new Error("report unavailable");
  let reject = true;
  const reports: RefreshReport[] = [];
  const view = executionCredentialStore(payload(), async (report) => {
    if (reject) throw failure;
    reports.push(report);
  });
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
  const view = executionCredentialStore(payload(), async () => {});
  await assert.rejects(
    view.store.modify(PROVIDER, async () => {
      view.discard();
      return SECOND;
    }),
    ExecutionStoreError,
  );
  assert.equal(await view.store.read(PROVIDER), undefined);
  const reporting = executionCredentialStore(payload(), async () => {
    reporting.discard();
  });
  await assert.rejects(reporting.release(), ExecutionStoreError);
  assert.equal(await reporting.store.read(PROVIDER), undefined);
  assert.throws(() => executionCredentialStore({ items: [] }, async () => {}));
});
