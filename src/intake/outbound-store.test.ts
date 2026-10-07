import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { identitySchema } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  INTAKE_SERVICE_NAME,
  OUTBOUND_REQUEST_ID_PREFIX,
  OutboundOperation,
  OutboundRequestState,
  ResultClass,
} from "./contract.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  OutboundKeyConflict,
  discard,
  fail,
  findById,
  findByKey,
  insertPending,
  outboundRecord,
  succeed,
  type PendingOutbound,
} from "./outbound-store.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST_KEY = "request-key-1";
const OTHER_REQUEST_KEY = "request-key-2";
const CREDENTIAL = "github-main";
const CREATED_AT = 1000;
const FIRST_FAILED_AT = 2000;
const SECOND_FAILED_AT = 3000;
const ADDRESS = { url: "https://github.com/acme/app/pull/7", number: 7 };
const OTHER_ADDRESS = { url: "https://github.com/acme/app/pull/8", number: 8 };
const TIMEOUT_CODE = "timeout";
const TIMEOUT_MESSAGE = "The call passed its deadline.";
const STATUS_CODE = "502";
const STATUS_MESSAGE = "Bad gateway.";
const SINGLE_ITEM = 1;

function migratedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return store;
}

function pending(requestKey = REQUEST_KEY): PendingOutbound {
  return {
    project_id: PROJECT_ID,
    operation: OutboundOperation.GitHubPullRequest,
    request_key: requestKey,
    credential: CREDENTIAL,
    created_at: CREATED_AT,
  };
}

function insert(store: Store, requestKey = REQUEST_KEY): string {
  return store.transaction((tx) => insertPending(tx, pending(requestKey)));
}

function stateOf(store: Store, id: string): string | undefined {
  return store.transaction((tx) => findById(tx, id)?.state);
}

function failOnce(store: Store, id: string): boolean {
  return store.transaction((tx) =>
    fail(
      tx,
      id,
      { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE },
      FIRST_FAILED_AT,
    ),
  );
}

test("An insert starts pending with null result and error and answers its identity", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  assert.ok(identitySchema(OUTBOUND_REQUEST_ID_PREFIX).safeParse(id).success);
  const row = store.transaction((tx) =>
    findByKey(tx, OutboundOperation.GitHubPullRequest, REQUEST_KEY),
  );
  assert.deepEqual(
    { ...row },
    {
      id,
      project_id: PROJECT_ID,
      operation: OutboundOperation.GitHubPullRequest,
      request_key: REQUEST_KEY,
      credential: CREDENTIAL,
      state: OutboundRequestState.Pending,
      result: null,
      error: null,
      created_at: CREATED_AT,
    },
  );
  assert.deepEqual(outboundRecord(row!), {
    id,
    project_id: PROJECT_ID,
    operation: OutboundOperation.GitHubPullRequest,
    request_key: REQUEST_KEY,
    state: OutboundRequestState.Pending,
    result: null,
    error: null,
    created_at: CREATED_AT,
  });
});

test("A second insert of one key throws OutboundKeyConflict", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  assert.throws(() => insert(store), OutboundKeyConflict);
  const other = store.transaction((tx) =>
    insertPending(tx, {
      ...pending(),
      operation: OutboundOperation.GitMergePush,
      credential: null,
    }),
  );
  assert.notEqual(other, id);
  assert.equal(
    store.transaction((tx) =>
      findByKey(tx, OutboundOperation.S3DeleteObject, REQUEST_KEY),
    ),
    null,
  );
});

test("An insert propagates a failure other than the key conflict", (t) => {
  const store = migratedStore(t);
  assert.throws(
    () =>
      store.transaction((tx) =>
        insertPending(tx, {
          ...pending(),
          project_id: null as unknown as string,
        }),
      ),
    (error: unknown) =>
      error instanceof Error && !(error instanceof OutboundKeyConflict),
  );
});

