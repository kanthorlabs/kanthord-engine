import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HELPER_LOG_PATTERN,
  KEPT_KEY_FILES,
  KEY_PREFIX,
  LOCK_FILE_NAMES,
  STAGING_PREFIX,
  sweepHome,
} from "./sweep.ts";
import type { SweepBoundary } from "./sweep.ts";

const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-sweep-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bareHome(
  root: string,
  repositoryId: string = REPOSITORY_ID,
): SweepBoundary {
  return { kind: "bare-home", root, repositoryId };
}

function workspaceBoundary(
  root: string,
  repositoryId: string = REPOSITORY_ID,
): SweepBoundary {
  return { kind: "workspace", root, repositoryId };
}

function write(path: string): void {
  writeFileSync(path, "");
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("src/services/git/sweep.test", () => {
  it("six lock files across the root and the subtrees are all removed in bytewise order", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(join(home, "refs", "heads"), { recursive: true });
    mkdirSync(join(home, "refs", "tags"), { recursive: true });
    mkdirSync(join(home, "objects", "pack"), { recursive: true });
    const lockFiles = [
      join(home, "HEAD.lock"),
      join(home, "config.lock"),
      join(home, "packed-refs.lock"),
      join(home, "refs", "heads", "main.lock"),
      join(home, "refs", "tags", "v1.lock"),
      join(home, "objects", "pack", "tmp.lock"),
    ];
    for (const lockFile of lockFiles) {
      write(lockFile);
    }
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    const expected = [...lockFiles].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    assert.deepEqual(
      report.removed.map((removal) => removal.path),
      expected,
    );
    for (const removal of report.removed) {
      assert.equal(removal.class, "lock");
    }
    for (const lockFile of lockFiles) {
      assert.equal(existsSync(lockFile), false);
    }
    assert.deepEqual(report.refused, []);
  });

  it("unmatching names survive and appear in neither list", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(join(home, "refs", "heads"), { recursive: true });
    const plain = join(home, "refs", "heads", "main");
    const readme = join(home, "README");
    write(plain);
    write(readme);
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    assert.equal(existsSync(plain), true);
    assert.equal(existsSync(readme), true);
    const touched = [...report.removed, ...report.refused].map(
      (entry) => entry.path,
    );
    assert.equal(touched.includes(plain), false);
    assert.equal(touched.includes(readme), false);
  });

  it("gc.pid is removed and gc.pid.keep is not", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(home, { recursive: true });
    const gcPid = join(home, "gc.pid");
    const gcPidKeep = join(home, "gc.pid.keep");
    write(gcPid);
    write(gcPidKeep);
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    assert.equal(existsSync(gcPid), false);
    assert.equal(existsSync(gcPidKeep), true);
    assert.equal(
      report.removed.some((removal) => removal.path === gcPid),
      true,
    );
    assert.equal(
      report.removed.some((removal) => removal.path === gcPidKeep),
      false,
    );
  });

  it("a lock reached through a symbolic link pointing outside the home is refused and the link survives", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(join(home, "refs", "heads"), { recursive: true });
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    const outsideTarget = join(outside, "target.lock");
    write(outsideTarget);
    const link = join(home, "refs", "heads", "main.lock");
    symlinkSync(outsideTarget, link);
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    assert.deepEqual(report.removed, []);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0]!.path, link);
    assert.equal(report.refused[0]!.class, "lock");
    assert.equal(report.refused[0]!.repositoryId, REPOSITORY_ID);
    assert.equal(report.refused[0]!.reason, "symlink-on-path");
    assert.equal(existsSync(outsideTarget), true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  it("a refs/heads directory that is a symbolic link is refused and never descended into", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(join(home, "refs"), { recursive: true });
    const outside = join(dir, "outside-heads");
    mkdirSync(outside, { recursive: true });
    const insideLock = join(outside, "target.lock");
    write(insideLock);
    symlinkSync(outside, join(home, "refs", "heads"));
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    const heads = join(home, "refs", "heads");
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0]!.path, heads);
    assert.equal(report.refused[0]!.reason, "symlink-on-path");
    const touched = [...report.removed, ...report.refused].map(
      (entry) => entry.path,
    );
    assert.equal(touched.includes(insideLock), false);
    assert.equal(existsSync(insideLock), true);
  });

  it("a staging directory from an interrupted seed is removed and a finished home beside it is untouched", async () => {
    const dir = temporaryDirectory();
    const parent = join(dir, "repos");
    mkdirSync(parent, { recursive: true });
    const staging = join(parent, ".staging-abc");
    mkdirSync(staging, { recursive: true });
    const finished = join(parent, "fixture.git");
    mkdirSync(finished, { recursive: true });
    write(join(finished, "HEAD"));
    const report = await sweepHome({
      boundaries: [bareHome(finished)],
      keyDirectory: join(dir, "keys"),
    });
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(join(finished, "HEAD")), true);
    assert.equal(
      report.removed.some(
        (removal) => removal.path === staging && removal.class === "staging",
      ),
      true,
    );
  });

  it("a .staging file refuses with not-a-directory and is still present", async () => {
    const dir = temporaryDirectory();
    const parent = join(dir, "repos");
    mkdirSync(parent, { recursive: true });
    const staging = join(parent, ".staging-abc");
    write(staging);
    const finished = join(parent, "fixture.git");
    mkdirSync(finished, { recursive: true });
    const report = await sweepHome({
      boundaries: [bareHome(finished)],
      keyDirectory: join(dir, "keys"),
    });
    assert.equal(report.removed.length, 0);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0]!.path, staging);
    assert.equal(report.refused[0]!.class, "staging");
    assert.equal(report.refused[0]!.reason, "not-a-directory");
    assert.equal(existsSync(staging), true);
  });

  it("a HEAD.lock that is a directory refuses with not-a-regular-file", async () => {
    const dir = temporaryDirectory();
    const home = join(dir, "home.git");
    mkdirSync(home, { recursive: true });
    const headLock = join(home, "HEAD.lock");
    mkdirSync(headLock, { recursive: true });
    const report = await sweepHome({
      boundaries: [bareHome(home)],
      keyDirectory: join(dir, "keys"),
    });
    assert.equal(report.removed.length, 0);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0]!.path, headLock);
    assert.equal(report.refused[0]!.class, "lock");
    assert.equal(report.refused[0]!.reason, "not-a-regular-file");
    assert.equal(lstatSync(headLock).isDirectory(), true);
  });

  it("key material is removed and the kept scripts survive at 0700", async () => {
    const dir = temporaryDirectory();
    const keyDirectory = join(dir, "keys");
    mkdirSync(keyDirectory, { recursive: true });
    const keyFile = join(keyDirectory, `${KEY_PREFIX}abc`);
    const helperLog = join(keyDirectory, "helper-abc.log");
    const kept = KEPT_KEY_FILES.map((name) => join(keyDirectory, name));
    writeFileSync(keyFile, "", { mode: 0o700 });
    writeFileSync(helperLog, "", { mode: 0o700 });
    assert.equal(HELPER_LOG_PATTERN.test("helper-abc.log"), true);
    for (const path of kept) {
      writeFileSync(path, "", { mode: 0o700 });
    }
    const report = await sweepHome({
      boundaries: [],
      keyDirectory,
    });
    const removed = report.removed
      .filter((entry) => entry.class === "key-material")
      .map((entry) => entry.path);
    assert.deepEqual(
      [...removed].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
      [keyFile, helperLog].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    for (const removal of report.removed) {
      if (removal.class === "key-material") {
        assert.equal(removal.repositoryId, null);
      }
    }
    for (const path of kept) {
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }
    assert.equal(existsSync(keyFile), false);
    assert.equal(existsSync(helperLog), false);
  });

  it("a workspace boundary sweeps its .git but not the workspace root", async () => {
    const dir = temporaryDirectory();
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const indexLock = join(workspace, ".git", "index.lock");
    const headLock = join(workspace, ".git", "HEAD.lock");
    const rootIndexLock = join(workspace, "index.lock");
    write(indexLock);
    write(headLock);
    write(rootIndexLock);
    const report = await sweepHome({
      boundaries: [workspaceBoundary(workspace)],
      keyDirectory: join(dir, "keys"),
    });
    assert.deepEqual(
      [...report.removed.map((entry) => entry.path)].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
      [headLock, indexLock].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    assert.equal(existsSync(rootIndexLock), true);
    const touched = [...report.removed, ...report.refused].map(
      (entry) => entry.path,
    );
    assert.equal(touched.includes(rootIndexLock), false);
  });

  it("missing roots and a missing key directory produce an empty report", async () => {
    const dir = temporaryDirectory();
    const emptyHome = join(dir, "home.git");
    mkdirSync(emptyHome, { recursive: true });
    const missing = join(dir, "missing.git");
    const report = await sweepHome({
      boundaries: [bareHome(emptyHome), bareHome(missing)],
      keyDirectory: join(dir, "keys"),
    });
    assert.deepEqual(report, { removed: [], refused: [] });
  });

  it("LOCK_FILE_NAMES is bytewise sorted", () => {
    for (let index = 1; index < LOCK_FILE_NAMES.length; index++) {
      const previous = LOCK_FILE_NAMES[index - 1]!;
      const current = LOCK_FILE_NAMES[index]!;
      assert.equal(
        Buffer.compare(Buffer.from(previous), Buffer.from(current)) < 0,
        true,
        `${previous} must sort before ${current}`,
      );
    }
  });

  it("two boundaries sharing a parent see one staging candidate attributed to the first boundary", async () => {
    const dir = temporaryDirectory();
    const parent = join(dir, "repos");
    mkdirSync(parent, { recursive: true });
    const repoA = join(parent, "a.git");
    const repoB = join(parent, "b.git");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const staging = join(parent, ".staging-abc");
    mkdirSync(staging, { recursive: true });
    const firstId = "repo_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const secondId = "repo_01BBBBBBBBBBBBBBBBBBBBBBBB";
    const report = await sweepHome({
      boundaries: [bareHome(repoA, firstId), bareHome(repoB, secondId)],
      keyDirectory: join(dir, "keys"),
    });
    const stagingRemovals = report.removed.filter(
      (removal) => removal.path === staging,
    );
    assert.equal(stagingRemovals.length, 1);
    assert.equal(stagingRemovals[0]!.class, "staging");
    assert.equal(stagingRemovals[0]!.repositoryId, firstId);
  });
});
