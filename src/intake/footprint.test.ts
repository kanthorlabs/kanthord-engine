import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import { FootprintKind } from "../footprint/contract.ts";
import { IntakeFootprint, oldestInboundEvent } from "./footprint.ts";
import { intakeMigrations } from "./migrations.ts";
import { INTAKE_SERVICE_NAME } from "./contract.ts";

const BYTES = 64;
const MIRRORS = 2;
const DEVICE = "device";
const OLDEST_EVENT_AT = 100;

test("the intake_mirror walk counts each mirror with its bytes", async (t) => {
  const state = temporary(t);
  const root = join(state, "intake", "repositories");
  for (const name of ["binding_a.git", "binding_b.git"]) {
    mkdirSync(join(root, name, "objects"), { recursive: true });
    writeFileSync(join(root, name, "objects", "pack"), "x".repeat(BYTES));
  }
  const owner = new IntakeFootprint({
    stateDirectory: state,
    device: () => Promise.resolve(DEVICE),
  });
  const [mirror] = await owner.measure(AbortSignal.timeout(5000));
  assert.equal(mirror?.kind, FootprintKind.IntakeMirror);
  assert.equal(mirror?.count, MIRRORS);
  assert.equal(mirror?.bytes, MIRRORS * BYTES);
  assert.equal(mirror?.device, DEVICE);
});

test("the intake_inbound_event row holds the oldest event", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  assert.equal(store.transaction(oldestInboundEvent), null);
  store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO intake_inbound (id, project_id, kind, platform, consumer, configuration, created_at) VALUES ('inbound', 'project', 'webhook', 'github', 'mission', '{}', 1)",
      )
      .run();
    const insert = tx.database.prepare(
      "INSERT INTO intake_inbound_event (id, inbound_id, event_id, event, metadata, state, created_at) VALUES (?, 'inbound', ?, x'00', '{}', 'pending', ?)",
    );
    insert.run("event_1", "e1", 200);
    insert.run("event_2", "e2", OLDEST_EVENT_AT);
  });
  assert.equal(store.transaction(oldestInboundEvent), OLDEST_EVENT_AT);
});
