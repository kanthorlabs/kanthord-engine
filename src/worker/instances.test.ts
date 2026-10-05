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
  clientId: "client-a",
  name: "Worker A",
  projectId: "project-a",
  resourceIdentity: "worker:kanthord:main",
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
    identitySchema("worker_instance").safeParse(registration.runtimeIdentity)
      .success,
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.clientId), registration);
  store.transaction((tx) => {
    assert.deepEqual(readLiveOfClient(tx, CLIENT.clientId), registration);
    assert.equal(
      endRegistration(tx, registration.runtimeIdentity, ENDED),
      ROWS_ENDED,
    );
    assert.equal(
      endRegistration(tx, registration.runtimeIdentity, ENDED + NEXT_TIMESTAMP),
      NO_ROWS_AFFECTED,
    );
    assert.equal(readRow(tx, registration.runtimeIdentity)!.endedAt, ENDED);
    assert.equal(readLiveOfClient(tx, CLIENT.clientId), undefined);
  });
  assert.equal(readLiveByClient(store, CLIENT.clientId), undefined);
  store.transaction((tx) =>
    reopenRegistration(tx, registration.runtimeIdentity),
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.clientId), registration);
  assert.throws(
    () => store.transaction((tx) => insertRegistration(tx, CLIENT, NOW)),
    /UNIQUE constraint failed/,
  );
  const failure = new Error("rollback");
  assert.throws(
    () =>
      store.transaction((tx) => {
        endRegistration(tx, registration.runtimeIdentity, ENDED);
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(readLiveByClient(store, CLIENT.clientId), registration);
});

test("counts, group endings and descending cursor pages respect both group keys", (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    const a = insertRegistration(tx, CLIENT, NOW);
    const b = insertRegistration(tx, { ...CLIENT, clientId: "client-b" }, NOW);
    const c = insertRegistration(
      tx,
      { ...CLIENT, clientId: "client-c", projectId: "project-b" },
      NOW,
    );
    const d = insertRegistration(
      tx,
      {
        ...CLIENT,
        clientId: "client-d",
        resourceIdentity: "worker:kanthord:other",
      },
      NOW,
    );
    assert.equal(
      countLive(tx, CLIENT.projectId, CLIENT.resourceIdentity),
      LIVE_REGISTRATION_COUNT,
    );
    const filter = {
      projectId: CLIENT.projectId,
      resourceIdentity: CLIENT.resourceIdentity,
      limit: REGISTRATION_PAGE_LIMIT,
    };
    const expected = [a.runtimeIdentity, b.runtimeIdentity].sort().reverse();
    const page = listLive(tx, filter);
    assert.deepEqual(
      page.map((entry) => entry.runtimeIdentity),
      expected,
    );
    assert.deepEqual(
      listLive(tx, { ...filter, cursor: expected[0] }).map(
        (entry) => entry.runtimeIdentity,
      ),
      expected.slice(REGISTRATION_PAGE_LIMIT),
    );
    assert.deepEqual(
      endGroup(tx, CLIENT.projectId, CLIENT.resourceIdentity, ENDED).sort(),
      expected.sort(),
    );
    assert.equal(
      countLive(tx, CLIENT.projectId, CLIENT.resourceIdentity),
      NO_ROWS_AFFECTED,
    );
    assert.deepEqual(
      readAllLive(tx)
        .map((entry) => entry.runtimeIdentity)
        .sort(),
      [c.runtimeIdentity, d.runtimeIdentity].sort(),
    );
    assert.equal(readRow(tx, a.runtimeIdentity)!.endedAt, ENDED);
    assert.equal(readRow(tx, "absent"), null);
  });
});
