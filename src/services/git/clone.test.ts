import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  fixtureObjectIds,
  seedRepositories,
} from "../../../test/helpers/remote/seed.ts";
import type { SeedRoot } from "../../../test/helpers/remote/seed.ts";

import { GitError, type GitPaths } from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner, GitRunResult } from "./run.ts";
import { cloneObjective } from "./clone.ts";

const tools: Tools = resolveTools();
const c1 = "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca";
const c2 = "251c92d5a215053aea80432f179653f99072835d";

const directories: string[] = [];

let seeded: SeedRoot;

before(() => {
  seeded = seedRepositories(tools);
});

after(() => {
  seeded?.dispose();
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): { root: string; home: string; paths: GitPaths } {
  const root = mkdtempSync(join(tmpdir(), "kanthord-clone-"));
  directories.push(root);
  const home = join(root, "home");
  const keyDirectory = join(root, "keys");
  const knownHosts = join(root, "known_hosts");
  const runDirectory = join(root, "run");
  for (const sub of [home, keyDirectory, runDirectory]) {
    mkdirSync(sub);
  }
  writeFileSync(knownHosts, "");
  const fixturePath = seeded.repositories["fixture.git"]?.path;
  assert.ok(fixturePath, "fixture.git must be seeded");
  cpSync(fixturePath, home, { recursive: true });
  return {
    root,
    home,
    paths: {
      git: tools.paths.git,
      ssh: tools.paths.ssh,
      sshKeyscan: tools.paths.sshKeyscan,
      home,
      keyDirectory,
      knownHosts,
      runDirectory,
    },
  };
}

async function runGit(
  runner: GitRunner,
  paths: GitPaths,
  args: readonly string[],
): Promise<GitRunResult> {
  return runner({ args: ["--git-dir=" + paths.home, ...args] });
}

async function workspaceGit(
  runner: GitRunner,
  workspace: string,
  args: readonly string[],
): Promise<GitRunResult> {
  return runner({ args: ["-C", workspace, ...args] });
}

async function writeLandBranch(
  runner: GitRunner,
  paths: GitPaths,
): Promise<void> {
  const result = await runGit(runner, paths, [
    "update-ref",
    "refs/heads/land",
    c2,
    "",
  ]);
  assert.equal(result.code, 0, result.stderr);
}

function objectFiles(gitDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk(join(gitDir, "objects"));
  return files;
}

function stagingEntries(parent: string): string[] {
  if (!existsSync(parent)) {
    return [];
  }
  return readdirSync(parent).filter((name) => name.startsWith(".staging-"));
}

function answeringRemoteRunner(real: GitRunner): GitRunner {
  return async (request) => {
    if (request.args[request.args.length - 1] === "remote") {
      return { code: 0, stdout: "upstream\n", stderr: "", args: ["remote"] };
    }
    return real(request);
  };
}

describe("src/services/git/clone.test", () => {
  it("the pinned object ids match the fixture", () => {
    assert.equal(fixtureObjectIds.commit1, c1);
    assert.equal(fixtureObjectIds.commit2, c2);
  });

  it("the clone carries the landing branch and returns the published path", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    const published = await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    });
    assert.equal(published, targetDir);
    const head = await workspaceGit(runner, targetDir, ["rev-parse", "HEAD"]);
    assert.equal(head.code, 0, head.stderr);
    assert.equal(head.stdout.trim(), c2);
    const branch = await workspaceGit(runner, targetDir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    assert.equal(branch.code, 0, branch.stderr);
    assert.equal(branch.stdout.trim(), "land");
  });

  it("isolation by link count", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    });
    const workspaceObjects = objectFiles(join(targetDir, ".git"));
    assert.ok(workspaceObjects.length > 0);
    for (const file of workspaceObjects) {
      assert.equal(statSync(file).nlink, 1, file);
    }
    const homeObjects = objectFiles(home);
    for (const file of homeObjects) {
      assert.equal(statSync(file).nlink, 1, file);
    }
  });

  it("the link-count control proves hard links are possible here", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const other = join(root, "local-clone");
    try {
      const result = await runGit(runner, paths, [
        "clone",
        "--local",
        home,
        other,
      ]);
      assert.equal(result.code, 0, result.stderr);
      const objects = objectFiles(join(other, ".git"));
      const linked = objects.filter((file) => statSync(file).nlink === 2);
      assert.ok(
        linked.length > 0,
        "this filesystem does not hard-link; the isolation control cannot run here",
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("no remote", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    });
    const remote = await workspaceGit(runner, targetDir, ["remote"]);
    assert.equal(remote.code, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), "");
    const originUrl = await workspaceGit(runner, targetDir, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    assert.notEqual(originUrl.code, 0);
  });

  it("no alternates and no promisor", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    });
    assert.equal(
      existsSync(join(targetDir, ".git", "objects", "info", "alternates")),
      false,
    );
    const promisor = await workspaceGit(runner, targetDir, [
      "config",
      "--get-regexp",
      "^remote\\..*\\.promisor$",
    ]);
    assert.notEqual(promisor.code, 0);
  });

  it("a hostile source path clones successfully", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const dashSource = join(root, "-dash.git");
    cpSync(home, dashSource, { recursive: true });
    const targetDir = join(root, "workspace");
    await cloneObjective(runner, {
      sourceGitDir: dashSource,
      targetDir,
      ref: "land",
    });
    const head = await workspaceGit(runner, targetDir, ["rev-parse", "HEAD"]);
    assert.equal(head.code, 0, head.stderr);
    assert.equal(head.stdout.trim(), c2);
  });

  it("an existing target refuses and leaves it unchanged", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "occupied");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "marker.txt"), "keep me");
    const rejection = await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.ok(rejection.message.endsWith(" already exists"), rejection.message);
    assert.equal(
      readFileSync(join(targetDir, "marker.txt"), "utf8"),
      "keep me",
    );
  });

  it("a failure leaves no visible workspace", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    const rejection = await cloneObjective(runner, {
      sourceGitDir: home,
      targetDir,
      ref: "missing",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(stagingEntries(root), []);
  });

  it("an injected assertion failure removes the staging directory", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    const answeringRunner = answeringRemoteRunner(runner);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    const rejection = await cloneObjective(answeringRunner, {
      sourceGitDir: home,
      targetDir,
      ref: "land",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.message, "the clone still carries a remote");
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(stagingEntries(root), []);
  });

  it("the detail carries no userinfo", async () => {
    const { root, home, paths } = makeHome();
    const runner = createGitRunner(paths);
    await writeLandBranch(runner, paths);
    const targetDir = join(root, "workspace");
    const rejection = await cloneObjective(runner, {
      sourceGitDir: "http://user@127.0.0.1:1/fixture.git",
      targetDir,
      ref: "land",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.ok(!rejection.detail.includes("user@"), rejection.detail);
    assert.ok(rejection.detail.includes("127.0.0.1"), rejection.detail);
  });
});
