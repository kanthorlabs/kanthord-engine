import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { writePrivate } from "../kernel/files.ts";
import { parseMapping } from "../kernel/yaml.ts";
import { diagnosticText, temporary } from "../kernel/test-support.ts";
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
const MIGRATED_SERVER_LIMIT = 8;
const PROMPT_FILES_VERSION = 2;
const PROMPT_DIRECTORY_LINE = "  prompt:\n    agent_directory: agents\n";

function legacyConfig(): string {
  return `${COMMENT}\n${initialConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(`${NEW_KEY}: 3`, `${OLD_KEY}: ${MIGRATED_LIMIT}`)}`;
}

function failsWith(code: string, text?: string) {
  return (error: unknown) =>
    error instanceof Diagnostic &&
    error.code === code &&
    (text === undefined || diagnosticText(error).includes(text));
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
      `the configuration version is older than this binary; run the command\nconfig_version:    ${LEGACY_VERSION}\nsupported_version: ${CONFIG_VERSION}\ncommand:           kanthord upgrade\n`,
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
    failsWith(VERSION_AHEAD, "install a newer kanthord"),
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
      failsWith(INVALID_FIELD, "invalid or missing value\nfield: version\n"),
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
    { kind: "rename", from: `mission.${OLD_KEY}`, to: `mission.${NEW_KEY}` },
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
    {
      kind: "rename",
      from: "gateway.token_version",
      to: "gateway.auth.version",
    },
    {
      kind: "rename",
      from: "gateway.token_lifetime",
      to: "gateway.auth.token_lifetime",
    },
  ]);
  assert.ok(!upgrade.content!.includes("token_version"));
  assert.deepEqual(
    configuration(parseMapping(upgrade.content!)).getProperties().gateway.auth,
    { version: MIGRATED_VERSION, token_lifetime: MIGRATED_LIFETIME },
  );
});

test("upgrade removes the system file and the host file keys of the agent prompt", () => {
  const legacy = initialConfig()
    .replace(CURRENT_VERSION_LINE, `version: ${PROMPT_FILES_VERSION}\n`)
    .replace(
      PROMPT_DIRECTORY_LINE,
      `  prompt:\n    system_file: ""\n${PROMPT_DIRECTORY_LINE.slice("  prompt:\n".length)}    host_file: true\n`,
    );
  assert.ok(legacy.includes("host_file"));
  const upgrade = upgradeConfig(legacy);
  assert.equal(upgrade.from, PROMPT_FILES_VERSION);
  assert.equal(upgrade.to, CONFIG_VERSION);
  assert.deepEqual(upgrade.changes, [
    { kind: "removal", key: "agent.prompt.system_file" },
    { kind: "removal", key: "agent.prompt.host_file" },
  ]);
  assert.ok(upgrade.content!.includes(PROMPT_DIRECTORY_LINE));
  assert.ok(!upgrade.content!.includes("system_file"));
  assert.ok(!upgrade.content!.includes("host_file"));
  assert.deepEqual(
    configuration(parseMapping(upgrade.content!)).getProperties().agent.prompt,
    { agent_directory: "agents" },
  );
});

test("upgrade renames the server slot limit to the server instance limit and raises the version by one", () => {
  const previous = CONFIG_VERSION - 1;
  const current = initialConfig();
  assert.ok(current.includes("  server_instance_limit: 16\n"));
  const legacy = current
    .replace(CURRENT_VERSION_LINE, `version: ${previous}\n`)
    .replace(
      "  server_instance_limit: 16\n",
      `  server_slot_limit: ${MIGRATED_SERVER_LIMIT}\n`,
    );
  const upgrade = upgradeConfig(legacy);
  assert.equal(upgrade.from, previous);
  assert.equal(upgrade.to, CONFIG_VERSION);
  assert.deepEqual(upgrade.changes, [
    {
      kind: "rename",
      from: "worker.server_slot_limit",
      to: "worker.server_instance_limit",
    },
  ]);
  assert.ok(!upgrade.content!.includes("server_slot_limit"));
  assert.equal(
    configuration(parseMapping(upgrade.content!)).getProperties().worker
      .server_instance_limit,
    MIGRATED_SERVER_LIMIT,
  );
});
