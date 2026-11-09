import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  acknowledgedUntil,
  acknowledgementHolds,
  type AlertStep,
  type AlertSubject,
  type AlertTrack,
  FIRING_TRACK,
  OK_TRACK,
  step,
} from "./alerts.ts";
import { insertAlert, openAlerts } from "./alert-store.ts";
import {
  DEFAULT_AGE_DAYS,
  FOOTPRINT_ALERT_CLEAR_RATIO,
  FootprintAlertState,
  FootprintKind,
  type FootprintThreshold,
  ThresholdMeasure,
} from "./contract.ts";
import { DEFAULT_DISK_FREE_RATIO } from "./config.ts";
import { FakeOwner, footprintFixture, measured } from "./test-support.ts";

const HUMAN = testHumanIdentity("ulrich", "Ulrich", "jti-ulrich");
const GIB = 1073741824;
const TOTAL = 1024 * GIB;
const LIMIT = 8 * GIB;
const BYTES: FootprintThreshold = {
  measure: ThresholdMeasure.Bytes,
  value: LIMIT,
};
const FREE_RATIO: FootprintThreshold = {
  measure: ThresholdMeasure.FreeRatio,
  value: DEFAULT_DISK_FREE_RATIO,
};
const DAYS_TO_FLOOR: FootprintThreshold = {
  measure: ThresholdMeasure.DaysToFloor,
  value: DEFAULT_AGE_DAYS,
  free_ratio: DEFAULT_DISK_FREE_RATIO,
};
const DEVICE = "2049";
const SERVER_DEVICE = "64768";
const CODER_INSTANCE = "e2e-coder-1";
const PEER_INSTANCE = "e2e-coder-2";
const ONE_EPISODE = 1;
const TWO_EPISODES = 2;

function bytesSubject(bytes: number | null): AlertSubject {
  return {
    kind: FootprintKind.Trace,
    bytes,
    free_bytes: null,
    total_bytes: null,
    days_to_floor: null,
    stale: false,
    measure_error: null,
    thresholds: [BYTES],
  };
}

function diskSubject(
  freeBytes: number,
  daysToFloor: number | null,
): AlertSubject {
  return {
    kind: FootprintKind.Disk,
    bytes: null,
    free_bytes: freeBytes,
    total_bytes: TOTAL,
    days_to_floor: daysToFloor,
    stale: false,
    measure_error: null,
    thresholds: [FREE_RATIO, DAYS_TO_FLOOR],
  };
}

function run(track: AlertTrack, subjects: readonly AlertSubject[]): AlertStep {
  let current: AlertStep = { track, event: null };
  for (const subject of subjects) current = step(current.track, subject);
  return current;
}

test("each transition of the alert state machine", () => {
  const above = bytesSubject(LIMIT + 1);
  const atThreshold = bytesSubject(LIMIT);
  const clear = bytesSubject(LIMIT * FOOTPRINT_ALERT_CLEAR_RATIO);
  const pending = step(OK_TRACK, above);
  assert.equal(pending.track.state, FootprintAlertState.Pending);
  assert.equal(pending.event, null);
  assert.equal(
    step(pending.track, atThreshold).track.state,
    FootprintAlertState.Ok,
  );
  const firing = step(pending.track, above);
  assert.equal(firing.track.state, FootprintAlertState.Firing);
  assert.deepEqual(firing.event, {
    fire: true,
    threshold: BYTES,
    value: LIMIT + 1,
  });
  const recovering = step(firing.track, clear);
  assert.equal(recovering.track.state, FootprintAlertState.Recovering);
  assert.equal(recovering.event, null);
  const again = step(recovering.track, atThreshold);
  assert.equal(again.track.state, FootprintAlertState.Firing);
  assert.equal(again.event, null);
  const resolved = run(firing.track, [clear, clear]);
  assert.equal(resolved.track.state, FootprintAlertState.Ok);
  assert.deepEqual(resolved.event, { fire: false });
});

test("a value between the clear value and the threshold does not flap", () => {
  const band = bytesSubject(LIMIT * 0.95);
  assert.equal(
    run(OK_TRACK, [band, band, band]).track.state,
    FootprintAlertState.Ok,
  );
  const held = run(FIRING_TRACK, [band, band, band]);
  assert.equal(held.track.state, FootprintAlertState.Firing);
  assert.equal(held.event, null);
});

test("a stale or a failed measurement changes no state", () => {
  const pending = step(OK_TRACK, bytesSubject(LIMIT + 1)).track;
  for (const subject of [
    { ...bytesSubject(LIMIT + 1), stale: true },
    {
      ...bytesSubject(LIMIT + 1),
      measure_error: { code: "worker.footprint.unmeasured", message: "x" },
    },
  ]) {
    const next = step(pending, subject);
    assert.deepEqual(next.track, pending);
    assert.equal(next.event, null);
  }
  const firing = step(FIRING_TRACK, { ...bytesSubject(0), stale: true });
  assert.deepEqual(firing.track, FIRING_TRACK);
});

