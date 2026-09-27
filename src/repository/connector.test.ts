import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../kernel/context.ts";
import { gitLsRemote } from "./connector.ts";

const DEADLINE_MS = 5000;
const EXPIRED_DEADLINE_MS = 1;
const MISSING_REPOSITORY = "file:////nonexistent_kanthord_plan04_test";

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
