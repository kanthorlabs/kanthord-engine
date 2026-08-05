import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import { createGitRunner } from "../../../src/services/git/run.ts";
import { seedHome } from "../../../src/services/git/seed.ts";
import { remoteRefValue } from "../../../src/services/git/preflight.ts";
import {
  assertScratchRef,
  deleteScratchRefs,
  httpsUrl,
  scratchRef,
  writerCredential,
  wrongCredential,
} from "../remote.ts";

function baseBranchRef(env: E2eEnv): string {
  return `refs/heads/${env.ghBaseBranch}`;
}

describe("scripts/e2e/007/09-bare-home-seeding.e2e", () => {
  it("E7-09 — bare home seeding against the real github.com", async (t) => {
    const env = loadE2eEnv();
    const tools = resolveTools();
    const root = mkdtempSync(join(tmpdir(), "kanthord-e2e-seed-"));
    const paths = buildGitPaths({
      probed: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
        gitVersion: tools.gitVersion,
        sshVersion: tools.sshVersion,
      },
      home: root,
    });
    const runner = createGitRunner(paths);
    const gitDir = join(root, "home.git");
    t.after(async () => {
      await deleteScratchRefs(paths, env);
      rmSync(paths.home, { recursive: true, force: true });
      rmSync(gitDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });

    const publishRef = scratchRef(env, "seed");
    assertScratchRef(env, publishRef);
    const writer = writerCredential(env);
    const base = baseBranchRef(env);

    const baseBefore = await remoteRefValue(runner, paths, {
      remoteUrl: httpsUrl(env),
      ref: base,
      credential: writer,
    });
    assert.ok(baseBefore !== null, "the base branch resolves");
    assert.equal(/^[0-9a-f]{40}$/.test(baseBefore), true, baseBefore);

    const result = await seedHome(runner, paths, {
      gitDir,
      remoteUrl: httpsUrl(env),
      upstreamBranch: env.ghBaseBranch,
      landingBranch: env.ghBaseBranch,
      publishRef,
      hostKey: null,
      credential: writer,
      pidFile: join(paths.runDirectory, "seed.pid"),
    });
    assert.equal(result.homePath, gitDir);
    assert.equal(result.fetchedUpstreamOid, baseBefore);
    assert.equal(result.landingOid, baseBefore);
    assert.equal(/^[0-9a-f]{40}$/.test(result.fetchedUpstreamOid), true);

    const heads = await runner({
      args: [
        "--git-dir=" + gitDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
      ],
    });
    assert.equal(heads.code, 0, heads.stderr);
    assert.deepEqual(
      heads.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== ""),
      [base],
    );
    const headOid = await runner({
      args: ["--git-dir=" + gitDir, "rev-parse", "--verify", base],
    });
    assert.equal(headOid.code, 0, headOid.stderr);
    assert.equal(headOid.stdout.trim(), baseBefore);

    const tracking = await runner({
      args: [
        "--git-dir=" + gitDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin",
      ],
    });
    assert.equal(tracking.code, 0, tracking.stderr);
    const trackingRefs = tracking.stdout
      .trim()
      .split("\n")
      .filter((line) => line !== "");
    assert.ok(trackingRefs.length > 1, trackingRefs.join(","));
    for (const ref of trackingRefs) {
      assert.ok(ref.startsWith("refs/remotes/origin/"), ref);
    }

    const tags = await runner({
      args: [
        "--git-dir=" + gitDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/tags",
      ],
    });
    assert.equal(tags.code, 0, tags.stderr);
    assert.equal(tags.stdout.trim(), "");

    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the scratch publish ref is absent after the seed",
    );
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      baseBefore,
      "the base branch did not move",
    );

    const missingGitDir = join(root, "missing.git");
    const missingRejection = await seedHome(runner, paths, {
      gitDir: missingGitDir,
      remoteUrl: httpsUrl(env),
      upstreamBranch: "kanthord-e2e-does-not-exist",
      landingBranch: env.ghBaseBranch,
      publishRef,
      hostKey: null,
      credential: writer,
      pidFile: join(paths.runDirectory, "missing.pid"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(missingRejection instanceof Error, String(missingRejection));
    assert.equal(existsSync(missingGitDir), false);

    const wrongGitDir = join(root, "wrong.git");
    const wrongRejection = await seedHome(runner, paths, {
      gitDir: wrongGitDir,
      remoteUrl: httpsUrl(env),
      upstreamBranch: env.ghBaseBranch,
      landingBranch: env.ghBaseBranch,
      publishRef,
      hostKey: null,
      credential: wrongCredential(env),
      pidFile: join(paths.runDirectory, "wrong.pid"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(wrongRejection instanceof Error, String(wrongRejection));
    assert.equal(existsSync(wrongGitDir), false);
  });
});
