import assert from "node:assert/strict";
import test from "node:test";
import { freeDiskOf } from "./disk.ts";
import { temporary } from "./test-support.ts";

const EMPTY_DISK_BYTES = 0;

test("freeDiskOf answers positive free bytes within the total bytes of a directory", async (t) => {
  const space = await freeDiskOf(temporary(t));
  assert.ok(space.total_bytes > EMPTY_DISK_BYTES);
  assert.ok(space.free_bytes >= EMPTY_DISK_BYTES);
  assert.ok(space.free_bytes <= space.total_bytes);
});

test("freeDiskOf rejects a directory that is absent", async (t) => {
  await assert.rejects(freeDiskOf(`${temporary(t)}/absent`));
});
