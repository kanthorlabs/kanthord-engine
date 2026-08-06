import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GITOP_PID_PATTERN, SEED_PID_PATTERN } from "../../domain/recovery.ts";
import { listPidFiles, pidFilePathFor, removePidFile } from "./pid-file.ts";

describe("src/services/git/pid-file.test", () => {
  it("pidFilePathFor names the run directory and the row", () => {
    assert.equal(
      pidFilePathFor("/h/git/run", "gitop_01J0"),
      "/h/git/run/gitop-gitop_01J0.pid",
    );
  });

  it("listPidFiles on a missing directory returns an empty list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanthord-pid-missing-"));
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await listPidFiles({ runDirectory: dir }), []);
  });

  it("listPidFiles returns every .pid regular file bytewise sorted and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanthord-pid-listing-"));
    try {
      for (const name of [
        "seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
        "gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
        "git-3f2a.pid",
        "probe-3f2a.pid",
        "keyscan-3f2a.pid",
      ]) {
        writeFileSync(join(dir, name), "12345\n");
      }
      writeFileSync(join(dir, "note.txt"), "not a pid file");
      mkdirSync(join(dir, "d.pid"));
      assert.deepEqual(await listPidFiles({ runDirectory: dir }), [
        join(dir, "git-3f2a.pid"),
        join(dir, "gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid"),
        join(dir, "keyscan-3f2a.pid"),
        join(dir, "probe-3f2a.pid"),
        join(dir, "seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SEED_PID_PATTERN and GITOP_PID_PATTERN attribute the two named forms and match nothing else", () => {
    const seedMatch = "seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid".match(
      SEED_PID_PATTERN,
    );
    assert.equal(seedMatch?.[1], "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const gitopMatch = "gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid".match(
      GITOP_PID_PATTERN,
    );
    assert.equal(gitopMatch?.[1], "gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(SEED_PID_PATTERN.test("git-3f2a.pid"), false);
    assert.equal(GITOP_PID_PATTERN.test("git-3f2a.pid"), false);
  });

  it("removePidFile on a missing path resolves without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanthord-pid-remove-"));
    try {
      await assert.doesNotReject(() =>
        removePidFile({ pidFile: join(dir, "nope.pid") }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
