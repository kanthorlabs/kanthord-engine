import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../kernel/context.ts";
import {
  gitLsRemote,
  resolveSshHostname,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  pushNodeBranch,
  mergePushFresh,
  pushSnapshotFresh,
  landedOn,
  foldBranchPush,
  GitStage,
  GitWriteError,
} from "./connector.ts";
import { CheckEndState, ExpectedEndState } from "./github.ts";
import { temporary } from "../kernel/test-support.ts";

const DEADLINE_MS = 5000;
const EXPIRED_DEADLINE_MS = 1;
const LOCAL_HOST = "localhost";
const MISSING_REPOSITORY = "file:////nonexistent_kanthord_plan04_test";

test("resolveSshHostname reads the hostname line of ssh -G", async () => {
  assert.equal(
    await resolveSshHostname(LOCAL_HOST, background, DEADLINE_MS),
    LOCAL_HOST,
  );
});

test("resolveSshHostname rejects when the deadline elapses or the context was cancelled", async () => {
  await assert.rejects(
    resolveSshHostname(LOCAL_HOST, background, EXPIRED_DEADLINE_MS - 1),
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(resolveSshHostname(LOCAL_HOST, context, DEADLINE_MS));
});

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

const GIT_FAILED = "repository.connector.git_failed";
const NODE_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const BASE_BRANCH = "main";
const MERGE_SIGNATURE =
  "kanthord <kanthord@localhost> kanthord <kanthord@localhost>";
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=t@example.invalid"];

interface Remote {
  origin: string;
  seed: string;
  base: string;
  snapshot: string;
  scratch: string;
  commit: (file: string, value: string) => Promise<string>;
  head: (branch: string) => Promise<string>;
}

function deadlineAt(): number {
  return Date.now() + DEADLINE_MS;
}

function isolateTemporary(t: test.TestContext, root: string): string {
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return scratch;
}

async function remote(t: test.TestContext): Promise<Remote> {
  const root = temporary(t);
  const origin = join(root, "origin");
  const seed = join(root, "seed");
  mkdirSync(origin);
  mkdirSync(seed);
  await simpleGit(origin).init(true);
  const git = simpleGit(seed);
  await git.init();
  await git.raw(["checkout", "-b", BASE_BRANCH]);
  const commit = async (file: string, value: string) => {
    writeFileSync(join(seed, file), value);
    await git.add(file);
    await git.raw([...IDENTITY, "commit", "-m", value]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const base = await commit("base", "base");
  await git.addRemote("origin", origin);
  await git.push("origin", BASE_BRANCH);
  await git.raw(["checkout", "-b", NODE_BRANCH]);
  const snapshot = await commit("node", "snapshot");
  await git.push("origin", NODE_BRANCH);
  await git.raw(["checkout", BASE_BRANCH]);
  const head = async (branch: string) =>
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim();
  const scratch = isolateTemporary(t, root);
  return { origin, seed, base, snapshot, scratch, commit, head };
}

function assertNoClone(scratch: string): void {
  assert.deepEqual(readdirSync(scratch), []);
}

test("mergePushFresh lands a merge commit whose second parent is the snapshot", async (t) => {
  const { origin, base, snapshot, scratch, head } = await remote(t);
  const { commit } = await mergePushFresh(
    { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
    background,
    deadlineAt(),
  );
  assert.equal(await head(BASE_BRANCH), commit);
  const parents = await simpleGit(origin).raw(["rev-parse", `${commit}^@`]);
  assert.deepEqual(parents.trim().split("\n"), [base, snapshot]);
  const author = await simpleGit(origin).raw([
    "log",
    "-1",
    "--format=%an <%ae> %cn <%ce>",
    commit,
  ]);
  assert.equal(author.trim(), MERGE_SIGNATURE);
  assertNoClone(scratch);
});

test("mergePushFresh throws before_push on a conflict and leaves the base unchanged", async (t) => {
  const { origin, seed, scratch, commit, head } = await remote(t);
  await simpleGit(seed).raw(["checkout", NODE_BRANCH]);
  const conflicting = await commit("base", "node side");
  await simpleGit(seed).push("origin", NODE_BRANCH);
  await simpleGit(seed).raw(["checkout", BASE_BRANCH]);
  await commit("base", "base side");
  await simpleGit(seed).push("origin", BASE_BRANCH);
  const before = await head(BASE_BRANCH);
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: conflicting },
      background,
      deadlineAt(),
    ),
    (error) =>
      error instanceof GitWriteError &&
      error.stage === GitStage.BeforePush &&
      error.code === GIT_FAILED,
  );
  assert.equal(await head(BASE_BRANCH), before);
  assertNoClone(scratch);
});

test("mergePushFresh throws push when the remote rejects the push", async (t) => {
  const { origin, base, snapshot, scratch, head } = await remote(t);
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    (error) =>
      error instanceof GitWriteError &&
      error.stage === GitStage.Push &&
      error.code === GIT_FAILED,
  );
  assert.equal(await head(BASE_BRANCH), base);
  assertNoClone(scratch);
});

