import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  ACCEPTED_HOST_KEY_ALGORITHMS,
  scanHostKeys,
  scanTargetFor,
} from "../../../src/services/git/host-key.ts";
import { listRemoteRefs, httpsUrl, wrongCredential } from "../remote.ts";
import type { GitCredential } from "../../../src/services/git/index.ts";

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

type InspectBody = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
  credential: Readonly<{ reachable: boolean; refusal: string | null }>;
  hostKey: Readonly<{ algorithm: string; fingerprint: string }> | null;
}>;

describe("scripts/e2e/007/06-repository-inspect.e2e", () => {
  it("E7-06 — repository.inspect serves the symref, the verdict and the host key on a real daemon", async (t) => {
    const env: E2eEnv = loadE2eEnv();
    const tools = resolveTools();
    const home = createTemporaryHome();
    const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-e2e-keys-"));
    let daemon: DaemonProcess | undefined;
    t.after(async () => {
      if (daemon !== undefined) {
        daemon.kill();
        await daemon.exited();
      }
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

    const writerId = await registerCredential("e2e-inspect-writer", {
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
    const body = inspected.body as InspectBody;
    assert.equal(body.defaultBranch, env.ghBaseBranch);
    assert.equal(body.branches.includes(env.ghBaseBranch), true);
    const sorted = [...body.branches].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    assert.deepEqual(
      body.branches,
      sorted,
      "the branch list is bytewise sorted",
    );
    for (const branch of body.branches) {
      assert.equal(branch.startsWith("refs/"), false, branch);
    }
    assert.deepEqual(body.credential, { reachable: true, refusal: null });
    assert.equal(body.hostKey, null);

    const wrongId = await registerCredential("e2e-inspect-wrong", {
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
    const wrongInspected = await request(`${baseUrl}/v1/repository/inspect`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        remoteUrl: httpsUrl(env),
        credentialId: wrongId,
      }),
    });
    assert.equal(
      wrongInspected.status,
      200,
      "the wrong token yields a verdict",
    );
    const wrongBody = wrongInspected.body as InspectBody;
    assert.deepEqual(wrongBody.credential, {
      reachable: false,
      refusal: "auth-failed",
    });
    assert.equal(wrongBody.defaultBranch, null);

    execFileSync(
      tools.paths.sshKeygen,
      ["-t", "ed25519", "-N", "", "-f", join(keyDirectory, "client")],
      { env: {}, encoding: "utf8" },
    );
    const privateKey = readFileSync(join(keyDirectory, "client"), "utf8");
    const sshId = await registerCredential("e2e-inspect-ssh", {
      transport: "ssh",
      privateKey,
    });
    const sshUrl = `ssh://git@github.com/${env.ghRepo}.git`;
    const probed = {
      git: tools.paths.git,
      ssh: tools.paths.ssh,
      sshKeyscan: tools.paths.sshKeyscan,
      gitVersion: tools.gitVersion,
      sshVersion: tools.sshVersion,
    };
    const paths = buildGitPaths({ probed, home: home.path });
    const scan = await scanHostKeys(paths, sshUrl);
    assert.equal(scan.scanned, true, "the host key scan resolves");
    if (scan.scanned) {
      const target = scanTargetFor(sshUrl);
      const lines = scan.hostKeys.map(
        (entry) => `${target.host} ${entry.algorithm} ${entry.publicKey}`,
      );
      writeFileSync(paths.knownHosts, `${lines.join("\n")}\n`, {
        mode: 0o600,
      });
    }
    const sshInspected = await request(`${baseUrl}/v1/repository/inspect`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ remoteUrl: sshUrl, credentialId: sshId }),
    });
    assert.equal(sshInspected.status, 200, "the ssh inspect answers 200");
    const sshBody = sshInspected.body as InspectBody;
    assert.ok(sshBody.hostKey !== null, "the ssh inspect returns a host key");
    assert.equal(
      (ACCEPTED_HOST_KEY_ALGORITHMS as readonly string[]).includes(
        sshBody.hostKey.algorithm,
      ),
      true,
    );
    assert.equal(
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(sshBody.hostKey.fingerprint),
      true,
    );
    assert.deepEqual(sshBody.credential, {
      reachable: false,
      refusal: "auth-failed",
    });

    const disagreement = await request(`${baseUrl}/v1/repository/inspect`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ remoteUrl: sshUrl, credentialId: writerId }),
    });
    assert.equal(disagreement.status, 400);
    assert.equal(
      (disagreement.body as { error: { details: { refusal: string } } }).error
        .details.refusal,
      "url-refused",
    );

    daemon.kill();
    await daemon.exited();
    daemon = undefined;

    const db = new DatabaseSync(join(home.path, "kanthord.db"));
    const row = db.prepare("SELECT COUNT(*) AS c FROM repository").get() as {
      c: number;
    };
    db.close();
    assert.equal(row.c, 0, "the inspect wrote no repository row");

    const scratch = await listRemoteRefs(
      paths,
      env,
      "refs/heads/kanthord-e2e/007/*",
    );
    assert.deepEqual(scratch, {}, "the scenario created no remote ref");
  });
});
