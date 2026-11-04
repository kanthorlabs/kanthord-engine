import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/test-support.ts";
import { FOOTPRINT_SERVICE_NAME, FootprintKind } from "./contract.ts";
import { insertAlert, resolveAlert } from "./alert-store.ts";
import { footprintMigrations } from "./migrations.ts";

const BYTES = { measure: "bytes" as const, value: 8589934592 };

function alert(kind: FootprintKind, itemKey: string | null) {
  return {
    alert_id: createIdentity("alert"),
    kind,
    instance_name: null,
    item_key: itemKey,
    threshold: BYTES,
    value: 9000000000,
    resolved_at: null,
    acknowledged_by: null,
    acknowledged_at: null,
    acknowledged_until: null,
  };
}

function store(t: TestContext) {
  const opened = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => opened.close());
  opened.migrate([
    { service: FOOTPRINT_SERVICE_NAME, migrations: footprintMigrations },
  ]);
  return opened;
}

test("a second open episode with NULL instance_name and NULL item_key for one kind fails", (t) => {
  const opened = store(t);
  opened.transaction((tx) => insertAlert(tx, alert(FootprintKind.Trace, null)));
  assert.throws(() =>
    opened.transaction((tx) =>
      insertAlert(tx, alert(FootprintKind.Trace, null)),
    ),
  );
});

test("a second open disk episode for one device fails", (t) => {
  const opened = store(t);
  opened.transaction((tx) =>
    insertAlert(tx, alert(FootprintKind.Disk, "16777231")),
  );
  assert.throws(() =>
    opened.transaction((tx) =>
      insertAlert(tx, alert(FootprintKind.Disk, "16777231")),
    ),
  );
  opened.transaction((tx) =>
    insertAlert(tx, alert(FootprintKind.Disk, "16777232")),
  );
});

test("a resolved episode permits a new one", (t) => {
  const opened = store(t);
  const first = alert(FootprintKind.Trace, null);
  opened.transaction((tx) => insertAlert(tx, first));
  opened.transaction((tx) => resolveAlert(tx, first.alert_id, 1));
  opened.transaction((tx) => insertAlert(tx, alert(FootprintKind.Trace, null)));
});
