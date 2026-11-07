import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../../repository/sshd-test-support.ts";
import {
  fakeContainerHost,
  fakeRepositoryFiles,
} from "./container-fakes-test-support.ts";

const FAKE_ADDRESS = "git@github.com:owner/repo.git";
const FAKE_REVISION = "a".repeat(40);
const CLONE_DEADLINE_MS = 10000;

test("the fake repository clones a checkout that git bundles at its head", async (t) => {
  const directory = join(temporary(t), "checkout");
  const files = fakeRepositoryFiles();
  await files.cloneSnapshot(
    FAKE_ADDRESS,
    FAKE_REVISION,
    directory,
    background,
    CLONE_DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
  );
  const git = simpleGit(directory);
  const bundle = join(directory, "..", "repository.bundle");
  await git.raw(["bundle", "create", "--quiet", bundle, "HEAD"]);
  await git.raw(["bundle", "verify", "--quiet", bundle]);
});

test("the fake container host answers only the complete lines of its command log", (t) => {
  const fake = fakeContainerHost(t);
  appendFileSync(fake.log, '["info"]\n["image","insp');
  assert.deepEqual(fake.commands(), [["info"]]);
  appendFileSync(fake.log, 'ect"]\n');
  assert.deepEqual(fake.commands(), [["info"], ["image", "inspect"]]);
});

test("the fake container host throws on a complete line that is not valid JSON", (t) => {
  const fake = fakeContainerHost(t);
  appendFileSync(fake.log, '["info"\n');
  assert.throws(() => fake.commands(), SyntaxError);
});
