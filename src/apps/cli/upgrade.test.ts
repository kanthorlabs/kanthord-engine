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
import { requirePiTools, temporary } from "../../kernel/test-support.ts";
import {
  DATABASE_FILE,
  TRACKING_DATABASE_FILE,
  enforceMasterKey,
  serverMigrations,
  trackingDatabaseMigrations,
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
const TRACKING_BACKUP_ONLY = 1;
const NO_OUTPUT = "";
const CURRENT_VERSION_LINE = `version: ${CONFIG_VERSION}\n`;
const OLD_KEY = "consecutive_loss_limit";
const NEW_KEY = "consecutive_failure_limit";
const PROMPT_DIRECTORY_LINE = "    agent_directory: agents\n";
const BEHIND_SERVICE = serverMigrations.find(
  ({ migrations }) => migrations.length,
)!;
const SCHEMA_MISMATCH = /system\.database\.migration\.schema_mismatch/;
const RESET_INSTRUCTION =
  /delete kanthord\.db, tracking\.db and their -wal and -shm files in the data directory, and start again/;
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
  const tracking = join(env.XDG_DATA_HOME!, "kanthord", TRACKING_DATABASE_FILE);
  return { env, config: env.KANTHORD_CONFIG!, database, tracking };
}

async function run(
  env: NodeJS.ProcessEnv,
  command: string,
  signal: AbortSignal,
) {
  const { code, stdout, stderr } = await runKanthord([command], env, signal);
  return { status: code, stdout, stderr };
}

function legacyConfig(): string {
  return currentConfig()
    .replace(CURRENT_VERSION_LINE, "")
    .replace(`${NEW_KEY}: 3`, `${OLD_KEY}: 4`)
    .replace(
      PROMPT_DIRECTORY_LINE,
      `${PROMPT_DIRECTORY_LINE}    host_file: true\n`,
    );
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
  requirePiTools();
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);

  const behind = await run(paths.env, "serve", t.signal);
  assert.equal(behind.status, ExitCode.Failure);
  assert.match(behind.stderr, /system\.config\.version_behind/);
  assert.match(behind.stderr, /^command:           kanthord upgrade$/m);

  writePrivate(paths.config, currentConfig(), true);
  const pending = await run(paths.env, "serve", t.signal);
  assert.equal(pending.status, ExitCode.Failure);
  assert.match(pending.stderr, /system\.database\.migration\.pending/);
  assert.match(pending.stderr, /^path:    .+\ncommand: kanthord upgrade\n$/m);
  writePrivate(paths.config, legacy, true);

  const upgraded = await run(paths.env, "upgrade", t.signal);
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
  assert.match(upgraded.stdout, /^removed: +agent\.prompt\.host_file$/m);
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

  const again = await run(paths.env, "upgrade", t.signal);
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
    const { code, stderr } = await spawnKanthord(
      ["upgrade"],
      paths.env,
      t.signal,
    );
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
  const result = await run(paths.env, "upgrade", t.signal);
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

  const refused = await run(paths.env, "upgrade", t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, /system\.config\.master_key_mismatch/);
  assert.match(refused.stderr, /restore the configuration file/);
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
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
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

test("upgrade refuses a tracking.db of another migration text before any backup or write", async (t) => {
  const paths = layout(temporary(t));
  const legacy = legacyConfig();
  writePrivate(paths.config, legacy);
  olderDatabase(paths.database);
  const foreign = new Store(paths.tracking);
  foreign.migrate(
    trackingDatabaseMigrations.map(({ service, migrations }) => ({
      service,
      migrations: [
        (database) => {
          migrations[0]!(database);
          database.exec("CREATE TABLE tracking_scratch_extra (value TEXT)");
        },
      ],
    })),
  );
  foreign.close();
  const before = new Store(paths.database);
  const history = before.database.prepare("SELECT * FROM migration").all();
  before.close();

  const refused = await run(paths.env, "upgrade", t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, SCHEMA_MISMATCH);
  assert.match(refused.stderr, /tracking\.db/);
  assert.match(refused.stderr, /scratch_extra/);
  assert.match(refused.stderr, RESET_INSTRUCTION);
  assert.equal(refused.stdout, NO_OUTPUT);
  assert.equal(readFileSync(paths.config, "utf8"), legacy);
  assert.deepEqual(readdirSync(join(paths.env.XDG_CONFIG_HOME!, "kanthord")), [
    "kanthord.yaml",
  ]);
  assert.deepEqual(
    readdirSync(join(paths.env.XDG_DATA_HOME!, "kanthord")).sort(),
    [DATABASE_FILE, TRACKING_DATABASE_FILE],
  );
  const after = new Store(paths.database);
  assert.deepEqual(
    after.database.prepare("SELECT * FROM migration").all(),
    history,
  );
  after.close();
});

