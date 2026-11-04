import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createIdempotencyKey } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import {
  DAY_MS,
  FootprintErrorCode,
  FootprintKind,
  type FootprintMeasure,
} from "./contract.ts";
import { ServerHost } from "./server-host.ts";
import { footprintFixture, NOW } from "./test-support.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";

const HUMAN = testHumanIdentity("ulrich", "Ulrich", "jti-ulrich");

const ROWS = 200;
const NO_BYTES = 0;
const BACKUP_FILES = 3;
const SHARED_DISKS = 1;
const ROW_BYTES = 2000;

function host(t: TestContext) {
  const directory = temporary(t);
  const databasePath = join(directory, "kanthord.db");
  const store = new Store(databasePath);
  stopAfter(t, () => store.close());
  const serverHost = new ServerHost({
    store,
    databasePath,
    trackingDatabasePath: join(directory, "tracking.db"),
    configPath: join(directory, "kanthord.yaml"),
    stateDirectory: directory,
    breakdownRows: {},
    now: () => NOW,
  });
  return { directory, store, serverHost };
}

function kind(measures: readonly FootprintMeasure[], name: FootprintKind) {
  return measures.filter((measure) => measure.kind === name);
}

test("the operational database reports used bytes, the freelist and wal_bytes", async (t) => {
  const { store, serverHost } = host(t);
  store.transaction((tx) => {
    tx.database.exec("CREATE TABLE sample (value TEXT)");
    const insert = tx.database.prepare("INSERT INTO sample VALUES (?)");
    for (let index = 0; index < ROWS; index++)
      insert.run("x".repeat(ROW_BYTES));
  });
  store.transaction((tx) => tx.database.exec("DELETE FROM sample"));
  const [database] = kind(
    await serverHost.measure(),
    FootprintKind.OperationalDatabase,
  );
  assert.ok((database?.free_bytes ?? NO_BYTES) > NO_BYTES);
  assert.ok((database?.wal_bytes ?? NO_BYTES) > NO_BYTES);
  assert.ok((database?.bytes ?? NO_BYTES) > NO_BYTES);
  assert.equal(database?.measure_error, null);
});

test("the newest backup of each file is kept and out of the candidates", async (t) => {
  const { directory, serverHost } = host(t);
  const names = [
    "kanthord.db.bak-20260901T101500",
    "kanthord.db.bak-20261001T101500",
    "tracking.db.bak-20260901T101500",
  ];
  names.forEach((name, index) => {
    writeFileSync(join(directory, name), "x");
    const at = (NOW - (60 - index * 10) * DAY_MS) / 1000;
    utimesSync(join(directory, name), at, at);
  });
  writeFileSync(join(directory, "other.bak-20260901T101500"), "x");
  const [backup] = kind(
    await serverHost.measure(),
    FootprintKind.DatabaseBackup,
  );
  assert.equal(backup?.count, BACKUP_FILES);
  const items = await serverHost.candidates({
    kind: "database_backup",
    instance_name: null,
    rule: null,
    offset: 0,
    limit: 10,
    now: NOW,
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(
    items.items
      .filter((item) => item.kept)
      .map((item) => item.key)
      .sort(),
    [names[1], names[2]],
  );
  const candidates = await serverHost.candidates({
    kind: "database_backup",
    instance_name: null,
    rule: { name: "older_than", older_than_days: 30 },
    offset: 0,
    limit: 10,
    now: NOW,
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(
    candidates.items.map((item) => item.key),
    [names[0]],
  );
});

test("D and S on one device give one disk statistic", async (t) => {
  const { serverHost } = host(t);
  const disks = kind(await serverHost.measure(), FootprintKind.Disk);
  assert.equal(disks.length, SHARED_DISKS);
  assert.ok((disks[0]?.total_bytes ?? NO_BYTES) > NO_BYTES);
});

test("footprint.backup.delete refuses a name outside the backup form and removes a backup", async (t) => {
  const fixture = footprintFixture(t);
  const name = "kanthord.db.bak-20261001T101500";
  writeFileSync(join(fixture.directory, name), "x");
  for (const names of [["../kanthord.db"], ["kanthord.db"]]) {
    const refused = await fixture.footprint["backup.delete"](
      { params: {}, query: {}, body: { names } },
      { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
    );
    assert.equal(refused.type, OperationResultType.Failure);
    assert.equal(refused.error.error.code, FootprintErrorCode.ValidationFailed);
  }
  const removed = await fixture.footprint["backup.delete"](
    {
      params: {},
      query: {},
      body: { names: [name, "tracking.db.bak-20261001T101500"] },
    },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(removed.type, OperationResultType.Completed);
  assert.deepEqual(removed.data, { removed: 1, absent: 1 });
});

test("footprint.backup.delete leaves a symlink with a backup name and its target", async (t) => {
  const fixture = footprintFixture(t);
  const outside = temporary(t);
  const target = join(outside, "kept");
  writeFileSync(target, "x");
  const name = "kanthord.db.bak-20261002T101500";
  symlinkSync(target, join(fixture.directory, name));
  const answer = await fixture.footprint["backup.delete"](
    { params: {}, query: {}, body: { names: [name] } },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(answer.type, OperationResultType.Completed);
  assert.deepEqual(answer.data, { removed: 0, absent: 1 });
  assert.ok(lstatSync(join(fixture.directory, name)).isSymbolicLink());
  assert.ok(existsSync(target));
});

test("a failed disk measure keeps the device key of its last measure and holds no path", async (t) => {
  const { serverHost, directory } = host(t);
  const key = kind(await serverHost.measure(), FootprintKind.Disk).at(
    0,
  )?.item_key;
  rmSync(directory, { recursive: true, force: true });
  const failed = kind(await serverHost.measure(), FootprintKind.Disk);
  assert.deepEqual(
    failed.map((measure) => [measure.item_key, measure.measure_error?.code]),
    [[key, "footprint.disk.unmeasured"]],
  );
});
