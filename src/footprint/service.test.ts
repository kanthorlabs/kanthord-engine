import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import {
  CleanableKind,
  CleanupState,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  FOOTPRINT_MEASURE_INTERVAL_MS,
  FootprintAlertState,
  FootprintErrorCode,
  FootprintKind,
  type FootprintStat,
  ThresholdMeasure,
} from "./contract.ts";
import { alertOf, insertAlert, listAlerts, openAlerts } from "./alert-store.ts";
import { CleanupRefusal } from "../kernel/cleanup.ts";
import { workerOperations } from "../worker/contract.ts";
import { insertCleanup } from "./cleanup-store.ts";
import {
  FakeOwner,
  footprintFixture,
  HUMAN_ACTOR,
  insertTrace,
  measured,
  NOW,
} from "./test-support.ts";
import { TrackingFootprint } from "../tracking/index.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";

const HUMAN = testHumanIdentity("ulrich", "Ulrich", "jti-ulrich");

const INSTANCE = "e2e-coder-1";
const DEVICE = "device-1";
const GIB = 1073741824;
const TOTAL = 1024 * GIB;
const SLOT_IMAGES = 2;
const SLOT_IMAGE_BYTES = 300;
const NO_DAYS = 0;
const UNMEASURED_BYTES = 5;
const RUNTIME_UNMEASURED = "worker.footprint.runtime_unmeasured";
const ONE_CHANGE = 1;
const TRACES = 4;
const OLD_ENDED_TRACES = 2;
const NO_ALERTS = 0;
const OTHER_DEVICE = "device-2";
const TRACE_THRESHOLD = 8 * GIB;
const ALERT_PAGE = 100;
const PREPARE = "prepare";

function statOf(
  stats: readonly FootprintStat[],
  kind: FootprintKind,
): FootprintStat {
  const stat = stats.find((entry) => entry.kind === kind);
  assert.ok(stat, kind);
  return stat;
}

function deviceStat(stats: readonly FootprintStat[]): FootprintStat {
  const stat = stats.find(
    (entry) => entry.kind === FootprintKind.Disk && entry.item_key === DEVICE,
  );
  assert.ok(stat, DEVICE);
  return stat;
}

test("a statistic carries the measured fields, the rules and the delete operation", async (t) => {
  const fixture = footprintFixture(t);
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.SlotImage],
      [
        measured(FootprintKind.SlotImage, {
          count: SLOT_IMAGES,
          bytes: SLOT_IMAGE_BYTES,
          oldest_at: NOW - 40 * DAY_MS,
          newest_at: NOW - DAY_MS,
          recent_count: 1,
        }),
      ],
    ),
  );
  await fixture.service.measure();
  const stat = statOf(fixture.service.stats(), FootprintKind.SlotImage);
  assert.equal(stat.count, SLOT_IMAGES);
  assert.equal(stat.bytes, SLOT_IMAGE_BYTES);
  assert.equal(stat.measured_at, NOW);
  assert.equal(stat.stale, false);
  assert.equal(stat.delete_operation, workerOperations["slot_image.delete"].id);
  assert.deepEqual(stat.rules, ["superseded"]);
  assert.deepEqual(stat.growth_per_day, {
    count: 1 / DEFAULT_AGE_DAYS,
    bytes: 150 / DEFAULT_AGE_DAYS,
  });
  assert.deepEqual(stat.alert, { state: "ok", alert_id: null });
});

test("days_to_floor sums the growth of the kinds on the device, is 0 below the floor and null with no growth", async (t) => {
  const fixture = footprintFixture(t);
  const disk = new FakeOwner(
    [FootprintKind.Disk],
    [
      measured(FootprintKind.Disk, {
        instance_name: INSTANCE,
        item_key: DEVICE,
        total_bytes: TOTAL,
        free_bytes: 260 * GIB,
      }),
    ],
  );
  fixture.service.register(disk);
  await fixture.service.measure();
  assert.equal(deviceStat(fixture.service.stats()).days_to_floor, null);
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.Workspace],
      [
        measured(FootprintKind.Workspace, {
          instance_name: INSTANCE,
          device: DEVICE,
          count: 30,
          bytes: 30 * 10 * GIB,
          oldest_at: NOW - 40 * DAY_MS,
          recent_count: 15,
        }),
      ],
    ),
  );
  await fixture.service.measure();
  const stat = deviceStat(fixture.service.stats());
  const growth = (15 * 10 * GIB) / DEFAULT_AGE_DAYS;
  assert.equal(stat.days_to_floor, (260 * GIB - 0.1 * TOTAL) / growth);
  assert.deepEqual(
    stat.thresholds.map((threshold) => threshold.measure),
    ["free_ratio", "days_to_floor"],
  );
  disk.measures = [
    measured(FootprintKind.Disk, {
      instance_name: INSTANCE,
      item_key: DEVICE,
      total_bytes: TOTAL,
      free_bytes: 50 * GIB,
    }),
  ];
  await fixture.service.measure();
  assert.equal(deviceStat(fixture.service.stats()).days_to_floor, NO_DAYS);
});

