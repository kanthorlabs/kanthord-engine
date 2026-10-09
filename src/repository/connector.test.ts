import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { RepositoryFileState } from "./contract.ts";
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
  resolveBranchCommit,
  readFilesAtCommit,
} from "./connector.ts";
import { CheckEndState, ExpectedEndState } from "./github.ts";
import { isString } from "../kernel/values.ts";
import { temporary } from "../kernel/test-support.ts";

const DEADLINE_MS = 5000;
const EXPIRED_DEADLINE_MS = 1;
const LOCAL_HOST = "localhost";
const SSH_RESOLVE_FAILED_STATUS = 422;
const SSH_RESOLVE_FAILED_CODE = "repository.credential.ssh_resolve_failed";
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
    (error) =>
      error instanceof OperationError &&
      error.status === SSH_RESOLVE_FAILED_STATUS &&
      error.code === SSH_RESOLVE_FAILED_CODE,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    resolveSshHostname(LOCAL_HOST, context, DEADLINE_MS),
    (error) => error === context.err(),
  );
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

const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
];
const NO_ENTRIES = 0;
const MAX_BYTES = 16;
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const FIRST_TEXT = "first\n";
const UNKNOWN_COMMIT = "0".repeat(40);

type SeedEntry = string | Buffer | { link: string } | { linkBlob: string };

async function instructionOrigin(t: TestContext) {
  const root = temporary(t);
  const origin = join(root, "origin");
  const seed = join(root, "seed");
  const scratch = join(root, "scratch");
  for (const directory of [origin, seed, scratch]) mkdirSync(directory);
  await simpleGit(origin).init(true);
  await simpleGit(origin).raw(["config", "uploadpack.allowFilter", "true"]);
  await simpleGit(origin).raw([
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  ]);
  const git = simpleGit(seed);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  await git.addRemote("origin", origin);
  const commit = async (files: Record<string, SeedEntry>) => {
    for (const [name, entry] of Object.entries(files)) {
      const path = join(seed, name);
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { force: true });
      if (isString(entry) || Buffer.isBuffer(entry)) writeFileSync(path, entry);
      else if ("link" in entry) symlinkSync(entry.link, path);
    }
    await git.raw(["add", "--force", "."]);
    for (const [name, entry] of Object.entries(files)) {
      if (isString(entry) || Buffer.isBuffer(entry) || "link" in entry)
        continue;
      const blob = join(root, "link-blob");
      writeFileSync(blob, entry.linkBlob);
      const object = (await git.raw(["hash-object", "-w", blob])).trim();
      await git.raw([
        "update-index",
        "--add",
        "--cacheinfo",
        `${SYMLINK_MODE},${object},${name}`,
      ]);
    }
    await git.raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "files",
    ]);
    await git.push("origin", "main");
    return (await git.revparse(["HEAD"])).trim();
  };
  return { address: "file://" + origin, scratch, commit };
}

test("resolveBranchCommit answers the commit of a branch and null for an absent branch", async (t) => {
  const { address, commit } = await instructionOrigin(t);
  const head = await commit({ "AGENTS.md": "first\n" });
  assert.equal(
    await resolveBranchCommit(address, "main", background, DEADLINE_MS),
    head,
  );
  assert.equal(
    await resolveBranchCommit(address, "absent", background, DEADLINE_MS),
    null,
  );
  assert.equal(
    await resolveBranchCommit(address, "ain", background, DEADLINE_MS),
    null,
  );
});

test("resolveBranchCommit rejects for a nonexistent repository", async () => {
  await assert.rejects(
    resolveBranchCommit(MISSING_REPOSITORY, "main", background, DEADLINE_MS),
    { code: "repository.connector.git_failed" },
  );
});

test("readFilesAtCommit reads the present files of a commit and answers null for an absent file", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  await commit({ "AGENTS.md": "first\n" });
  const head = await commit({
    "AGENTS.md": "second\n",
    "CLAUDE.md": "claude\n\n",
    "other.md": "other\n",
  });
  const files = await readFilesAtCommit(
    address,
    head,
    INSTRUCTION_PATHS,
    MAX_BYTES,
    background,
    DEADLINE_MS,
    scratch,
  );
  assert.deepEqual(files, [
    { path: "AGENTS.md", state: RepositoryFileState.Present, text: "second\n" },
    { path: "AGENTS.local.md", state: RepositoryFileState.Absent, text: null },
    {
      path: "CLAUDE.md",
      state: RepositoryFileState.Present,
      text: "claude\n\n",
    },
    { path: "CLAUDE.local.md", state: RepositoryFileState.Absent, text: null },
  ]);
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});

async function readStates(t: TestContext, files: Record<string, SeedEntry>) {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit(files);
  const read = await readFilesAtCommit(
    address,
    head,
    INSTRUCTION_PATHS,
    MAX_BYTES,
    background,
    DEADLINE_MS,
    scratch,
  );
  return read.map(({ state, text }) => [state, text]);
}

