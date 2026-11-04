import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { walkFootprint } from "./footprint-walk.ts";
import { temporary } from "./test-support.ts";

const BYTES = 100;
const LINKED_FILES = 1;
const WALKED_FILES = 2;

test("a hard link counts once", async (t) => {
  const root = temporary(t);
  writeFileSync(join(root, "a"), "x".repeat(BYTES));
  linkSync(join(root, "a"), join(root, "b"));
  const total = await walkFootprint(root);
  assert.equal(total.files, LINKED_FILES);
  assert.equal(total.bytes, BYTES);
});

test("a symlink is not followed and a skip path is not walked", async (t) => {
  const root = temporary(t);
  const outside = temporary(t);
  writeFileSync(join(outside, "big"), "x".repeat(BYTES * 10));
  symlinkSync(outside, join(root, "link"));
  mkdirSync(join(root, "skipped"));
  writeFileSync(join(root, "skipped", "file"), "x".repeat(BYTES));
  writeFileSync(join(root, "kept"), "x".repeat(BYTES));
  const total = await walkFootprint(root, { skip: ["skipped"] });
  assert.equal(total.files, WALKED_FILES);
  assert.ok(total.bytes < BYTES * 2);
});

test("a --local clone counts once", async (t) => {
  const root = temporary(t);
  const source = join(root, "source");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "a",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "a",
        GIT_COMMITTER_EMAIL: "a@example.com",
      },
    });
  mkdirSync(source);
  git(source, "init", "-q");
  writeFileSync(join(source, "file"), "x".repeat(BYTES * 50));
  git(source, "add", "file");
  git(source, "commit", "-q", "-m", "one");
  const alone = await walkFootprint(join(source, ".git", "objects"));
  git(root, "clone", "-q", "--local", source, "clone");
  const seen = new Set<string>();
  const first = await walkFootprint(join(source, ".git", "objects"), { seen });
  const second = await walkFootprint(join(root, "clone", ".git", "objects"), {
    seen,
  });
  assert.equal(first.bytes, alone.bytes);
  assert.ok(second.bytes < alone.bytes);
});
