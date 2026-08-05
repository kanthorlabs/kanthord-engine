import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  E2E_REQUIRED_KEYS,
  E2eEnvError,
  loadE2eEnv,
  parseDotEnv,
  type E2eEnv,
} from "../env.ts";
import {
  E2eSafetyError,
  assertScratchRef,
  deleteScratchRefs,
  httpsUrl,
  listRemoteRefs,
  pushScratchRef,
  scratchRef,
  wrongCredential,
} from "../remote.ts";
import { GitError, type GitPaths } from "../../../src/services/git/index.ts";
import { buildGitPaths, probeTools } from "../../../src/services/git/probe.ts";

async function e2ePaths(): Promise<{ paths: GitPaths; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "kanthord-e2e-home-"));
  const probed = await probeTools({
    tools: {
      git: "/usr/bin/git",
      ssh: "/usr/bin/ssh",
      sshKeyscan: "/usr/bin/ssh-keyscan",
    },
    runDirectory: join(homeDir, "git", "run"),
  });
  return { paths: buildGitPaths({ probed, home: homeDir }), homeDir };
}

describe("scripts/e2e/007/00-harness.e2e", () => {
  describe("env.ts", () => {
    it("parseDotEnv splits on the first = and keeps empty values", () => {
      assert.deepEqual(parseDotEnv("# c\nA=1\n\nB=x=y\nnoequals\nC=\n"), {
        A: "1",
        B: "x=y",
        C: "",
      });
    });

    it("parseDotEnv does not strip quotes", () => {
      assert.deepEqual(parseDotEnv("K='quoted'\n"), { K: "'quoted'" });
    });

    it("loadE2eEnv refuses an absent file and names the required keys", () => {
      const absent = join(tmpdir(), `kanthord-e2e-absent-${process.pid}.env`);
      assert.throws(
        () => loadE2eEnv({ file: absent }),
        (error: unknown) => {
          assert.ok(error instanceof E2eEnvError, `not an E2eEnvError`);
          assert.deepEqual(error.missing, E2E_REQUIRED_KEYS);
          return true;
        },
      );
    });

    it("loadE2eEnv reports exactly the missing keys in order", async () => {
      const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-env-"));
      try {
        const file = join(dir, ".env.e2e");
        await writeFile(file, "E2E_GH_TOKEN=x\n");
        assert.throws(
          () => loadE2eEnv({ file }),
          (error: unknown) => {
            assert.ok(error instanceof E2eEnvError, `not an E2eEnvError`);
            assert.deepEqual(error.missing, [
              "E2E_GH_REPO",
              "E2E_GH_BASE_BRANCH",
            ]);
            assert.ok(error.message.includes("E2E_GH_REPO"));
            assert.ok(error.message.includes("E2E_GH_BASE_BRANCH"));
            return true;
          },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("loadE2eEnv treats an empty value as missing", async () => {
      const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-env-"));
      try {
        const file = join(dir, ".env.e2e");
        await writeFile(
          file,
          "E2E_GH_TOKEN=x\nE2E_GH_REPO=\nE2E_GH_BASE_BRANCH=main\n",
        );
        assert.throws(
          () => loadE2eEnv({ file }),
          (error: unknown) => {
            assert.ok(error instanceof E2eEnvError, `not an E2eEnvError`);
            assert.ok(error.missing.includes("E2E_GH_REPO"));
            return true;
          },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("remote.ts", () => {
    const baseEnv: E2eEnv = {
      ghToken: "github_pat_AAA",
      ghRepo: "kanthorlabs/kanthord-verify",
      ghBaseBranch: "main",
      runId: "01J0TESTRUN",
    };

    it("assertScratchRef refuses refs outside the scratch prefix", () => {
      assert.throws(
        () => assertScratchRef(baseEnv, "refs/heads/main"),
        E2eSafetyError,
      );
      assert.throws(
        () => assertScratchRef(baseEnv, "refs/heads/kanthord-e2e/other"),
        E2eSafetyError,
      );
      assert.equal(
        assertScratchRef(baseEnv, scratchRef(baseEnv, "probe")),
        undefined,
      );
    });

    it("the base-branch guard is not shadowed by the prefix check", () => {
      const env = { ...baseEnv, ghBaseBranch: "kanthord-e2e/007/x" };
      assert.throws(
        () => assertScratchRef(env, "refs/heads/kanthord-e2e/007/x"),
        E2eSafetyError,
      );
    });

    it("httpsUrl carries no userinfo and no token", () => {
      const url = httpsUrl(baseEnv);
      assert.ok(!url.includes("@"), `url contains @`);
      assert.ok(!url.includes(baseEnv.ghToken), `url contains the token`);
      assert.equal(url, `https://github.com/${baseEnv.ghRepo}.git`);
    });

    it("scratchRef ends with the run id and is stable within a process", () => {
      const ref = scratchRef(baseEnv, "seed");
      assert.ok(
        ref.endsWith(`-${baseEnv.runId}`),
        `ref does not end with the run id`,
      );
      assert.equal(ref, scratchRef(baseEnv, "seed"));
    });
  });

  describe("E7-00a — the real remote answers", () => {
    it("the token reads the named repository and a wrong credential is auth-failed", async (t) => {
      const { paths, homeDir } = await e2ePaths();
      t.after(() => rm(homeDir, { recursive: true, force: true }));

      const env = loadE2eEnv();
      assert.ok(env.ghToken.length > 0);
      assert.ok(env.ghRepo.length > 0);
      assert.ok(env.ghBaseBranch.length > 0);

      const refs = await listRemoteRefs(paths, env, "refs/heads/*");
      const baseRef = `refs/heads/${env.ghBaseBranch}`;
      const baseOid = refs[baseRef];
      assert.ok(baseOid !== undefined, `no ref ${baseRef}`);
      assert.match(baseOid, /^[0-9a-f]{40}$/);

      await assert.rejects(
        listRemoteRefs(paths, env, "refs/heads/*", wrongCredential(env)),
        (error: unknown) => {
          assert.ok(error instanceof GitError, `not a GitError`);
          assert.equal(error.failure, "auth-failed");
          return true;
        },
      );
    });
  });

  describe("E7-00b — the cleanup is real", () => {
    it("pushes a scratch ref, deletes it, and refuses the base branch", async (t) => {
      let env: E2eEnv | undefined;
      let paths: GitPaths | undefined;
      const { paths: seededPaths, homeDir } = await e2ePaths();
      paths = seededPaths;
      t.after(async () => {
        if (paths !== undefined && env !== undefined) {
          await deleteScratchRefs(paths, env);
        }
        await rm(homeDir, { recursive: true, force: true });
      });

      env = loadE2eEnv();
      const baseRef = `refs/heads/${env.ghBaseBranch}`;
      const baseRefs = await listRemoteRefs(paths, env, baseRef);
      const baseOid = baseRefs[baseRef];
      assert.ok(baseOid !== undefined, `no ref ${baseRef}`);
      assert.match(baseOid, /^[0-9a-f]{40}$/);

      const scratch = scratchRef(env, "harness");
      await pushScratchRef(paths, env, { ref: scratch, oid: baseOid });
      const afterPush = await listRemoteRefs(paths, env, scratch);
      assert.equal(afterPush[scratch], baseOid);

      await assert.rejects(
        pushScratchRef(paths, env, { ref: baseRef, oid: baseOid }),
        E2eSafetyError,
      );
      const afterRefusal = await listRemoteRefs(paths, env, baseRef);
      assert.equal(afterRefusal[baseRef], baseOid);

      const deleted = await deleteScratchRefs(paths, env);
      assert.ok(deleted.includes(scratch), `deleted list misses ${scratch}`);
      const remaining = await listRemoteRefs(
        paths,
        env,
        "refs/heads/kanthord-e2e/007/*",
      );
      const runRefs = Object.keys(remaining).filter((ref) =>
        ref.endsWith(`-${env!.runId}`),
      );
      assert.deepEqual(runRefs, []);
    });
  });
});
