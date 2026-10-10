import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_VERSION,
  initialConfig,
  loadConfig,
} from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { Store } from "../../kernel/store.ts";
import { temporary } from "../../kernel/test-support.ts";
import { DATABASE_FILE, serverMigrations } from "../server/index.ts";
import { ExitCode } from "./constants.ts";

const entry = new URL("../../main.ts", import.meta.url).href;
const PRIVATE_FILE_MODE = 0o600;
const BACKUPS_OF_CONFIGURATION_AND_DATABASE = 2;
const CURRENT_VERSION_LINE = `version: ${CONFIG_VERSION}\n`;
const OLD_KEY = "consecutive_loss_limit";
const NEW_KEY = "consecutive_failure_limit";
const BEHIND_SERVICE = serverMigrations.find(
  ({ migrations }) => migrations.length,
)!;
const olderMigrations = serverMigrations.map((entry) =>
  entry.service === BEHIND_SERVICE.service
    ? { ...entry, migrations: entry.migrations.slice(0, -1) }
    : entry,
);

function layout(directory: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KANTHORD_CONFIG: join(directory, "config", "kanthord", "kanthord.yaml"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  for (const path of [
    env.XDG_CONFIG_HOME!,
    env.XDG_DATA_HOME!,
    env.XDG_STATE_HOME!,
  ])
    mkdirSync(join(path, "kanthord"), { mode: 0o700, recursive: true });
  const database = join(env.XDG_DATA_HOME!, "kanthord", DATABASE_FILE);
  return { env, config: env.KANTHORD_CONFIG!, database };
}

function run(env: NodeJS.ProcessEnv, command: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord','${command}'];await import(${JSON.stringify(entry)});`,
    ],
    { env, encoding: "utf8", timeout: 10000 },
  );
}

function legacyConfig(): string {
  return currentConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(`${NEW_KEY}: 3`, `${OLD_KEY}: 4`);
}

function currentConfig(): string {
  return initialConfig().replace("port: 31415", "port: 0");
}

function olderDatabase(path: string): void {
  const store = new Store(path);
  store.migrate(olderMigrations);
  store.close();
}

test("serve refuses an older configuration and an older database, and upgrade brings both to the binary with backups", (t) => {
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);

  const behind = run(paths.env, "serve");
  assert.equal(behind.status, ExitCode.Failure);
  assert.match(behind.stderr, /system\.config\.version_behind/);
  assert.match(behind.stderr, /Run kanthord upgrade/);

  writePrivate(paths.config, currentConfig(), true);
  const pending = run(paths.env, "serve");
  assert.equal(pending.status, ExitCode.Failure);
  assert.match(pending.stderr, /system\.database\.migration\.pending/);
  writePrivate(paths.config, legacy, true);

  const upgraded = run(paths.env, "upgrade");
  assert.equal(upgraded.status, ExitCode.Success, upgraded.stderr);
  const backups = [...upgraded.stdout.matchAll(/^Backup: (.+)$/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(backups.length, BACKUPS_OF_CONFIGURATION_AND_DATABASE);
  assert.equal(readFileSync(backups[0]!, "utf8"), legacy);
  for (const backup of backups)
    assert.equal(statSync(backup).mode & 0o7777, PRIVATE_FILE_MODE);
  assert.match(
    upgraded.stdout,
    new RegExp(`^Migrated ${BEHIND_SERVICE.service} from version`, "m"),
  );
  assert.match(
    upgraded.stdout,
    new RegExp(`^Renamed mission\\.${OLD_KEY} to mission\\.${NEW_KEY}$`, "m"),
  );
  assert.equal(loadConfig(paths.config).version, CONFIG_VERSION);
  const store = new Store(paths.database);
  assert.deepEqual(store.plan(serverMigrations).pending, []);
  store.close();
  const copy = new Store(backups[1]!);
  assert.deepEqual(copy.plan(olderMigrations).pending, []);
  copy.close();

  const again = run(paths.env, "upgrade");
  assert.equal(again.status, ExitCode.Success, again.stderr);
  assert.equal(again.stdout, `Up to date: ${paths.config}\n`);
});

test("upgrade changes nothing while another process holds the database", (t) => {
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);
  const holder = new Store(paths.database);
  try {
    const locked = run(paths.env, "upgrade");
    assert.equal(locked.status, ExitCode.Failure);
    assert.match(locked.stderr, /database is locked/);
  } finally {
    holder.close();
  }
  assert.equal(readFileSync(paths.config, "utf8"), legacy);
  assert.deepEqual(readdirSync(join(paths.env.XDG_CONFIG_HOME!, "kanthord")), [
    "kanthord.yaml",
  ]);
});

test("upgrade refuses a configuration version newer than the binary and writes nothing", (t) => {
  const paths = layout(temporary(t));
  const newer = initialConfig().replace(
    CURRENT_VERSION_LINE,
    `version: ${CONFIG_VERSION + 1}\n`,
  );
  writePrivate(paths.config, newer);
  const result = run(paths.env, "upgrade");
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /system\.config\.version_ahead/);
  assert.equal(readFileSync(paths.config, "utf8"), newer);
  assert.deepEqual(readdirSync(join(paths.env.XDG_DATA_HOME!, "kanthord")), []);
});