test("succeed changes one row from pending and failed and none from a terminal state", (t) => {
  const store = migratedStore(t);
  const sources = [OutboundRequestState.Pending, OutboundRequestState.Failed];
  const fromPending = insert(store);
  assert.equal(
    store.transaction((tx) => succeed(tx, fromPending, ADDRESS, sources)),
    true,
  );
  assert.equal(stateOf(store, fromPending), OutboundRequestState.Succeeded);
  assert.equal(
    store.transaction((tx) => succeed(tx, fromPending, OTHER_ADDRESS, sources)),
    false,
  );
  const record = store.transaction((tx) =>
    outboundRecord(findById(tx, fromPending)!),
  );
  assert.deepEqual(record.result, ADDRESS);

  const fromFailed = insert(store, OTHER_REQUEST_KEY);
  assert.equal(failOnce(store, fromFailed), true);
  assert.equal(
    store.transaction((tx) =>
      succeed(tx, fromFailed, ADDRESS, [OutboundRequestState.Pending]),
    ),
    false,
  );
  assert.equal(
    store.transaction((tx) => succeed(tx, fromFailed, ADDRESS, sources)),
    true,
  );
  assert.equal(stateOf(store, fromFailed), OutboundRequestState.Succeeded);

  const discarded = insert(store, "request-key-3");
  assert.equal(
    store.transaction((tx) => discard(tx, discarded)),
    true,
  );
  assert.equal(
    store.transaction((tx) => succeed(tx, discarded, ADDRESS, sources)),
    false,
  );
  assert.equal(stateOf(store, discarded), OutboundRequestState.Discarded);
});

test("fail changes one row from pending and none from failed", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  assert.equal(failOnce(store, id), true);
  assert.equal(stateOf(store, id), OutboundRequestState.Failed);
  assert.equal(failOnce(store, id), false);
  const record = store.transaction((tx) => outboundRecord(findById(tx, id)!));
  assert.equal(record.error?.length, SINGLE_ITEM);
});

test("discard changes one row from pending only", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  assert.equal(
    store.transaction((tx) => discard(tx, id)),
    true,
  );
  assert.equal(
    store.transaction((tx) => discard(tx, id)),
    false,
  );
  const failed = insert(store, OTHER_REQUEST_KEY);
  assert.equal(failOnce(store, failed), true);
  assert.equal(
    store.transaction((tx) => discard(tx, failed)),
    false,
  );
  assert.equal(stateOf(store, failed), OutboundRequestState.Failed);
});

test("Two failures through two requests keep their own arrays", (t) => {
  const store = migratedStore(t);
  const first = insert(store);
  const second = insert(store, OTHER_REQUEST_KEY);
  assert.equal(failOnce(store, first), true);
  assert.equal(
    store.transaction((tx) =>
      fail(
        tx,
        second,
        { code: STATUS_CODE, message: STATUS_MESSAGE },
        SECOND_FAILED_AT,
      ),
    ),
    true,
  );
  const [firstRecord, secondRecord] = store.transaction((tx) => [
    outboundRecord(findById(tx, first)!),
    outboundRecord(findById(tx, second)!),
  ]);
  assert.deepEqual(firstRecord.error, [
    {
      code: TIMEOUT_CODE,
      message: TIMEOUT_MESSAGE,
      created_at: FIRST_FAILED_AT,
    },
  ]);
  assert.deepEqual(secondRecord.error, [
    {
      code: STATUS_CODE,
      message: STATUS_MESSAGE,
      created_at: SECOND_FAILED_AT,
    },
  ]);
});

test("The projection answers error items with created_at and omits the credential", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  assert.equal(
    store.transaction((tx) =>
      fail(
        tx,
        id,
        { code: ResultClass.UnknownOutcome, message: TIMEOUT_MESSAGE },
        FIRST_FAILED_AT,
      ),
    ),
    true,
  );
  const record = store.transaction((tx) => outboundRecord(findById(tx, id)!));
  assert.equal("credential" in record, false);
  assert.deepEqual(record.error, [
    {
      code: ResultClass.UnknownOutcome,
      message: TIMEOUT_MESSAGE,
      created_at: FIRST_FAILED_AT,
    },
  ]);
  assert.equal(record.result, null);
});
