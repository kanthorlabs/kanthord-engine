import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  checkpointCommitMessage,
  commitWork,
  discardChanges,
  headCommit,
  taskCommitMessage,
} from "./local-git.ts";

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
  const head = await headCommit(directory, background, 10000);
  writeFileSync(join(directory, "tracked"), "changed");
  writeFileSync(join(directory, "untracked"), "changed");
  writeFileSync(join(directory, "ignored"), "retained");
  await discardChanges(directory, background, 10000);
  assert.equal(await headCommit(directory, background, 10000), head);
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
  const initial = await commitWork(directory, "initial", background, 10000);
  writeFileSync(join(directory, "tracked"), "changed");
  writeFileSync(join(directory, "new"), "new");
  writeFileSync(join(directory, "ignored"), "ignored");
  const message = taskCommitMessage("task-1", 2);
  const head = await commitWork(directory, message, background, 10000);
  assert.notEqual(head, initial);
  assert.equal((await git.raw(["rev-parse", "HEAD^"])).trim(), initial);
  assert.equal((await git.raw(["log", "-1", "--format=%s"])).trim(), message);
  assert.deepEqual((await git.raw(["ls-files"])).trim().split("\n"), [
    ".gitignore",
    "new",
    "tracked",
  ]);
  assert.equal(await commitWork(directory, "clean", background, 10000), null);
  assert.equal(await headCommit(directory, background, 10000), head);
  writeFileSync(join(directory, "tracked"), "checkpoint");
  const checkpoint = checkpointCommitMessage("task-1", 2);
  await commitWork(directory, checkpoint, background, 10000);
  assert.equal((await git.raw(["rev-parse", "HEAD^"])).trim(), head);
  assert.equal(
    (await git.raw(["log", "-1", "--format=%s"])).trim(),
    checkpoint,
  );
  await assert.rejects(commitWork(directory, "expired", background, 1));
});
