import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { CHECKOUT_HEAD, commitLog } from "./tasks-verify.ts";

test("commitLog refuses a range end that is no commit id, and git log writes no file", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.raw([
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "start",
  ]);
  const head = (await git.revparse([CHECKOUT_HEAD])).trim();
  const written = join(directory, "written");
  const env = hostEnvironment();
  assert.match(
    await commitLog(directory, { from: head, to: CHECKOUT_HEAD }, env),
    /^$/,
  );
  await assert.rejects(
    commitLog(directory, { from: `--output=${written}`, to: head }, env),
  );
  await assert.rejects(
    commitLog(directory, { from: head, to: `--output=${written}` }, env),
  );
  assert.equal(existsSync(written), false);
});
