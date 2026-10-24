import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../../repository/test-sshd.ts";
import { fakeRepositoryFiles } from "./container-fakes.ts";

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
  await simpleGit().raw(["bundle", "verify", "--quiet", bundle]);
});