test("readFilesAtCommit follows a symlink and a chain of two symlinks", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      "AGENTS.md": "agents\n",
      "CLAUDE.md": { link: "AGENTS.md" },
      "docs/target.md": "target\n",
      "AGENTS.local.md": { link: "docs/middle.md" },
      "docs/middle.md": { link: "target.md" },
    }),
    [
      [RepositoryFileState.Present, "agents\n"],
      [RepositoryFileState.Present, "target\n"],
      [RepositoryFileState.Present, "agents\n"],
      [RepositoryFileState.Absent, null],
    ],
  );
});

test("readFilesAtCommit refuses a symlink that leaves the repository root", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      "AGENTS.md": { link: "../outside" },
      "CLAUDE.md": { link: "/etc/passwd" },
      "CLAUDE.local.md": { link: "docs/../../outside" },
    }),
    [
      [RepositoryFileState.OutsideRoot, null],
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.OutsideRoot, null],
      [RepositoryFileState.OutsideRoot, null],
    ],
  );
});

test("readFilesAtCommit answers absent for a dangling symlink", async (t) => {
  assert.deepEqual(
    await readStates(t, { "AGENTS.md": { link: "missing.md" } }),
    [
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.Absent, null],
    ],
  );
});

test("readFilesAtCommit answers unreadable for a symlink loop", async (t) => {
  const [loop] = await readStates(t, {
    "AGENTS.md": { link: "CLAUDE.md" },
    "CLAUDE.md": { link: "AGENTS.md" },
  });
  assert.deepEqual(loop, [RepositoryFileState.Unreadable, null]);
});

const SYMLINK_HOPS_MAX = 40;
const CHAIN_START = "AGENTS.md";
const CHAIN_TARGET = "target.md";
const CHAIN_TEXT = "target\n";
const CHAIN_FIRST_LINK = 1;

function symlinkChain(links: number) {
  const files: Record<string, string | { link: string }> = {
    [CHAIN_TARGET]: CHAIN_TEXT,
  };
  let next = CHAIN_TARGET;
  for (let link = links - CHAIN_FIRST_LINK; link >= CHAIN_FIRST_LINK; link--) {
    files[`link-${link}.md`] = { link: next };
    next = `link-${link}.md`;
  }
  files[CHAIN_START] = { link: next };
  return files;
}

test("readFilesAtCommit follows a chain of 40 symlinks within the deadline and refuses a chain of 41", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      ...symlinkChain(SYMLINK_HOPS_MAX),
      "CLAUDE.md": { link: CHAIN_START },
    }),
    [
      [RepositoryFileState.Present, CHAIN_TEXT],
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.Unreadable, null],
      [RepositoryFileState.Absent, null],
    ],
  );
});

const SYMLINK_MODE = "120000";
const SYMLINK_TARGET_BYTES_MAX = 4096;
const UNRELATED_SYMLINKS = 200;
const BOUND_TARGET = "a.md";
const CURRENT_DIRECTORY_PREFIX = "./";
const WANT_PATTERN = / fetch> want ([0-9a-f]{40})/g;
const WANTED_OBJECT_GROUP = 1;
const START_EVENT = "start";
const NO_TEXT = "";
const GIT_ARGUMENTS_START = 1;

function blobObject(text: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");
}

async function tracedRead(t: TestContext, files: Record<string, SeedEntry>) {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit(files);
  const traces = temporary(t);
  const events = join(traces, "trace2");
  const packets = join(traces, "packet");
  const previous = [process.env.GIT_TRACE2_EVENT, process.env.GIT_TRACE_PACKET];
  process.env.GIT_TRACE2_EVENT = events;
  process.env.GIT_TRACE_PACKET = packets;
  try {
    const read = await readFilesAtCommit(
      address,
      head,
      INSTRUCTION_PATHS,
      MAX_BYTES,
      background,
      DEADLINE_MS,
      scratch,
    );
    const starts = readFileSync(events, "utf8")
      .split("\n")
      .filter((line) => line !== NO_TEXT)
      .map((line) => JSON.parse(line) as { event: string; argv: string[] })
      .filter(({ event }) => event === START_EVENT)
      .map(({ argv }) => argv.slice(GIT_ARGUMENTS_START));
    const wants = new Set(
      [...readFileSync(packets, "utf8").matchAll(WANT_PATTERN)].map(
        (match) => match[WANTED_OBJECT_GROUP]!,
      ),
    );
    return { head, read, starts, wants };
  } finally {
    [process.env.GIT_TRACE2_EVENT, process.env.GIT_TRACE_PACKET] = previous;
  }
}

test("readFilesAtCommit lists only the requested paths when no path is a symlink", async (t) => {
  const { head, read, starts } = await tracedRead(t, {
    "AGENTS.md": "agents\n",
    "CLAUDE.md": "claude\n",
    "docs/other.md": "other\n",
  });
  assert.deepEqual(
    read.map(({ state }) => state),
    [
      RepositoryFileState.Present,
      RepositoryFileState.Absent,
      RepositoryFileState.Present,
      RepositoryFileState.Absent,
    ],
  );
  assert.deepEqual(
    starts.filter((argv) => argv.includes("ls-tree")),
    [
      [
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        head,
        "--",
        ...INSTRUCTION_PATHS,
      ],
    ],
  );
});

