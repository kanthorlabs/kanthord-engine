import { timingSafeEqual } from "node:crypto";
import { Diagnostic } from "../kernel/errors.ts";
import { deriveKey } from "../kernel/json.ts";
import type { Store, Transaction } from "../kernel/store.ts";

export const KEY_CHECK_LABEL = "custody/key-check/v1";
export const MASTER_KEY_TABLE = "custody_master_key";
export const MASTER_KEY_MISMATCH_CODE = "system.config.master_key_mismatch";
const MASTER_KEY_ROW_ID = 1;

export function masterKeyVerifier(masterKey: string): Buffer {
  return deriveKey(masterKey, KEY_CHECK_LABEL);
}

function storedVerifier(tx: Transaction): Buffer | null {
  const exists = tx.database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(MASTER_KEY_TABLE);
  if (!exists) return null;
  const row = tx.database
    .prepare(`SELECT verifier FROM ${MASTER_KEY_TABLE} WHERE id = ?`)
    .get(MASTER_KEY_ROW_ID);
  return row ? Buffer.from(row.verifier as Uint8Array) : null;
}

function verifyIn(
  tx: Transaction,
  store: Store,
  masterKey: string,
  configPath: string,
): boolean {
  const stored = storedVerifier(tx);
  if (stored === null) return false;
  const expected = masterKeyVerifier(masterKey);
  if (stored.length === expected.length && timingSafeEqual(stored, expected))
    return true;
  throw new Diagnostic(
    MASTER_KEY_MISMATCH_CODE,
    "master_key does not match the database; restore the configuration file that created the database, or the database backup that matches the configuration file",
    {
      fields: [
        ["database", store.path],
        ["config", configPath],
      ],
    },
  );
}

export function verifyMasterKey(
  store: Store,
  masterKey: string,
  configPath: string,
): boolean {
  return store.transaction((tx) => verifyIn(tx, store, masterKey, configPath));
}

export function enforceMasterKey(
  store: Store,
  masterKey: string,
  configPath: string,
): void {
  store.transaction((tx) => {
    if (verifyIn(tx, store, masterKey, configPath)) return;
    tx.database
      .prepare(
        `INSERT INTO ${MASTER_KEY_TABLE} (id, verifier, created_at) VALUES (?, ?, ?)`,
      )
      .run(MASTER_KEY_ROW_ID, masterKeyVerifier(masterKey), Date.now());
  });
}
