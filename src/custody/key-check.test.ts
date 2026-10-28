import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { diagnosticText } from "../kernel/test-support.ts";
import {
  enforceMasterKey,
  MASTER_KEY_MISMATCH_CODE,
  MASTER_KEY_TABLE,
  masterKeyVerifier,
  verifyMasterKey,
} from "./key-check.ts";
import { custodyMigrations } from "./migrations.ts";
import { CUSTODY_SERVICE_NAME } from "./contract.ts";
import { deriveEnvelopeKey } from "./envelope.ts";

const CONFIG_PATH = "/etc/kanthord/kanthord.yaml";
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const ONE_ROW = 1;
const VERIFIER_BYTES = 32;

function migrated(): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  return store;
}

function rows(store: Store) {
  return store.database
    .prepare(`SELECT id, verifier FROM ${MASTER_KEY_TABLE}`)
    .all()
    .map((row) => ({
      id: row.id,
      verifier: Buffer.from(row.verifier as Uint8Array),
    }));
}

test("the verifier derives under its own label and differs from the envelope key", () => {
  assert.equal(masterKeyVerifier(KEY_A).length, VERIFIER_BYTES);
  assert.notDeepEqual(masterKeyVerifier(KEY_A), deriveEnvelopeKey(KEY_A));
  assert.notDeepEqual(masterKeyVerifier(KEY_A), masterKeyVerifier(KEY_B));
});

test("enforce records the first master_key once and accepts it again", () => {
  const store = migrated();
  try {
    assert.equal(verifyMasterKey(store, KEY_A, CONFIG_PATH), false);
    enforceMasterKey(store, KEY_A, CONFIG_PATH);
    enforceMasterKey(store, KEY_A, CONFIG_PATH);
    assert.equal(verifyMasterKey(store, KEY_A, CONFIG_PATH), true);
    assert.deepEqual(rows(store), [
      { id: ONE_ROW, verifier: masterKeyVerifier(KEY_A) },
    ]);
  } finally {
    store.close();
  }
});

test("enforce and verify refuse another master_key and keep the record", () => {
  const store = migrated();
  try {
    enforceMasterKey(store, KEY_A, CONFIG_PATH);
    const before = rows(store);
    for (const check of [enforceMasterKey, verifyMasterKey])
      assert.throws(
        () => check(store, KEY_B, CONFIG_PATH),
        (error: unknown) =>
          error instanceof Diagnostic &&
          error.code === MASTER_KEY_MISMATCH_CODE &&
          diagnosticText(error).includes(`\nconfig:   ${CONFIG_PATH}\n`) &&
          diagnosticText(error).includes(`database: ${store.path}\n`) &&
          error.message.includes("restore the configuration file") &&
          !diagnosticText(error).includes(KEY_B),
      );
    assert.deepEqual(rows(store), before);
  } finally {
    store.close();
  }
});

test("verify tolerates a database without the table", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    assert.equal(verifyMasterKey(store, KEY_A, CONFIG_PATH), false);
  } finally {
    store.close();
  }
});
