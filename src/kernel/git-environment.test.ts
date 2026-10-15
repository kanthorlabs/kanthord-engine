import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedGitEnvironment } from "./git-environment.ts";

const PATH_VALUE = "/bin";

test("isolatedGitEnvironment replaces the global and system configuration and keeps the rest", () => {
  assert.deepEqual(
    isolatedGitEnvironment({
      PATH: "/bin",
      HOME: "/home/host",
      GIT_CONFIG_GLOBAL: "/home/host/.gitconfig",
      GIT_CONFIG_COUNT: "3",
    }),
    {
      PATH: "/bin",
      HOME: "/home/host",
      GIT_AUTHOR_NAME: "kanthord",
      GIT_AUTHOR_EMAIL: "kanthord@localhost",
      GIT_COMMITTER_NAME: "kanthord",
      GIT_COMMITTER_EMAIL: "kanthord@localhost",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
    },
  );
});

test("isolatedGitEnvironment fills a missing identity and keeps a given identity", () => {
  const output = isolatedGitEnvironment({ GIT_AUTHOR_NAME: "Given" });
  assert.deepEqual(
    [
      output.GIT_AUTHOR_NAME,
      output.GIT_AUTHOR_EMAIL,
      output.GIT_COMMITTER_NAME,
      output.GIT_COMMITTER_EMAIL,
    ],
    ["Given", "kanthord@localhost", "kanthord", "kanthord@localhost"],
  );
});

test("isolatedGitEnvironment removes the interactive helpers", () => {
  const output = isolatedGitEnvironment({
    PAGER: "less",
    GIT_PAGER: "less",
    EDITOR: "vi",
    GIT_EDITOR: "vi",
    GIT_SEQUENCE_EDITOR: "vi",
    GIT_ASKPASS: "ask",
    SSH_ASKPASS: "ask",
    PATH: PATH_VALUE,
  });
  assert.deepEqual(
    Object.keys(output).filter((name) => /PAGER|EDITOR|ASKPASS/.test(name)),
    [],
  );
  assert.deepEqual(output.PATH, PATH_VALUE);
});
