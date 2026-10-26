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
import {
  background,
  CancellationContext,
  DeadlineExceeded,
} from "../kernel/context.ts";
import { RepositoryFileState } from "./contract.ts";
import {
  gitLsRemote,
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
  listFilesAtCommit,
  readObjectIds,
} from "./connector.ts";
import { CheckEndState, ExpectedEndState } from "./github.ts";
import { isString } from "../kernel/values.ts";
import {
  fixtureTemplate,
  overrideEnvironment,
  temporary,
  UNSET_GIT_ENVIRONMENT,
} from "../kernel/test-support.ts";
import { SshAgentErrorCode } from "./ssh-agent.ts";
import { LOCAL_GIT_SSH_ACCESS } from "./test-sshd.ts";

const DEADLINE_MS = 60_000;
const ORIGIN_NAME = "origin";
const SEED_NAME = "seed";
const SIBLING_ORIGIN = `../${ORIGIN_NAME}`;
const EXPIRED_DEADLINE_MS = 1;
const MISSING_REPOSITORY = "file:////nonexistent_kanthord_plan04_test";

test("gitLsRemote resolves for a local git repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  await assert.doesNotReject(
    gitLsRemote("file://" + dir, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS),
  );
});

test("gitLsRemote rejects for a nonexistent repository", async () => {
  await assert.rejects(
    gitLsRemote(
      MISSING_REPOSITORY,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
  );
});

test("gitLsRemote rejects when the deadline elapses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  await assert.rejects(
    gitLsRemote(
      "file://" + dir,
      background,
      EXPIRED_DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
  );
});

