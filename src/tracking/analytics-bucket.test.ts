import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketEnd, bucketStart } from "./analytics-bucket.ts";
import { AnalyticsBucket } from "./contract.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONDAY = Date.UTC(2024, 0, 1);

test("bucketEnd of a week is the start of the next Monday", () => {
  const start = bucketStart(MONDAY + 3 * DAY, AnalyticsBucket.Week)!;
  assert.equal(start, MONDAY);
  assert.equal(bucketEnd(start, AnalyticsBucket.Week), MONDAY + WEEK);
});
