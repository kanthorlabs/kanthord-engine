import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../../kernel/context.ts";
import { CodedError } from "../../kernel/errors.ts";
import {
  hostEnvironment,
  overrideEnvironment,
  temporary,
  UNSET_GIT_ENVIRONMENT,
} from "../../kernel/test-support.ts";
import {
  addedFiles,
  changedEntries,
  changedFiles,
  ChangeStatus,
  checkoutDetached,
  commitWork,
  discardChanges,
  excludeUntracked,
  fetchLocal,
  fileAtRevision,
  headCommit,
  isAncestor,
  mergeBase,
  modifiedFiles,
  normaliseGitState,
  scrubTree,
  treeOf,
} from "./local-git.ts";
import { readSetupRecord, writeSetupRecord } from "./setup-record.ts";
import { PoolClass, TreePool } from "./tree-pool.ts";
import { GIT_COMMIT_FAILED } from "./stop-codes.ts";

const env = hostEnvironment();
const DEFAULT_IDENTITY = "kanthord <kanthord@localhost>";
const CRLF_CONTENT = "a\r\nb\r\n";
const HOOK_MARKER = "hook-ran";
const EXECUTABLE_MODE = 0o755;
const MANY_FILES = 9000;
const LONG_NAME = "x".repeat(235);
const LINUX_ARG_MAX_BYTES = 2 * 1024 * 1024;
const CRLF_LINE = "a\r\n";
const EMPTY_OBJECT = "{}";
const FAILING_SIGNER = "false";
const SIGNER_FAILURE = "failed to sign the data";
const REAL_CONTENT = "real";

function writeRefusingHook(hooks: string, marker: string): void {
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "commit-msg");
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(hook, EXECUTABLE_MODE);
}

async function repositoryWithFailingSigner(
  t: Parameters<typeof temporary>[0],
): Promise<string> {
  const directory = temporary(t);
  await simpleGit(directory).init();
  appendFileSync(
    join(directory, ".git", "config"),
    `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${FAILING_SIGNER}\n`,
  );
  writeFileSync(join(directory, "tracked"), "original");
  return directory;
}

test("a refused work commit throws the commit code with the git error as the cause", async (t) => {
  const directory = await repositoryWithFailingSigner(t);
  await assert.rejects(
    commitWork(env, directory, "refused", background, 10000),
    (error) => {
      assert.ok(error instanceof CodedError);
      assert.equal(error.code, GIT_COMMIT_FAILED);
      assert.ok(error.cause instanceof Error);
      assert.ok(error.cause.message.includes(SIGNER_FAILURE));
      return true;
    },
  );
});

test("a cancelled work commit throws the cancellation and not the commit code", async (t) => {
  const directory = await repositoryWithFailingSigner(t);
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    commitWork(env, directory, "cancelled", context, 10000),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        !(error instanceof CodedError && error.code === GIT_COMMIT_FAILED),
      );
      return true;
    },
  );
});

test("verification cleanup discards tracked and untracked edits but keeps ignored files", async (t) => {
  const original = "original";
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, "tracked"), "original");
  writeFileSync(join(directory, ".gitignore"), "ignored\n");
  await git.add(["tracked", ".gitignore"]);
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const head = await headCommit(env, directory, background, 10000);
  writeFileSync(join(directory, "tracked"), "changed");
  writeFileSync(join(directory, "untracked"), "changed");
  writeFileSync(join(directory, "ignored"), "retained");
  await discardChanges(env, directory, background, 10000);
  assert.equal(await headCommit(env, directory, background, 10000), head);
  assert.equal(readFileSync(join(directory, "tracked"), "utf8"), original);
  assert.equal(existsSync(join(directory, "untracked")), false);
  assert.equal(existsSync(join(directory, "ignored")), true);
});

test("a tree id stays the same when an amend changes only the commit and differs when a file changes", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, "tracked"), "original");
  await commitWork(env, directory, "first", background, 10000);
  const first = await headCommit(env, directory, background, 10000);
  const tree = await treeOf(env, directory, first, background, 10000);
  assert.match(tree, /^[a-f0-9]{40,64}$/);
  await git.raw(["commit", "--amend", "--no-edit", "--trailer", "Done: x"]);
  const amended = await headCommit(env, directory, background, 10000);
  assert.notEqual(amended, first);
  assert.equal(await treeOf(env, directory, amended, background, 10000), tree);
  writeFileSync(join(directory, "tracked"), "changed");
  await commitWork(env, directory, "second", background, 10000);
  const second = await headCommit(env, directory, background, 10000);
  assert.notEqual(
    await treeOf(env, directory, second, background, 10000),
    tree,
  );
});

