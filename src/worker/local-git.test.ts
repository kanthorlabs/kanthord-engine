import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { discardChanges, headCommit } from "./local-git.ts";

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
