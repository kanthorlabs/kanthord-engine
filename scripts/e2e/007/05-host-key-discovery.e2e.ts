import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadE2eEnv } from "../env.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { buildGitPaths } from "../../../src/services/git/probe.ts";
import {
  ACCEPTED_HOST_KEY_ALGORITHMS,
  knownHostsLine,
  scanHostKeys,
  scanTargetFor,
} from "../../../src/services/git/host-key.ts";

describe("scripts/e2e/007/05-host-key-discovery.e2e", () => {
  it("E7-05 — host key discovery against the real github.com", async (t) => {
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
    const first = await scanHostKeys(paths, url);
    assert.equal(first.scanned, true);
    if (!first.scanned) {
      return;
    }

    const algorithms = first.hostKeys.map((entry) => entry.algorithm);
    const sorted = [...algorithms].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    assert.deepEqual(
      algorithms,
      sorted,
      "the algorithm list is bytewise sorted",
    );
    for (const algorithm of algorithms) {
      assert.ok(
        (ACCEPTED_HOST_KEY_ALGORITHMS as readonly string[]).includes(algorithm),
        `${algorithm} is not an accepted algorithm`,
      );
    }
    assert.ok(algorithms.includes("ssh-ed25519"));
    assert.ok(algorithms.includes("ssh-rsa"));

    const second = await scanHostKeys(paths, url);
    assert.equal(second.scanned, true);
    if (second.scanned) {
      assert.deepEqual(second.hostKeys, first.hostKeys, "two runs agree");
    }

    for (const entry of first.hostKeys) {
      const line = knownHostsLine(scanTargetFor(url), entry);
      assert.ok(
        line.startsWith("[github.com]:22 "),
        `the line uses the bracketed spelling: ${line}`,
      );
      const filePath = join(root, "scan-line");
      writeFileSync(filePath, line + "\n", "utf8");
      const reported = execFileSync(
        tools.paths.sshKeygen,
        ["-l", "-f", filePath],
        { env: {}, encoding: "utf8" },
      )
        .trim()
        .split(/\s+/)[1];
      assert.equal(
        reported,
        entry.fingerprint,
        `ssh-keygen agrees for ${entry.algorithm}`,
      );
    }

    const started = Date.now();
    const refused = await scanHostKeys(paths, "ssh://git@127.0.0.1:1/r.git");
    assert.equal(refused.scanned, false);
    if (!refused.scanned) {
      assert.equal(refused.failure, "host-key-unavailable");
    }
    assert.ok(
      Date.now() - started < 10_000,
      "the refusal is classified quickly",
    );
  });
});