test("work commits include new and tracked files, preserve history and ignore ignored files", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, "tracked"), "original");
  writeFileSync(join(directory, ".gitignore"), "ignored\n");
  const initial = await commitWork(
    env,
    directory,
    "initial",
    background,
    10000,
  );
  writeFileSync(join(directory, "tracked"), "changed");
  writeFileSync(join(directory, "new"), "new");
  writeFileSync(join(directory, "ignored"), "ignored");
  const message = "feat: add the task";
  const head = await commitWork(env, directory, message, background, 10000);
  assert.notEqual(head, initial);
  assert.equal((await git.raw(["rev-parse", "HEAD^"])).trim(), initial);
  assert.equal((await git.raw(["log", "-1", "--format=%s"])).trim(), message);
  assert.deepEqual((await git.raw(["ls-files"])).trim().split("\n"), [
    ".gitignore",
    "new",
    "tracked",
  ]);
  assert.equal(
    await commitWork(env, directory, "clean", background, 10000),
    null,
  );
  assert.equal(await headCommit(env, directory, background, 10000), head);
  writeFileSync(join(directory, "tracked"), "checkpoint");
  const checkpoint = "feat: keep the task";
  await commitWork(env, directory, checkpoint, background, 10000);
  assert.equal((await git.raw(["rev-parse", "HEAD^"])).trim(), head);
  assert.equal(
    (await git.raw(["log", "-1", "--format=%s"])).trim(),
    checkpoint,
  );
  await assert.rejects(commitWork(env, directory, "expired", background, 1));
});

test("work commits ignore the interactive helpers of the host environment", async (t) => {
  const interactive = {
    PAGER: "less",
    GIT_PAGER: "less",
    EDITOR: "vi",
    GIT_EDITOR: "vi",
    GIT_SEQUENCE_EDITOR: "vi",
    GIT_ASKPASS: "askpass",
    SSH_ASKPASS: "askpass",
  };
  const env = { ...hostEnvironment(), ...interactive };
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, "tracked"), "original");
  const head = await commitWork(env, directory, "initial", background, 10000);
  assert.ok(head);
  await discardChanges(env, directory, background, 10000);
  assert.equal(await headCommit(env, directory, background, 10000), head);
});

test("added files list only the files that the branch adds against its base", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  const commit = (message: string) =>
    git.raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      message,
    ]);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  writeFileSync(join(directory, "kept"), "base");
  await git.add("kept");
  await commit("base");
  await git.raw(["checkout", "-b", "work"]);
  writeFileSync(join(directory, "kept"), "changed");
  writeFileSync(join(directory, "debug.mjs"), "scratch");
  await git.add(["kept", "debug.mjs"]);
  await commit("work");
  assert.deepEqual(
    await addedFiles(env, directory, "main", background, 10000),
    ["debug.mjs"],
  );
});

test("modified files list the added, the modified and the deleted path of the branch", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  const commit = (message: string) =>
    git.raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      message,
    ]);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  writeFileSync(join(directory, "modified"), "base");
  writeFileSync(join(directory, "deleted"), "base");
  await git.add(["modified", "deleted"]);
  await commit("base");
  await git.raw(["checkout", "-b", "work"]);
  writeFileSync(join(directory, "modified"), "changed");
  writeFileSync(join(directory, "added"), "new");
  rmSync(join(directory, "deleted"));
  await git.add(["modified", "added", "deleted"]);
  await commit("work");
  assert.deepEqual(
    (await modifiedFiles(env, directory, "main", background, 10000)).sort(),
    ["added", "deleted", "modified"],
  );
});

test("changed files list an added, a modified, a deleted and a spaced path of a commit range", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, "modified"), "base");
  writeFileSync(join(directory, "deleted"), "base");
  const from = await commitWork(env, directory, "base", background, 10000);
  assert.ok(from);
  writeFileSync(join(directory, "modified"), "changed");
  rmSync(join(directory, "deleted"));
  writeFileSync(join(directory, "added"), "new");
  writeFileSync(join(directory, "with space.txt"), "new");
  const to = await commitWork(env, directory, "work", background, 10000);
  assert.ok(to);
  assert.deepEqual(
    await changedFiles(env, directory, from, to, background, 10000),
    ["added", "deleted", "modified", "with space.txt"],
  );
});

test("merge base answers the fork commit of two branches", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  await git.raw(["checkout", "-b", "main"]);
  writeFileSync(join(directory, "kept"), "base");
  const fork = await commitWork(env, directory, "base", background, 10000);
  assert.ok(fork);
  await git.raw(["checkout", "-b", "work"]);
  writeFileSync(join(directory, "work"), "work");
  await commitWork(env, directory, "work", background, 10000);
  await git.raw(["checkout", "main"]);
  writeFileSync(join(directory, "main"), "main");
  await commitWork(env, directory, "main", background, 10000);
  assert.equal(
    await mergeBase(env, directory, "main", "work", background, 10000),
    fork,
  );
  await assert.rejects(
    mergeBase(env, directory, "--all", "work", background, 10000),
  );
});

