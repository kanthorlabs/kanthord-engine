import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { workerMigrations } from "./migrations.ts";
import {
  InstancePlacement,
  RegistrationActivity,
  registrationRecordSchema,
  type WorkerBindingOf,
  WorkerErrorCode,
  WorkerHost,
  workerOperations,
} from "./contract.ts";
import {
  endRegistration,
  insertRegistration,
  readAllLive,
} from "./registration-rows.ts";
import {
  listRegistrationRecords,
  registrationRecord,
} from "./registration-record.ts";

const NOW = 1000;
const PROJECT = createIdentity("project");
const RESOURCE = "worker:kanthord:general";
const NATIVE = "coder@1";
const PLACEMENT = "worker";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const BINDING = {
  binding_id: "binding",
  name: "test_worker",
  project_name: "test_project",
  revision: 1,
  worker_name: "coder@1",
  instance_count: 3,
  placement: InstancePlacement.Worker,
  generation: 1,
  resource_budget: null,
  entries: [],
  tombstone: false,
};

test("registration output enforces host, registration and activity field presence", () => {
  const record = {
    runtime_identity: createIdentity("worker_registration"),
    project_id: PROJECT,
    resource_identity: RESOURCE,
    worker_name: NATIVE,
    host: WorkerHost.Kanthord,
    placement: PLACEMENT,
    registered: true,
    client_id: createIdentity("client_identity"),
    name: "worker-a",
    instance: null,
    activity: RegistrationActivity.Idle,
    draining: false,
  };
  assert.equal(registrationRecordSchema.safeParse(record).success, true);
  for (const change of [
    { placement: undefined },
    { host: WorkerHost.ExternalHarness },
    { client_id: undefined },
    { name: undefined },
    { registered: false },
    { activity: RegistrationActivity.Executing },
    { execution_id: createIdentity("execution") },
  ])
    assert.equal(
      registrationRecordSchema.safeParse({ ...record, ...change }).success,
      false,
    );
  const external = {
    ...record,
    host: WorkerHost.ExternalHarness,
    placement: undefined,
    activity: RegistrationActivity.Executing,
    execution_id: createIdentity("execution"),
  };
  assert.equal(registrationRecordSchema.safeParse(external).success, true);
  assert.equal(
    registrationRecordSchema.safeParse({
      ...record,
      registered: false,
      client_id: undefined,
      name: undefined,
    }).success,
    true,
  );
});

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([{ service: "worker", migrations: workerMigrations }]);
  return store;
}

test("registration records distinguish native/external placement and pure Scheduler activity", (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    const registration = insertRegistration(
      tx,
      {
        project_id: PROJECT,
        resource_identity: RESOURCE,
        client_id: createIdentity("client_identity"),
        name: "worker-a",
      },
      NOW,
    );
    const executionId = createIdentity("execution");
    const before = readAllLive(tx);
    for (const workerName of ["coder@1", "claude-code@1"])
      for (const activity of Object.values(RegistrationActivity)) {
        const record = registrationRecord(
          tx,
          {
            workerBindingOf: () => ({ ...BINDING, worker_name: workerName }),
            schedulerClaims: {
              agentSelectionsOf: () => [],
              agentPinsOf: () => null,
              unendedExecutionOf: () => null,
              requireRunning: () => assert.fail("UNEXPECTED_COLLABORATION"),
              runningExecutionOfRuntime: () => {
                throw new Error("read must not settle");
              },
              activityOf: (transaction, runtimeIdentity, now) => {
                assert.equal(transaction, tx);
                assert.equal(runtimeIdentity, registration.runtime_identity);
                assert.equal(now, NOW);
                return { activity, execution_id: executionId };
              },
            },
          },
          registration,
          NOW,
        );
        assert.equal(record.runtime_identity, registration.runtime_identity);
        assert.equal(record.activity, activity);
        assert.equal(record.registered, true);
        assert.equal(record.draining, false);
        assert.equal(
          "execution_id" in record,
          activity === RegistrationActivity.Executing,
        );
        const native = workerName === NATIVE;
        assert.equal("placement" in record, native);
        if (native) assert.equal(record.placement, PLACEMENT);
        assert.equal("token" in record, false);
      }
    assert.deepEqual(readAllLive(tx), before);
  });
});

test("registration inventory pages live rows descending with both filters and canonical cursors", (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    let binding: ReturnType<WorkerBindingOf> = BINDING;
    const dependencies = {
      workerBindingOf: () => binding,
      schedulerClaims: {
        agentSelectionsOf: () => [],
        agentPinsOf: () => null,
        requireRunning: () => assert.fail("UNEXPECTED_COLLABORATION"),
        runningExecutionOfRuntime: () => null,
        unendedExecutionOf: () => null,
        activityOf: () => ({
          activity: RegistrationActivity.Idle,
          execution_id: null,
        }),
      },
    };
    const rows = [RESOURCE, RESOURCE, "worker:kanthord:other"].map(
      (resourceIdentity) =>
        insertRegistration(
          tx,
          {
            project_id: PROJECT,
            resource_identity: resourceIdentity,
            client_id: createIdentity("client_identity"),
            name: "worker",
          },
          NOW,
        ),
    );
    const otherProject = insertRegistration(
      tx,
      {
        project_id: createIdentity("project"),
        resource_identity: RESOURCE,
        client_id: createIdentity("client_identity"),
        name: "other",
      },
      NOW,
    );
    const limit = 1;
    const query = { project_id: PROJECT, resource_identity: RESOURCE, limit };
    const first = listRegistrationRecords(tx, dependencies, query, NOW);
    const expected = rows
      .filter((row) => row.resource_identity === RESOURCE)
      .map((row) => row.runtime_identity)
      .sort()
      .reverse();
    assert.deepEqual(
      first.items.map((row) => row.runtime_identity),
      expected.slice(0, limit),
    );
    assert.ok(first.next_cursor);
    const second = listRegistrationRecords(
      tx,
      dependencies,
      { ...query, cursor: first.next_cursor },
      NOW,
    );
    assert.deepEqual(
      second.items.map((row) => row.runtime_identity),
      expected.slice(limit),
    );
    assert.equal(second.next_cursor, null);
    const allLimit = 100;
    assert.equal(
      listRegistrationRecords(
        tx,
        dependencies,
        { project_id: PROJECT, limit: allLimit },
        NOW,
      ).items.length,
      rows.length,
    );
    endRegistration(tx, otherProject.runtime_identity, NOW);
    assert.equal(
      listRegistrationRecords(tx, dependencies, { limit: allLimit }, NOW).items
        .length,
      rows.length,
    );
    for (const cursor of [
      "invalid",
      `${first.next_cursor}=`,
      Buffer.from("wrong").toString("base64url"),
    ])
      assert.throws(
        () =>
          listRegistrationRecords(tx, dependencies, { ...query, cursor }, NOW),
        (error) =>
          error instanceof OperationError && error.code === CURSOR_INVALID,
      );
    for (const unavailable of [null, { ...BINDING, tombstone: true }]) {
      binding = unavailable;
      assert.throws(
        () => listRegistrationRecords(tx, dependencies, query, NOW),
        (error) =>
          error instanceof OperationError &&
          error.code === WorkerErrorCode.BindingUnknown,
      );
    }
    assert.equal(
      workerOperations["registration.list"].input.safeParse({
        params: {},
        query: { resource_identity: RESOURCE },
        body: null,
      }).success,
      false,
    );
  });
});
