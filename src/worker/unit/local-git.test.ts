import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
  ChangeStatus,
  changedEntries,
  changedFiles,
  commitWork,
  discardChanges,
  excludeUntracked,
  fileAtRevision,
  headCommit,
  isAncestor,
  mergeBase,
} from "./local-git.ts";
import { GIT_COMMIT_FAILED } from "./stop-codes.ts";

const env = hostEnvironment();
const DEFAULT_IDENTITY = "kanthord <kanthord@localhost>";
const CRLF_CONTENT = "a\r\nb\r\n";
const HOOK_MARKER = "hook-ran";
const EXECUTABLE_MODE = 0o755;
const MANY_FILES = 20000;
const LONG_NAME = "x".repeat(120);
const CRLF_LINE = "a\r\n";
const EMPTY_OBJECT = "{}";
const FAILING_SIGNER = "false";
const SIGNER_FAILURE = "failed to sign the data";

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
