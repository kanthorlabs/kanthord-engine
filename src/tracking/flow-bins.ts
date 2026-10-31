import assert from "node:assert/strict";

export const BIN_COUNT = 128;
const COUNTER_BYTES = 4;
const BLOB_BYTES = BIN_COUNT * COUNTER_BYTES;
const LAST_BIN = BIN_COUNT - 1;
const BINS_PER_OCTAVE = 4;
const BIN_CENTER_OFFSET = 0.5;
const UNDERFLOW_BIN = 0;
const FIRST_VALUE_BIN = 1;
const MIN_BINNED_MS = 1;
const NO_VALUES = 0;
const OCTAVE_BASE = 2;
const P50 = 0.5;
const P90 = 0.9;
const P99 = 0.99;

export interface FlowPercentiles {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

export function binOf(milliseconds: number): number {
  if (milliseconds < MIN_BINNED_MS) return UNDERFLOW_BIN;
  return Math.min(
    LAST_BIN,
    FIRST_VALUE_BIN + Math.floor(BINS_PER_OCTAVE * Math.log2(milliseconds)),
  );
}

export function encodeBins(bins: readonly number[]): Buffer {
  assert.equal(bins.length, BIN_COUNT);
  const blob = Buffer.alloc(BLOB_BYTES);
  bins.forEach((counter, index) =>
    blob.writeUInt32LE(counter, index * COUNTER_BYTES),
  );
  return blob;
}

export function decodeBins(blob: Uint8Array): number[] {
  assert.equal(blob.byteLength, BLOB_BYTES);
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  return Array.from({ length: BIN_COUNT }, (_, index) =>
    view.readUInt32LE(index * COUNTER_BYTES),
  );
}

export function addBins(
  left: readonly number[],
  right: readonly number[],
): number[] {
  assert.equal(left.length, BIN_COUNT);
  assert.equal(right.length, BIN_COUNT);
  return left.map((counter, index) => counter + (right[index] ?? 0));
}

function binValue(bin: number): number {
  if (bin === UNDERFLOW_BIN) return 0;
  return Math.round(
    OCTAVE_BASE ** ((bin - BIN_CENTER_OFFSET) / BINS_PER_OCTAVE),
  );
}

function percentileOf(
  bins: readonly number[],
  count: number,
  fraction: number,
): number {
  const target = Math.ceil(fraction * count);
  let cumulative = 0;
  for (const [bin, counter] of bins.entries()) {
    cumulative += counter;
    if (cumulative >= target) return binValue(bin);
  }
  return binValue(LAST_BIN);
}

export function percentilesOf(bins: readonly number[]): FlowPercentiles {
  const count = bins.reduce((sum, counter) => sum + counter, 0);
  if (count === NO_VALUES) return { count, p50: null, p90: null, p99: null };
  return {
    count,
    p50: percentileOf(bins, count, P50),
    p90: percentileOf(bins, count, P90),
    p99: percentileOf(bins, count, P99),
  };
}