test("changed entries list the status of each path of a commit range in git order", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, "modified"), "base");
  writeFileSync(join(directory, "deleted"), "base");
  writeFileSync(join(directory, "typed"), "base");
  writeFileSync(join(directory, "old name"), "renamed content\nsecond line\n");
  const from = await commitWork(env, directory, "base", background, 10000);
  assert.ok(from);
  writeFileSync(join(directory, "modified"), "changed");
  rmSync(join(directory, "deleted"));
  rmSync(join(directory, "typed"));
  symlinkSync("modified", join(directory, "typed"));
  rmSync(join(directory, "old name"));
  writeFileSync(join(directory, "new name"), "renamed content\nsecond line\n");
  writeFileSync(join(directory, "added"), "new");
  writeFileSync(join(directory, "with space.txt"), "new");
  const to = await commitWork(env, directory, "work", background, 10000);
  assert.ok(to);
  assert.deepEqual(
    await changedEntries(env, directory, from, to, background, 10000),
    [
      { path: "added", status: ChangeStatus.Added },
      { path: "deleted", status: ChangeStatus.Deleted },
      { path: "modified", status: ChangeStatus.Modified },
      {
        path: "new name",
        status: ChangeStatus.Renamed,
        previous_path: "old name",
      },
      { path: "typed", status: ChangeStatus.Modified },
      { path: "with space.txt", status: ChangeStatus.Added },
    ],
  );
});

test("work commits ignore the global git configuration of the host", async (t) => {
  const home = temporary(t);
  writeFileSync(join(home, ".gitignore_global"), "**/*.env.*\n");
  writeFileSync(
    join(home, ".gitconfig"),
    `[core]\n\texcludesFile = ${join(home, ".gitignore_global")}\n[user]\n\tname = Host\n\temail = host@example.invalid\n`,
  );
  overrideEnvironment(t, {
    ...UNSET_GIT_ENVIRONMENT,
    HOME: home,
    XDG_CONFIG_HOME: undefined,
  });
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, ".env.example"), "KEY=value");
  writeFileSync(join(directory, "app.env.local"), "KEY=value");
  assert.notEqual(
    await commitWork(
      hostEnvironment(),
      directory,
      "checkpoint",
      background,
      10000,
    ),
    null,
  );
  assert.deepEqual((await git.raw(["ls-files"])).trim().split("\n"), [
    ".env.example",
    "app.env.local",
  ]);
  assert.deepEqual(
    (await git.raw(["log", "-1", "--format=%an <%ae>"])).trim(),
    DEFAULT_IDENTITY,
  );
});

test("work commits ignore the default global ignore file of the host", async (t) => {
  const config = temporary(t);
  mkdirSync(join(config, "git"));
  writeFileSync(join(config, "git", "ignore"), "**/*.env.*\n");
  overrideEnvironment(t, {
    ...UNSET_GIT_ENVIRONMENT,
    HOME: temporary(t),
    XDG_CONFIG_HOME: config,
  });
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, ".env.example"), "KEY=value");
  await commitWork(
    hostEnvironment(),
    directory,
    "checkpoint",
    background,
    10000,
  );
  assert.deepEqual((await git.raw(["ls-files"])).trim().split("\n"), [
    ".env.example",
  ]);
});

test("work commits ignore the default global attributes file of the host", async (t) => {
  const config = temporary(t);
  mkdirSync(join(config, "git"));
  writeFileSync(join(config, "git", "attributes"), "* text\n");
  overrideEnvironment(t, {
    ...UNSET_GIT_ENVIRONMENT,
    HOME: temporary(t),
    XDG_CONFIG_HOME: config,
  });
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, "crlf.txt"), CRLF_CONTENT);
  await commitWork(
    hostEnvironment(),
    directory,
    "checkpoint",
    background,
    10000,
  );
  assert.equal(
    await git.raw(["cat-file", "blob", "HEAD:crlf.txt"]),
    CRLF_CONTENT,
  );
});

test("work commits run no hook of the configured hooks path of the repository", async (t) => {
  const directory = temporary(t);
  const hooks = temporary(t);
  const marker = join(hooks, HOOK_MARKER);
  writeRefusingHook(hooks, marker);
  const git = simpleGit(directory, { unsafe: { allowUnsafeHooksPath: true } });
  await git.init();
  await git.addConfig("core.hooksPath", hooks);
  writeFileSync(join(directory, "tracked"), "original");
  const head = await commitWork(
    env,
    directory,
    "checkpoint",
    background,
    10000,
  );
  assert.ok(head);
  assert.equal(existsSync(marker), false);
});

test("work commits run no hook of the default hooks directory of the repository", async (t) => {
  const directory = temporary(t);
  const marker = join(temporary(t), HOOK_MARKER);
  const git = simpleGit(directory);
  await git.init();
  writeRefusingHook(join(directory, ".git", "hooks"), marker);
  writeFileSync(join(directory, "tracked"), "original");
  const head = await commitWork(
    env,
    directory,
    "checkpoint",
    background,
    10000,
  );
  assert.ok(head);
  assert.equal(existsSync(marker), false);
});