test("pushSnapshotFresh pushes the snapshot without force", async (t) => {
  const { origin, seed, base, snapshot, scratch, commit, head } =
    await remote(t);
  const branch = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAB";
  await pushSnapshotFresh(
    { address: origin, branch, commit: snapshot },
    background,
    deadlineAt(),
  );
  assert.equal(await head(branch), snapshot);
  await simpleGit(seed).raw(["checkout", "--detach", base]);
  const diverged = await commit("other", "diverged");
  await simpleGit(seed).push("origin", `${diverged}:refs/heads/side`);
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch, commit: diverged },
      background,
      deadlineAt(),
    ),
    (error) => error instanceof GitWriteError && error.stage === GitStage.Push,
  );
  assert.equal(await head(branch), snapshot);
  assertNoClone(scratch);
});

test("pushSnapshotFresh throws before_push for a commit that the remote lacks", async (t) => {
  const { origin, seed, scratch, commit } = await remote(t);
  await simpleGit(seed).raw(["checkout", NODE_BRANCH]);
  const local = await commit("node", "unpushed");
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch: NODE_BRANCH, commit: local },
      background,
      deadlineAt(),
    ),
    (error) =>
      error instanceof GitWriteError && error.stage === GitStage.BeforePush,
  );
  assertNoClone(scratch);
});

test("a missing temporary directory throws before_push for both git writes", async (t) => {
  const { origin, snapshot, scratch } = await remote(t);
  process.env.TMPDIR = join(scratch, "missing");
  const beforePush = (error: unknown) =>
    error instanceof GitWriteError &&
    error.stage === GitStage.BeforePush &&
    error.code === GIT_FAILED;
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    beforePush,
  );
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    beforePush,
  );
  assertNoClone(scratch);
});

test("landedOn answers the oldest first-parent commit that contains the snapshot", async (t) => {
  const { origin, seed, snapshot, scratch, commit } = await remote(t);
  const { commit: merge } = await mergePushFresh(
    { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
    background,
    deadlineAt(),
  );
  await simpleGit(seed).raw(["pull", "--ff-only", "origin", BASE_BRANCH]);
  await commit("later", "later");
  await simpleGit(seed).push("origin", BASE_BRANCH);
  assert.deepEqual(
    await landedOn(
      { address: origin, branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    { landed: true, first_parent: merge },
  );
  assert.deepEqual(
    await landedOn(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    { landed: true, first_parent: snapshot },
  );
  assertNoClone(scratch);
});

test("landedOn answers landed false for a rewritten branch", async (t) => {
  const { origin, base, snapshot, scratch } = await remote(t);
  await mergePushFresh(
    { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
    background,
    deadlineAt(),
  );
  await simpleGit(origin).raw([
    "update-ref",
    `refs/heads/${BASE_BRANCH}`,
    base,
  ]);
  assert.deepEqual(
    await landedOn(
      { address: origin, branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
    ),
    { landed: false, first_parent: null },
  );
  assertNoClone(scratch);
});

test("landedOn throws for an unreachable commit and a missing repository", async (t) => {
  const { origin, seed, scratch, commit } = await remote(t);
  const unreachable = await commit("local", "unreachable");
  await assert.rejects(
    landedOn(
      { address: origin, branch: BASE_BRANCH, commit: unreachable },
      background,
      deadlineAt(),
    ),
    { code: GIT_FAILED },
  );
  await assert.rejects(
    landedOn(
      {
        address: join(seed, "missing"),
        branch: BASE_BRANCH,
        commit: unreachable,
      },
      background,
      deadlineAt(),
    ),
    { code: GIT_FAILED },
  );
  assertNoClone(scratch);
});

test("an abort ends every git write and the landing read", async (t) => {
  const { origin, base, snapshot, scratch, head } = await remote(t);
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      context,
      deadlineAt(),
    ),
    (error) =>
      error instanceof GitWriteError && error.stage === GitStage.BeforePush,
  );
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      context,
      deadlineAt(),
    ),
    (error) =>
      error instanceof GitWriteError && error.stage === GitStage.BeforePush,
  );
  await assert.rejects(
    landedOn(
      { address: origin, branch: BASE_BRANCH, commit: snapshot },
      context,
      deadlineAt(),
    ),
    { code: GIT_FAILED },
  );
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      background,
      Date.now(),
    ),
    (error) =>
      error instanceof GitWriteError && error.stage === GitStage.BeforePush,
  );
  assert.equal(await head(BASE_BRANCH), base);
  assertNoClone(scratch);
});

test("foldBranchPush folds a landing against base_branch_pushed", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(
    foldBranchPush(true, commit, ExpectedEndState.BaseBranchPushed),
    { end_state: CheckEndState.Expected, landed_commits: [commit] },
  );
  assert.deepEqual(
    foldBranchPush(false, commit, ExpectedEndState.BaseBranchPushed),
    { end_state: CheckEndState.Other, landed_commits: [] },
  );
  assert.throws(() =>
    foldBranchPush(true, commit, ExpectedEndState.PullRequestMerged),
  );
});
