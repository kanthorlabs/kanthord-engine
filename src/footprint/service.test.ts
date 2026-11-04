import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import {
  CleanableKind,
  CleanupState,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  FOOTPRINT_MEASURE_INTERVAL_MS,
  FootprintErrorCode,
  FootprintKind,
  type FootprintStat,
} from "./contract.ts";
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

function statOf(
  stats: readonly FootprintStat[],
  kind: FootprintKind,
): FootprintStat {
  const stat = stats.find((entry) => entry.kind === kind);
  assert.ok(stat, kind);
  return stat;
}

function completed(
  fixture: ReturnType<typeof footprintFixture>,
  kind: CleanableKind,
  fields: {
    instance_name?: string | null;
    rule?:
      | { name: "older_than"; older_than_days: number }
      | { name: "node_closed" }
      | null;
    removed: number;
    removed_bytes: number | null;
    finished_at: number;
    keys?: string[];
  },
): void {
  fixture.store.transaction((tx) =>
    insertCleanup(tx, {
      cleanup_id: createIdentity("cleanup"),
      kind,
      instance_name: fields.instance_name ?? null,
      rule: fields.rule ?? null,
      keys: fields.keys ?? ["node_01JZ8R2B3C4D5E6F7G8H9J0K1M"],
      requested_by: HUMAN_ACTOR,
      state: CleanupState.Completed,
      finished_at: fields.finished_at,
      outcome: {
        removed: fields.removed,
        removed_bytes: fields.removed_bytes,
        absent: 0,
        refused: [],
      },
    }),
  );
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

test("the window of an instance younger than DEFAULT_AGE_DAYS is its age, and an empty kind takes DEFAULT_AGE_DAYS", async (t) => {
  const fixture = footprintFixture(t);
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.Workspace],
      [
        measured(FootprintKind.Workspace, {
          instance_name: INSTANCE,
          count: 10,
          bytes: 1000,
          oldest_at: NOW - 5 * DAY_MS,
          recent_count: 10,
        }),
      ],
    ),
  );
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.ToolOutput],
      [
        measured(FootprintKind.ToolOutput, {
          instance_name: INSTANCE,
          count: 0,
          bytes: 0,
          oldest_at: null,
          recent_count: 0,
        }),
      ],
    ),
  );
  completed(fixture, CleanableKind.ToolOutput, {
    instance_name: INSTANCE,
    removed: 30,
    removed_bytes: null,
    finished_at: NOW - DAY_MS,
    rule: { name: "older_than", older_than_days: 1 },
    keys: ["pi-bash-0123456789abcdef.log"],
  });
  await fixture.service.measure();
  const stats = fixture.service.stats();
  assert.deepEqual(statOf(stats, FootprintKind.Workspace).growth_per_day, {
    count: 2,
    bytes: 200,
  });
  assert.deepEqual(statOf(stats, FootprintKind.ToolOutput).growth_per_day, {
    count: 30 / DEFAULT_AGE_DAYS,
    bytes: 0,
  });
});

test("a completed node_closed cleanup inside the window adds, an older_than cleanup of 30 days adds nothing, and a null removed_bytes takes the mean", async (t) => {
  const fixture = footprintFixture(t);
  fixture.service.register(
    new FakeOwner(
      [FootprintKind.Workspace],
      [
        measured(FootprintKind.Workspace, {
          instance_name: INSTANCE,
          count: 10,
          bytes: 1000,
          oldest_at: NOW - 60 * DAY_MS,
          recent_count: 3,
        }),
      ],
    ),
  );
  completed(fixture, CleanableKind.Workspace, {
    instance_name: INSTANCE,
    rule: { name: "node_closed" },
    removed: 6,
    removed_bytes: 900,
    finished_at: NOW - 2 * DAY_MS,
  });
  completed(fixture, CleanableKind.Workspace, {
    instance_name: INSTANCE,
    rule: null,
    removed: 3,
    removed_bytes: null,
    finished_at: NOW - 3 * DAY_MS,
  });
  completed(fixture, CleanableKind.Workspace, {
    instance_name: INSTANCE,
    rule: { name: "older_than", older_than_days: DEFAULT_AGE_DAYS },
    removed: 50,
    removed_bytes: 5000,
    finished_at: NOW - DAY_MS,
  });
  await fixture.service.measure();
  const growth = statOf(
    fixture.service.stats(),
    FootprintKind.Workspace,
  ).growth_per_day;
  assert.deepEqual(growth, {
    count: (3 + 6 + 3) / DEFAULT_AGE_DAYS,
    bytes: (300 + 900 + 300) / DEFAULT_AGE_DAYS,
  });
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
  assert.equal(
    statOf(fixture.service.stats(), FootprintKind.Disk).days_to_floor,
    null,
  );
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
  const stat = statOf(fixture.service.stats(), FootprintKind.Disk);
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
  assert.equal(
    statOf(fixture.service.stats(), FootprintKind.Disk).days_to_floor,
    NO_DAYS,
  );
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

test("the alert list answers the stored episodes and acknowledge refuses an unknown alert", async (t) => {
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
});