test("work commits run no hook of the hooks path in the host git configuration parameters", async (t) => {
  const directory = temporary(t);
  const hooks = temporary(t);
  const marker = join(hooks, HOOK_MARKER);
  writeRefusingHook(hooks, marker);
  await simpleGit(directory).init();
  writeFileSync(join(directory, "tracked"), "original");
  const head = await commitWork(
    { ...env, GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooks}'` },
    directory,
    "checkpoint",
    background,
    10000,
  );
  assert.ok(head);
  assert.equal(existsSync(marker), false);
});

test("work commits make no commit for a change inside a nested repository", async (t) => {
  const directory = temporary(t);
  const nested = join(directory, "nested");
  mkdirSync(nested);
  await simpleGit(nested).init();
  writeFileSync(join(nested, "file"), "original");
  await commitWork(env, nested, "nested", background, 10000);
  await simpleGit(directory).init();
  await commitWork(env, directory, "initial", background, 10000);
  writeFileSync(join(nested, "file"), "changed");
  assert.equal(
    await commitWork(env, directory, "nested change", background, 10000),
    null,
  );
});

test("a git exit that is not zero and writes no error output fails the call", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, "tracked"), "original");
  const initial = await commitWork(
    env,
    directory,
    "initial",
    background,
    10000,
  );
  assert.ok(initial);
  await git.raw(["checkout", "-q", "--orphan", "unrelated"]);
  await commitWork(env, directory, "unrelated", background, 10000);
  await assert.rejects(
    isAncestor(env, directory, initial, background, 10000),
    /git exited with 1/,
  );
});

test("work commits handle more conversion-only files than one command line holds", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  await git.addConfig("core.autocrlf", "false");
  const names = Array.from(
    { length: MANY_FILES },
    (_, index) => `${LONG_NAME}-${index}.txt`,
  );
  const pathBytes = names.reduce(
    (total, name) => total + Buffer.byteLength(name) + 1,
    0,
  );
  assert.ok(pathBytes > LINUX_ARG_MAX_BYTES);
  for (const name of names) writeFileSync(join(directory, name), CRLF_LINE);
  await git.raw(["add", "--all"]);
  await git.raw(["commit", "-q", "-m", "initial"]);
  writeFileSync(join(directory, ".gitattributes"), "*.txt text\n");
  for (const name of names) writeFileSync(join(directory, name), CRLF_LINE);
  writeFileSync(join(directory, names[0]!), "changed\n");
  const head = await commitWork(env, directory, "many", background, 60000);
  assert.ok(head);
  const changed = await git.raw(["show", "--name-only", "--format=", "HEAD"]);
  assert.deepEqual(changed.trim().split("\n").sort(), [
    ".gitattributes",
    names[0]!,
  ]);
});

test("a file at a revision reads a regular blob and refuses an absent path or a directory", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  mkdirSync(join(directory, "folder"));
  writeFileSync(join(directory, "folder", "file.json"), EMPTY_OBJECT);
  await git.add(["folder/file.json"]);
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const read = (path: string) =>
    fileAtRevision(env, directory, "HEAD", path, background, 10000);
  assert.equal(await read("folder/file.json"), EMPTY_OBJECT);
  assert.equal(await read("folder/absent.json"), null);
  assert.equal(await read("folder"), null);
});

test("an untracked exclusion keeps the setup output out of a commit and out of the cleanup", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  writeFileSync(join(directory, "tracked"), "original");
  writeFileSync(join(directory, ".gitignore"), "ignored\n");
  await git.add(["tracked", ".gitignore"]);
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  mkdirSync(join(directory, "node_modules"));
  writeFileSync(join(directory, "node_modules", "package"), "setup");
  writeFileSync(join(directory, "ignored"), "setup");
  writeFileSync(join(directory, "star*"), "setup");
  assert.deepEqual(
    (await excludeUntracked(env, directory, background, 10000)).sort(),
    ["node_modules/", "star*"],
  );
  assert.equal(
    await commitWork(env, directory, "setup", background, 10000),
    null,
  );
  await discardChanges(env, directory, background, 10000);
  assert.equal(existsSync(join(directory, "node_modules", "package")), true);
  assert.equal(existsSync(join(directory, "star*")), true);
  writeFileSync(join(directory, "star-agent"), "agent");
  assert.notEqual(
    await commitWork(env, directory, "agent", background, 10000),
    null,
  );
  assert.deepEqual(
    await excludeUntracked(env, directory, background, 10000),
    [],
  );
});

test("a KanthorD checkout writes the real tree of a commit with a replace ref", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  const identity = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
  ];
  await git.init();
  writeFileSync(join(directory, "tracked"), REAL_CONTENT);
  await git.add(["tracked"]);
  await git.raw([...identity, "commit", "-m", "real"]);
  const real = await headCommit(env, directory, background, 10000);
  writeFileSync(join(directory, "tracked"), "replacement");
  await git.add(["tracked"]);
  await git.raw([...identity, "commit", "-m", "replacement"]);
  const replacement = await headCommit(env, directory, background, 10000);
  await git.raw(["replace", real, replacement]);
  await checkoutDetached(env, directory, real, background, 10000);
  assert.equal(readFileSync(join(directory, "tracked"), "utf8"), REAL_CONTENT);
});

