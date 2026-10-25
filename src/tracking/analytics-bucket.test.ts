import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketEnd, bucketStart } from "./analytics-bucket.ts";
import { AnalyticsBucket } from "./contract.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONDAY = Date.UTC(2024, 0, 1);

test("bucketEnd of an hour is the start of the next hour", () => {
  const start = bucketStart(MONDAY + 90 * 60_000, AnalyticsBucket.Hour)!;
  assert.equal(start, MONDAY + HOUR);
  assert.equal(bucketEnd(start, AnalyticsBucket.Hour), MONDAY + 2 * HOUR);
});

test("bucketEnd of a day is the start of the next day", () => {
  const start = bucketStart(MONDAY + 5 * HOUR, AnalyticsBucket.Day)!;
  assert.equal(start, MONDAY);
  assert.equal(bucketEnd(start, AnalyticsBucket.Day), MONDAY + DAY);
});

test("bucketEnd of a week is the start of the next Monday", () => {
  const start = bucketStart(MONDAY + 3 * DAY, AnalyticsBucket.Week)!;
  assert.equal(start, MONDAY);
  assert.equal(bucketEnd(start, AnalyticsBucket.Week), MONDAY + WEEK);
});