test("readFilesAtCommit fetches only the symlink blobs of the chain among many unrelated symlinks", async (t) => {
  const unrelated: Record<string, SeedEntry> = {};
  const unrelatedTargets: string[] = [];
  for (let index = 0; index < UNRELATED_SYMLINKS; index++) {
    unrelatedTargets.push(`root-target-${index}.md`, `target-${index}.md`);
    unrelated[`unrelated-${index}.md`] = { link: `root-target-${index}.md` };
    unrelated[`unrelated/link-${index}.md`] = { link: `target-${index}.md` };
  }
  const { read, wants } = await tracedRead(t, {
    ...unrelated,
    "AGENTS.md": "agents\n",
    "CLAUDE.md": { link: "AGENTS.md" },
    "AGENTS.local.md": { link: "docs/middle.md" },
    "docs/middle.md": { link: "target.md" },
    "docs/target.md": "target\n",
  });
  assert.deepEqual(
    read.map(({ state, text }) => [state, text]),
    [
      [RepositoryFileState.Present, "agents\n"],
      [RepositoryFileState.Present, "target\n"],
      [RepositoryFileState.Present, "agents\n"],
      [RepositoryFileState.Absent, null],
    ],
  );
  for (const target of ["AGENTS.md", "docs/middle.md", "target.md"])
    assert.ok(wants.has(blobObject(target)));
  for (const target of unrelatedTargets)
    assert.ok(!wants.has(blobObject(target)));
});

test("readFilesAtCommit answers unreadable for a symlink target above the byte bound", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      [BOUND_TARGET]: "a\n",
      "AGENTS.md": { linkBlob: "x".repeat(SYMLINK_TARGET_BYTES_MAX + 1) },
      "CLAUDE.md": {
        linkBlob:
          CURRENT_DIRECTORY_PREFIX.repeat(
            (SYMLINK_TARGET_BYTES_MAX - BOUND_TARGET.length) /
              CURRENT_DIRECTORY_PREFIX.length,
          ) + BOUND_TARGET,
      },
    }),
    [
      [RepositoryFileState.Unreadable, null],
      [RepositoryFileState.Absent, null],
      [RepositoryFileState.Present, "a\n"],
      [RepositoryFileState.Absent, null],
    ],
  );
});

test("readFilesAtCommit refuses a directory and a symlink to a directory", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      "AGENTS.md/inner.md": "inner\n",
      "CLAUDE.md": { link: "AGENTS.md" },
      "AGENTS.local.md": { link: "." },
    }),
    [
      [RepositoryFileState.NotRegularFile, null],
      [RepositoryFileState.NotRegularFile, null],
      [RepositoryFileState.NotRegularFile, null],
      [RepositoryFileState.Absent, null],
    ],
  );
});

test("readFilesAtCommit refuses a file above the byte bound and a file that is not UTF-8", async (t) => {
  assert.deepEqual(
    await readStates(t, {
      "AGENTS.md": "x".repeat(MAX_BYTES + 1),
      "AGENTS.local.md": "x".repeat(MAX_BYTES),
      "CLAUDE.md": Buffer.from([0x66, 0xff, 0x0a]),
      "CLAUDE.local.md": { link: "CLAUDE.md" },
    }),
    [
      [RepositoryFileState.TooLarge, null],
      [RepositoryFileState.Present, "x".repeat(MAX_BYTES)],
      [RepositoryFileState.NotUtf8, null],
      [RepositoryFileState.NotUtf8, null],
    ],
  );
});

test("readFilesAtCommit reads the named commit after the branch moved", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const first = await commit({ "AGENTS.md": "first\n" });
  await commit({ "AGENTS.md": "second\n" });
  const files = await readFilesAtCommit(
    address,
    first,
    INSTRUCTION_PATHS,
    MAX_BYTES,
    background,
    DEADLINE_MS,
    scratch,
  );
  assert.equal(files[FIRST_INDEX]?.text, FIRST_TEXT);
  assert.equal(files[SECOND_INDEX]?.text, null);
});

test("readFilesAtCommit deletes its directory when the read fails", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  await commit({ "AGENTS.md": "first\n" });
  await assert.rejects(
    readFilesAtCommit(
      address,
      UNKNOWN_COMMIT,
      INSTRUCTION_PATHS,
      MAX_BYTES,
      background,
      DEADLINE_MS,
      scratch,
    ),
    { code: "repository.connector.git_failed" },
  );
  await assert.rejects(
    readFilesAtCommit(
      MISSING_REPOSITORY,
      UNKNOWN_COMMIT,
      INSTRUCTION_PATHS,
      MAX_BYTES,
      background,
      DEADLINE_MS,
      scratch,
    ),
    { code: "repository.connector.git_failed" },
  );
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});

test("readFilesAtCommit rejects when the deadline elapsed and deletes its directory", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit({ "AGENTS.md": "first\n" });
  await assert.rejects(
    readFilesAtCommit(
      address,
      head,
      INSTRUCTION_PATHS,
      MAX_BYTES,
      background,
      EXPIRED_DEADLINE_MS - 1,
      scratch,
    ),
    { code: "repository.connector.git_failed" },
  );
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});
