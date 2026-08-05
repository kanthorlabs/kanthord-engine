import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import {
  killAll,
  launchDaemon,
  type DaemonProcess,
} from "../../../test/helpers/daemon.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { SystemClock } from "../../../src/services/clock/system.ts";
import { SqliteStorage } from "../../../src/services/storage/sqlite.ts";
import { migrations } from "../../../src/services/storage/migrations.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import { createGitRunner } from "../../../src/services/git/run.ts";
import { remoteRefValue } from "../../../src/services/git/preflight.ts";
import { fingerprintOf } from "../../../src/services/git/host-key.ts";
import type { GitCredential } from "../../../src/services/git/index.ts";
import {
  assertScratchRef,
  deleteScratchRefs,
  httpsUrl,
  listRemoteRefs,
  scratchRef,
  writerCredential,
  wrongCredential,
} from "../remote.ts";

async function request(
  url: string,
  init?: Readonly<{
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  const text = await response.text();
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  return { status: response.status, body };
}

function baseBranchRef(env: E2eEnv): string {
  return `refs/heads/${env.ghBaseBranch}`;
}

describe("scripts/e2e/007/10-repository-register.e2e", () => {
  it("E7-10 — repository.register against the real github.com", async (t) => {
    const env: E2eEnv = loadE2eEnv();
    const tools = resolveTools();
    const home = createTemporaryHome();
    const keyDirectory = mkdtempSync(
      join(tmpdir(), "kanthord-e2e-register-keys-"),
    );
    const paths = buildGitPaths({
      probed: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
        gitVersion: tools.gitVersion,
        sshVersion: tools.sshVersion,
      },
      home: home.path,
    });
    let daemon: DaemonProcess | undefined;
    t.after(async () => {
      if (daemon !== undefined) {
        daemon.kill();
        await daemon.exited();
      }
      await deleteScratchRefs(paths, env);
      rmSync(keyDirectory, { recursive: true, force: true });
      home.dispose();
      await killAll();
    });

    const configPath = home.writeConfig({
      tools: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
      },
    });
    const migrated = new SqliteStorage({
      path: join(home.path, "kanthord.db"),
      clock: new SystemClock(),
      migrations,
    });
    migrated.migrate();
    migrated.close();

    daemon = launchDaemon({ configPath, home: home.path });
    await daemon.ready();

    const baseUrl = "http://127.0.0.1:7421";
    const auth = { Authorization: "Bearer test-token" };
    const json = { ...auth, "Content-Type": "application/json" };

    const registerCredential = async (
      name: string,
      payload: unknown,
    ): Promise<string> => {
      const response = await request(`${baseUrl}/v1/provider`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name, kind: "git", payload }),
      });
      assert.equal(response.status, 200, `credential ${name} registers`);
      return (response.body as { id: string }).id;
    };

    const writerId = await registerCredential("e2e-register-writer", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token: env.ghToken,
    });

    const inspected = await request(`${baseUrl}/v1/repository/inspect`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
      }),
    });
    assert.equal(inspected.status, 200, "the inspect answers 200");
    const defaultBranch = (inspected.body as { defaultBranch: string })
      .defaultBranch;
    assert.equal(defaultBranch, env.ghBaseBranch);

    const runner = createGitRunner(paths);
    const base = baseBranchRef(env);
    const writer = writerCredential(env);
    const baseOid = await remoteRefValue(runner, paths, {
      remoteUrl: httpsUrl(env),
      ref: base,
      credential: writer,
    });
    assert.ok(baseOid !== null, "the base branch resolves");
    assert.equal(/^[0-9a-f]{40}$/.test(baseOid), true, baseOid);

    const publishRef = scratchRef(env, "register");
    assertScratchRef(env, publishRef);
    const runSuffix = env.runId.toLowerCase();
    const repoName = `kanthord-verify-${runSuffix}`;

    const registered = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: repoName,
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef,
        publishOnApproval: true,
      }),
    });
    assert.equal(
      registered.status,
      200,
      `the register answers 200: ${JSON.stringify(registered.body)}`,
    );
    const registeredBody = registered.body as {
      id: string;
      state: string;
      fetchedUpstreamOid: string;
    };
    assert.equal(registeredBody.state, "ready");
    assert.equal(
      /^[0-9a-f]{40}$/.test(registeredBody.fetchedUpstreamOid),
      true,
      registeredBody.fetchedUpstreamOid,
    );
    assert.equal(registeredBody.fetchedUpstreamOid, baseOid);
    const repositoryId = registeredBody.id;

    execFileSync(
      tools.paths.sshKeygen,
      ["-t", "ed25519", "-N", "", "-f", join(keyDirectory, "client")],
      { env: {}, encoding: "utf8" },
    );
    execFileSync(
      tools.paths.sshKeygen,
      ["-t", "ed25519", "-N", "", "-f", join(keyDirectory, "other")],
      { env: {}, encoding: "utf8" },
    );
    const clientKey = readFileSync(join(keyDirectory, "client"), "utf8");
    const otherTokens = readFileSync(
      `${join(keyDirectory, "other")}.pub`,
      "utf8",
    )
      .trim()
      .split(/\s+/);
    const otherPublicKey = otherTokens[1];
    assert.ok(otherPublicKey, "the other public key is readable");
    const otherFingerprint = fingerprintOf(otherPublicKey);

    const sshId = await registerCredential("e2e-register-ssh", {
      transport: "ssh",
      privateKey: clientKey,
    });
    const sshUrl = `ssh://git@github.com/${env.ghRepo}.git`;

    const mismatch = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: `kanthord-mismatch-${runSuffix}`,
        remoteUrl: sshUrl,
        credentialId: sshId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef: scratchRef(env, "mismatch"),
        publishOnApproval: true,
        hostFingerprint: otherFingerprint,
      }),
    });
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
    const mismatchError = mismatch.body as {
      error: {
        code: string;
        details: { presented: string[]; confirmed: string };
      };
    };
    assert.equal(mismatchError.error.code, "host-key-mismatch");
    assert.equal(Array.isArray(mismatchError.error.details.presented), true);
    for (const fingerprint of mismatchError.error.details.presented) {
      assert.equal(
        /^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint),
        true,
        fingerprint,
      );
    }
    assert.equal(mismatchError.error.details.confirmed, otherFingerprint);

    const missingFingerprint = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: `kanthord-no-fingerprint-${runSuffix}`,
        remoteUrl: sshUrl,
        credentialId: sshId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef: scratchRef(env, "no-fingerprint"),
        publishOnApproval: true,
      }),
    });
    assert.equal(
      missingFingerprint.status,
      400,
      JSON.stringify(missingFingerprint.body),
    );
    assert.equal(
      (missingFingerprint.body as { error: { details: { refusal: string } } })
        .error.details.refusal,
      "host-fingerprint-required",
    );

    const forbiddenFingerprint = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: `kanthord-forbidden-${runSuffix}`,
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef: scratchRef(env, "forbidden"),
        publishOnApproval: true,
        hostFingerprint: otherFingerprint,
      }),
    });
    assert.equal(
      forbiddenFingerprint.status,
      400,
      JSON.stringify(forbiddenFingerprint.body),
    );
    assert.equal(
      (forbiddenFingerprint.body as { error: { details: { refusal: string } } })
        .error.details.refusal,
      "host-fingerprint-forbidden",
    );

    for (const field of ["upstreamBranch", "landingBranch", "publishRef"]) {
      const body: Record<string, unknown> = {
        name: `kanthord-missing-${field}-${runSuffix}`,
        remoteUrl: httpsUrl(env),
        credentialId: writerId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef: scratchRef(env, `missing-${field}`),
        publishOnApproval: true,
      };
      delete body[field];
      const missing = await request(`${baseUrl}/v1/repository`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
      assert.equal(
        missing.status,
        400,
        `missing ${field}: ${JSON.stringify(missing.body)}`,
      );
      assert.equal(
        (missing.body as { error: { code: string } }).error.code,
        "invalid-request",
      );
    }

    const wrongId = await registerCredential("e2e-register-wrong", {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
      token: (
        wrongCredential(env) as Extract<
          GitCredential,
          { transport: "http-basic" }
        >
      ).token,
    });
    const rejected = await request(`${baseUrl}/v1/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: `kanthord-wrong-${runSuffix}`,
        remoteUrl: httpsUrl(env),
        credentialId: wrongId,
        upstreamBranch: defaultBranch,
        landingBranch: defaultBranch,
        publishRef: scratchRef(env, "wrong"),
        publishOnApproval: true,
      }),
    });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(
      (rejected.body as { error: { code: string } }).error.code,
      "credential-rejected",
    );

    daemon.kill();
    await daemon.exited();
    daemon = undefined;

    const db = new DatabaseSync(join(home.path, "kanthord.db"));
    const repositoryCount = (
      db.prepare("SELECT COUNT(*) AS c FROM repository").get() as { c: number }
    ).c;
    assert.equal(
      repositoryCount,
      1,
      "only the successful registration wrote a row",
    );
    const authFailedOperations = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM git_operation WHERE outcome = 'auth-failed'",
        )
        .get() as { c: number }
    ).c;
    assert.equal(
      authFailedOperations,
      0,
      "the journal carries no refused registration",
    );
    const rejectedEvent = db
      .prepare(
        "SELECT COUNT(*) AS c FROM event WHERE type = 'repository.register.credentialRejected' AND subject_id = ?",
      )
      .get(wrongId) as { c: number };
    assert.equal(
      rejectedEvent.c,
      1,
      "exactly one credentialRejected event names the wrong-token credential",
    );
    db.close();

    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the scratch publish ref is absent after the registration",
    );
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      baseOid,
      "the base branch did not move",
    );
    const refs = await listRemoteRefs(
      paths,
      env,
      "refs/heads/kanthord-e2e/007/*",
    );
    const runRefs = Object.keys(refs).filter((ref) =>
      ref.endsWith(`-${env.runId}`),
    );
    assert.deepEqual(runRefs, [], "the scenario created no remote ref");

    const homePath = join(home.path, "repos", `${repoName}.git`);
    const heads = await runner({
      args: [
        `--git-dir=${homePath}`,
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
      "the seeded home holds exactly one landing branch",
    );
    const tags = await runner({
      args: [
        `--git-dir=${homePath}`,
        "for-each-ref",
        "--format=%(refname)",
        "refs/tags",
      ],
    });
    assert.equal(tags.code, 0, tags.stderr);
    assert.equal(tags.stdout.trim(), "", "the seeded home holds no tag");
  });
});
