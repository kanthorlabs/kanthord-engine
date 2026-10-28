import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedGitEnvironment } from "./git-environment.ts";

const PATH_VALUE = "/bin";
const GIT_PREFIX = "GIT_";
const GIVEN_AUTHOR = "Given";

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
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.attributesFile",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
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

test("isolatedGitEnvironment removes the helpers that the simple-git unsafe check rejects", () => {
  const output = isolatedGitEnvironment({
    GIT_TEMPLATE_DIR: "/tmp/template",
    GIT_EXTERNAL_DIFF: "diff",
    GIT_PROXY_COMMAND: "proxy",
    PATH: PATH_VALUE,
  });
  assert.deepEqual(
    Object.keys(output).filter((name) =>
      /TEMPLATE_DIR|EXTERNAL_DIFF|PROXY_COMMAND/.test(name),
    ),
    [],
  );
});

test("isolatedGitEnvironment removes the SSH agent and the SSH command of the host", () => {
  const output = isolatedGitEnvironment({
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SSH_AGENT_PID: "42",
    GIT_SSH: "ssh",
    GIT_SSH_COMMAND: "ssh -i key",
    PATH: PATH_VALUE,
  });
  assert.deepEqual(
    Object.keys(output).filter((name) => /SSH/.test(name)),
    [],
  );
  assert.deepEqual(output.PATH, PATH_VALUE);
});

test("isolatedGitEnvironment removes the git configuration parameters of the host", () => {
  const output = isolatedGitEnvironment({
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp/hooks'",
    PATH: PATH_VALUE,
  });
  assert.equal(output.GIT_CONFIG_PARAMETERS, undefined);
  assert.deepEqual(output.PATH, PATH_VALUE);
});

test("isolatedGitEnvironment removes every host GIT_ variable except the identity and the ceiling", () => {
  const ceiling = "/srv/state";
  const output = isolatedGitEnvironment({
    GIT_EXEC_PATH: "/tmp/exec",
    GIT_SSL_NO_VERIFY: "1",
    GIT_TRACE_CURL: "1",
    GIT_DIR: "/tmp/other.git",
    GIT_INDEX_FILE: "/tmp/index",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/objects",
    GIT_NAMESPACE: "other",
    GIT_AUTHOR_NAME: GIVEN_AUTHOR,
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_CONFIG_SYSTEM: "/tmp/system",
    GIT_CONFIG_KEY_7: "core.fsmonitor",
    PATH: PATH_VALUE,
  });
  assert.deepEqual(
    Object.keys(output)
      .filter((name) => name.startsWith(GIT_PREFIX))
      .sort(),
    [
      "GIT_ATTR_NOSYSTEM",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_CEILING_DIRECTORIES",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_KEY_2",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_VALUE_1",
      "GIT_CONFIG_VALUE_2",
    ],
  );
  assert.equal(output.GIT_AUTHOR_NAME, GIVEN_AUTHOR);
  assert.equal(output.GIT_CEILING_DIRECTORIES, ceiling);
  assert.deepEqual(output.PATH, PATH_VALUE);
});
