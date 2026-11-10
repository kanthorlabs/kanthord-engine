import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import type { AgentProviderItem, DefaultConfiguration } from "./contract.ts";
import { AGENT_COMPONENT_NAME } from "./contract.ts";
import {
  agentProvidersDependentOn,
  EnablementState,
  insertEnablementRevision,
  listEnablements,
} from "./enablements.ts";
import { agentMigrations } from "./migrations.ts";

const providers: AgentProviderItem[] = [
  { name: "primary", provider: "anthropic", credential: "secret" },
  { name: "other", provider: "github-copilot", credential: "other-secret" },
];
const defaults: DefaultConfiguration = {
  agent_provider: "primary",
  model_identifier: "model-a",
  reasoning_effort: "low",
};

function withStore(work: (tx: Transaction) => void): void {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    store.transaction(work);
  } finally {
    store.close();
  }
}

test("pagination skips tombstones before limiting and validates cursors", () => {
  withStore((tx) => {
    for (const name of ["alpha", "bravo", "charlie", "delta"]) {
      insertEnablementRevision(
        tx,
        name,
        EnablementState.Enabled,
        providers,
        defaults,
        [],
      );
    }
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Disabled,
      providers,
      defaults,
      [],
      Date.now(),
    );
    const first = listEnablements(tx, 1, null);
    assert.deepEqual(
      first.items.map((item) => item.agent_name),
      ["alpha"],
    );
    assert.equal(first.next_cursor, Buffer.from("alpha").toString("base64url"));
    const second = listEnablements(tx, 1, first.next_cursor);
    assert.deepEqual(
      second.items.map((item) => item.agent_name),
      ["charlie"],
    );
    assert.notEqual(second.next_cursor, null);
    const third = listEnablements(tx, 1, second.next_cursor);
    assert.deepEqual(
      third.items.map((item) => item.agent_name),
      ["delta"],
    );
    assert.equal(third.next_cursor, null);
    assert.throws(() => listEnablements(tx, 1, "!!"), {
      code: "system.pagination.cursor_invalid",
    });
    assert.throws(() => listEnablements(tx, 1, "Y"), {
      code: "system.pagination.cursor_invalid",
    });
  });
});

test("credential dependents exclude tombstones and retain provider names", () => {
  withStore((tx) => {
    insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Enabled,
      providers,
      defaults,
      [],
    );
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Enabled,
      providers,
      defaults,
      [],
    );
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Disabled,
      providers,
      defaults,
      [],
      Date.now(),
    );
    assert.deepEqual(agentProvidersDependentOn(tx, "secret"), [
      { agent_name: "alpha", provider_name: "primary" },
    ]);
    assert.deepEqual(agentProvidersDependentOn(tx, "absent"), []);
  });
});
