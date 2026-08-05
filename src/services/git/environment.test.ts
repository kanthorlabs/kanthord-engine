import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";

import type { GitPaths } from "./index.ts";
import { gitArgv, gitEnvironment, gitPath } from "./environment.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(overrides?: Partial<GitPaths>): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-env-"));
  directories.push(dir);
  return {
    git: tools.paths.git,
    ssh: tools.paths.ssh,
    sshKeyscan: tools.paths.sshKeyscan,
    home: join(dir, "home"),
    keyDirectory: join(dir, "keys"),
    knownHosts: join(dir, "known_hosts"),
    runDirectory: join(dir, "run"),
    ...overrides,
  };
}

const pinnedKeys = [
  "PATH",
  "HOME",
  "LC_ALL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

describe("src/services/git/environment.test", () => {
  it("gitArgv prepends the three config pins to the caller args", () => {
    assert.deepEqual(gitArgv(["--git-dir=/x", "rev-parse", "HEAD"]), [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "--git-dir=/x",
      "rev-parse",
      "HEAD",
    ]);
  });

  it("gitPath collapses duplicate directories", () => {
    assert.equal(
      gitPath({
        ...makePaths(),
        git: "/usr/bin/git",
        ssh: "/usr/bin/ssh",
        sshKeyscan: "/usr/bin/ssh-keyscan",
      }),
      "/usr/bin",
    );
  });

  it("gitPath keeps the fixed order and drops the duplicate", () => {
    assert.equal(
      gitPath({
        ...makePaths(),
        git: "/opt/git/bin/git",
        ssh: "/usr/bin/ssh",
        sshKeyscan: "/usr/bin/ssh-keyscan",
      }),
      "/opt/git/bin:/usr/bin",
    );
  });

  it("gitEnvironment holds exactly the eleven pinned keys", () => {
    const paths = makePaths();
    assert.deepEqual(
      Object.keys(gitEnvironment({ paths })).sort(),
      [...pinnedKeys].sort(),
    );
  });

  it("each pinned value is the documented one", () => {
    const paths = makePaths();
    const environment = gitEnvironment({ paths });
    assert.equal(environment.PATH, gitPath(paths));
    assert.equal(environment.HOME, paths.home);
    assert.equal(environment.LC_ALL, "C");
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environment.GIT_AUTHOR_NAME, "kanthord");
    assert.equal(environment.GIT_AUTHOR_EMAIL, "kanthord@kanthord.invalid");
    assert.equal(environment.GIT_COMMITTER_NAME, "kanthord");
    assert.equal(environment.GIT_COMMITTER_EMAIL, "kanthord@kanthord.invalid");
  });

  it("suppressed names are absent, not empty", () => {
    const paths = makePaths();
    const environment = gitEnvironment({ paths });
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_CONFIG_COUNT",
      "GIT_TRACE",
      "GIT_TRACE_PACKET",
      "GIT_TRACE2",
    ]) {
      assert.equal(
        Object.hasOwn(environment, name),
        false,
        `${name} is present`,
      );
    }
  });

  it("process.env leaks into no key", () => {
    const paths = makePaths();
    process.env.KANTHORD_LEAK_PROBE = "leak";
    try {
      const environment = gitEnvironment({ paths });
      assert.equal(Object.hasOwn(environment, "KANTHORD_LEAK_PROBE"), false);
    } finally {
      delete process.env.KANTHORD_LEAK_PROBE;
    }
  });

  it("extra merges last and adds one key", () => {
    const paths = makePaths();
    const environment = gitEnvironment({
      paths,
      extra: { GIT_SSH_COMMAND: "x" },
    });
    assert.equal(environment.GIT_SSH_COMMAND, "x");
    assert.equal(Object.keys(environment).length, 12);
  });

  it("extra rejects every pinned name", () => {
    const paths = makePaths();
    for (const key of ["PATH", "HOME", "LC_ALL"]) {
      assert.throws(
        () => gitEnvironment({ paths, extra: { [key]: "x" } }),
        { message: `${key} is a pinned entry` },
        key,
      );
    }
  });

  it("extra rejects every suppressed name", () => {
    const paths = makePaths();
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT"]) {
      assert.throws(
        () => gitEnvironment({ paths, extra: { [key]: "x" } }),
        { message: `${key} is a suppressed entry` },
        key,
      );
    }
    assert.throws(() => gitEnvironment({ paths, extra: { GIT_TRACE: "1" } }), {
      message: "GIT_TRACE is a suppressed entry",
    });
  });

  it("environment.ts never reads process.env", () => {
    const source = readFileSync(
      new URL("./environment.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("process.env"), false);
  });

  it("the child PATH never carries a fixture tool", () => {
    const paths = makePaths();
    const pathEntries = gitPath(paths).split(":");
    assert.ok(pathEntries.length <= 3, `PATH is ${gitPath(paths)}`);
    const toolDirectories = new Set(
      [tools.paths.git, tools.paths.ssh, tools.paths.sshKeyscan].map(dirname),
    );
    for (const fixtureTool of [tools.paths.sshd, tools.paths.sshKeygen]) {
      const fixtureDirectory = dirname(fixtureTool);
      if (!toolDirectories.has(fixtureDirectory)) {
        assert.ok(
          !pathEntries.includes(fixtureDirectory),
          `${fixtureDirectory} leaked onto the child PATH`,
        );
      }
    }
  });
});
