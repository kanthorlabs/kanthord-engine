import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { agentKinds } from "../../domain/agent.ts";
import { rows } from "../../domain/rows.ts";
import { blockReasons, nodeKinds, nodeStates } from "../../domain/state.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildMigrated = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations,
  });
  storage.migrate();
  return { storage, temporary };
};

const tableDdl = (storage: SqliteStorage, table: string): string => {
  const row = storage.transact((t) =>
    t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
  ) as { sql: string | null } | undefined;
  assert.ok(row !== undefined && row.sql !== null, `no DDL row for ${table}`);
  return row.sql;
};

const literalListIn = (ddl: string, column: string): readonly string[] => {
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([\\s\\S]*?)\\)`);
  const match = ddl.match(pattern);
  assert.ok(match !== null, `no IN clause for ${column} in the DDL`);
  const literals = [...(match[1] ?? "").matchAll(/'([^']*)'/g)].map(
    (item) => item[1] ?? "",
  );
  return literals;
};

const assertClauseAgrees = (
  storage: SqliteStorage,
  table: string,
  column: string,
  domain: readonly string[],
): void => {
  const ddl = tableDdl(storage, table);
  const extracted = literalListIn(ddl, column);
  for (const value of domain) {
    assert.ok(
      ddl.includes(`'${value}'`),
      `${value} is absent from the ${table} DDL`,
    );
  }
  assert.equal(
    extracted.length,
    domain.length,
    `${table}.${column} literal count`,
  );
  assert.deepEqual(extracted, [...domain], `${table}.${column} literal list`);
};

describe("src/services/storage/schema-parity.test", () => {
  it("node.state CHECK agrees with the domain nodeStates", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "node", "state", nodeStates);
  });

  it("node.block_reason CHECK agrees with the domain blockReasons", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "node", "block_reason", blockReasons);
  });

  it("node.kind CHECK agrees with the domain nodeKinds", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "node", "kind", nodeKinds);
  });

  it("agent_invocation.agent CHECK agrees with the domain agentKinds", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "agent_invocation", "agent", agentKinds);
  });

  it("the table set after migrate equals Object.keys(rows)", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const tables = storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as readonly Record<string, unknown>[];

    assert.deepEqual(
      tables.map((row) => row.name),
      Object.keys(rows),
    );
  });
});