test("upgrade refuses a newer migration history before it writes anything", async (t) => {
  const paths = layout(temporary(t));
  const current = currentConfig();
  writePrivate(paths.config, current);
  const newer = new Store(paths.database);
  newer.migrate(
    serverMigrations.map((entry) =>
      entry.service === BEHIND_SERVICE.service
        ? {
            ...entry,
            migrations: [
              ...entry.migrations,
              (database) =>
                database.exec(
                  `CREATE TABLE ${entry.service}_newer_extra (value TEXT)`,
                ),
            ],
          }
        : entry,
    ),
  );
  newer.close();
  const before = new Store(paths.database);
  const history = before.database.prepare("SELECT * FROM migration").all();
  before.close();

  const refused = await run(paths.env, "upgrade", t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(
    refused.stderr,
    /system\.database\.migration\.incompatible_history/,
  );
  assert.doesNotMatch(refused.stderr, RESET_INSTRUCTION);
  assert.equal(refused.stdout, NO_OUTPUT);
  assert.equal(readFileSync(paths.config, "utf8"), current);
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

test("upgrade applies a pending tracking.db service with a backup", async (t) => {
  const paths = layout(temporary(t));
  writePrivate(paths.config, currentConfig());
  const server = new Store(paths.database);
  server.migrate(serverMigrations);
  server.close();
  const empty = new Store(paths.tracking);
  empty.migrate([]);
  empty.close();

  const upgraded = await run(paths.env, "upgrade", t.signal);
  assert.equal(upgraded.status, ExitCode.Success, upgraded.stderr);
  const backups = [...upgraded.stdout.matchAll(/^backup: +(.+)$/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(backups.length, TRACKING_BACKUP_ONLY);
  assert.match(
    backups[0]!,
    new RegExp(`${TRACKING_DATABASE_FILE}\\.bak-\\d{8}T\\d{6}$`),
  );
  assert.equal(statSync(backups[0]!).mode & 0o7777, PRIVATE_FILE_MODE);
  assert.match(upgraded.stdout, /^migrated: +tracking 0 -> 1$/m);
  const store = new Store(paths.tracking);
  assert.deepEqual(store.plan(trackingDatabaseMigrations).pending, []);
  store.close();
  const copy = new Store(backups[0]!);
  assert.deepEqual(
    copy.plan(trackingDatabaseMigrations).pending.map(({ service }) => service),
    ["tracking"],
  );
  copy.close();

  const again = await run(paths.env, "upgrade", t.signal);
  assert.equal(again.status, ExitCode.Success, again.stderr);
  assert.equal(again.stdout, `up_to_date:     ${paths.config}\n`);
});

test("upgrade keeps a missing tracking.db missing", async (t) => {
  const paths = layout(temporary(t));
  writePrivate(paths.config, currentConfig());
  const server = new Store(paths.database);
  server.migrate(serverMigrations);
  server.close();

  const result = await run(paths.env, "upgrade", t.signal);
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `up_to_date:     ${paths.config}\n`);
  assert.deepEqual(readdirSync(join(paths.env.XDG_DATA_HOME!, "kanthord")), [
    DATABASE_FILE,
  ]);
});
