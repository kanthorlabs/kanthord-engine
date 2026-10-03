import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../kernel/context.ts";
import {
  gitLsRemote,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  pushNodeBranch,
} from "./connector.ts";
import { temporary } from "../kernel/test-support.ts";

const DEADLINE_MS = 5000;
const EXPIRED_DEADLINE_MS = 1;
const MISSING_REPOSITORY = "file:////nonexistent_kanthord_plan04_test";

test("gitLsRemote resolves for a local git repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  await assert.doesNotReject(
    gitLsRemote("file://" + dir, background, DEADLINE_MS),
  );
});

test("gitLsRemote rejects for a nonexistent repository", async () => {
  await assert.rejects(
    gitLsRemote(MISSING_REPOSITORY, background, DEADLINE_MS),
  );
});

test("gitLsRemote rejects when the deadline elapses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  await assert.rejects(
    gitLsRemote("file://" + dir, background, EXPIRED_DEADLINE_MS),
  );
});

test("gitLsRemote rejects when the context was already cancelled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(gitLsRemote("file://" + dir, context, DEADLINE_MS));
});

test("connector clones, resumes and pushes only fast-forward node branches and immutable snapshots", async (t) => {
  const root = temporary(t);
  const origin = join(root, "origin");
  const seed = join(root, "seed");
  const first = join(root, "first");
  const second = join(root, "second");
  const snapshot = join(root, "snapshot");
  const baseSnapshot = join(root, "baseSnapshot");
  for (const directory of [origin, seed, first, second, snapshot, baseSnapshot])
    mkdirSync(directory);
  await simpleGit(origin).init(true);
  const git = simpleGit(seed);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  const commit = async (directory: string, value: string) => {
    writeFileSync(join(directory, "file"), value);
    await simpleGit(directory).add("file");
    await simpleGit(directory).raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      value,
    ]);
    return (await simpleGit(directory).revparse(["HEAD"])).trim();
  };
  const base = await commit(seed, "base");
  await git.addRemote("origin", origin);
  await git.push("origin", "main");
  const branch = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
  await clone(origin, first, background, DEADLINE_MS);
  assert.equal(
    await fetchAndCheckout(first, branch, "main", background, DEADLINE_MS),
    base,
  );
  const pushed = await commit(first, "pushed");
  await pushNodeBranch(first, branch, background, DEADLINE_MS);
  await clone(origin, second, background, DEADLINE_MS);
  assert.equal(
    await fetchAndCheckout(second, branch, "main", background, DEADLINE_MS),
    pushed,
  );
  await simpleGit(second).reset(["--hard", base]);
  await commit(second, "conflict");
  await assert.rejects(
    pushNodeBranch(second, branch, background, DEADLINE_MS),
    { code: "repository.connector.git_failed" },
  );
  assert.equal(
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim(),
    pushed,
  );
  assert.equal(
    await cloneSnapshot(origin, pushed, snapshot, background, DEADLINE_MS),
    pushed,
  );
  assert.equal(
    await cloneSnapshot(
      origin,
      "origin/main",
      baseSnapshot,
      background,
      DEADLINE_MS,
    ),
    base,
  );
  assert.equal(process.env.GIT_SSH_COMMAND, undefined);
  assert.equal(process.env.GIT_SSH, undefined);
});