test("a null threshold sets ok and resolves an open episode", () => {
  const off = { ...bytesSubject(LIMIT * 2), thresholds: [] };
  const resolved = step(FIRING_TRACK, off);
  assert.deepEqual(resolved.track, OK_TRACK);
  assert.deepEqual(resolved.event, { fire: false });
  const pending = step(step(OK_TRACK, bytesSubject(LIMIT + 1)).track, off);
  assert.deepEqual(pending.track, OK_TRACK);
  assert.equal(pending.event, null);
});

test("a disk episode fires on the projection while the free ratio is above the floor", () => {
  const projected = diskSubject(TOTAL / 2, DEFAULT_AGE_DAYS - 1);
  const fired = run(OK_TRACK, [projected, projected]);
  assert.equal(fired.track.state, FootprintAlertState.Firing);
  assert.deepEqual(fired.event, {
    fire: true,
    threshold: DAYS_TO_FLOOR,
    value: DEFAULT_AGE_DAYS - 1,
  });
});

test("a disk episode resolves only when both conditions clear", () => {
  const ratioClear = TOTAL / 2;
  const projectionHeld = DEFAULT_AGE_DAYS + 1;
  const held = run(FIRING_TRACK, [
    diskSubject(ratioClear, projectionHeld),
    diskSubject(ratioClear, projectionHeld),
  ]);
  assert.equal(held.track.state, FootprintAlertState.Firing);
  const ratioHeld = run(FIRING_TRACK, [
    diskSubject(TOTAL * 0.105, null),
    diskSubject(TOTAL * 0.105, null),
  ]);
  assert.equal(ratioHeld.track.state, FootprintAlertState.Firing);
  const resolved = run(FIRING_TRACK, [
    diskSubject(ratioClear, null),
    diskSubject(ratioClear, DEFAULT_AGE_DAYS * 2),
  ]);
  assert.equal(resolved.track.state, FootprintAlertState.Ok);
  assert.deepEqual(resolved.event, { fire: false });
});

test("a restart restores firing for an open episode", async (t) => {
  const fixture = footprintFixture(t);
  const alertId = createIdentity("alert");
  fixture.store.transaction((tx) =>
    insertAlert(tx, {
      alert_id: alertId,
      kind: FootprintKind.Disk,
      instance_name: null,
      item_key: DEVICE,
      threshold: FREE_RATIO,
      value: 0.05,
      resolved_at: null,
      acknowledged_by: null,
      acknowledged_at: null,
      acknowledged_until: null,
    }),
  );
  const owner = new FakeOwner(
    [FootprintKind.Disk],
    [
      measured(FootprintKind.Disk, {
        item_key: DEVICE,
        total_bytes: TOTAL,
        free_bytes: TOTAL * 0.05,
      }),
    ],
  );
  fixture.service.register(owner);
  await fixture.service.measure();
  const stat = fixture.service
    .stats()
    .find((entry) => entry.item_key === DEVICE);
  assert.deepEqual(stat?.alert, {
    state: FootprintAlertState.Firing,
    alert_id: alertId,
  });
  owner.measures = [
    measured(FootprintKind.Disk, {
      item_key: DEVICE,
      total_bytes: TOTAL,
      free_bytes: TOTAL / 2,
    }),
  ];
  await fixture.service.measure();
  const list = await fixture.footprint["alert.list"](
    { params: {}, query: { limit: 10 }, body: null },
    { identity: HUMAN },
  );
  assert.equal(list.type, OperationResultType.Completed);
  assert.equal(
    list.data.items.find((item) => item.alert_id === alertId)?.state,
    FootprintAlertState.Recovering,
  );
});

async function episodesOf(
  t: Parameters<typeof footprintFixture>[0],
  kind: FootprintKind,
  measures: ReturnType<typeof measured>[],
) {
  const fixture = footprintFixture(t);
  fixture.service.register(new FakeOwner([kind], measures));
  await fixture.service.measure();
  await fixture.service.measure();
  return fixture.store
    .transaction((tx) => openAlerts(tx))
    .filter((alert) => alert.kind === kind && alert.item_key !== null)
    .filter((alert) => measures.some((m) => m.item_key === alert.item_key));
}

test("two server instances on S give one disk episode", async (t) => {
  const episodes = await episodesOf(t, FootprintKind.Disk, [
    measured(FootprintKind.Disk, {
      item_key: SERVER_DEVICE,
      instance_names: [CODER_INSTANCE, PEER_INSTANCE],
      total_bytes: TOTAL,
      free_bytes: TOTAL * 0.05,
    }),
  ]);
  assert.equal(episodes.length, ONE_EPISODE);
  assert.equal(episodes[0]?.instance_name, null);
});

