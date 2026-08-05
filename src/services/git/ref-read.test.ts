import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { GitRunner } from "./run.ts";
import { resolveRef } from "./ref-read.ts";

const tools: Tools = resolveTools();
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

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-refread-"));
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

describe("src/services/git/ref-read.test", () => {
  it("resolveRef returns the fixture main oid as the documented literal", async () => {
    assert.equal(fixtureObjectIds.commit2, c2);
    const fixturePath = seeded.repositories["fixture.git"]?.path;
    assert.ok(fixturePath, "fixture.git must be seeded");
    const runner = createGitRunner(makePaths());
    assert.equal(
      await resolveRef(runner, {
        gitDir: fixturePath,
        ref: "refs/heads/main",
      }),
      c2,
    );
  });

  it("resolveRef returns null for an absent ref", async () => {
    const fixturePath = seeded.repositories["fixture.git"]?.path;
    assert.ok(fixturePath, "fixture.git must be seeded");
    const runner = createGitRunner(makePaths());
    assert.equal(
      await resolveRef(runner, {
        gitDir: fixturePath,
        ref: "refs/heads/absent",
      }),
      null,
    );
  });

  it("resolveRef survives pack-refs", async () => {
    const fixturePath = seeded.repositories["fixture.git"]?.path;
    assert.ok(fixturePath, "fixture.git must be seeded");
    const runner = createGitRunner(makePaths());
    const packed = await runner({
      args: ["--git-dir=" + fixturePath, "pack-refs", "--all"],
    });
    assert.equal(packed.code, 0, packed.stderr);
    assert.equal(
      await resolveRef(runner, {
        gitDir: fixturePath,
        ref: "refs/heads/main",
      }),
      c2,
    );
  });

  it("resolveRef on a non-repository returns null rather than throwing", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "kanthord-notarepo-"));
    directories.push(notARepository);
    const runner = createGitRunner(makePaths());
    assert.equal(
      await resolveRef(runner, {
        gitDir: notARepository,
        ref: "refs/heads/main",
      }),
      null,
    );
  });

  it("resolveRef returns null for a malformed ref name", async () => {
    const fixturePath = seeded.repositories["fixture.git"]?.path;
    assert.ok(fixturePath, "fixture.git must be seeded");
    const runner = createGitRunner(makePaths());
    assert.equal(
      await resolveRef(runner, {
        gitDir: fixturePath,
        ref: "HEAD~1x",
      }),
      null,
    );
  });

  it("resolveRef rejects a non-oid stdout with failure unknown", async () => {
    const stub: GitRunner = async () => ({
      code: 0,
      stdout: "refs/heads/main\n",
      stderr: "",
      args: [],
    });
    await assert.rejects(
      resolveRef(stub, { gitDir: "/stub", ref: "refs/heads/main" }),
      (error: unknown) =>
        error instanceof GitError &&
        error.failure === "unknown" &&
        error.message ===
          "rev-parse returned an unexpected value for refs/heads/main",
    );
  });
});
