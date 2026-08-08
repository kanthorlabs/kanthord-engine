import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleDirectory,
  claimBundleDirectory,
  mintTag,
  runDirectory,
} from "./tag.ts";
import { RunnerError } from "./errors.ts";

test("mintTag joins the stripped ISO timestamp and the lowercased entropy with one dash", () => {
  const tag = mintTag(
    new Date("2026-08-06T12:34:56.789Z"),
    () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );

  assert.equal(tag, "20260806123456789-01arz3ndektsv4rrffq69g5fav");
});

test("runDirectory nests the tag under the acceptance run root", () => {
  assert.equal(runDirectory("t1"), ".data/acceptance-t1");
});

test("bundleDirectory nests the scenario id under the run directory", () => {
  assert.equal(bundleDirectory("t1", "P1-E2"), ".data/acceptance-t1/P1-E2");
});

test("claimBundleDirectory refuses a reused scenario id under one tag, and lets a second id through", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-tag-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  await t.test(
    "the first claim of a scenario id under a tag resolves to its bundle directory",
    async () => {
      const claimed = await claimBundleDirectory("t1", "P1-E1");
      assert.equal(claimed, bundleDirectory("t1", "P1-E1"));
    },
  );

  await t.test(
    "a second claim of the same tag and scenario id is refused, and writes nothing",
    async () => {
      const before = await readdir(".data/acceptance-t1/P1-E1");

      try {
        await claimBundleDirectory("t1", "P1-E1");
        assert.fail("expected a throw");
      } catch (error) {
        assert.ok(error instanceof RunnerError);
        assert.equal(error.code, "tag-reused");
        assert.equal(error.message, "tag t1 already holds a run of P1-E1");
      }

      const after = await readdir(".data/acceptance-t1/P1-E1");
      assert.deepEqual(after, before);
    },
  );

  await t.test("a second scenario id under the same tag resolves", async () => {
    const claimed = await claimBundleDirectory("t1", "P1-E2");
    assert.equal(claimed, bundleDirectory("t1", "P1-E2"));
  });
});
