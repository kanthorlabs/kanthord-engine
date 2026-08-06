import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { toolTimeoutMilliseconds } from "../../../test/helpers/remote/tools.ts";
import {
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
} from "../../../test/helpers/remote/seed.ts";

import { GitError, type GitPaths } from "./index.ts";
import { createGitRunner } from "./run.ts";
import { worktreeClean } from "./worktree.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function invocationEnvironment(): Readonly<Record<string, string>> {
  return { ...pinnedGitEnvironment, PATH: tools.execPath };
}

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-worktree-"));
  directories.push(dir);
  const home = join(dir, "home");
  const keyDirectory = join(dir, "keys");
  const knownHosts = join(dir, "known_hosts");
  const runDirectory = join(dir, "run");
  for (const sub of [home, keyDirectory, runDirectory]) {
    mkdirSync(sub);
  }
  writeFileSync(knownHosts, "");
  return {
    git: tools.paths.git,
    ssh: tools.paths.ssh,
    sshKeyscan: tools.paths.sshKeyscan,
    home,
    keyDirectory,
    knownHosts,
    runDirectory,
  };
}

function workDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-workdir-"));
  directories.push(dir);
  return dir;
}

function gitIn(workDir: string, args: readonly string[]): string {
  return execFileSync(
    tools.paths.git,
    [...pinnedGitConfigArguments, "-C", workDir, ...args],
    {
      env: invocationEnvironment(),
      encoding: "utf8",
      timeout: toolTimeoutMilliseconds,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  ).trim();
}

function initWorkRepository(workDir: string): void {
  execFileSync(
    tools.paths.git,
    [
      ...pinnedGitConfigArguments,
      "init",
      "--quiet",
      "--template=",
      "--initial-branch=main",
      "--object-format=sha1",
      workDir,
    ],
    {
      env: invocationEnvironment(),
      encoding: "utf8",
      timeout: toolTimeoutMilliseconds,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(join(workDir, "README.md"), "kanthord worktree fixture\n");
  gitIn(workDir, ["add", "README.md"]);
  gitIn(workDir, ["commit", "-m", "fixture: initial"]);
}

describe("src/services/git/worktree.test", () => {
  it("a freshly initialised repository with one commit and no change is clean", async () => {
    const workDir = workDirectory();
    initWorkRepository(workDir);
    const runner = createGitRunner(makePaths());
    assert.equal(await worktreeClean(runner, { workDir }), true);
  });

  it("one modified tracked file makes the worktree dirty", async () => {
    const workDir = workDirectory();
    initWorkRepository(workDir);
    writeFileSync(
      join(workDir, "README.md"),
      "kanthord worktree fixture\nchanged\n",
    );
    const runner = createGitRunner(makePaths());
    assert.equal(await worktreeClean(runner, { workDir }), false);
  });

  it("one untracked file makes the worktree dirty", async () => {
    const workDir = workDirectory();
    initWorkRepository(workDir);
    writeFileSync(join(workDir, "new-file.txt"), "untracked\n");
    const runner = createGitRunner(makePaths());
    assert.equal(await worktreeClean(runner, { workDir }), false);
  });

  it("a directory that is not a repository throws GitError", async () => {
    const workDir = workDirectory();
    const runner = createGitRunner(makePaths());
    await assert.rejects(
      () => worktreeClean(runner, { workDir }),
      (error: unknown) => error instanceof GitError,
    );
  });
});