const TEST_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const TRACKED_CONTENT = "tracked";
const GIT_DEADLINE_MS = 30000;
const READY = "ready";
const REBUILD = "rebuild";
const NEWLINE_TEXT = "\n";
const DETACHED_HEAD = "HEAD";
const SKIP_WORKTREE_TAG = "S ";
const NO_LINES = 0;
const FALSE_TEXT = "false";
const OUTSIDE_TEXT = "outside\n";
const SCRUBBED_EXCLUDE = "/deps/\n/star\\*\n";

async function commitFile(directory: string, path: string, content: string) {
  mkdirSync(join(directory, path, ".."), { recursive: true });
  writeFileSync(join(directory, path), content);
  await simpleGit(directory).add(path);
  await simpleGit(directory).raw([...TEST_IDENTITY, "commit", "-m", path]);
}

async function poolFixture(
  t: Parameters<typeof temporary>[0],
  cloneArgs: readonly string[] = [],
) {
  const root = temporary(t);
  const origin = join(root, "origin");
  mkdirSync(origin);
  await simpleGit(origin).raw(["init", "-b", "main"]);
  await simpleGit(origin).raw(["config", "uploadpack.allowFilter", "true"]);
  await commitFile(origin, ".gitignore", "deps/\nbuild/\n");
  await commitFile(origin, "tracked", TRACKED_CONTENT);
  await commitFile(origin, "dir/a", "a");
  await commitFile(origin, "other/b", "b");
  const tree = join(root, "tree");
  await simpleGit(root).raw([
    "clone",
    ...cloneArgs,
    cloneArgs.length ? `file://${origin}` : origin,
    tree,
  ]);
  const commit = await headCommit(env, tree, background, GIT_DEADLINE_MS);
  return { root, origin, tree, commit };
}

type PoolFixture = Awaited<ReturnType<typeof poolFixture>>;

function take(at: PoolFixture): string {
  const pool = TreePool.open(join(at.root, "pool"));
  pool.give({ address: at.origin, poolClass: PoolClass.Agent }, at.tree, null);
  const directory = join(at.root, "taken", "checkout");
  assert.equal(
    pool.take(
      { address: at.origin, poolClass: PoolClass.Agent },
      directory,
      null,
    ),
    true,
  );
  return directory;
}

async function normalise(
  at: PoolFixture,
  directory: string,
  keepRefs: readonly string[] = [],
) {
  return await normaliseGitState(
    { env, directory, context: background, deadlineMs: GIT_DEADLINE_MS },
    at.origin,
    keepRefs,
  );
}

async function takeAndScrub(
  at: PoolFixture,
  keepRefs: readonly string[] = [],
): Promise<string> {
  const directory = take(at);
  assert.equal(await normalise(at, directory, keepRefs), READY);
  const call = {
    env,
    directory,
    context: background,
    deadlineMs: GIT_DEADLINE_MS,
  };
  await scrubTree(call, at.commit, (await readSetupRecord(call))?.roots ?? []);
  return directory;
}

async function hostGit(directory: string, args: string[]): Promise<string> {
  return (await simpleGit(directory).raw(args)).trim();
}

function snapshot(path: string): string | string[] {
  return lstatSync(path).isDirectory()
    ? readdirSync(path, { recursive: true }).map(String).sort()
    : readFileSync(path, "utf8");
}

function lockFiles(directory: string): string[] {
  return readdirSync(join(directory, ".git"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".lock"));
}

test("a replace ref is gone and the checkout writes the real tree", async (t) => {
  const at = await poolFixture(t);
  await commitFile(at.tree, "tracked", "replacement");
  const replacement = await headCommit(
    env,
    at.tree,
    background,
    GIT_DEADLINE_MS,
  );
  await hostGit(at.tree, ["replace", at.commit, replacement]);
  await hostGit(at.tree, ["branch", "feature"]);
  await hostGit(at.tree, ["branch", "keep"]);
  await hostGit(at.tree, ["tag", "v1"]);
  await hostGit(at.tree, ["update-ref", "refs/kanthord/heads/x", at.commit]);
  writeFileSync(join(at.tree, "tracked"), "stashed");
  await hostGit(at.tree, [...TEST_IDENTITY, "stash"]);
  const directory = await takeAndScrub(at, ["refs/heads/keep"]);
  assert.deepEqual(
    (await hostGit(directory, ["for-each-ref", "--format=%(refname)"]))
      .split(NEWLINE_TEXT)
      .sort(),
    [
      "refs/heads/keep",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/tags/v1",
    ],
  );
  assert.equal(await hostGit(directory, ["rev-parse", "HEAD"]), at.commit);
  assert.equal(
    await hostGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    DETACHED_HEAD,
  );
  assert.equal(
    await hostGit(directory, ["show", `${at.commit}:tracked`]),
    TRACKED_CONTENT,
  );
  assert.equal(
    readFileSync(join(directory, "tracked"), "utf8"),
    TRACKED_CONTENT,
  );
});

