import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadE2eEnv } from "../env.ts";
import { listRemoteRefs } from "../remote.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import {
  confirmHostKey,
  fingerprintOf,
  scanHostKeys,
  trustHostKey,
} from "../../../src/services/git/host-key.ts";

describe("scripts/e2e/007/08-host-key-confirmation.e2e", () => {
  it("E7-08 — host key confirmation against the real github.com", async (t) => {
    const env = loadE2eEnv();
    const tools = resolveTools();
    const root = mkdtempSync(join(tmpdir(), "kanthord-e2e-hostkey-"));
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

    const url = `ssh://git@github.com/${env.ghRepo}.git`;

    const scan = await scanHostKeys(paths, url);
    assert.equal(scan.scanned, true);
    if (!scan.scanned) {
      return;
    }
    const firstEntry = scan.hostKeys[0];
    assert.ok(firstEntry, "the scan returns at least one key");

    const confirmed = await confirmHostKey(paths, url, firstEntry.fingerprint);
    assert.equal(confirmed.confirmed, true);
    if (confirmed.confirmed) {
      assert.deepEqual(confirmed.hostKey, firstEntry);
    }

    const forgedKeyPath = join(root, "forged");
    execFileSync(
      tools.paths.sshKeygen,
      ["-t", "ed25519", "-N", "", "-f", forgedKeyPath],
      { env: {}, encoding: "utf8" },
    );
    const forgedTokens = readFileSync(`${forgedKeyPath}.pub`, "utf8")
      .trim()
      .split(/\s+/);
    const forgedPublicKey = forgedTokens[1];
    assert.ok(forgedPublicKey, "the generated public key is readable");
    const forgedFingerprint = fingerprintOf(forgedPublicKey);

    const refused = await confirmHostKey(paths, url, forgedFingerprint);
    assert.equal(refused.confirmed, false);
    if (!refused.confirmed) {
      assert.equal(refused.reason, "fingerprint-mismatch");
      assert.deepEqual(
        refused.presented,
        scan.hostKeys.map((entry) => entry.fingerprint),
      );
    }

    await trustHostKey(paths, {
      remoteUrl: url,
      hostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: forgedFingerprint,
        publicKey: forgedPublicKey,
      },
    });
    const reconfirmed = await confirmHostKey(
      paths,
      url,
      firstEntry.fingerprint,
    );
    assert.equal(reconfirmed.confirmed, true);
    if (reconfirmed.confirmed) {
      assert.deepEqual(reconfirmed.hostKey, firstEntry);
    }

    for (const entry of scan.hostKeys) {
      await trustHostKey(paths, { remoteUrl: url, hostKey: entry });
    }
    assert.equal(statSync(paths.knownHosts).mode & 0o777, 0o600);
    execFileSync(tools.paths.sshKeygen, ["-l", "-f", paths.knownHosts], {
      env: {},
      encoding: "utf8",
    });

    const knownHostsText = readFileSync(paths.knownHosts, "utf8");
    for (const entry of scan.hostKeys) {
      assert.ok(
        knownHostsText.includes(
          `[github.com]:22 ${entry.algorithm} ${entry.publicKey}`,
        ),
        `the bracketed line is present for ${entry.algorithm}`,
      );
    }

    const bareHostLines = scan.hostKeys.map(
      (entry) => `github.com ${entry.algorithm} ${entry.publicKey}`,
    );
    writeFileSync(
      paths.knownHosts,
      knownHostsText + bareHostLines.join("\n") + "\n",
      { mode: 0o600 },
    );

    const sshArgs = (knownHostsFile: string): string[] => [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-o",
      "IdentityAgent=none",
      "-i",
      forgedKeyPath,
      "-T",
      "git@github.com",
    ];

    const pinned = spawnSync(tools.paths.ssh, sshArgs(paths.knownHosts), {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ok(pinned.stderr.includes("Permission denied"), pinned.stderr);
    assert.equal(
      pinned.stderr.includes("Host key verification failed"),
      false,
      pinned.stderr,
    );

    const empty = join(root, "empty-known-hosts");
    writeFileSync(empty, "");
    const unpinned = spawnSync(tools.paths.ssh, sshArgs(empty), {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ok(
      unpinned.stderr.includes("Host key verification failed"),
      unpinned.stderr,
    );

    const scratch = await listRemoteRefs(
      paths,
      env,
      "refs/heads/kanthord-e2e/007/*",
    );
    assert.deepEqual(scratch, {}, "the scenario created no remote ref");
  });
});
