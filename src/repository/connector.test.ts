import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  gitLsRemote,
  resolveSshHostname,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  pushNodeBranch,
  resolveBranchCommit,
  readFilesAtCommit,
} from "./connector.ts";
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

const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
];
const NO_ENTRIES = 0;
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const FIRST_TEXT = "first\n";
const UNKNOWN_COMMIT = "0".repeat(40);

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
  const commit = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(seed, name), text);
    await git.add(".");
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
    background,
    DEADLINE_MS,
    scratch,
  );
  assert.deepEqual(files, [
    { path: "AGENTS.md", text: "second\n" },
    { path: "AGENTS.local.md", text: null },
    { path: "CLAUDE.md", text: "claude\n\n" },
    { path: "CLAUDE.local.md", text: null },
  ]);
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});

test("readFilesAtCommit reads the named commit after the branch moved", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const first = await commit({ "AGENTS.md": "first\n" });
  await commit({ "AGENTS.md": "second\n" });
  const files = await readFilesAtCommit(
    address,
    first,
    INSTRUCTION_PATHS,
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
      background,
      EXPIRED_DEADLINE_MS - 1,
      scratch,
    ),
    { code: "repository.connector.git_failed" },
  );
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});
