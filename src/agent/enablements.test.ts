import assert from "node:assert/strict";
import { test } from "node:test";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import type { AgentProviderItem, DefaultConfiguration } from "./contract.ts";
import { AGENT_COMPONENT_NAME } from "./contract.ts";
import {
  EnablementState,
  agentProvidersDependentOn,
  enablementsByModel,
  getEnablement,
  getLatestRevision,
  insertEnablementRevision,
  listEnablements,
} from "./enablements.ts";
import { agentMigrations } from "./migrations.ts";

const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;

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

test("inserts successive revisions with canonical JSON and prefixed ids", () => {
  withStore((tx) => {
    const first = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    const second = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Disabled,
      providers,
      defaults,
    );
    assert.equal(first.revision, FIRST_REVISION);
    assert.equal(second.revision, SECOND_REVISION);
    assert.equal(
      identitySchema("agent_enablement").safeParse(first.id).success,
      true,
    );
    assert.equal(
      identitySchema("agent_enablement").safeParse(second.id).success,
      true,
    );
    const stored = tx.database
      .prepare(
        "SELECT agent_providers, default_configuration FROM agent_enablement WHERE id = ?",
      )
      .get(first.id);
    assert.equal(stored?.agent_providers, canonicalJSON(providers));
    assert.equal(stored?.default_configuration, canonicalJSON(defaults));
    assert.deepEqual(getEnablement(tx, "alpha"), second);
  });
});

test("latest revision includes tombstones while live lookup does not", () => {
  withStore((tx) => {
    assert.equal(getLatestRevision(tx, "missing"), null);
    assert.equal(getEnablement(tx, "missing"), null);
    const first = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    assert.deepEqual(getEnablement(tx, "alpha"), first);
    const removed = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Disabled,
      providers,
      defaults,
      Date.now(),
    );
    assert.equal(removed.revision, SECOND_REVISION);
    assert.equal(getEnablement(tx, "alpha"), null);
    assert.deepEqual(getLatestRevision(tx, "alpha"), { revision: 2 });
    const restored = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    assert.equal(restored.revision, THIRD_REVISION);
    assert.deepEqual(getEnablement(tx, "alpha"), restored);
  });
});

test("pagination skips tombstones before limiting and validates cursors", () => {
  withStore((tx) => {
    for (const name of ["alpha", "bravo", "charlie", "delta"]) {
      insertEnablementRevision(
        tx,
        name,
        EnablementState.Enabled,
        providers,
        defaults,
      );
    }
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Disabled,
      providers,
      defaults,
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
    );
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    insertEnablementRevision(
      tx,
      "bravo",
      EnablementState.Disabled,
      providers,
      defaults,
      Date.now(),
    );
    assert.deepEqual(agentProvidersDependentOn(tx, "secret"), [
      { agent_name: "alpha", provider_name: "primary" },
    ]);
    assert.deepEqual(agentProvidersDependentOn(tx, "absent"), []);
  });
});

test("model lookup matches the selected provider credential and model on live rows", () => {
  withStore((tx) => {
    const matching = insertEnablementRevision(
      tx,
      "alpha",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    insertEnablementRevision(tx, "bravo", EnablementState.Enabled, providers, {
      ...defaults,
      agent_provider: "other",
    });
    insertEnablementRevision(
      tx,
      "charlie",
      EnablementState.Enabled,
      providers,
      { ...defaults, model_identifier: "model-b" },
    );
    insertEnablementRevision(
      tx,
      "delta",
      EnablementState.Enabled,
      providers,
      defaults,
    );
    insertEnablementRevision(
      tx,
      "delta",
      EnablementState.Disabled,
      providers,
      defaults,
      Date.now(),
    );
    assert.deepEqual(enablementsByModel(tx, "secret", "model-a"), [matching]);
    assert.deepEqual(enablementsByModel(tx, "absent", "model-a"), []);
  });
});
