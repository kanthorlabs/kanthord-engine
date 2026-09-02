import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { agentKinds } from "../../domain/agent.ts";
import {
  providerLoginMethods,
  providerLoginStates,
} from "../../domain/provider-login.ts";
import { rows } from "../../domain/rows.ts";
import { blockReasons, nodeKinds, nodeStates } from "../../domain/state.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { assertClauseAgrees, tableDdl } from "../../../test/helpers/schema.ts";
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

  it("agent_invocation.agents CHECK agrees with the domain agentKinds", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "agent_invocation", "agent", agentKinds);
  });

  it("provider_login.method CHECK agrees with the domain providerLoginMethods", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(
      storage,
      "provider_login",
      "method",
      providerLoginMethods,
    );
  });

  it("provider_login.state CHECK agrees with the domain providerLoginStates", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "provider_login", "state", providerLoginStates);
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
      Object.keys(rows).sort(),
    );
  });
});