test("a skip-worktree bit is gone and the changed tracked file is restored", async (t) => {
  const at = await poolFixture(t);
  await hostGit(at.tree, ["update-index", "--skip-worktree", "tracked"]);
  writeFileSync(join(at.tree, "tracked"), "changed");
  const directory = await takeAndScrub(at);
  assert.equal(
    readFileSync(join(directory, "tracked"), "utf8"),
    TRACKED_CONTENT,
  );
  assert.equal(
    (await hostGit(directory, ["ls-files", "-v"]))
      .split(NEWLINE_TEXT)
      .filter((line) => line.startsWith(SKIP_WORKTREE_TAG)).length,
    NO_LINES,
  );
});

test("a sparse checkout is gone and each tracked file is present", async (t) => {
  const at = await poolFixture(t);
  await hostGit(at.tree, ["config", "core.sparseCheckout", "true"]);
  writeFileSync(join(at.tree, ".git", "info", "sparse-checkout"), "/dir/\n");
  await hostGit(at.tree, ["read-tree", "-mu", "HEAD"]);
  assert.equal(existsSync(join(at.tree, "other", "b")), false);
  const directory = await takeAndScrub(at);
  for (const path of ["tracked", "dir/a", "other/b", ".gitignore"])
    assert.equal(existsSync(join(directory, path)), true, path);
  assert.equal(
    existsSync(join(directory, ".git", "info", "sparse-checkout")),
    false,
  );
});