test("two worker instances with the same device number give two disk episodes", async (t) => {
  const episodes = await episodesOf(
    t,
    FootprintKind.Disk,
    [CODER_INSTANCE, PEER_INSTANCE].map((name) =>
      measured(FootprintKind.Disk, {
        instance_name: name,
        item_key: DEVICE,
        instance_names: [name],
        total_bytes: TOTAL,
        free_bytes: TOTAL * 0.05,
      }),
    ),
  );
  assert.deepEqual(episodes.map((alert) => alert.instance_name).sort(), [
    CODER_INSTANCE,
    PEER_INSTANCE,
  ]);
});

test("two log files of one instance hold two episodes", async (t) => {
  const episodes = await episodesOf(
    t,
    FootprintKind.Log,
    ["kanthord.log", "stderr.log"].map((file) =>
      measured(FootprintKind.Log, {
        instance_name: CODER_INSTANCE,
        item_key: file,
        count: 1,
        bytes: 3 * GIB,
      }),
    ),
  );
  assert.equal(episodes.length, TWO_EPISODES);
  assert.deepEqual(
    episodes.map((alert) => alert.threshold),
    [
      { measure: ThresholdMeasure.Bytes, value: 2 * GIB },
      { measure: ThresholdMeasure.Bytes, value: 2 * GIB },
    ],
  );
});

const DISK_ALERT = {
  kind: FootprintKind.Disk,
  value: 0.05,
  acknowledged_until: null,
};
const BYTES_ALERT = {
  kind: FootprintKind.Trace,
  value: 9 * GIB,
  acknowledged_until: null,
};

function diskBytes(freeBytes: number, totalBytes = TOTAL) {
  return { bytes: null, free_bytes: freeBytes, total_bytes: totalBytes };
}

test("a disk acknowledgement holds until the free bytes drop below the larger of half the free bytes and the floor bytes", () => {
  const until = acknowledgedUntil(
    DISK_ALERT,
    diskBytes(400 * GIB),
    DEFAULT_DISK_FREE_RATIO,
  );
  assert.equal(until, 200 * GIB);
  const nearFloor = acknowledgedUntil(
    DISK_ALERT,
    diskBytes(150 * GIB),
    DEFAULT_DISK_FREE_RATIO,
  );
  assert.equal(nearFloor, Math.floor(DEFAULT_DISK_FREE_RATIO * TOTAL));
  const acknowledged = { ...DISK_ALERT, acknowledged_until: until };
  assert.equal(acknowledgementHolds(acknowledged, diskBytes(until)), true);
  assert.equal(acknowledgementHolds(acknowledged, diskBytes(until - 1)), false);
});

test("a bytes acknowledgement holds until the value reaches twice the value at the acknowledgement", () => {
  const until = acknowledgedUntil(
    BYTES_ALERT,
    { bytes: 9 * GIB, free_bytes: null, total_bytes: null },
    DEFAULT_DISK_FREE_RATIO,
  );
  assert.equal(until, 18 * GIB);
  const acknowledged = { ...BYTES_ALERT, acknowledged_until: until };
  const at = (bytes: number) => ({
    bytes,
    free_bytes: null,
    total_bytes: null,
  });
  assert.equal(acknowledgementHolds(acknowledged, at(until - 1)), true);
  assert.equal(acknowledgementHolds(acknowledged, at(until)), false);
});

test("a new acknowledgement replaces the old one", async (t) => {
  let now = Date.UTC(2026, 10, 3, 9);
  const fixture = footprintFixture(t, { now: () => now });
  const owner = new FakeOwner(
    [FootprintKind.Trace],
    [measured(FootprintKind.Trace, { count: 1, bytes: 9 * GIB })],
  );
  fixture.service.register(owner);
  await fixture.service.measure();
  await fixture.service.measure();
  const traceAlerts = () =>
    fixture.store
      .transaction((tx) => openAlerts(tx))
      .filter((entry) => entry.kind === FootprintKind.Trace);
  const [alert] = traceAlerts();
  assert.ok(alert);
  const acknowledge = () =>
    fixture.footprint["alert.acknowledge"](
      { params: { alert_id: alert.alert_id }, query: {}, body: null },
      { identity: HUMAN, idempotencyKey: createIdempotencyKey() },
    );
  const first = await acknowledge();
  assert.equal(first.type, OperationResultType.Completed);
  assert.equal(first.data.acknowledged_until, 18 * GIB);
  owner.measures = [
    measured(FootprintKind.Trace, { count: 1, bytes: 20 * GIB }),
  ];
  await fixture.service.measure();
  now += 1;
  const second = await acknowledge();
  assert.equal(second.type, OperationResultType.Completed);
  assert.equal(second.data.acknowledged_until, 40 * GIB);
  assert.equal(second.data.acknowledged_at, now);
  const [stored] = traceAlerts();
  assert.equal(stored?.acknowledged_until, 40 * GIB);
});
