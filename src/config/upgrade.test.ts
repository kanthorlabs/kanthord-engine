import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { writePrivate } from "../kernel/files.ts";
import { parseMapping } from "../kernel/yaml.ts";
import { temporary } from "../kernel/test-support.ts";
import { configuration, initialConfig, loadConfig } from "./index.ts";
import { CONFIG_VERSION } from "./steps.ts";
import { upgradeConfig } from "./upgrade.ts";

const COMMENT = "# keep this comment";
const OLD_KEY = "consecutive_loss_limit";
const NEW_KEY = "consecutive_failure_limit";
const INVALID_FIELD = "system.config.invalid_field";
const RENAME_CONFLICT = "system.config.rename_conflict";
const VERSION_BEHIND = "system.config.version_behind";
const VERSION_AHEAD = "system.config.version_ahead";
const CURRENT_VERSION_LINE = `version: ${CONFIG_VERSION}\n`;
const LEGACY_VERSION = 1;
const MIGRATED_LIMIT = 4;
const MIGRATED_VERSION = 2;
const MIGRATED_LIFETIME = 600;

function legacyConfig(): string {
  return `${COMMENT}\n${initialConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(`${NEW_KEY}: 3`, `${OLD_KEY}: ${MIGRATED_LIMIT}`)}`;
}

function failsWith(code: string, text?: string) {
  return (error: unknown) =>
    error instanceof Diagnostic &&
    error.code === code &&
    (text === undefined || error.message.includes(text));
}

test("config init writes the configuration version of the binary", () => {
  assert.ok(initialConfig().startsWith(CURRENT_VERSION_LINE));
  assert.equal(
    configuration(parseMapping(initialConfig())).getProperties().version,
    CONFIG_VERSION,
  );
});

test("the loader refuses a configuration without a version as version 1 and names the upgrade command", (t) => {
  const path = join(temporary(t), "kanthord.yaml");
  writePrivate(path, legacyConfig());
  assert.throws(
    () => loadConfig(path),
    failsWith(
      VERSION_BEHIND,
      `configuration version ${LEGACY_VERSION} is older than configuration version ${CONFIG_VERSION} of this binary. Run kanthord upgrade.`,
    ),
  );
});

test("the loader refuses a configuration version newer than the binary", () => {
  const newer = initialConfig().replace(
    CURRENT_VERSION_LINE,
    `version: ${CONFIG_VERSION + 1}\n`,
  );
  assert.throws(
    () => configuration(parseMapping(newer)),
    failsWith(VERSION_AHEAD, "Install a newer kanthord"),
  );
  assert.throws(() => upgradeConfig(newer), failsWith(VERSION_AHEAD));
});

test("the loader refuses a version that is not a positive safe integer as an invalid field", () => {
  for (const value of ["0", "null", "two", "1.5"])
    assert.throws(
      () =>
        configuration(
          parseMapping(
            initialConfig().replace(
              CURRENT_VERSION_LINE,
              `version: ${value}\n`,
            ),
          ),
        ),
      failsWith(INVALID_FIELD, "version: invalid or missing value."),
    );
});

test("a current configuration that still holds an old key fails as an undeclared field", () => {
  const stale = initialConfig().replace(
    `${NEW_KEY}: 3`,
    `${NEW_KEY}: 3\n  ${OLD_KEY}: 4`,
  );
  assert.throws(
    () => configuration(parseMapping(stale)),
    failsWith(INVALID_FIELD, "mission: undeclared field."),
  );
});

test("upgrade renames the keys, keeps comments and values, sets the version and is a no-op on its own output", () => {
  const upgrade = upgradeConfig(legacyConfig());
  assert.equal(upgrade.from, LEGACY_VERSION);
  assert.equal(upgrade.to, CONFIG_VERSION);
  assert.deepEqual(upgrade.changes, [
    { from: `mission.${OLD_KEY}`, to: `mission.${NEW_KEY}` },
  ]);
  assert.ok(upgrade.content!.startsWith(COMMENT));
  assert.ok(!upgrade.content!.includes(OLD_KEY));
  const config = configuration(parseMapping(upgrade.content!));
  assert.equal(
    config.getProperties().mission.consecutive_failure_limit,
    MIGRATED_LIMIT,
  );
  assert.deepEqual(upgradeConfig(upgrade.content!), {
    from: CONFIG_VERSION,
    to: CONFIG_VERSION,
    changes: [],
    content: null,
  });
});

test("upgrade of a legacy file without old keys only sets the version", () => {
  const upgrade = upgradeConfig(
    initialConfig().replace(CURRENT_VERSION_LINE, ""),
  );
  assert.deepEqual(upgrade.changes, []);
  assert.ok(upgrade.content!.includes(CURRENT_VERSION_LINE));
});

test("upgrade refuses a file that holds the old and the new key", () => {
  const both = initialConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(`${NEW_KEY}: 3`, `${NEW_KEY}: 3\n  ${OLD_KEY}: 4`);
  assert.throws(() => upgradeConfig(both), failsWith(RENAME_CONFLICT));
});

test("upgrade moves the gateway token keys into the nested auth mapping", () => {
  const nested = `  auth:\n    version: 1\n    token_lifetime: 31536000\n`;
  const flat = initialConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(
      nested,
      `  token_lifetime: ${MIGRATED_LIFETIME}\n  token_version: ${MIGRATED_VERSION}\n`,
    );
  assert.ok(!flat.includes(nested));
  const upgrade = upgradeConfig(flat);
  assert.deepEqual(upgrade.changes, [
    { from: "gateway.token_version", to: "gateway.auth.version" },
    { from: "gateway.token_lifetime", to: "gateway.auth.token_lifetime" },
  ]);
  assert.ok(!upgrade.content!.includes("token_version"));
  assert.deepEqual(
    configuration(parseMapping(upgrade.content!)).getProperties().gateway.auth,
    { version: MIGRATED_VERSION, token_lifetime: MIGRATED_LIFETIME },
  );
});
