import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { MissionErrorCode } from "./contract.ts";
import { guardEnvironmentMix } from "./environment-mix.ts";

const SINGLE_CALL = 1;
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const REPOSITORY_ID = "binding_00000000000000000000000001";
const OTHER_REPOSITORY_ID = "binding_00000000000000000000000002";
const STORAGE = "binding_00000000000000000000000003";
const IDENTITIES: Record<string, string> = {
  [REPOSITORY_ID]: "repository:github:owner/first",
  [OTHER_REPOSITORY_ID]: "repository:github:owner/second",
  [STORAGE]: "storage:s3:bucket",
};

function harness(answer: boolean) {
  const reads: string[] = [];
  const calls: Array<{
    tx: Transaction;
    projectId: string;
    identities: readonly string[];
  }> = [];
  const dependencies = {
    bindings: {
      storageBindingOf: () => assert.fail("The guard reads no storage."),
      resolveBinding: () => assert.fail("The guard resolves no name."),
      resolveBindingIdentity: () => assert.fail("The guard resolves no pin."),
      repositoryPolicyOf: () => assert.fail("The guard reads no policy."),
      getBindingRevision: (_tx: Transaction, bindingId: string) => {
        reads.push(bindingId);
        return {
          project_id: PROJECT_ID,
          binding_id: bindingId,
          name: bindingId,
          resource_identity: IDENTITIES[bindingId]!,
          revision: 1,
          tombstone: false,
          disabled: false,
        };
      },
    },
    environments: {
      environmentsMixed: (
        tx: Transaction,
        projectId: string,
        identities: readonly string[],
      ) => {
        calls.push({ tx, projectId, identities });
        return answer;
      },
    },
  };
  return { reads, calls, dependencies };
}

function inTransaction<T>(write: (tx: Transaction) => T): T {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    return store.transaction(write);
  } finally {
    store.close();
  }
}

test("two repository bindings with mixed environments refuse the write", () => {
  const h = harness(true);
  assert.throws(
    () =>
      inTransaction((tx) =>
        guardEnvironmentMix(tx, h.dependencies, PROJECT_ID, [
          REPOSITORY_ID,
          OTHER_REPOSITORY_ID,
        ]),
      ),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.EnvironmentMixed);
      assert.deepEqual(error.details, {
        bindings: [REPOSITORY_ID, OTHER_REPOSITORY_ID],
      });
      return true;
    },
  );
});

test("two repository bindings with equal environments pass", () => {
  const h = harness(false);
  inTransaction((tx) =>
    guardEnvironmentMix(tx, h.dependencies, PROJECT_ID, [
      REPOSITORY_ID,
      OTHER_REPOSITORY_ID,
    ]),
  );
  assert.equal(h.calls.length, SINGLE_CALL);
});

test("one repository binding and one storage binding make no call", () => {
  const h = harness(true);
  inTransaction((tx) =>
    guardEnvironmentMix(tx, h.dependencies, PROJECT_ID, [
      REPOSITORY_ID,
      STORAGE,
    ]),
  );
  assert.deepEqual(h.calls, []);
});

test("no binding makes no call", () => {
  const h = harness(true);
  inTransaction((tx) =>
    guardEnvironmentMix(tx, h.dependencies, PROJECT_ID, []),
  );
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.reads, []);
});

test("the collaboration receives the transaction, the project and the repository identities in node order", () => {
  const h = harness(false);
  const seen = inTransaction((tx) => {
    guardEnvironmentMix(tx, h.dependencies, PROJECT_ID, [
      OTHER_REPOSITORY_ID,
      STORAGE,
      REPOSITORY_ID,
    ]);
    return tx;
  });
  assert.equal(h.calls.length, SINGLE_CALL);
  assert.equal(h.calls[0]?.tx, seen);
  assert.equal(h.calls[0]?.projectId, PROJECT_ID);
  assert.deepEqual(h.calls[0]?.identities, [
    IDENTITIES[OTHER_REPOSITORY_ID],
    IDENTITIES[REPOSITORY_ID],
  ]);
});
