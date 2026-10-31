import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBins,
  BIN_COUNT,
  binOf,
  decodeBins,
  encodeBins,
  percentilesOf,
} from "./flow-bins.ts";

const BLOB_BYTES = 512;
const LAST_BIN = 127;
const TOLERANCE = 0.09;

function emptyBins(): number[] {
  return Array.from({ length: BIN_COUNT }, () => 0);
}

function binsOf(values: readonly number[]): number[] {
  const bins = emptyBins();
  for (const value of values)
    bins[binOf(value)] = (bins[binOf(value)] ?? 0) + 1;
  return bins;
}

function sumOf(bins: readonly number[]): number {
  return bins.reduce((sum, counter) => sum + counter, 0);
}

test("a value goes to the bin of the formula", () => {
  assert.deepEqual(
    [0, 0.5, 1, 2, 1000, 2 ** 40].map((value) => binOf(value)),
    [0, 0, 1, 5, 40, LAST_BIN],
  );
});

test("the blob holds 512 little-endian counters and decodes to the same counters", () => {
  const bins = emptyBins();
  bins[0] = 1;
  bins[5] = 0x01020304;
  bins[LAST_BIN] = 4294967295;
  const blob = encodeBins(bins);
  assert.equal(blob.byteLength, BLOB_BYTES);
  assert.deepEqual([...blob.subarray(20, 24)], [0x04, 0x03, 0x02, 0x01]);
  assert.deepEqual(decodeBins(blob), bins);
});

test("a blob of another size is refused", () => {
  assert.throws(() => decodeBins(new Uint8Array(BLOB_BYTES - 1)));
});

test("the merge of two blobs adds each counter", () => {
  const left = binsOf([1, 2, 2]);
  const right = binsOf([2, 1000]);
  const merged = addBins(
    decodeBins(encodeBins(left)),
    decodeBins(encodeBins(right)),
  );
  assert.deepEqual([merged[1], merged[5], merged[40]], [1, 3, 1]);
  assert.deepEqual(merged, binsOf([1, 2, 2, 2, 1000]));
  assert.equal(sumOf(merged), sumOf(left) + sumOf(right));
});

test("the percentiles of a known set fall inside the bin of the exact value", () => {
  const values = Array.from({ length: 100 }, (_, index) => (index + 1) * 100);
  const answer = percentilesOf(binsOf(values));
  assert.equal(answer.count, values.length);
  for (const [fraction, found] of [
    [0.5, answer.p50],
    [0.9, answer.p90],
    [0.99, answer.p99],
  ] as const) {
    const exact = values[Math.ceil(fraction * values.length) - 1] ?? 0;
    assert.ok(found !== null);
    assert.ok(Math.abs(found - exact) / exact <= TOLERANCE, `${fraction}`);
  }
});

test("bin 0 answers 0", () => {
  assert.deepEqual(percentilesOf(binsOf([0, 0.2])), {
    count: 2,
    p50: 0,
    p90: 0,
    p99: 0,
  });
});

test("an empty histogram answers null percentiles", () => {
  assert.deepEqual(percentilesOf(emptyBins()), {
    count: 0,
    p50: null,
    p90: null,
    p99: null,
  });
});
