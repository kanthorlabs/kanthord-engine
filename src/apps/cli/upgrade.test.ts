import assert from "node:assert/strict";
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
import {
  DATABASE_FILE,
  enforceMasterKey,
  serverMigrations,
} from "../server/index.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ExitCode } from "./constants.ts";
import { upgrade } from "./upgrade.ts";
import { runKanthord, spawnKanthord } from "./test-support.ts";

const PRIVATE_FILE_MODE = 0o600;
const FIXED_NOW = "2026-10-18T00:36:01.000Z";
const FIXED_STAMP = "20261018T003601";
const BACKUP_FAILED = "system.database.backup_failed";
const CONFIGURATION_BACKUP_ONLY = 1;
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

async function run(env: NodeJS.ProcessEnv, command: string) {
  const { code, stdout, stderr } = await runKanthord([command], env);
  return { status: code, stdout, stderr };
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

test("serve refuses an older configuration and an older database, and upgrade brings both to the binary with backups", async (t) => {
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);

  const behind = await run(paths.env, "serve");
  assert.equal(behind.status, ExitCode.Failure);
  assert.match(behind.stderr, /system\.config\.version_behind/);
  assert.match(behind.stderr, /Run kanthord upgrade/);

  writePrivate(paths.config, currentConfig(), true);
  const pending = await run(paths.env, "serve");
  assert.equal(pending.status, ExitCode.Failure);
  assert.match(pending.stderr, /system\.database\.migration\.pending/);
  writePrivate(paths.config, legacy, true);

  const upgraded = await run(paths.env, "upgrade");
  assert.equal(upgraded.status, ExitCode.Success, upgraded.stderr);
  const backups = [...upgraded.stdout.matchAll(/^backup: +(.+)$/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(backups.length, BACKUPS_OF_CONFIGURATION_AND_DATABASE);
  assert.equal(readFileSync(backups[0]!, "utf8"), legacy);
  for (const backup of backups)
    assert.equal(statSync(backup).mode & 0o7777, PRIVATE_FILE_MODE);
  assert.match(
    upgraded.stdout,
    new RegExp(`^migrated: +${BEHIND_SERVICE.service} \\d+ -> \\d+$`, "m"),
  );
  assert.match(
    upgraded.stdout,
    new RegExp(`^renamed: +mission\\.${OLD_KEY} -> mission\\.${NEW_KEY}$`, "m"),
  );
  assert.equal(loadConfig(paths.config).version, CONFIG_VERSION);
  assert.match(
    upgraded.stdout,
    new RegExp(
      `^upgraded: +${paths.config}\nconfig_version: \\d+ -> ${CONFIG_VERSION}\n$`,
      "m",
    ),
  );
  const valueColumns = upgraded.stdout
    .trimEnd()
    .split("\n")
    .map((line) => line.search(/(?<=^[a-z_]+: +)\S/));
  assert.deepEqual(new Set(valueColumns), new Set(["config_version: ".length]));
  const store = new Store(paths.database);
  assert.deepEqual(store.plan(serverMigrations).pending, []);
  store.close();
  const copy = new Store(backups[1]!);
  assert.deepEqual(copy.plan(olderMigrations).pending, []);
  copy.close();

  const again = await run(paths.env, "upgrade");
  assert.equal(again.status, ExitCode.Success, again.stderr);
  assert.equal(again.stdout, `up_to_date:     ${paths.config}\n`);
});

test("upgrade changes nothing while another process holds the database", async (t) => {
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);
  const holder = new Store(paths.database);
  try {
    const { code, stderr } = await spawnKanthord(["upgrade"], paths.env);
    const locked = { status: code, stderr };
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

test("upgrade refuses a configuration version newer than the binary and writes nothing", async (t) => {
  const paths = layout(temporary(t));
  const newer = initialConfig().replace(
    CURRENT_VERSION_LINE,
    `version: ${CONFIG_VERSION + 1}\n`,
  );
  writePrivate(paths.config, newer);
  const result = await run(paths.env, "upgrade");
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /system\.config\.version_ahead/);
  assert.equal(readFileSync(paths.config, "utf8"), newer);
  assert.deepEqual(readdirSync(join(paths.env.XDG_DATA_HOME!, "kanthord")), []);
});

test("upgrade refuses another master_key before the backups and the migrations", async (t) => {
  const paths = layout(temporary(t));
  const otherService = serverMigrations.find(
    ({ service, migrations }) =>
      service !== BEHIND_SERVICE.service && migrations.length,
  )!;
  const store = new Store(paths.database);
  store.migrate(
    serverMigrations.map((entry) =>
      entry.service === otherService.service
        ? { ...entry, migrations: entry.migrations.slice(0, -1) }
        : entry,
    ),
  );
  enforceMasterKey(store, Buffer.alloc(32, 1).toString("base64"), paths.config);
  const history = store.database.prepare("SELECT * FROM migration").all();
  store.close();
  const foreign = currentConfig().replace(
    /^master_key: .*$/m,
    `master_key: ${Buffer.alloc(32, 2).toString("base64")}`,
  );
  writePrivate(paths.config, foreign);

  const refused = await run(paths.env, "upgrade");
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, /system\.config\.master_key_mismatch/);
  assert.match(refused.stderr, /Restore the configuration file/);
  assert.equal(readFileSync(paths.config, "utf8"), foreign);
  assert.deepEqual(readdirSync(join(paths.env.XDG_CONFIG_HOME!, "kanthord")), [
    "kanthord.yaml",
  ]);
  assert.deepEqual(readdirSync(join(paths.env.XDG_DATA_HOME!, "kanthord")), [
    DATABASE_FILE,
  ]);
  const after = new Store(paths.database);
  assert.deepEqual(
    after.database.prepare("SELECT * FROM migration").all(),
    history,
  );
  after.close();
});

test("upgrade writes each row when it happens, before a later step fails", async (t) => {
  const paths = layout(temporary(t));
  writePrivate(paths.config, legacyConfig());
  olderDatabase(paths.database);
  const now = new Date(FIXED_NOW);
  writePrivate(`${paths.database}.bak-${FIXED_STAMP}`, "");
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = paths.env.XDG_DATA_HOME;
  t.after(() => {
    process.env.XDG_DATA_HOME = previous;
  });
  const written: string[] = [];
  await assert.rejects(
    upgrade(paths.config, (text) => written.push(text), now),
    (error) =>
      error instanceof Diagnostic &&
      error.code === BACKUP_FAILED &&
      written.length === CONFIGURATION_BACKUP_ONLY,
  );
  assert.deepEqual(written, [
    `backup:         ${paths.config}.bak-${FIXED_STAMP}\n`,
  ]);
});
