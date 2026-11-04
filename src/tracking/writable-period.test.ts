import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS, writableCutoff } from "./writable-period.ts";

const NOW = 1751566593132;
const WRITABLE_DAYS = 30;
const CUTOFF_30_DAYS = NOW - 2592000000;

test("the cutoff lies the writable period before now", () => {
  assert.equal(writableCutoff(NOW, WRITABLE_DAYS), CUTOFF_30_DAYS);
});

test("the cutoff of one writable day lies one day before now", () => {
  assert.equal(writableCutoff(NOW, 1), NOW - DAY_MS);
});
