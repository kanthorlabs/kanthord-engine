import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { writePrivate } from "../kernel/files.ts";
import { temporary } from "../kernel/test-support.ts";
import { initialConfig, loadConfig } from "./index.ts";
import { migrateConfig } from "./migrate.ts";

const PRIVATE_FILE_MODE = 0o600;
const COMMENT = "# keep this comment";
const NOW = new Date("2026-10-10T07:59:30.000Z");
const OLD_KEY = "consecutive_loss_limit";
const NEW_KEY = "consecutive_failure_limit";
const INVALID_FIELD = "system.config.invalid_field";
const RENAME_CONFLICT = "system.config.rename_conflict";
const MIGRATED_LIMIT = 4;
const MIGRATED_VERSION = 2;
const MIGRATED_LIFETIME = 600;

function oldConfig(): string {
  return `${COMMENT}\n${initialConfig().replace(`${NEW_KEY}: 3`, `${OLD_KEY}: 4`)}`;
}

test("the loader names the new key and the migrate command for a renamed key", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  writePrivate(path, oldConfig());
  assert.throws(
    () => loadConfig(path),
    (error: unknown) =>
      error instanceof Diagnostic &&
      error.code === INVALID_FIELD &&
      error.message.includes(
        `mission.${OLD_KEY}: renamed to mission.${NEW_KEY}. Run kanthord config migrate.`,
      ),
  );
});

test("migrate renames the key, keeps comments and values, writes a private backup and runs once", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const original = oldConfig();
  writePrivate(path, original);
  const migration = migrateConfig(path, NOW);
  assert.deepEqual(migration.changes, [
    { from: `mission.${OLD_KEY}`, to: `mission.${NEW_KEY}` },
  ]);
  assert.equal(migration.backup, `${path}.bak-20261010T075930`);
  assert.equal(readFileSync(migration.backup!, "utf8"), original);
  assert.equal(statSync(migration.backup!).mode & 0o7777, PRIVATE_FILE_MODE);
  const migrated = readFileSync(path, "utf8");
  assert.ok(migrated.startsWith(COMMENT));
  assert.ok(!migrated.includes(OLD_KEY));
  assert.equal(
    loadConfig(path).mission.consecutive_failure_limit,
    MIGRATED_LIMIT,
  );
  assert.deepEqual(migrateConfig(path, NOW), { changes: [], backup: null });
});

test("migrate refuses a file that holds the old and the new key and changes nothing", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const both = initialConfig().replace(
    `${NEW_KEY}: 3`,
    `${NEW_KEY}: 3\n  ${OLD_KEY}: 4`,
  );
  writePrivate(path, both);
  assert.throws(
    () => migrateConfig(path, NOW),
    (error: unknown) =>
      error instanceof Diagnostic && error.code === RENAME_CONFLICT,
  );
  assert.equal(readFileSync(path, "utf8"), both);
});

test("migrate moves the gateway token keys into the nested auth mapping", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  const nested = `  auth:\n    version: 1\n    token_lifetime: 31536000\n`;
  const flat = initialConfig().replace(
    nested,
    `  token_lifetime: ${MIGRATED_LIFETIME}\n  token_version: ${MIGRATED_VERSION}\n`,
  );
  assert.notEqual(flat, initialConfig());
  writePrivate(path, flat);
  assert.throws(
    () => loadConfig(path),
    (error: unknown) =>
      error instanceof Diagnostic &&
      error.code === INVALID_FIELD &&
      error.message.includes(
        "gateway.token_version: renamed to gateway.auth.version. Run kanthord config migrate.",
      ) &&
      error.message.includes(
        "gateway.token_lifetime: renamed to gateway.auth.token_lifetime. Run kanthord config migrate.",
      ),
  );
  const migration = migrateConfig(path, NOW);
  assert.deepEqual(migration.changes, [
    { from: "gateway.token_version", to: "gateway.auth.version" },
    { from: "gateway.token_lifetime", to: "gateway.auth.token_lifetime" },
  ]);
  const migrated = readFileSync(path, "utf8");
  assert.ok(!migrated.includes("token_version"));
  assert.ok(
    migrated.includes(
      `  auth:\n    version: ${MIGRATED_VERSION}\n    token_lifetime: ${MIGRATED_LIFETIME}\n`,
    ),
  );
  assert.deepEqual(loadConfig(path).gateway.auth, {
    version: MIGRATED_VERSION,
    token_lifetime: MIGRATED_LIFETIME,
  });
});