test("a statistic goes stale after three measurement intervals", async (t) => {
  let now = NOW;
  const fixture = footprintFixture(t, { now: () => now });
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.SlotResidue],
      [
        measured(FootprintKind.SlotResidue, {
          instance_name: INSTANCE,
          count: 1,
          bytes: 1,
        }),
      ],
    ),
  );
  await fixture.service.measure();
  now += 3 * FOOTPRINT_MEASURE_INTERVAL_MS + 1;
  const stat = statOf(fixture.service.stats(), FootprintKind.SlotResidue);
  assert.equal(stat.stale, true);
  assert.equal(stat.growth_per_day, null);
});

test("a failed measurement keeps the last value, sets measure_error and logs once for each code change", async (t) => {
  const lines: string[] = [];
  const fixture = footprintFixture(t, { lines });
  const owner = new FakeOwner(
    [FootprintKind.SlotImage],
    [
      measured(FootprintKind.SlotImage, {
        count: 1,
        bytes: UNMEASURED_BYTES,
        recent_count: 1,
      }),
    ],
  );
  fixture.service.register(owner);
  await fixture.service.measure();
  owner.measures = [
    measured(FootprintKind.SlotImage, {
      measure_error: { code: RUNTIME_UNMEASURED, message: "podman absent" },
    }),
  ];
  await fixture.service.measure();
  await fixture.service.measure();
  const stat = statOf(fixture.service.stats(), FootprintKind.SlotImage);
  assert.equal(stat.bytes, UNMEASURED_BYTES);
  assert.equal(stat.measure_error?.code, RUNTIME_UNMEASURED);
  const changes = lines.filter(
    (line) =>
      line.includes("footprint.measure.error_changed") &&
      line.includes("slot_image"),
  );
  assert.equal(changes.length, ONE_CHANGE);
});

