import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Store } from "../kernel/store.ts";
import { identitySchema } from "../kernel/identity.ts";
import { workerMigrations } from "./migrations.ts";
import {
  countLive,
  endGroup,
  endRegistration,
  insertRegistration,
  listLive,
  readAllLive,
  readLiveByClient,
  readLiveOfClient,
  readRow,
  reopenRegistration,
} from "./instances.ts";

const NOW = 1000;
const ENDED = 2000;
const ROWS_ENDED = 1;
const NEXT_TIMESTAMP = 1;
const REGISTRATION_PAGE_LIMIT = 1;
const LIVE_REGISTRATION_COUNT = 2;
const NO_ROWS_AFFECTED = 0;
const CLIENT = {
  client_id: "client-a",
  name: "Worker A",
  project_id: "project-a",
  resource_identity: "worker:kanthord:main",
};
function fixture(t: TestContext): Store {
  const store = new Store(":memory:");
  store.migrate([{ service: "worker", migrations: workerMigrations }]);
  t.after(() => store.close());
  assert.ok(store.database.isOpen);
  assert.ok(!store.database.isTransaction);
  return store;
}

test("registration rows retain attribution, end once, reopen, and roll back atomically", (t) => {
  const store = fixture(t);
  const registration = store.transaction((tx) =>
    insertRegistration(tx, CLIENT, NOW),
  );
  assert.ok(
    identitySchema("worker_instance").safeParse(registration.runtime_identity)
      .success,
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.client_id), registration);
  store.transaction((tx) => {
    assert.deepEqual(readLiveOfClient(tx, CLIENT.client_id), registration);
    assert.equal(
      endRegistration(tx, registration.runtime_identity, ENDED),
      ROWS_ENDED,
    );
    assert.equal(
      endRegistration(
        tx,
        registration.runtime_identity,
        ENDED + NEXT_TIMESTAMP,
      ),
      NO_ROWS_AFFECTED,
    );
    assert.equal(readRow(tx, registration.runtime_identity)!.ended_at, ENDED);
    assert.equal(readLiveOfClient(tx, CLIENT.client_id), undefined);
  });
  assert.equal(readLiveByClient(store, CLIENT.client_id), undefined);
  store.transaction((tx) =>
    reopenRegistration(tx, registration.runtime_identity),
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.client_id), registration);
  assert.throws(
    () => store.transaction((tx) => insertRegistration(tx, CLIENT, NOW)),
    /UNIQUE constraint failed/,
  );
  const failure = new Error("rollback");
  assert.throws(
    () =>
      store.transaction((tx) => {
        endRegistration(tx, registration.runtime_identity, ENDED);
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.client_id), registration);
});

test("counts, group endings and descending cursor pages respect both group keys", (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    const a = insertRegistration(tx, CLIENT, NOW);
    const b = insertRegistration(tx, { ...CLIENT, client_id: "client-b" }, NOW);
    const c = insertRegistration(
      tx,
      { ...CLIENT, client_id: "client-c", project_id: "project-b" },
      NOW,
    );
    const d = insertRegistration(
      tx,
      {
        ...CLIENT,
        client_id: "client-d",
        resource_identity: "worker:kanthord:other",
      },
      NOW,
    );
    assert.equal(
      countLive(tx, CLIENT.project_id, CLIENT.resource_identity),
      LIVE_REGISTRATION_COUNT,
    );
    const filter = {
      project_id: CLIENT.project_id,
      resource_identity: CLIENT.resource_identity,
      limit: REGISTRATION_PAGE_LIMIT,
    };
    const expected = [a.runtime_identity, b.runtime_identity].sort().reverse();
    const page = listLive(tx, filter);
    assert.deepEqual(
      page.map((entry) => entry.runtime_identity),
      expected,
    );
    assert.deepEqual(
      listLive(tx, { ...filter, cursor: expected[0] }).map(
        (entry) => entry.runtime_identity,
      ),
      expected.slice(REGISTRATION_PAGE_LIMIT),
    );
    assert.deepEqual(
      endGroup(tx, CLIENT.project_id, CLIENT.resource_identity, ENDED).sort(),
      expected.sort(),
    );
    assert.equal(
      countLive(tx, CLIENT.project_id, CLIENT.resource_identity),
      NO_ROWS_AFFECTED,
    );
    assert.deepEqual(
      readAllLive(tx)
        .map((entry) => entry.runtime_identity)
        .sort(),
      [c.runtime_identity, d.runtime_identity].sort(),
    );
    assert.equal(readRow(tx, a.runtime_identity)!.ended_at, ENDED);
    assert.equal(readRow(tx, "absent"), null);
  });
});
