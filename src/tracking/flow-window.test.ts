import assert from "node:assert/strict";
import { test } from "node:test";
import { type AnalyticsFlowQuery, FlowCompare, FlowGrain } from "./contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { flowWindowOf } from "./flow-window.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D0 = Date.UTC(2024, 5, 15);
const NOW = D0 + 10 * HOUR + 30 * 60_000;
const NOW_ON_HOUR = D0 + 10 * HOUR;
const COVERED = { [FlowGrain.Hour]: 0, [FlowGrain.Day]: 0 };
const UNCOVERED = { [FlowGrain.Hour]: null, [FlowGrain.Day]: null };
const RANGE_INVALID = "tracking.filter.range_invalid";
const HOURS_IN_TWO_DAYS_PLUS_ONE = 49;
const DAYS_PER_WEEK = 7;

function query(overrides: Partial<AnalyticsFlowQuery>): AnalyticsFlowQuery {
  return { compare: FlowCompare.Previous, ...overrides };
}

function isRangeInvalid(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === RANGE_INVALID &&
    "status" in error &&
    error.status === HttpStatus.BadRequest
  );
}

function refuses(overrides: Partial<AnalyticsFlowQuery>): void {
  assert.throws(
    () => flowWindowOf(query(overrides), NOW, COVERED),
    isRangeInvalid,
  );
}