test("the trace candidates answer the rule totals and the about bytes of trace", async (t) => {
  const fixture = footprintFixture(t);
  fixture.service.register(
    new TrackingFootprint({
      store: fixture.trackingStore,
      path: `${fixture.directory}/tracking.db`,
      now: () => NOW,
    }),
  );
  insertTrace(fixture.trackingStore, "1".repeat(32), NOW - 40 * DAY_MS);
  insertTrace(fixture.trackingStore, "2".repeat(32), NOW - 35 * DAY_MS);
  insertTrace(fixture.trackingStore, "3".repeat(32), NOW - DAY_MS);
  insertTrace(fixture.trackingStore, "4".repeat(32), NOW - 50 * DAY_MS, "open");
  await fixture.service.measure();
  const stat = statOf(fixture.service.stats(), FootprintKind.Trace);
  assert.equal(stat.count, TRACES);
  assert.equal(stat.candidates?.count, OLD_ENDED_TRACES);
  assert.equal(stat.candidates?.bytes_estimated, true);
  assert.equal(
    stat.candidates?.bytes,
    Math.floor((OLD_ENDED_TRACES * (stat.bytes ?? 0)) / TRACES),
  );
  const page = await fixture.footprint["candidate.list"](
    { params: { kind: "trace" }, query: { limit: 1 }, body: null },
    { identity: HUMAN },
  );
  assert.equal(page.type, OperationResultType.Completed);
  assert.equal(page.data.total_count, OLD_ENDED_TRACES);
  assert.equal(page.data.bytes_estimated, true);
  assert.equal(page.data.items[0]?.key, "1".repeat(32));
  assert.ok(page.data.next_cursor);
  const other = await fixture.footprint["candidate.list"](
    {
      params: { kind: "trace" },
      query: {
        limit: 1,
        older_than_days: 10,
        rule: "older_than",
        cursor: page.data.next_cursor,
      },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(other.type, OperationResultType.Failure);
  assert.equal(other.error.error.code, FootprintErrorCode.CursorInvalid);
  const items = await fixture.footprint["item.list"](
    { params: { kind: "trace" }, query: { limit: 10 }, body: null },
    { identity: HUMAN },
  );
  assert.equal(items.type, OperationResultType.Completed);
  assert.equal(items.data.items[0]?.refusal, CleanupRefusal.Live);
});

test("a rule outside the kind answers footprint.rule.not_supported", async (t) => {
  const fixture = footprintFixture(t);
  const result = await fixture.footprint["candidate.list"](
    {
      params: { kind: "trace" },
      query: { rule: "unbound", limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(result.type, OperationResultType.Failure);
  assert.equal(result.error.error.code, FootprintErrorCode.RuleNotSupported);
});

test("the alert list answers the stored episodes and acknowledge refuses an unknown and a resolved alert", async (t) => {
  const fixture = footprintFixture(t);
  const list = await fixture.footprint["alert.list"](
    { params: {}, query: { limit: 10 }, body: null },
    { identity: HUMAN },
  );
  assert.equal(list.type, OperationResultType.Completed);
  assert.deepEqual(list.data.items, []);
  const summary = await fixture.footprint["summary.get"](
    { params: {}, query: {}, body: null },
    { identity: HUMAN },
  );
  assert.equal(summary.type, OperationResultType.Completed);
  assert.equal(summary.data.open_alerts, NO_ALERTS);
  const unknown = await fixture.footprint["alert.acknowledge"](
    { params: { alert_id: createIdentity("alert") }, query: {}, body: null },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(unknown.type, OperationResultType.Failure);
  assert.equal(unknown.error.error.code, FootprintErrorCode.AlertNotFound);
  const resolved = {
    alert_id: createIdentity("alert"),
    kind: FootprintKind.Trace,
    instance_name: null,
    item_key: null,
    threshold: { measure: ThresholdMeasure.Bytes, value: GIB },
    value: TOTAL,
    resolved_at: NOW,
    acknowledged_by: null,
    acknowledged_at: null,
    acknowledged_until: null,
  };
  fixture.store.transaction((tx) => insertAlert(tx, resolved));
  const stored = await fixture.footprint["alert.list"](
    { params: {}, query: { open: "false", limit: 10 }, body: null },
    { identity: HUMAN },
  );
  assert.equal(stored.type, OperationResultType.Completed);
  assert.deepEqual(
    stored.data.items.map((alert) => [alert.alert_id, alert.state]),
    [[resolved.alert_id, FootprintAlertState.Ok]],
  );
  const refused = await fixture.footprint["alert.acknowledge"](
    { params: { alert_id: resolved.alert_id }, query: {}, body: null },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(refused.type, OperationResultType.Failure);
  assert.equal(refused.error.error.code, FootprintErrorCode.AlertResolved);
});

function traceOwner(bytes: number): FakeOwner {
  return new FakeOwner(
    [FootprintKind.Trace],
    [measured(FootprintKind.Trace, { count: 1, bytes })],
  );
}

function traceAlerts(fixture: ReturnType<typeof footprintFixture>) {
  return fixture.store
    .transaction((tx) => listAlerts(tx, null, null, ALERT_PAGE))
    .filter((alert) => alert.kind === FootprintKind.Trace);
}

test("an acknowledgement holds, a second one answers acknowledged and a resolved episode answers resolved", async (t) => {
  const fixture = footprintFixture(t);
  const owner = traceOwner(TRACE_THRESHOLD + 1);
  fixture.service.register(owner);
  await fixture.service.measure();
  await fixture.service.measure();
  const [alert] = traceAlerts(fixture);
  assert.ok(alert);
  const acknowledge = () =>
    fixture.footprint["alert.acknowledge"](
      { params: { alert_id: alert.alert_id }, query: {}, body: null },
      { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
    );
  const summary = () =>
    fixture.footprint["summary.get"](
      { params: {}, query: {}, body: null },
      { identity: HUMAN },
    );
  const acknowledged = await acknowledge();
  assert.equal(acknowledged.type, OperationResultType.Completed);
  assert.deepEqual(acknowledged.data.acknowledged_by, HUMAN_ACTOR);
  assert.equal(acknowledged.data.acknowledged_at, NOW);
  assert.equal(acknowledged.data.acknowledged_until, 2 * (TRACE_THRESHOLD + 1));
  assert.equal(acknowledged.data.state, FootprintAlertState.Firing);
  const held = await summary();
  assert.equal(held.type, OperationResultType.Completed);
  assert.equal(
    held.data.unacknowledged_alerts,
    held.data.open_alerts - ONE_CHANGE,
  );
  const again = await acknowledge();
  assert.equal(again.type, OperationResultType.Failure);
  assert.equal(again.error.error.code, FootprintErrorCode.AlertAcknowledged);
  owner.measures = [measured(FootprintKind.Trace, { count: 1, bytes: 1 })];
  await fixture.service.measure();
  assert.equal(
    statOf(fixture.service.stats(), FootprintKind.Trace).alert.state,
    FootprintAlertState.Recovering,
  );
  await fixture.service.measure();
  const [resolved] = traceAlerts(fixture);
  assert.equal(resolved?.resolved_at, NOW);
  assert.deepEqual(statOf(fixture.service.stats(), FootprintKind.Trace).alert, {
    state: FootprintAlertState.Ok,
    alert_id: null,
  });
  const refused = await acknowledge();
  assert.equal(refused.type, OperationResultType.Failure);
  assert.equal(refused.error.error.code, FootprintErrorCode.AlertResolved);
});

test("an open episode whose item_key the next measurement no longer reports resolves", async (t) => {
  const fixture = footprintFixture(t);
  const low = (device: string) =>
    measured(FootprintKind.Disk, {
      item_key: device,
      total_bytes: TOTAL,
      free_bytes: TOTAL / 20,
    });
  const owner = new FakeOwner([FootprintKind.Disk], [low(DEVICE)]);
  fixture.service.register(owner);
  await fixture.service.measure();
  await fixture.service.measure();
  const open = () =>
    fixture.store
      .transaction((tx) => openAlerts(tx))
      .filter((alert) => alert.item_key === DEVICE);
  const [alert] = open();
  assert.ok(alert);
  owner.measures = [low(OTHER_DEVICE)];
  await fixture.service.measure();
  assert.deepEqual(open(), []);
  assert.equal(
    fixture.store.transaction((tx) => alertOf(tx, alert.alert_id))?.resolved_at,
    NOW,
  );
  assert.equal(
    fixture.service.stats().some((stat) => stat.item_key === DEVICE),
    false,
  );
});

test("a second disk owner keeps the server disk entries and a throwing owner keeps its own entries", async (t) => {
  const fixture = footprintFixture(t);
  const serverDisks = () =>
    fixture.service
      .stats()
      .filter(
        (stat) =>
          stat.kind === FootprintKind.Disk &&
          stat.instance_name === null &&
          stat.item_key !== null &&
          stat.item_key !== DEVICE,
      ).length;
  await fixture.service.measure();
  const measuredDisks = serverDisks();
  assert.ok(measuredDisks > NO_ALERTS);
  let fail = false;
  const owner = new FakeOwner(
    [FootprintKind.Disk],
    [
      measured(FootprintKind.Disk, {
        item_key: DEVICE,
        total_bytes: TOTAL,
        free_bytes: TOTAL / 2,
      }),
    ],
  );
  const measure = owner.measure.bind(owner);
  owner.measure = () =>
    fail ? Promise.reject(new Error("runtime down")) : measure();
  fixture.service.register(owner);
  await fixture.service.measure();
  assert.equal(serverDisks(), measuredDisks);
  fail = true;
  await fixture.service.measure();
  assert.equal(serverDisks(), measuredDisks);
  assert.equal(deviceStat(fixture.service.stats()).free_bytes, TOTAL / 2);
});

test("a failed alert write keeps the state, so the next measurement writes again", async (t) => {
  const fixture = footprintFixture(t);
  fixture.service.register(traceOwner(TRACE_THRESHOLD + 1));
  let failing: string | null = null;
  const transaction = fixture.store.transaction.bind(fixture.store);
  fixture.store.transaction = (work) =>
    transaction((tx) => {
      const prepare = tx.database.prepare.bind(tx.database);
      return work({
        database: new Proxy(tx.database, {
          get: (target, property) =>
            property === PREPARE
              ? (sql: string) => {
                  if (failing !== null && sql.startsWith(failing))
                    throw new Error("database busy");
                  return prepare(sql);
                }
              : Reflect.get(target, property, target),
        }),
      });
    });
  const state = () =>
    statOf(fixture.service.stats(), FootprintKind.Trace).alert.state;
  await fixture.service.measure();
  failing = "INSERT INTO footprint_alert";
  await fixture.service.measure();
  assert.equal(state(), FootprintAlertState.Pending);
  assert.deepEqual(traceAlerts(fixture), []);
  failing = null;
  await fixture.service.measure();
  assert.equal(state(), FootprintAlertState.Firing);
  assert.equal(traceAlerts(fixture).length, ONE_CHANGE);
});

const EXECUTION_OLD = "execution_01JABCDEFGHJKMNPQRSTVWXYZ0";
const EXECUTION_LIVE = "execution_01JABCDEFGHJKMNPQRSTVWXYZ1";
const EXECUTION_RECENT = "execution_01JABCDEFGHJKMNPQRSTVWXYZ2";
const NODE_DONE = "node_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NODE_OPEN = "node_01JABCDEFGHJKMNPQRSTVWXYZ1";
const POOL_KEY = "pool";
const NODE_RETIRED = "node_01JABCDEFGHJKMNPQRSTVWXYZ2";
const UNIT_DEVICE = "unit-device";

function reportedKind(
  kind: "session" | "workspace" | "tool_output" | "log" | "slot_residue",
  items: { key: string; bytes: number; modified_at: number }[],
) {
  return {
    kind,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    oldest_at: items.at(0)?.modified_at ?? null,
    newest_at: items.at(-1)?.modified_at ?? null,
    recent_count: items.length,
    items,
    items_complete: true,
  };
}

const SESSION_BYTES = 10;
const ONE_CANDIDATE = 1;
const UNIT_LOG_KEY = "kanthord.log";
const SELECTED_WORKSPACE_BYTES = 9;

function instanceFixture(t: Parameters<typeof footprintFixture>[0]) {
  return footprintFixture(t, {
    instances: { [INSTANCE]: { archived: false } },
    endTimes: {
      [EXECUTION_OLD]: NOW - 40 * DAY_MS,
      [EXECUTION_LIVE]: null,
      [EXECUTION_RECENT]: NOW - DAY_MS,
    },
    nodeStates: {
      [NODE_DONE]: { state: "Completed", retired: false },
      [NODE_OPEN]: { state: "Executing", retired: false },
      [NODE_RETIRED]: { state: "Available", retired: true },
    },
  });
}

test("recordMeasurement keeps the unit kinds of a worker instance with its disk and device", async (t) => {
  const fixture = instanceFixture(t);
  await fixture.service.measure();
  fixture.store.transaction((tx) =>
    fixture.service.recordMeasurement(tx, INSTANCE, "worker", {
      measured_at: NOW,
      disk: { device: UNIT_DEVICE, total_bytes: 1000, free_bytes: 500 },
      kinds: [
        reportedKind("session", [
          {
            key: EXECUTION_OLD,
            bytes: SESSION_BYTES,
            modified_at: NOW - 40 * DAY_MS,
          },
        ]),
        reportedKind("log", [
          { key: UNIT_LOG_KEY, bytes: 7, modified_at: NOW },
        ]),
        { ...reportedKind("slot_residue", []), count: 1, bytes: 5 },
      ],
    }),
  );
  fixture.service.settleMeasurement(INSTANCE);
  const stats = fixture.service
    .stats()
    .filter((stat) => stat.instance_name === INSTANCE);
  const session = statOf(stats, FootprintKind.Session);
  assert.equal(session.bytes, SESSION_BYTES);
  assert.deepEqual(session.candidates?.count, ONE_CANDIDATE);
  assert.equal(statOf(stats, FootprintKind.Log).item_key, UNIT_LOG_KEY);
  assert.equal(statOf(stats, FootprintKind.SlotResidue).growth_per_day, null);
  const disk = statOf(stats, FootprintKind.Disk);
  assert.deepEqual(
    [disk.item_key, disk.instance_names, disk.free_bytes],
    [UNIT_DEVICE, [INSTANCE], 500],
  );
});

test("the session candidates join executionEndTimes and keep a live execution out", async (t) => {
  const fixture = instanceFixture(t);
  fixture.store.transaction((tx) =>
    fixture.service.recordMeasurement(tx, INSTANCE, "worker", {
      measured_at: NOW,
      disk: null,
      kinds: [
        reportedKind("session", [
          { key: EXECUTION_LIVE, bytes: 1, modified_at: NOW - 50 * DAY_MS },
          { key: EXECUTION_OLD, bytes: 2, modified_at: NOW - 45 * DAY_MS },
          { key: EXECUTION_RECENT, bytes: 3, modified_at: NOW - 44 * DAY_MS },
        ]),
      ],
    }),
  );
  const page = await fixture.footprint["candidate.list"](
    {
      params: { kind: "session" },
      query: { instance_name: INSTANCE, limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(page.type, OperationResultType.Completed);
  assert.deepEqual(
    page.data.items.map((item) => [item.key, item.at]),
    [[EXECUTION_OLD, NOW - 40 * DAY_MS]],
  );
  const items = await fixture.footprint["item.list"](
    {
      params: { kind: "session" },
      query: { instance_name: INSTANCE, limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(items.type, OperationResultType.Completed);
  assert.equal(
    items.data.items.find((item) => item.key === EXECUTION_LIVE)?.refusal,
    CleanupRefusal.Live,
  );
});

test("the workspace candidates join nodeStates: a closed or retired node and an ended execution", async (t) => {
  const fixture = instanceFixture(t);
  fixture.store.transaction((tx) =>
    fixture.service.recordMeasurement(tx, INSTANCE, "server", {
      measured_at: NOW,
      disk: null,
      kinds: [
        reportedKind("workspace", [
          { key: NODE_DONE, bytes: 1, modified_at: NOW - 3 * DAY_MS },
          { key: NODE_OPEN, bytes: 2, modified_at: NOW - 2 * DAY_MS },
          { key: NODE_RETIRED, bytes: 3, modified_at: NOW - DAY_MS },
          { key: EXECUTION_LIVE, bytes: 4, modified_at: NOW },
          { key: EXECUTION_RECENT, bytes: 5, modified_at: NOW },
        ]),
      ],
    }),
  );
  const page = await fixture.footprint["candidate.list"](
    {
      params: { kind: "workspace" },
      query: { instance_name: INSTANCE, limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(page.type, OperationResultType.Completed);
  assert.deepEqual(
    page.data.items.map((item) => item.key),
    [NODE_DONE, NODE_RETIRED, EXECUTION_RECENT],
  );
  assert.equal(page.data.total_bytes, SELECTED_WORKSPACE_BYTES);
});

test("the pool item of the workspace kind is not selectable", async (t) => {
  const fixture = instanceFixture(t);
  fixture.store.transaction((tx) =>
    fixture.service.recordMeasurement(tx, INSTANCE, "server", {
      measured_at: NOW,
      disk: null,
      kinds: [
        reportedKind("workspace", [
          { key: NODE_DONE, bytes: 1, modified_at: NOW - 3 * DAY_MS },
          { key: POOL_KEY, bytes: 2, modified_at: NOW - 2 * DAY_MS },
        ]),
      ],
    }),
  );
  const page = await fixture.footprint["candidate.list"](
    {
      params: { kind: "workspace" },
      query: { instance_name: INSTANCE, limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(page.type, OperationResultType.Completed);
  assert.deepEqual(
    page.data.items.map((item) => item.key),
    [NODE_DONE],
  );
  const items = await fixture.footprint["item.list"](
    {
      params: { kind: "workspace" },
      query: { instance_name: INSTANCE, limit: 10 },
      body: null,
    },
    { identity: HUMAN },
  );
  assert.equal(items.type, OperationResultType.Completed);
  assert.equal(
    items.data.items.find((item) => item.key === POOL_KEY)?.refusal,
    CleanupRefusal.Live,
  );
});

test("recordResults completes an open instance record, keeps removed_bytes and answers an unknown cleanup", async (t) => {
  const fixture = instanceFixture(t);
  const cleanupId = createIdentity("cleanup");
  fixture.store.transaction((tx) =>
    insertCleanup(tx, {
      cleanup_id: cleanupId,
      kind: CleanableKind.Workspace,
      instance_name: INSTANCE,
      rule: null,
      keys: [NODE_DONE, NODE_RETIRED],
      requested_by: HUMAN_ACTOR,
      state: CleanupState.Running,
      finished_at: null,
      outcome: null,
    }),
  );
  const other = createIdentity("cleanup");
  const unknown = fixture.store.transaction((tx) =>
    fixture.service.recordResults(tx, INSTANCE, [
      {
        cleanup_id: cleanupId,
        removed: [NODE_DONE],
        removed_bytes: 11,
        absent: [NODE_RETIRED],
        refused: [],
      },
      {
        cleanup_id: other,
        removed: [],
        removed_bytes: 0,
        absent: [],
        refused: [],
      },
    ]),
  );
  assert.deepEqual(unknown, [other]);
  const record = await fixture.footprint["cleanup.get"](
    { params: { cleanup_id: cleanupId }, query: {}, body: null },
    { identity: HUMAN },
  );
  assert.equal(record.type, OperationResultType.Completed);
  assert.equal(record.data.state, CleanupState.Completed);
  assert.deepEqual(record.data.outcome, {
    removed: 1,
    removed_bytes: 11,
    absent: 1,
    refused: [],
    pending: 0,
  });
});

test("instanceArchived fails the open orders, resolves the open episodes and drops the instance statistics", async (t) => {
  const fixture = instanceFixture(t);
  const cleanupId = createIdentity("cleanup");
  const alertId = createIdentity("alert");
  fixture.store.transaction((tx) => {
    insertCleanup(tx, {
      cleanup_id: cleanupId,
      kind: CleanableKind.ToolOutput,
      instance_name: INSTANCE,
      rule: null,
      keys: ["pi-bash-0123456789abcdef.log"],
      requested_by: HUMAN_ACTOR,
      state: CleanupState.Queued,
      finished_at: null,
      outcome: null,
    });
    insertAlert(tx, {
      alert_id: alertId,
      kind: FootprintKind.Log,
      instance_name: INSTANCE,
      item_key: "kanthord.log",
      threshold: { measure: ThresholdMeasure.Bytes, value: GIB },
      value: 2 * GIB,
      resolved_at: null,
      acknowledged_by: null,
      acknowledged_at: null,
      acknowledged_until: null,
    });
    fixture.service.recordMeasurement(tx, INSTANCE, "server", {
      measured_at: NOW,
      disk: null,
      kinds: [reportedKind("tool_output", [])],
    });
  });
  fixture.store.transaction((tx) =>
    fixture.service.instanceArchived(tx, INSTANCE),
  );
  const record = await fixture.footprint["cleanup.get"](
    { params: { cleanup_id: cleanupId }, query: {}, body: null },
    { identity: HUMAN },
  );
  assert.equal(record.type, OperationResultType.Completed);
  assert.equal(record.data.state, CleanupState.Failed);
  assert.notEqual(
    fixture.store.transaction((tx) => alertOf(tx, alertId))?.resolved_at,
    null,
  );
  assert.equal(
    fixture.service.stats().some((stat) => stat.instance_name === INSTANCE),
    false,
  );
});

test("a queued instance order stays running until its result arrives and is dispatched once in a run", async (t) => {
  const calls: string[] = [];
  const fixture = footprintFixture(t, {
    instances: { [INSTANCE]: { archived: false } },
    deleters: {
      [CleanableKind.Workspace]: async (call) => {
        calls.push(call.cleanup_id);
        return null;
      },
    },
  });
  const created = await fixture.footprint["cleanup.create"](
    {
      params: {},
      query: {},
      body: {
        kind: CleanableKind.Workspace,
        instance_name: INSTANCE,
        rule: null,
        keys: [NODE_DONE],
      },
    },
    { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(created.type, OperationResultType.Completed);
  await fixture.service.runCleanups();
  await fixture.service.runCleanups();
  assert.deepEqual(calls, [created.data.cleanup_id]);
  const record = await fixture.footprint["cleanup.get"](
    { params: { cleanup_id: created.data.cleanup_id }, query: {}, body: null },
    { identity: HUMAN },
  );
  assert.equal(record.type, OperationResultType.Completed);
  assert.equal(record.data.state, CleanupState.Running);
});
