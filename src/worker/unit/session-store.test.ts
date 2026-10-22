import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createIdentity } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  EXECUTION_SESSIONS_KEPT,
  executionSessionDirectory,
  executionSessionRoot,
} from "./session-store.ts";

const DIRECTORY_MODE_MASK = 0o7777;
const PRIVATE_DIRECTORY_MODE = 0o700;
const EXTRA_DIRECTORIES = 10;
const MILLISECONDS = 1000;

function seed(root: string, count: number): string[] {
  mkdirSync(root, { recursive: true });
  const base = Date.now() / MILLISECONDS - count;
  return Array.from({ length: count }, (_, index) => {
    const id = createIdentity("execution");
    const path = join(root, id);
    mkdirSync(path);
    utimesSync(path, base + index, base + index);
    return id;
  });
}

test("the session root lies in the pi directory of the data directory", () => {
  assert.equal(
    executionSessionRoot("/data"),
    join("/data", "pi", "sessions", "execution"),
  );
});

test("an execution directory has mode 0700 under the session root", (t) => {
  const root = join(temporary(t), "sessions");
  const id = createIdentity("execution");
  const directory = executionSessionDirectory(root, id);
  assert.equal(directory, join(root, id));
  assert.equal(
    statSync(directory).mode & DIRECTORY_MODE_MASK,
    PRIVATE_DIRECTORY_MODE,
  );
});

test("a new execution directory prunes the oldest directories and keeps the current one", (t) => {
  const root = join(temporary(t), "sessions");
  const seeded = seed(root, EXECUTION_SESSIONS_KEPT + EXTRA_DIRECTORIES);
  const id = createIdentity("execution");
  const directory = executionSessionDirectory(root, id);
  const kept = readdirSync(root);
  assert.equal(kept.length, EXECUTION_SESSIONS_KEPT);
  assert.ok(existsSync(directory));
  assert.ok(kept.includes(id));
  assert.deepEqual(
    kept.filter((name) => name !== id).toSorted(),
    seeded.slice(EXTRA_DIRECTORIES + 1).toSorted(),
  );
});

test("an existing execution directory prunes nothing", (t) => {
  const root = join(temporary(t), "sessions");
  const seeded = seed(root, EXECUTION_SESSIONS_KEPT + EXTRA_DIRECTORIES);
  executionSessionDirectory(root, seeded[0]!);
  assert.equal(
    readdirSync(root).length,
    EXECUTION_SESSIONS_KEPT + EXTRA_DIRECTORIES,
  );
});

test("an invalid execution identity throws", (t) => {
  const root = join(temporary(t), "sessions");
  assert.throws(() => executionSessionDirectory(root, "../escape"));
  assert.throws(() =>
    executionSessionDirectory(root, "node_01ARZ3NDEKTSV4RRFFQ69G5FAA"),
  );
  assert.equal(existsSync(root), false);
});
