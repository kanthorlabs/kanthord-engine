import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Store,
  IN_MEMORY_DATABASE,
  type Migrations,
} from "../../kernel/store.ts";
import { gatewayMigrations } from "../../gateway/index.ts";
import { workerMigrations } from "../../worker/index.ts";
import { projectMigrations } from "../../project/index.ts";

const services: Migrations = [
  { service: "gateway", migrations: gatewayMigrations },
  { service: "worker", migrations: workerMigrations },
  { service: "project", migrations: projectMigrations },
];
const HISTORY_TABLE = "migration";
const INTEGRITY_OK = "ok";

function tables(store: Store): string[] {
  return store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name))
    .filter((name) => name !== HISTORY_TABLE);
}

test("service migrations own distinct prefixes and create only tables in their namespace", () => {
  const prefixes = services.map(({ service }) => `${service}_`);
  assert.equal(new Set(prefixes).size, services.length);
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const applied: Migrations[number][] = [];
    for (const service of services) {
      const before = new Set(tables(store));
      applied.push(service);
      store.migrate(applied);
      for (const name of tables(store).filter((name) => !before.has(name))) {
        assert.ok(
          name.startsWith(`${service.service}_`),
          `${service.service} created ${name}`,
        );
        assert.deepEqual(
          prefixes.filter((prefix) => name.startsWith(prefix)),
          [`${service.service}_`],
        );
      }
    }
    assert.deepEqual(tables(store), []);
  } finally {
    store.close();
  }
});

test("each service migration set applies alone to an empty store", () => {
  for (const service of services) {
    const store = new Store(IN_MEMORY_DATABASE);
    try {
      assert.deepEqual(tables(store), []);
      assert.doesNotThrow(() => store.migrate([service]), service.service);
      assert.deepEqual(
        store.database.prepare("PRAGMA foreign_key_check").all(),
        [],
      );
      assert.equal(
        store.database.prepare("PRAGMA integrity_check").get()?.integrity_check,
        INTEGRITY_OK,
      );
    } finally {
      store.close();
    }
  }
});
