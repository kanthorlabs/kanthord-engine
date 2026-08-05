import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import { createGitRunner } from "../../../src/services/git/run.ts";
import { fetchTracking } from "../../../src/services/git/fetch.ts";
import { resolveRef } from "../../../src/services/git/ref-read.ts";
import {
  canPush,
  remoteRefValue,
} from "../../../src/services/git/preflight.ts";
import { TRACKING_REFSPEC } from "../../../src/services/git/index.ts";
import {
  assertScratchRef,
  emptyTokenCredential,
  httpsUrl,
  listRemoteRefs,
  scratchRef,
  writerCredential,
  wrongCredential,
} from "../remote.ts";

function baseBranchRef(env: E2eEnv): string {
  return `refs/heads/${env.ghBaseBranch}`;
}

describe("scripts/e2e/007/07-registration-preflight.e2e", () => {
  it("E7-07 — the write-advertisement preflight against the real github.com", async (t) => {
    const env = loadE2eEnv();
    const tools = resolveTools();
    const root = mkdtempSync(join(tmpdir(), "kanthord-e2e-preflight-"));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
    });
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
    const stagingDir = join(root, "staging.git");

    const init = await runner({
      args: ["init", "--bare", "--template=", stagingDir],
    });
    assert.equal(init.code, 0, init.stderr);
    const addRemote = await runner({
      args: [
        "--git-dir=" + stagingDir,
        "remote",
        "add",
        "origin",
        httpsUrl(env),
      ],
    });
    assert.equal(addRemote.code, 0, addRemote.stderr);
    const fetchRefspec = await runner({
      args: [
        "--git-dir=" + stagingDir,
        "config",
        "remote.origin.fetch",
        TRACKING_REFSPEC,
      ],
    });
    assert.equal(fetchRefspec.code, 0, fetchRefspec.stderr);
    await fetchTracking(runner, paths, {
      gitDir: stagingDir,
      credential: writerCredential(env),
      pidFile: join(paths.runDirectory, "preflight-fetch.pid"),
    });

    const resolved = await resolveRef(runner, {
      gitDir: stagingDir,
      ref: `refs/remotes/origin/${env.ghBaseBranch}`,
    });
    assert.ok(resolved !== null, "the tracking ref resolves");
    const U = resolved;
    assert.equal(/^[0-9a-f]{40}$/.test(U), true, U);
    const localTags = await runner({
      args: [
        "--git-dir=" + stagingDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/tags",
      ],
    });
    assert.equal(localTags.code, 0, localTags.stderr);
    assert.equal(localTags.stdout.trim(), "", "the fetch left no local tag");
    assert.deepEqual(
      await listRemoteRefs(paths, env, "refs/tags/*"),
      {},
      "the remote advertises no tag",
    );

    const publishRef = scratchRef(env, "preflight");
    assertScratchRef(env, publishRef);
    const writer = writerCredential(env);
    const base = baseBranchRef(env);

    const baseBefore = await remoteRefValue(runner, paths, {
      remoteUrl: httpsUrl(env),
      ref: base,
      credential: writer,
    });
    assert.equal(baseBefore, U, "the base branch sits at the fetched oid");
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the scratch ref does not exist yet",
    );

    const allowed = await canPush(runner, paths, {
      gitDir: stagingDir,
      remoteUrl: httpsUrl(env),
      publishRef,
      proposedOid: U,
      credential: writer,
    });
    assert.deepEqual(allowed, { allowed: true });

    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the dry run wrote no scratch ref",
    );
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      U,
      "the base branch did not move",
    );
    const refs = await listRemoteRefs(
      paths,
      env,
      "refs/heads/kanthord-e2e/007/*",
    );
    assert.equal(
      Object.hasOwn(refs, publishRef),
      false,
      "no ref of this run exists",
    );

    const harmless = await canPush(runner, paths, {
      gitDir: stagingDir,
      remoteUrl: httpsUrl(env),
      publishRef: base,
      proposedOid: U,
      credential: writer,
    });
    assert.deepEqual(harmless, { allowed: true });
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      U,
      "the dry run against the base branch is harmless",
    );

    const wrong = wrongCredential(env);
    const wrongToken = wrong.transport === "http-basic" ? wrong.token : "";
    const refused = await canPush(runner, paths, {
      gitDir: stagingDir,
      remoteUrl: httpsUrl(env),
      publishRef,
      proposedOid: U,
      credential: wrong,
    });
    assert.equal(refused.allowed, false);
    if (refused.allowed === false) {
      assert.equal(refused.failure, "auth-failed");
      assert.equal(
        refused.detail.includes("Authentication failed"),
        true,
        refused.detail,
      );
      assert.equal(
        refused.detail.includes(env.ghToken),
        false,
        "the real token is absent from the detail",
      );
      assert.equal(
        refused.detail.includes(wrongToken),
        false,
        "the wrong token is absent from the detail",
      );
    }

    const empty = await canPush(runner, paths, {
      gitDir: stagingDir,
      remoteUrl: httpsUrl(env),
      publishRef,
      proposedOid: U,
      credential: emptyTokenCredential(env),
    });
    assert.equal(empty.allowed, false);
    if (empty.allowed === false) {
      assert.equal(empty.failure, "auth-failed");
    }

    const originalHome = process.env.HOME;
    try {
      process.env.HOME = homedir();
      const ambient = await canPush(runner, paths, {
        gitDir: stagingDir,
        remoteUrl: httpsUrl(env),
        publishRef,
        proposedOid: U,
        credential: wrong,
      });
      assert.equal(ambient.allowed, false);
      if (ambient.allowed === false) {
        assert.equal(ambient.failure, "auth-failed");
      }
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