test("a range of 2 days defaults to the hour bucket and ends at the time of the read", () => {
  const { grain, window } = flowWindowOf(
    query({ from: NOW - 2 * DAY }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Hour);
  assert.equal(window.bucket, FlowGrain.Hour);
  assert.equal(window.from, NOW_ON_HOUR - 2 * DAY);
  assert.equal(window.to, NOW_ON_HOUR + HOUR);
  assert.equal(window.now, NOW);
  assert.equal(window.buckets.length, HOURS_IN_TWO_DAYS_PLUS_ONE);
});

test("a range of 3 days defaults to the day bucket", () => {
  const { grain, window } = flowWindowOf(
    query({ from: NOW - 3 * DAY }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Day);
  assert.equal(window.from, D0 - 3 * DAY);
  assert.equal(window.to, D0 + DAY);
  assert.deepEqual(window.buckets, [D0 - 3 * DAY, D0 - 2 * DAY, D0 - DAY, D0]);
});

test("a query with no range reads 7 days back from the time of the read by day", () => {
  const { grain, window } = flowWindowOf(query({}), NOW, COVERED);
  assert.equal(grain, FlowGrain.Day);
  assert.equal(window.from, D0 - DAYS_PER_WEEK * DAY);
  assert.equal(window.now, NOW);
});

test("a range of 31 days passes and 31 days plus 1 ms is refused", () => {
  const { grain } = flowWindowOf(
    query({ from: NOW - 31 * DAY, to: NOW }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Day);
  refuses({ from: NOW - 31 * DAY - 1, to: NOW });
});

test("the bucket hour passes with 2 days and is refused with 2 days plus 1 ms", () => {
  const { grain } = flowWindowOf(
    query({ from: NOW - 2 * DAY, to: NOW, bucket: FlowGrain.Hour }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Hour);
  refuses({ from: NOW - 2 * DAY - 1, to: NOW, bucket: FlowGrain.Hour });
});

test("a from after to is refused", () => {
  refuses({ from: NOW, to: NOW - 1 });
});

test("the hour grain floors from, ceils to and lists each bucket start", () => {
  const { window } = flowWindowOf(
    query({
      from: D0 + 10 * HOUR + 15 * 60_000,
      to: D0 + 13 * HOUR + 5 * 60_000,
    }),
    NOW,
    COVERED,
  );
  assert.equal(window.from, D0 + 10 * HOUR);
  assert.equal(window.to, D0 + 14 * HOUR);
  assert.deepEqual(window.buckets, [
    D0 + 10 * HOUR,
    D0 + 11 * HOUR,
    D0 + 12 * HOUR,
    D0 + 13 * HOUR,
  ]);
});

test("window.now is to for a to in the past and the time of the read for a later to", () => {
  const past = flowWindowOf(
    query({ from: D0 + 2 * HOUR, to: D0 + 5 * HOUR + 1 }),
    NOW,
    COVERED,
  );
  assert.equal(past.window.now, D0 + 5 * HOUR + 1);
  assert.ok(past.window.now < past.window.to);
  const later = flowWindowOf(
    query({ from: D0 + 2 * HOUR, to: D0 + 14 * HOUR }),
    NOW,
    COVERED,
  );
  assert.equal(later.window.now, NOW);
});

test("the previous window of the hour grain ends where the window starts", () => {
  const { previous_window } = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR }),
    NOW,
    COVERED,
  );
  assert.deepEqual(previous_window, {
    from: D0 + 2 * HOUR,
    to: D0 + 6 * HOUR,
  });
});

test("the previous window of the day grain ends where the window starts", () => {
  const { previous_window } = flowWindowOf(
    query({ from: D0 - 4 * DAY, to: D0 - DAY }),
    NOW,
    COVERED,
  );
  assert.deepEqual(previous_window, {
    from: D0 - 7 * DAY,
    to: D0 - 4 * DAY,
  });
});

test("compare none answers a null previous window and a null cut", () => {
  const result = flowWindowOf(
    query({ from: D0 - 4 * DAY, compare: FlowCompare.None }),
    NOW,
    COVERED,
  );
  assert.equal(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the previous window of the hour grain older than 8 days stays", () => {
  const start = NOW_ON_HOUR - 9 * DAY;
  const { previous_window } = flowWindowOf(
    query({ from: start + 4 * HOUR, to: start + 8 * HOUR }),
    NOW_ON_HOUR,
    COVERED,
  );
  assert.deepEqual(previous_window, { from: start, to: start + 4 * HOUR });
});

test("the previous window of the day grain older than 64 days stays", () => {
  const { previous_window } = flowWindowOf(
    query({ from: D0 - 90 * DAY, to: D0 - 89 * DAY, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.deepEqual(previous_window, {
    from: D0 - 91 * DAY,
    to: D0 - 90 * DAY,
  });
});

test("the previous window is null before the coverage start of its grain", () => {
  const input = query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR });
  const start = D0 + 2 * HOUR;
  const coverage = (hour: number) => ({ ...UNCOVERED, [FlowGrain.Hour]: hour });
  assert.notEqual(
    flowWindowOf(input, NOW, coverage(start)).previous_window,
    null,
  );
  assert.equal(
    flowWindowOf(input, NOW, coverage(start + 1)).previous_window,
    null,
  );
});

test("the previous window is null when the grain holds no row", () => {
  const result = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR }),
    NOW,
    UNCOVERED,
  );
  assert.equal(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the cut of the hour grain inside an hour ends the hour of window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 14 * HOUR }),
    NOW,
    COVERED,
  );
  assert.equal(result.cut, D0 + 11 * HOUR - 8 * HOUR);
});

test("the cut of the day grain inside an hour ends the hour of window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 - 6 * DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(result.window.to - result.window.from, 7 * DAY);
  assert.equal(result.cut, D0 + 11 * HOUR - 7 * DAY);
});

test("the cut of the day grain of a window of 8 days counts the hour rows older than 8 days", () => {
  const result = flowWindowOf(
    query({ from: D0 - 7 * DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(result.window.to - result.window.from, 8 * DAY);
  assert.notEqual(result.previous_window, null);
  assert.equal(result.cut, D0 + 11 * HOUR - 8 * DAY);
});

test("the cut of the day grain is null when its day starts before the first hour row", () => {
  const result = flowWindowOf(
    query({ from: D0 - 6 * DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    { [FlowGrain.Hour]: D0 - 7 * DAY + HOUR, [FlowGrain.Day]: 0 },
  );
  assert.notEqual(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the cut of the day grain on a day boundary needs no hour rows", () => {
  const result = flowWindowOf(
    query({ from: D0 - 30 * DAY, to: D0, bucket: FlowGrain.Day }),
    D0,
    COVERED,
  );
  assert.equal(result.cut, D0 - 30 * DAY);
});