test("a fsmonitor hook and a filter driver do not run", async (t) => {
  const at = await poolFixture(t);
  const marker = join(at.root, "ran");
  const filter = join(at.root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\necho filter >> "${marker}"\ncat\n`);
  chmodSync(filter, EXECUTABLE_MODE);
  const monitor = join(at.root, "monitor.sh");
  writeFileSync(monitor, `#!/bin/sh\necho monitor >> "${marker}"\n`);
  chmodSync(monitor, EXECUTABLE_MODE);
  appendFileSync(
    join(at.tree, ".git", "config"),
    `[core]\n\tfsmonitor = ${monitor}\n[filter "x"]\n\tsmudge = ${filter}\n\tclean = ${filter}\n`,
  );
  writeFileSync(join(at.tree, ".git", "info", "attributes"), "* filter=x\n");
  const directory = await takeAndScrub(at);
  await hostGit(directory, ["status"]);
  await hostGit(directory, ["checkout", "--force", "--detach", at.commit]);
  assert.equal(existsSync(marker), false);
  assert.equal(
    existsSync(join(directory, ".git", "info", "attributes")),
    false,
  );
});

test("a pushurl and an insteadOf rule are gone", async (t) => {
  const at = await poolFixture(t);
  const elsewhere = join(at.root, "elsewhere");
  await hostGit(at.tree, ["config", "remote.origin.pushurl", elsewhere]);
  await hostGit(at.tree, ["config", `url.${elsewhere}.insteadOf`, at.origin]);
  appendFileSync(
    join(at.tree, ".git", "config"),
    "[user]\n\tname = Agent\n[core]\n\teditor = vi\n\tfilemode = maybe\n",
  );
  const directory = await takeAndScrub(at);
  assert.equal(
    await hostGit(directory, ["remote", "get-url", "--push", "origin"]),
    at.origin,
  );
  const entries = (
    await hostGit(directory, ["config", "--file", ".git/config", "--list"])
  ).split(NEWLINE_TEXT);
  const allowed = [
    "core.repositoryformatversion=0",
    "core.bare=false",
    `remote.origin.url=${at.origin}`,
    "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
    "gc.autodetach=false",
    "maintenance.autodetach=false",
  ];
  for (const entry of allowed) assert.ok(entries.includes(entry), entry);
  const optional =
    /^core\.(logallrefupdates|ignorecase|precomposeunicode|symlinks)=(true|false)$/;
  assert.deepEqual(
    entries.filter(
      (entry) => !allowed.includes(entry) && !optional.test(entry),
    ),
    [],
  );
});

test("the hooks directory is empty, and gc.autoDetach and maintenance.autoDetach read false", async (t) => {
  const at = await poolFixture(t);
  writeRefusingHook(join(at.tree, ".git", "hooks"), join(at.root, "hook"));
  const directory = await takeAndScrub(at);
  assert.deepEqual(readdirSync(join(directory, ".git", "hooks")), []);
  assert.equal(
    await hostGit(directory, ["config", "--get", "gc.autoDetach"]),
    FALSE_TEXT,
  );
  assert.equal(
    await hostGit(directory, ["config", "--get", "maintenance.autoDetach"]),
    FALSE_TEXT,
  );
});

test("an alternates file is gone", async (t) => {
  const at = await poolFixture(t);
  const alternates = join(at.tree, ".git", "objects", "info", "alternates");
  mkdirSync(join(alternates, ".."), { recursive: true });
  writeFileSync(alternates, `${join(at.origin, ".git", "objects")}\n`);
  writeFileSync(join(at.tree, ".git", "info", "grafts"), `${at.commit}\n`);
  const directory = await takeAndScrub(at);
  for (const path of ["objects/info/alternates", "info/grafts"])
    assert.equal(existsSync(join(directory, ".git", path)), false, path);
});

test("a rebase, a sequencer and a bisect in progress are gone", async (t) => {
  const at = await poolFixture(t);
  const git = join(at.tree, ".git");
  for (const name of ["rebase-merge", "rebase-apply", "sequencer"]) {
    mkdirSync(join(git, name));
    writeFileSync(join(git, name, "head-name"), "refs/heads/main\n");
  }
  for (const name of [
    "BISECT_START",
    "BISECT_LOG",
    "AUTO_MERGE",
    "MERGE_HEAD",
    "MERGE_MSG",
  ])
    writeFileSync(join(git, name), `${at.commit}\n`);
  const directory = await takeAndScrub(at);
  for (const name of [
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
    "BISECT_LOG",
    "AUTO_MERGE",
    "MERGE_HEAD",
    "MERGE_MSG",
  ])
    assert.equal(existsSync(join(directory, ".git", name)), false, name);
});

test("a cherry-pick and a revert in progress are gone", async (t) => {
  const at = await poolFixture(t);
  const git = join(at.tree, ".git");
  mkdirSync(join(git, "sequencer"));
  writeFileSync(join(git, "sequencer", "todo"), `pick ${at.commit}\n`);
  for (const name of ["CHERRY_PICK_HEAD", "REVERT_HEAD"])
    writeFileSync(join(git, name), `${at.commit}\n`);
  const directory = await takeAndScrub(at);
  for (const name of ["sequencer", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
    assert.equal(existsSync(join(directory, ".git", name)), false, name);
});

test("a lock behind a symlink in .git outside the tree survives", async (t) => {
  const at = await poolFixture(t);
  const outside = join(at.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "x.lock"), "");
  symlinkSync(outside, join(at.tree, ".git", "linked"));
  const directory = take(at);
  assert.equal(await normalise(at, directory), REBUILD);
  assert.equal(existsSync(join(outside, "x.lock")), true);
});

test("a symlinked config, info, objects, objects/info, hooks or refs answers rebuild", async (t) => {
  for (const path of [
    "config",
    "info",
    "objects",
    "objects/info",
    "hooks",
    "refs",
  ]) {
    const at = await poolFixture(t);
    const inside = join(at.tree, ".git", path);
    const outside = join(at.root, "outside");
    mkdirSync(join(inside, ".."), { recursive: true });
    if (existsSync(inside)) renameSync(inside, outside);
    else mkdirSync(outside);
    symlinkSync(outside, inside);
    const before = snapshot(outside);
    assert.equal(await normalise(at, take(at)), REBUILD, path);
    assert.deepEqual(snapshot(outside), before, path);
  }
});

test("a symlink anywhere under .git answers rebuild and the outside file stays", async (t) => {
  const cases: {
    name: string;
    plant: (git: string, outside: string) => void;
  }[] = [
    {
      name: "logs",
      plant: (git, outside) => {
        mkdirSync(join(outside, "refs", "kanthord"), { recursive: true });
        writeFileSync(join(outside, "refs", "kanthord", "x"), OUTSIDE_TEXT);
        rmSync(join(git, "logs"), { recursive: true, force: true });
        symlinkSync(outside, join(git, "logs"));
      },
    },
    {
      name: "nested ref",
      plant: (git, outside) => {
        mkdirSync(outside);
        writeFileSync(join(outside, "x"), OUTSIDE_TEXT);
        mkdirSync(join(git, "refs", "heads"), { recursive: true });
        symlinkSync(join(outside, "x"), join(git, "refs", "heads", "x"));
      },
    },
  ];
  for (const entry of cases) {
    const at = await poolFixture(t);
    const outside = join(at.root, "outside");
    entry.plant(join(at.tree, ".git"), outside);
    await hostGit(at.tree, ["update-ref", "refs/kanthord/x", at.commit]);
    const before = snapshot(outside);
    const directory = take(at);
    assert.equal(await normalise(at, directory), REBUILD, entry.name);
    assert.deepEqual(snapshot(outside), before, entry.name);
  }
});

test("a symlinked info/exclude answers rebuild and its target stays", async (t) => {
  const at = await poolFixture(t);
  const outside = join(at.root, "outside-exclude");
  writeFileSync(outside, OUTSIDE_TEXT);
  const exclude = join(at.tree, ".git", "info", "exclude");
  rmSync(exclude, { force: true });
  symlinkSync(outside, exclude);
  assert.equal(await normalise(at, take(at)), REBUILD);
  assert.equal(readFileSync(outside, "utf8"), OUTSIDE_TEXT);
});

test("a stale index lock and a stale ref lock are removed and the tree is reused", async (t) => {
  const at = await poolFixture(t);
  const git = join(at.tree, ".git");
  mkdirSync(join(git, "refs", "remotes", "origin"), { recursive: true });
  for (const path of [
    "index.lock",
    "HEAD.lock",
    "packed-refs.lock",
    "refs/heads/main.lock",
    "refs/remotes/origin/main.lock",
  ])
    writeFileSync(join(git, path), "");
  const directory = await takeAndScrub(at);
  assert.deepEqual(lockFiles(directory), []);
  assert.equal(await hostGit(directory, ["rev-parse", "HEAD"]), at.commit);
});

test("a shallow tree, a partial clone and a tree with linked worktrees answer rebuild", async (t) => {
  const cases: {
    name: string;
    cloneArgs?: string[];
    change?: (at: PoolFixture) => Promise<void>;
  }[] = [
    { name: "shallow", cloneArgs: ["--depth", "1"] },
    { name: "partial", cloneArgs: ["--filter=blob:none"] },
    {
      name: "partial at format 0",
      cloneArgs: ["--filter=blob:none"],
      change: async (at) => {
        await hostGit(at.tree, ["config", "core.repositoryformatversion", "0"]);
      },
    },
    {
      name: "promisor remote",
      change: async (at) => {
        await hostGit(at.tree, ["config", "remote.origin.promisor", "true"]);
      },
    },
    {
      name: "linked worktree",
      change: async (at) => {
        await hostGit(at.tree, [
          "worktree",
          "add",
          "--detach",
          join(at.root, "linked"),
        ]);
      },
    },
    {
      name: "commondir",
      change: async (at) => {
        writeFileSync(join(at.tree, ".git", "commondir"), "../other\n");
      },
    },
    {
      name: "format 1",
      change: async (at) => {
        await hostGit(at.tree, ["config", "core.repositoryformatversion", "1"]);
      },
    },
  ];
  for (const entry of cases) {
    const at = await poolFixture(t, entry.cloneArgs);
    await entry.change?.(at);
    assert.equal(await normalise(at, take(at)), REBUILD, entry.name);
  }
});

test("a tree whose .git is a relative gitdir file answers rebuild", async (t) => {
  const at = await poolFixture(t);
  renameSync(join(at.tree, ".git"), join(at.root, "store.git"));
  writeFileSync(join(at.tree, ".git"), "gitdir: ../store.git\n");
  assert.equal(await hostGit(at.tree, ["rev-parse", "HEAD"]), at.commit);
  assert.equal(await normalise(at, at.tree), REBUILD);
});

test("scrubTree keeps the recorded roots, removes every other untracked and ignored path and rewrites info/exclude", async (t) => {
  const at = await poolFixture(t);
  mkdirSync(join(at.tree, "deps"));
  writeFileSync(join(at.tree, "deps", "x"), "setup");
  mkdirSync(join(at.tree, "build"));
  writeFileSync(join(at.tree, "build", "y"), "agent");
  writeFileSync(join(at.tree, "star*"), "setup");
  writeFileSync(join(at.tree, "starX"), "agent");
  writeFileSync(join(at.tree, "untracked"), "agent");
  writeFileSync(join(at.tree, ".git", "info", "exclude"), "/stale\n");
  writeSetupRecord(at.tree, { digest: "none", roots: ["deps/", "star*"] });
  const directory = await takeAndScrub(at);
  assert.equal(existsSync(join(directory, "deps", "x")), true);
  assert.equal(existsSync(join(directory, "star*")), true);
  for (const path of ["build", "starX", "untracked"])
    assert.equal(existsSync(join(directory, path)), false, path);
  assert.equal(
    readFileSync(join(directory, ".git", "info", "exclude"), "utf8"),
    SCRUBBED_EXCLUDE,
  );
});

test("fetchLocal brings an unpushed commit of the source into the tree", async (t) => {
  const at = await poolFixture(t);
  const source = join(at.root, "source");
  await simpleGit(at.root).clone(at.origin, source);
  await hostGit(source, ["checkout", "-b", "kanthord/node"]);
  await commitFile(source, "unpushed", "local");
  const unpushed = await headCommit(env, source, background, GIT_DEADLINE_MS);
  const directory = await takeAndScrub(at);
  await fetchLocal(
    { env, directory, context: background, deadlineMs: GIT_DEADLINE_MS },
    source,
  );
  assert.equal(
    await hostGit(directory, [
      "rev-parse",
      "refs/kanthord/heads/kanthord/node",
    ]),
    unpushed,
  );
  assert.equal(
    await hostGit(directory, ["rev-parse", "refs/kanthord/remotes/main"]),
    at.commit,
  );
});
