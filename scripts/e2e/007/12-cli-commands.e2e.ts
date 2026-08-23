import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import {
  assertScratchRef,
  deleteScratchRefs,
  httpsUrl,
  listRemoteRefs,
  scratchRef,
  writerCredential,
} from "../remote.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import {
  killAll,
  launchDaemon,
  type DaemonProcess,
} from "../../../test/helpers/daemon.ts";
import { runCli } from "../../../test/helpers/cli.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { SystemClock } from "../../../src/services/clock/system.ts";
import { SqliteStorage } from "../../../src/services/storage/sqlite.ts";
import { migrations } from "../../../src/services/storage/migrations.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import { createGitRunner } from "../../../src/services/git/run.ts";
import { remoteRefValue } from "../../../src/services/git/preflight.ts";

function baseBranchRef(env: E2eEnv): string {
  return `refs/heads/${env.ghBaseBranch}`;
}

describe("scripts/e2e/007/12-cli-commands.e2e", () => {
  it("E7-12 — the CLI commands against the real github.com", async (t) => {
    const env: E2eEnv = loadE2eEnv();
    const tools = resolveTools();
    const home = createTemporaryHome();
    const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-e2e-cli-keys-"));
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
    const clientArgs = ["--base-url", baseUrl, "--token", "test-token"];

    const runSuffix = env.runId.toLowerCase();
    const credentialName = `gh-${runSuffix}`;

    const tokenFile = join(keyDirectory, "token");
    writeFileSync(tokenFile, env.ghToken);
    chmodSync(tokenFile, 0o600);

    const credentialRegistered = await runCli({
      args: [
        ...clientArgs,
        "credential",
        "register",
        "--name",
        credentialName,
        "--kind",
        "git",
        "--transport",
        "http-basic",
        "--forge",
        "github",
        "--username",
        "x-access-token",
        "--input-token-file",
        tokenFile,
      ],
    });
    assert.equal(credentialRegistered.code, 0, credentialRegistered.stderr);
    const credentialLine = credentialRegistered.stdout
      .split("\n")
      .find((line) => line.startsWith("kanthord: registered "));
    assert.ok(credentialLine, credentialRegistered.stdout);
    assert.equal(
      /^kanthord: registered gh-[a-z0-9]+ provider_[A-Z0-9]{26}$/.test(
        credentialLine,
      ),
      true,
      credentialLine,
    );
    assert.equal(
      credentialRegistered.stdout.includes(env.ghToken),
      false,
      credentialRegistered.stdout,
    );
    assert.equal(
      credentialRegistered.stderr.includes(env.ghToken),
      false,
      credentialRegistered.stderr,
    );

    const runner = createGitRunner(paths);
    const writer = writerCredential(env);
    const base = baseBranchRef(env);
    const baseOid = await remoteRefValue(runner, paths, {
      remoteUrl: httpsUrl(env),
      ref: base,
      credential: writer,
    });
    assert.ok(baseOid !== null, "the base branch resolves");
    assert.equal(/^[0-9a-f]{40}$/.test(baseOid), true, baseOid);

    const publishRef = scratchRef(env, "cli");
    assertScratchRef(env, publishRef);
    const repoName = `r-${runSuffix}`;

    const repoRegistered = await runCli({
      args: [
        ...clientArgs,
        "repository",
        "register",
        "--name",
        repoName,
        "--url",
        httpsUrl(env),
        "--credential",
        credentialName,
        "--branch",
        env.ghBaseBranch,
      ],
    });
    assert.equal(repoRegistered.code, 0, repoRegistered.stderr);
    const landingLine = `kanthord: landing refs/heads/${env.ghBaseBranch} ${baseOid}`;
    assert.ok(
      repoRegistered.stdout.includes(landingLine),
      repoRegistered.stdout,
    );
    const registeredLine = repoRegistered.stdout
      .split("\n")
      .find((line) => line.startsWith("kanthord: registered "));
    assert.ok(registeredLine, repoRegistered.stdout);
    const repositoryId = registeredLine.split(" ")[3];
    assert.ok(
      repositoryId !== undefined && /^repo_[A-Z0-9]{26}$/.test(repositoryId),
      registeredLine,
    );

    const noBranch = await runCli({
      args: [
        ...clientArgs,
        "repository",
        "register",
        "--name",
        `r2-${runSuffix}`,
        "--url",
        httpsUrl(env),
        "--credential",
        credentialName,
      ],
    });
    assert.equal(noBranch.code, 1, noBranch.stdout);
    assert.equal(noBranch.stdout, "");
    assert.ok(
      noBranch.stderr.startsWith("kanthord: confirmation-required:"),
      noBranch.stderr,
    );
    assert.ok(noBranch.stderr.includes("--branch"), noBranch.stderr);

    execFileSync(
      tools.paths.sshKeygen,
      ["-t", "ed25519", "-N", "", "-f", join(keyDirectory, "client")],
      { env: {}, encoding: "utf8" },
    );
    const privateKey = readFileSync(join(keyDirectory, "client"), "utf8");
    const privateKeyFile = join(keyDirectory, "client-key");
    writeFileSync(privateKeyFile, privateKey);
    chmodSync(privateKeyFile, 0o600);
    const sshCredentialName = `ssh-${runSuffix}`;
    const sshRegistered = await runCli({
      args: [
        ...clientArgs,
        "credential",
        "register",
        "--name",
        sshCredentialName,
        "--kind",
        "git",
        "--transport",
        "ssh",
        "--private-key-file",
        privateKeyFile,
      ],
    });
    assert.equal(sshRegistered.code, 0, sshRegistered.stderr);
    assert.equal(
      sshRegistered.stdout.includes(privateKey),
      false,
      sshRegistered.stdout,
    );

    const sshUrl = `ssh://git@github.com/${env.ghRepo}.git`;
    const noFingerprint = await runCli({
      args: [
        ...clientArgs,
        "repository",
        "register",
        "--name",
        `rs-${runSuffix}`,
        "--url",
        sshUrl,
        "--credential",
        sshCredentialName,
        "--branch",
        env.ghBaseBranch,
      ],
    });
    assert.equal(noFingerprint.code, 1, noFingerprint.stdout);
    assert.ok(
      noFingerprint.stderr.includes("--host-fingerprint"),
      noFingerprint.stderr,
    );

    const unknownCredential = await runCli({
      args: [
        ...clientArgs,
        "repository",
        "register",
        "--name",
        `rx-${runSuffix}`,
        "--url",
        httpsUrl(env),
        "--credential",
        "does-not-exist",
        "--branch",
        env.ghBaseBranch,
      ],
    });
    assert.equal(unknownCredential.code, 1, unknownCredential.stdout);
    assert.ok(
      unknownCredential.stderr.startsWith("kanthord: not-found:"),
      unknownCredential.stderr,
    );

    const shown = await runCli({
      args: [...clientArgs, "repository", "show", "--id", repositoryId],
    });
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(shown.stdout.includes(landingLine), shown.stdout);

    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: base,
        credential: writer,
      }),
      baseOid,
      "the base branch did not move",
    );
    assert.equal(
      await remoteRefValue(runner, paths, {
        remoteUrl: httpsUrl(env),
        ref: publishRef,
        credential: writer,
      }),
      null,
      "the scratch publish ref is absent after the registration",
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
    db.close();
  });
});
