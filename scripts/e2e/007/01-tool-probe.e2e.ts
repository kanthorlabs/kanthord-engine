import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadE2eEnv } from "../env.ts";
import {
  MINIMUM_GIT_VERSION,
  buildGitPaths,
  compareVersions,
  probeTools,
} from "../../../src/services/git/probe.ts";

describe("scripts/e2e/007/01-tool-probe.e2e", () => {
  it("E7-01 — the real tools resolve and satisfy the version floor", async (t) => {
    const env = loadE2eEnv();
    assert.equal(env.runId, process.env.E2E_RUN_ID);

    const homeDir = await mkdtemp(join(tmpdir(), "kanthord-e2e-tools-"));
    t.after(() => rm(homeDir, { recursive: true, force: true }));

    const probed = await probeTools({
      tools: {
        git: "/usr/bin/git",
        ssh: "/usr/bin/ssh",
        sshKeyscan: "/usr/bin/ssh-keyscan",
      },
      runDirectory: join(homeDir, "git", "run"),
    });

    assert.ok(
      compareVersions(probed.gitVersion, MINIMUM_GIT_VERSION) >= 0,
      `git ${probed.gitVersion} is below the floor ${MINIMUM_GIT_VERSION}`,
    );
    assert.ok(probed.sshVersion.length > 0);

    const paths = buildGitPaths({ probed, home: homeDir });
    assert.equal(paths.git, "/usr/bin/git");
    assert.equal(paths.ssh, "/usr/bin/ssh");
    assert.equal(paths.sshKeyscan, "/usr/bin/ssh-keyscan");
    for (const path of [
      paths.git,
      paths.ssh,
      paths.sshKeyscan,
      paths.home,
      paths.keyDirectory,
      paths.knownHosts,
      paths.runDirectory,
    ]) {
      assert.ok(path.startsWith("/"), `${path} is not absolute`);
    }
  });
});