test("gitLsRemote rejects when the context was already cancelled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-repository-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await simpleGit(dir).init();
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    gitLsRemote("file://" + dir, context, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS),
  );
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
  await clone(origin, first, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS);
  assert.equal(
    await fetchAndCheckout(
      first,
      branch,
      "main",
      false,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    base,
  );
  const pushed = await commit(first, "pushed");
  await pushNodeBranch(
    first,
    branch,
    background,
    DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
  );
  await clone(origin, second, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS);
  assert.equal(
    await fetchAndCheckout(
      second,
      branch,
      "main",
      false,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    pushed,
  );
  await simpleGit(second).reset(["--hard", base]);
  await commit(second, "conflict");
  await assert.rejects(
    pushNodeBranch(
      second,
      branch,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    { code: "repository.connector.git_failed" },
  );
  assert.equal(
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim(),
    pushed,
  );
  assert.equal(
    await cloneSnapshot(
      origin,
      pushed,
      snapshot,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    pushed,
  );
  assert.equal(
    await cloneSnapshot(
      origin,
      "origin/main",
      baseSnapshot,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    base,
  );
  assert.equal(process.env.GIT_SSH_COMMAND, undefined);
  assert.equal(process.env.GIT_SSH, undefined);
});

test("fetchAndCheckout keeps the unpushed commits of the local node branch when the remote node branch is missing", async (t) => {
  const root = temporary(t);
  const origin = join(root, "origin");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  for (const directory of [origin, seed, workspace]) mkdirSync(directory);
  await simpleGit(origin).init(true);
  await simpleGit(seed).init();
  await simpleGit(seed).raw(["checkout", "-b", "main"]);
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
  await simpleGit(seed).addRemote("origin", origin);
  await simpleGit(seed).push("origin", "main");
  const branch = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
  await clone(origin, workspace, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS);
  assert.equal(
    await fetchAndCheckout(
      workspace,
      branch,
      "main",
      false,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    base,
  );
  const unpushedContent = "unpushed";
  const unpushed = await commit(workspace, unpushedContent);
  writeFileSync(join(workspace, "untracked"), "scratch");
  assert.equal(
    await fetchAndCheckout(
      workspace,
      branch,
      "main",
      false,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    unpushed,
  );
  assert.equal(readFileSync(join(workspace, "file"), "utf8"), unpushedContent);
  assert.deepEqual(readdirSync(workspace).sort(), [".git", "file"]);
});

const GIT_FAILED = "repository.connector.git_failed";
const SHORT_TEMPORARY_ROOT = "/tmp";
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

function isolateTemporary(t: test.TestContext): string {
  const scratch = mkdtempSync(join(SHORT_TEMPORARY_ROOT, "kd-scratch-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  });
  return scratch;
}

function seedCommit(seed: string) {
  const git = simpleGit(seed);
  return async (file: string, value: string) => {
    writeFileSync(join(seed, file), value);
    await git.add(file);
    await git.raw([...IDENTITY, "commit", "-m", value]);
    return (await git.revparse(["HEAD"])).trim();
  };
}

const remoteTemplate = fixtureTemplate(async (root) => {
  const origin = join(root, ORIGIN_NAME);
  const seed = join(root, SEED_NAME);
  mkdirSync(origin);
  mkdirSync(seed);
  await simpleGit(origin).init(true);
  const git = simpleGit(seed);
  await git.raw(["init", "-b", BASE_BRANCH]);
  const commit = seedCommit(seed);
  const base = await commit("base", "base");
  await git.addRemote("origin", SIBLING_ORIGIN);
  await git.push("origin", BASE_BRANCH);
  await git.raw(["checkout", "-b", NODE_BRANCH]);
  const snapshot = await commit("node", "snapshot");
  await git.push("origin", NODE_BRANCH);
  await git.raw(["checkout", BASE_BRANCH]);
  return { base, snapshot };
});

async function remote(t: test.TestContext): Promise<Remote> {
  const {
    root,
    built: { base, snapshot },
  } = await remoteTemplate(t);
  const origin = join(root, ORIGIN_NAME);
  const seed = join(root, SEED_NAME);
  const head = async (branch: string) =>
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim();
  const scratch = isolateTemporary(t);
  return {
    origin,
    seed,
    base,
    snapshot,
    scratch,
    commit: seedCommit(seed),
    head,
  };
}

function assertNoClone(scratch: string): void {
  assert.deepEqual(readdirSync(scratch), []);
}

test("every git caller rejects a nonzero exit with an empty stderr", async (t) => {
  const bin = temporary(t);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const failed = { code: GIT_FAILED };
  const address = "file:///silent";
  await assert.rejects(
    gitLsRemote(address, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS),
    failed,
  );
  await assert.rejects(
    clone(address, temporary(t), background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS),
    failed,
  );
  await assert.rejects(
    fetchAndCheckout(
      temporary(t),
      NODE_BRANCH,
      BASE_BRANCH,
      false,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    failed,
  );
  await assert.rejects(
    pushNodeBranch(
      temporary(t),
      NODE_BRANCH,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    failed,
  );
  await assert.rejects(
    cloneSnapshot(
      address,
      "HEAD",
      temporary(t),
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    failed,
  );
  await assert.rejects(
    resolveBranchCommit(
      address,
      BASE_BRANCH,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    failed,
  );
});

test("a git failure keeps the operation and the stderr without credentials in its cause", async (t) => {
  const bin = temporary(t);
  const secret = "ghs_0123456789abcdefghij";
  const stderr = `fatal: unable to access 'https://x-access-token:${secret}@example.invalid/r.git/': Could not resolve host`;
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho "${stderr}" >&2\nexit 128\n`,
    {
      mode: 0o700,
    },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const keepsCause = (operation: string) => (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, GIT_FAILED);
    assert.equal(error.message, `${operation}: git failed.`);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, new RegExp(`^${operation}: `));
    assert.match(error.cause.message, /Could not resolve host/);
    assert.doesNotMatch(error.cause.message, new RegExp(secret));
    return true;
  };
  await assert.rejects(
    clone(
      "file:///remote",
      temporary(t),
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    keepsCause("clone"),
  );
  await assert.rejects(
    pushNodeBranch(
      temporary(t),
      NODE_BRANCH,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    keepsCause("push node branch"),
  );
});

test("every git caller ignores the global git configuration of the host", async (t) => {
  const { origin, snapshot } = await remote(t);
  const home = temporary(t);
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file:///nonexistent_kanthord_rewrite/"]\n\tinsteadOf = ${dirname(origin)}/\n`,
  );
  overrideEnvironment(t, {
    ...UNSET_GIT_ENVIRONMENT,
    HOME: home,
    XDG_CONFIG_HOME: undefined,
  });
  const directory = temporary(t);
  assert.equal(
    await cloneSnapshot(
      origin,
      snapshot,
      directory,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    snapshot,
  );
  await gitLsRemote(origin, background, DEADLINE_MS, LOCAL_GIT_SSH_ACCESS);
  assert.equal(
    await resolveBranchCommit(
      origin,
      NODE_BRANCH,
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    snapshot,
  );
});

test("mergePushFresh lands a merge commit whose second parent is the snapshot", async (t) => {
  const { origin, base, snapshot, scratch, head } = await remote(t);
  const { commit } = await mergePushFresh(
    { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
    background,
    deadlineAt(),
    LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
    LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
    error.code === SshAgentErrorCode.Failed;
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
    ),
    beforePush,
  );
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
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
    LOCAL_GIT_SSH_ACCESS,
  );
  await simpleGit(seed).raw(["pull", "--ff-only", "origin", BASE_BRANCH]);
  await commit("later", "later");
  await simpleGit(seed).push("origin", BASE_BRANCH);
  assert.deepEqual(
    await landedOn(
      { address: origin, branch: BASE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
    ),
    { landed: true, first_parent: merge },
  );
  assert.deepEqual(
    await landedOn(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      background,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
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
    LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
    ),
    (error) => error === context.signal.reason,
  );
  await assert.rejects(
    pushSnapshotFresh(
      { address: origin, branch: NODE_BRANCH, commit: snapshot },
      context,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
    ),
    (error) => error === context.signal.reason,
  );
  await assert.rejects(
    landedOn(
      { address: origin, branch: BASE_BRANCH, commit: snapshot },
      context,
      deadlineAt(),
      LOCAL_GIT_SSH_ACCESS,
    ),
    (error) => error === context.signal.reason,
  );
  await assert.rejects(
    mergePushFresh(
      { address: origin, base_branch: BASE_BRANCH, commit: snapshot },
      background,
      Date.now(),
      LOCAL_GIT_SSH_ACCESS,
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
});

test("the check folds that address to pull_request_merged with the landed commit", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(
    foldBranchPush(true, commit, ExpectedEndState.PullRequestMerged),
    { end_state: CheckEndState.Expected, landed_commits: [commit] },
  );
  assert.deepEqual(
    foldBranchPush(false, commit, ExpectedEndState.PullRequestMerged),
    { end_state: CheckEndState.Other, landed_commits: [] },
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

const GITLINK_MODE = "160000";

type SeedEntry =
  | string
  | Buffer
  | { link: string }
  | { linkBlob: string }
  | { gitlink: string };

const instructionTemplate = fixtureTemplate(async (root) => {
  const origin = join(root, ORIGIN_NAME);
  const seed = join(root, SEED_NAME);
  mkdirSync(origin);
  mkdirSync(seed);
  await simpleGit(origin).init(true);
  await simpleGit(origin).raw(["config", "uploadpack.allowFilter", "true"]);
  await simpleGit(origin).raw([
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  ]);
  const git = simpleGit(seed);
  await git.raw(["init", "-b", "main"]);
  await git.addRemote("origin", SIBLING_ORIGIN);
});

async function instructionOrigin(t: TestContext) {
  const { root } = await instructionTemplate(t);
  const origin = join(root, ORIGIN_NAME);
  const seed = join(root, SEED_NAME);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const git = simpleGit(seed);
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
      if ("gitlink" in entry) {
        await git.raw([
          "update-index",
          "--add",
          "--cacheinfo",
          `${GITLINK_MODE},${entry.gitlink},${name}`,
        ]);
        continue;
      }
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
    await resolveBranchCommit(
      address,
      "main",
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    head,
  );
  assert.equal(
    await resolveBranchCommit(
      address,
      "absent",
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    null,
  );
  assert.equal(
    await resolveBranchCommit(
      address,
      "ain",
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
    null,
  );
});

test("resolveBranchCommit rejects for a nonexistent repository", async () => {
  await assert.rejects(
    resolveBranchCommit(
      MISSING_REPOSITORY,
      "main",
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    ),
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
    LOCAL_GIT_SSH_ACCESS,
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

const WORKFLOWS_DIRECTORY = ".github/workflows";
const LIST_LIMIT = 20;
const LIST_LIMIT_ABOVE = 25;
const LIST_LIMIT_MAX = 1000;
const GITLINK_OBJECT = "1".repeat(40);
const UNSAFE_DIRECTORIES = ["..", "/abs", "a/../b", "", "a//b"];
const REPOSITORY_FILES_PREFIX = "kanthord-repository-files-";

async function listWorkflows(
  t: TestContext,
  files: Record<string, SeedEntry>,
  directory = WORKFLOWS_DIRECTORY,
  limit = LIST_LIMIT,
) {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit(files);
  return listFilesAtCommit(
    address,
    head,
    directory,
    limit,
    background,
    DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
    scratch,
  );
}

test("listFilesAtCommit answers the regular files of one directory in path order", async (t) => {
  assert.deepEqual(
    await listWorkflows(t, {
      ".github/workflows/release.yaml": "release\n",
      ".github/workflows/ci.yml": "ci\n",
      ".github/workflows/nested/deep.yml": "deep\n",
      ".github/README.md": "readme\n",
    }),
    [".github/workflows/ci.yml", ".github/workflows/release.yaml"],
  );
});

test("listFilesAtCommit skips a symbolic link and a submodule entry", async (t) => {
  assert.deepEqual(
    await listWorkflows(t, {
      ".github/workflows/ci.yml": "ci\n",
      ".github/workflows/link.yml": { link: "ci.yml" },
      ".github/workflows/module": { gitlink: GITLINK_OBJECT },
    }),
    [".github/workflows/ci.yml"],
  );
});

test("listFilesAtCommit answers an empty list for an absent directory and for a path that is a file", async (t) => {
  const files = { ".github/workflows/ci.yml": "ci\n" };
  assert.deepEqual(await listWorkflows(t, files, ".github/absent"), []);
  assert.deepEqual(
    await listWorkflows(t, files, ".github/workflows/ci.yml"),
    [],
  );
});

test("listFilesAtCommit answers at most the limit", async (t) => {
  const files: Record<string, string> = {};
  for (let index = LIST_LIMIT_ABOVE; index > NO_ENTRIES; index--)
    files[`${WORKFLOWS_DIRECTORY}/f${String(index).padStart(2, "0")}.yml`] =
      "x\n";
  const listed = await listWorkflows(t, files);
  assert.equal(listed.length, LIST_LIMIT);
  assert.deepEqual(listed, [...listed].sort());
  assert.equal(listed[FIRST_INDEX], `${WORKFLOWS_DIRECTORY}/f01.yml`);
  assert.equal(listed.at(-1), `${WORKFLOWS_DIRECTORY}/f20.yml`);
});

test("listFilesAtCommit refuses an unsafe directory", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit({ "a/b": "x\n" });
  for (const directory of UNSAFE_DIRECTORIES)
    await assert.rejects(
      listFilesAtCommit(
        address,
        head,
        directory,
        LIST_LIMIT,
        background,
        DEADLINE_MS,
        LOCAL_GIT_SSH_ACCESS,
        scratch,
      ),
      { name: "AssertionError" },
      directory,
    );
  for (const limit of [NO_ENTRIES, LIST_LIMIT_MAX + 1])
    await assert.rejects(
      listFilesAtCommit(
        address,
        head,
        "a",
        limit,
        background,
        DEADLINE_MS,
        LOCAL_GIT_SSH_ACCESS,
        scratch,
      ),
      { name: "AssertionError" },
    );
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});

test("listFilesAtCommit fetches no blob", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const head = await commit({ ".github/workflows/ci.yml": "ci\n" });
  await listFilesAtCommit(
    address,
    head,
    WORKFLOWS_DIRECTORY,
    LIST_LIMIT,
    background,
    DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
    scratch,
  );
  assert.deepEqual(
    readdirSync(scratch).filter((name) =>
      name.startsWith(REPOSITORY_FILES_PREFIX),
    ),
    [],
  );
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
    LOCAL_GIT_SSH_ACCESS,
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
const TREE_AND_BLOB_PACKS = 2;

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
      LOCAL_GIT_SSH_ACCESS,
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

test("readFilesAtCommit fetches the blobs of all regular files in one fetch", async (t) => {
  const { read, starts } = await tracedRead(t, {
    "AGENTS.md": "agents\n",
    "AGENTS.local.md": "agents local\n",
    "CLAUDE.md": "claude\n",
    "CLAUDE.local.md": "claude local\n",
  });
  assert.deepEqual(
    read.map(({ state, text }) => [state, text]),
    [
      [RepositoryFileState.Present, "agents\n"],
      [RepositoryFileState.Present, "agents local\n"],
      [RepositoryFileState.Present, "claude\n"],
      [RepositoryFileState.Present, "claude local\n"],
    ],
  );
  assert.equal(
    starts.filter((argv) => argv.includes("pack-objects")).length,
    TREE_AND_BLOB_PACKS,
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
    LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
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
      LOCAL_GIT_SSH_ACCESS,
      scratch,
    ),
    DeadlineExceeded,
  );
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});

test("readObjectIds answers the tree ids of the root and of a directory, and null for an absent path", async (t) => {
  const { address, scratch, commit } = await instructionOrigin(t);
  const first = await commit({
    ".devcontainer/local/install.sh": "true\n",
    "README.md": "first\n",
  });
  const second = await commit({ "README.md": "second\n" });
  const read = (head: string) =>
    readObjectIds(
      address,
      head,
      [".", ".devcontainer/local", ".devcontainer/absent"],
      background,
      DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
      scratch,
    );
  const [before, after] = [await read(first), await read(second)];
  assert.match(before[0] ?? "", /^[0-9a-f]{40}$/);
  assert.match(before[1] ?? "", /^[0-9a-f]{40}$/);
  assert.equal(before[2], null);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(readdirSync(scratch).length, NO_ENTRIES);
});
