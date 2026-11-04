import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { bucketEnd, bucketStart } from "./analytics-bucket.ts";
import {
  ANALYTICS_RANGE_DAYS_DEFAULT,
  ANALYTICS_RANGE_DAYS_MAX,
  type AnalyticsFlowQuery,
  FlowCompare,
  FlowGrain,
  type FlowRead,
} from "./contract.ts";
import { FLOW_HOUR_RANGE_DAYS_MAX } from "./flow-model.ts";
import { DAY_MS } from "./writable-period.ts";

const RANGE_INVALID_CODE = "tracking.filter.range_invalid";

export type FlowCoverage = Readonly<Record<FlowGrain, number | null>>;

export interface FlowWindows {
  grain: FlowGrain;
  window: FlowRead["window"];
  previous_window: FlowRead["previous_window"];
  cut: number | null;
}

function rangeInvalid(message: string): never {
  throw new OperationError(HttpStatus.BadRequest, RANGE_INVALID_CODE, message);
}

function startOf(time: number, grain: FlowGrain): number {
  const start = bucketStart(time, grain);
  assert.ok(start !== null);
  return start;
}

function endOf(time: number, grain: FlowGrain): number {
  const start = startOf(time, grain);
  return start === time ? time : bucketEnd(start, grain);
}

function checkedRange(
  query: Pick<AnalyticsFlowQuery, "from" | "to">,
  now: number,
): { from: number; to: number } {
  const to = query.to ?? now;
  const from = query.from ?? to - ANALYTICS_RANGE_DAYS_DEFAULT * DAY_MS;
  if (from > to) return rangeInvalid("from is after to.");
  if (to - from > ANALYTICS_RANGE_DAYS_MAX * DAY_MS)
    return rangeInvalid(
      `The range is longer than ${ANALYTICS_RANGE_DAYS_MAX} days.`,
    );
  return { from, to };
}

function grainOf(
  bucket: FlowGrain | undefined,
  range: { from: number; to: number },
): FlowGrain {
  const hourAllowed =
    range.to - range.from <= FLOW_HOUR_RANGE_DAYS_MAX * DAY_MS;
  if (bucket === undefined) return hourAllowed ? FlowGrain.Hour : FlowGrain.Day;
  if (bucket === FlowGrain.Hour && !hourAllowed)
    return rangeInvalid(
      `The bucket hour takes a range of at most ${FLOW_HOUR_RANGE_DAYS_MAX} days.`,
    );
  return bucket;
}

function bucketListOf(from: number, to: number, grain: FlowGrain): number[] {
  const buckets: number[] = [];
  for (let start = from; start < to; start = bucketEnd(start, grain))
    buckets.push(start);
  return buckets;
}

function previousWindowOf(
  compare: FlowCompare,
  grain: FlowGrain,
  window: FlowRead["window"],
  coverage: FlowCoverage,
): FlowRead["previous_window"] {
  const coverageStart = coverage[grain];
  if (compare === FlowCompare.None || coverageStart === null) return null;
  const from = window.from - (window.to - window.from);
  if (from < coverageStart) return null;
  return { from, to: window.from };
}

function cutOf(
  grain: FlowGrain,
  window: FlowRead["window"],
  coverage: FlowCoverage,
): number | null {
  const cut = endOf(window.now, FlowGrain.Hour) - (window.to - window.from);
  if (grain === FlowGrain.Hour) return cut;
  const dayStart = startOf(cut, FlowGrain.Day);
  if (dayStart === cut) return cut;
  const hourStart = coverage[FlowGrain.Hour];
  return hourStart === null || dayStart < hourStart ? null : cut;
}

export function flowWindowOf(
  query: Pick<AnalyticsFlowQuery, "from" | "to" | "bucket" | "compare">,
  now: number,
  coverage: FlowCoverage,
): FlowWindows {
  const range = checkedRange(query, now);
  const grain = grainOf(query.bucket, range);
  const from = startOf(range.from, grain);
  const to = endOf(range.to, grain);
  const window = {
    from,
    to,
    now: Math.min(range.to, now),
    bucket: grain,
    buckets: bucketListOf(from, to, grain),
  };
  const previous_window = previousWindowOf(
    query.compare,
    grain,
    window,
    coverage,
  );
  return {
    grain,
    window,
    previous_window,
    cut: previous_window === null ? null : cutOf(grain, window, coverage),
  };
}
