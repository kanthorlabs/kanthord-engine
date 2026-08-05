import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { createSshRemote } from "../../../test/helpers/remote/index.ts";
import type { SshRemote } from "../../../test/helpers/remote/index.ts";

import { GitError, type GitCredential, type GitPaths } from "./index.ts";
import {
  ACCEPTED_HOST_KEY_ALGORITHMS,
  confirmHostKey,
  DEFAULT_SSH_PORT,
  fingerprintOf,
  KEYSCAN_TIMEOUT_MS,
  knownHostsLine,
  parseKeyscanOutput,
  parseKnownHosts,
  scanHostKeys,
  scanTargetFor,
  trustHostKey,
} from "./host-key.ts";
import { classifyFailure } from "./credential.ts";
import { runAuthenticated } from "./authenticated.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner } from "./run.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-hostkey-"));
  directories.push(dir);
  return dir;
}

function makePaths(): GitPaths {
  const dir = newDir();
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

function generateHostKey(
  dir: string,
  name: string,
  args: readonly string[],
): Readonly<{ algorithm: string; publicKey: string; fingerprint: string }> {
  const path = join(dir, name);
  execFileSync(tools.paths.sshKeygen, [...args, "-N", "", "-f", path], {
    env: {},
    encoding: "utf8",
  });
  const pub = readFileSync(`${path}.pub`, "utf8").trim().split(/\s+/);
  const algorithm = pub[0];
  const publicKey = pub[1];
  const fingerprint = execFileSync(
    tools.paths.sshKeygen,
    ["-l", "-f", `${path}.pub`],
    { env: {}, encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)[1];
  if (
    algorithm === undefined ||
    publicKey === undefined ||
    fingerprint === undefined
  ) {
    assert.fail(`unparseable generated host key ${name}`);
  }
  return { algorithm, publicKey, fingerprint };
}

async function prepareBareHome(
  runner: GitRunner,
  paths: GitPaths,
  url: string,
): Promise<void> {
  const init = await runner({
    args: [
      "init",
      "--bare",
      "--template=",
      "--initial-branch=main",
      paths.home,
    ],
  });
  assert.equal(init.code, 0, init.stderr);
  const addRemote = await runner({
    args: ["--git-dir=" + paths.home, "remote", "add", "origin", url],
  });
  assert.equal(addRemote.code, 0, addRemote.stderr);
}

function waitForScanPid(runDirectory: string): Promise<number> {
  const deadline = Date.now() + 3000;
  return new Promise<number>((resolve, reject) => {
    const attempt = (): void => {
      const entry = readdirSync(runDirectory).find(
        (name) => name.startsWith("git-") || name.startsWith("keyscan-"),
      );
      if (entry !== undefined) {
        resolve(Number(readFileSync(join(runDirectory, entry), "utf8")));
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(`timed out waiting for a scan pid in ${runDirectory}`),
        );
        return;
      }
      setTimeout(attempt, 25);
    };
    attempt();
  });
}

describe("src/services/git/host-key.test", () => {
  describe("scanTargetFor", () => {
    it("resolves a plain ssh url to the host and the default port", () => {
      assert.deepEqual(scanTargetFor("ssh://git@forge.test/r.git"), {
        host: "forge.test",
        port: 22,
      });
    });

    it("reads an explicit port", () => {
      assert.deepEqual(scanTargetFor("ssh://git@forge.test:2222/r.git"), {
        host: "forge.test",
        port: 2222,
      });
    });

    it("resolves the scp-like spelling with no port", () => {
      assert.deepEqual(scanTargetFor("git@forge.test:group/r.git"), {
        host: "forge.test",
        port: 22,
      });
    });

    it("strips the IPv6 brackets", () => {
      assert.deepEqual(scanTargetFor("ssh://git@[::1]:2222/r.git"), {
        host: "::1",
        port: 2222,
      });
    });

    it("refuses a non-ssh transport", () => {
      assert.throws(
        () => scanTargetFor("https://forge.test/r.git"),
        (error: unknown) =>
          error instanceof GitError &&
          error.failure === "unknown" &&
          error.message === "only an ssh url has a host key",
      );
    });

    it("runs the url policy before the transport check", () => {
      assert.throws(
        () => scanTargetFor("ssh://git@forge.test/r.git\n"),
        (error: unknown) =>
          error instanceof GitError && error.failure === "url-refused",
      );
    });

    it("pins the default port and the scan timeout", () => {
      assert.equal(DEFAULT_SSH_PORT, 22);
      assert.equal(KEYSCAN_TIMEOUT_MS, 15_000);
    });
  });

  describe("fingerprintOf", () => {
    it("reproduces ssh-keygen -l -f for an ed25519 key", () => {
      const dir = newDir();
      const key = generateHostKey(dir, "ed25519", ["-t", "ed25519"]);
      assert.equal(fingerprintOf(key.publicKey), key.fingerprint);
    });

    it("reproduces ssh-keygen -l -f for an rsa key", () => {
      const dir = newDir();
      const key = generateHostKey(dir, "rsa", ["-t", "rsa", "-b", "2048"]);
      assert.equal(fingerprintOf(key.publicKey), key.fingerprint);
    });

    it("reproduces ssh-keygen -l -f for an ecdsa key", () => {
      const dir = newDir();
      const key = generateHostKey(dir, "ecdsa", ["-t", "ecdsa", "-b", "256"]);
      assert.equal(fingerprintOf(key.publicKey), key.fingerprint);
    });

    it("is the unpadded SHA256 base64 shape", () => {
      const dir = newDir();
      const key = generateHostKey(dir, "shape", ["-t", "ed25519"]);
      assert.match(fingerprintOf(key.publicKey), /^SHA256:[A-Za-z0-9+/]{43}$/);
      assert.equal(fingerprintOf(key.publicKey).includes("="), false);
    });
  });

  describe("parseKeyscanOutput", () => {
    let keys: readonly Readonly<{
      algorithm: string;
      publicKey: string;
      fingerprint: string;
    }>[];
    let keyLine: (
      key: Readonly<{ algorithm: string; publicKey: string }>,
    ) => string;

    before(() => {
      const dir = newDir();
      keys = [
        generateHostKey(dir, "ed25519", ["-t", "ed25519"]),
        generateHostKey(dir, "rsa", ["-t", "rsa", "-b", "2048"]),
        generateHostKey(dir, "ecdsa", ["-t", "ecdsa", "-b", "256"]),
      ];
      keyLine = (key): string => `forge.test ${key.algorithm} ${key.publicKey}`;
    });

    it("orders the three accepted algorithms identically from any input order", () => {
      const permutations: readonly (readonly number[])[] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      for (const order of permutations) {
        const text =
          order.map((index) => keyLine(keys[index]!)).join("\n") + "\n";
        const parsed = parseKeyscanOutput(text);
        assert.deepEqual(
          parsed.map((entry) => entry.algorithm),
          ["ecdsa-sha2-nistp256", "ssh-ed25519", "ssh-rsa"],
          `permutation ${order.join(",")}`,
        );
      }
    });

    it("drops comment, empty and two-field lines", () => {
      const text =
        [
          "# a comment line",
          "",
          keyLine(keys[0]!),
          "ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAA",
        ].join("\n") + "\n";
      const parsed = parseKeyscanOutput(text);
      assert.deepEqual(
        parsed.map((entry) => entry.algorithm),
        ["ssh-ed25519"],
      );
    });

    it("drops an algorithm outside the accepted set", () => {
      const text =
        ["forge.test ssh-dss AAAAB3NzaC1kc3MAAACB", keyLine(keys[0]!)].join(
          "\n",
        ) + "\n";
      const parsed = parseKeyscanOutput(text);
      assert.deepEqual(
        parsed.map((entry) => entry.algorithm),
        ["ssh-ed25519"],
      );
    });

    it("keeps the first of a duplicated line", () => {
      const text = [keyLine(keys[0]!), keyLine(keys[0]!)].join("\n") + "\n";
      const parsed = parseKeyscanOutput(text);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0]?.publicKey, keys[0]?.publicKey);
    });

    it("orders shared-algorithm keys bytewise, not by string comparison", () => {
      const emoji = "a\ud83d\ude00";
      const privateUse = "a\uE000";
      assert.ok(
        emoji < privateUse,
        "the pair must disagree with the bytewise order",
      );
      assert.ok(
        Buffer.compare(Buffer.from(emoji), Buffer.from(privateUse)) > 0,
        "the pair must disagree with the bytewise order",
      );
      const text =
        `forge.test ssh-ed25519 ${emoji}\n` +
        `forge.test ssh-ed25519 ${privateUse}\n`;
      const parsed = parseKeyscanOutput(text);
      assert.deepEqual(
        parsed.map((entry) => entry.publicKey),
        [privateUse, emoji],
      );
    });

    it("parses an empty output to an empty list", () => {
      assert.deepEqual(parseKeyscanOutput(""), []);
    });

    it("parses CRLF line endings without corrupting a field", () => {
      const text = [keyLine(keys[0]!), keyLine(keys[1]!)].join("\r\n") + "\r\n";
      const parsed = parseKeyscanOutput(text);
      assert.deepEqual(
        parsed.map((entry) => entry.algorithm),
        ["ssh-ed25519", "ssh-rsa"],
      );
      for (const entry of parsed) {
        assert.equal(entry.publicKey.includes("\r"), false);
        assert.equal(entry.algorithm.includes("\r"), false);
      }
      assert.equal(fingerprintOf(parsed[0]!.publicKey), keys[0]?.fingerprint);
    });

    it("accepts exactly the three documented algorithms", () => {
      assert.deepEqual(ACCEPTED_HOST_KEY_ALGORITHMS, [
        "ecdsa-sha2-nistp256",
        "ssh-ed25519",
        "ssh-rsa",
      ]);
    });
  });

  describe("knownHostsLine", () => {
    const key = {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abc",
      publicKey: "AAAAkey",
    };

    it("writes the bracketed spelling at the default port", () => {
      assert.equal(
        knownHostsLine({ host: "forge.test", port: 22 }, key),
        "[forge.test]:22 ssh-ed25519 AAAAkey",
      );
    });

    it("writes the bracketed spelling at a custom port", () => {
      const rsaKey = { ...key, algorithm: "ssh-rsa", publicKey: "BBBBkey" };
      assert.equal(
        knownHostsLine({ host: "127.0.0.1", port: 7422 }, rsaKey),
        "[127.0.0.1]:7422 ssh-rsa BBBBkey",
      );
    });

    it("contains exactly two spaces and no newline", () => {
      const line = knownHostsLine({ host: "forge.test", port: 22 }, key);
      assert.equal(line.split(" ").length - 1, 2);
      assert.equal(line.includes("\n"), false);
    });
  });

  describe("parseKnownHosts", () => {
    it("drops comments and empty lines and trims the rest", () => {
      assert.deepEqual(parseKnownHosts("# c\n\n[h]:22 a k\n"), ["[h]:22 a k"]);
    });

    it("keeps every surviving line in order", () => {
      assert.deepEqual(parseKnownHosts("a k\n# comment\n\n b k \n"), [
        "a k",
        "b k",
      ]);
    });
  });

  describe("against the ssh fixture", () => {
    let remote: SshRemote;

    before(async () => {
      remote = await createSshRemote();
    });

    after(async () => {
      await remote?.dispose();
    });

    it("scans the two fixture algorithms in the accepted order", async () => {
      const paths = makePaths();
      const outcome = await scanHostKeys(paths, remote.url("fixture.git"));
      assert.equal(outcome.scanned, true);
      if (!outcome.scanned) {
        return;
      }
      assert.deepEqual(
        outcome.hostKeys.map((entry) => entry.algorithm),
        ["ssh-ed25519", "ssh-rsa"],
      );
    });

    it("two runs yield the same ordered list and fingerprints", async () => {
      const paths = makePaths();
      const first = await scanHostKeys(paths, remote.url("fixture.git"));
      const second = await scanHostKeys(paths, remote.url("fixture.git"));
      assert.equal(first.scanned, true);
      assert.equal(second.scanned, true);
      if (!first.scanned || !second.scanned) {
        return;
      }
      assert.deepEqual(first.hostKeys, second.hostKeys);
    });

    it("the fingerprints agree with ssh-keygen on the fixture keys", async () => {
      const paths = makePaths();
      const outcome = await scanHostKeys(paths, remote.url("fixture.git"));
      assert.equal(outcome.scanned, true);
      if (!outcome.scanned) {
        return;
      }
      for (const entry of outcome.hostKeys) {
        const fixture = remote.hostKeys.find(
          (candidate) => candidate.algorithm === entry.algorithm,
        );
        assert.ok(fixture, `no fixture key for ${entry.algorithm}`);
        assert.equal(entry.fingerprint, fixture.fingerprint);
      }
    });

    it("the known_hosts spelling matches the fixture's own", async () => {
      const paths = makePaths();
      const outcome = await scanHostKeys(paths, remote.url("fixture.git"));
      assert.equal(outcome.scanned, true);
      if (!outcome.scanned) {
        return;
      }
      const target = scanTargetFor(remote.url("fixture.git"));
      assert.equal(
        knownHostsLine(target, outcome.hostKeys[0]!),
        remote.knownHostsLine(remote.hostKeys[0]!),
      );
    });

    it("a refused connection is classified, not reported as a mismatch", async () => {
      const paths = makePaths();
      const started = Date.now();
      const outcome = await scanHostKeys(paths, "ssh://git@127.0.0.1:1/r.git");
      const elapsed = Date.now() - started;
      assert.equal(outcome.scanned, false);
      if (!outcome.scanned) {
        assert.notEqual(outcome.failure, "host-key-mismatch");
        assert.equal(outcome.failure, "host-key-unavailable");
      }
      assert.ok(elapsed < 10_000, `the scan took ${elapsed}ms`);
    });

    it("a wedged scan reports timed-out and the recorded pid is gone", async () => {
      const dir = newDir();
      const paths = makePaths();
      const sleeper = join(dir, "sleeper-keyscan");
      writeFileSync(sleeper, "#!/bin/sh\n/bin/sleep 30\n", { mode: 0o700 });
      const pending = scanHostKeys(
        { ...paths, sshKeyscan: sleeper },
        "ssh://git@127.0.0.1:1/r.git",
        { timeoutMs: 1500 },
      );
      const pid = await waitForScanPid(paths.runDirectory);
      const started = Date.now();
      const outcome = await pending;
      assert.ok(Date.now() - started < 5000, "the outcome resolves in time");
      assert.equal(outcome.scanned, false);
      if (!outcome.scanned) {
        assert.equal(outcome.failure, "timed-out");
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        } catch {
          break;
        }
      }
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    });

    it("no pid file survives a scan, successful or failing", async () => {
      const paths = makePaths();
      await scanHostKeys(paths, remote.url("fixture.git"));
      await scanHostKeys(paths, "ssh://git@127.0.0.1:1/r.git");
      const leftovers = readdirSync(paths.runDirectory).filter(
        (name) => name.startsWith("git-") || name.startsWith("keyscan-"),
      );
      assert.deepEqual(leftovers, []);
    });

    it("the scan writes nothing to known_hosts", async () => {
      const paths = makePaths();
      await scanHostKeys(paths, remote.url("fixture.git"));
      assert.equal(readFileSync(paths.knownHosts, "utf8"), "");
    });

    describe("confirmHostKey", () => {
      it("confirms the first presented fingerprint and returns that key", async () => {
        const paths = makePaths();
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.hostKeys[0]!.fingerprint,
        );
        assert.equal(outcome.confirmed, true);
        if (outcome.confirmed) {
          assert.equal(
            outcome.hostKey.fingerprint,
            remote.hostKeys[0]!.fingerprint,
          );
          assert.equal(
            outcome.hostKey.publicKey,
            remote.hostKeys[0]!.publicKey,
          );
        }
      });

      it("confirms the second presented fingerprint and returns the second key", async () => {
        const paths = makePaths();
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.hostKeys[1]!.fingerprint,
        );
        assert.equal(outcome.confirmed, true);
        if (outcome.confirmed) {
          assert.equal(
            outcome.hostKey.publicKey,
            remote.hostKeys[1]!.publicKey,
          );
        }
      });

      it("refuses a syntactically valid fingerprint the host never presented", async () => {
        const paths = makePaths();
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.wrongHostKey.fingerprint,
        );
        assert.equal(outcome.confirmed, false);
        if (!outcome.confirmed) {
          assert.equal(outcome.reason, "fingerprint-mismatch");
          assert.deepEqual(
            outcome.presented,
            remote.hostKeys.map((entry) => entry.fingerprint),
          );
          assert.equal(outcome.detail, "");
        }
      });

      it("refuses a truncated fingerprint: the comparison is whole-string", async () => {
        const paths = makePaths();
        const truncated = remote.hostKeys[0]!.fingerprint.slice(0, 20);
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          truncated,
        );
        assert.equal(outcome.confirmed, false);
        if (!outcome.confirmed) {
          assert.equal(outcome.reason, "fingerprint-mismatch");
        }
      });

      it("refuses a fingerprint with a lower-cased SHA256 prefix", async () => {
        const paths = makePaths();
        const lower = remote.hostKeys[0]!.fingerprint.replace(
          "SHA256:",
          "sha256:",
        );
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          lower,
        );
        assert.equal(outcome.confirmed, false);
        if (!outcome.confirmed) {
          assert.equal(outcome.reason, "fingerprint-mismatch");
        }
      });

      it("classifies a host that does not answer as scan-failed, not a mismatch", async () => {
        const paths = makePaths();
        const outcome = await confirmHostKey(
          paths,
          "ssh://git@127.0.0.1:1/r.git",
          remote.hostKeys[0]!.fingerprint,
        );
        assert.equal(outcome.confirmed, false);
        if (!outcome.confirmed) {
          assert.equal(outcome.reason, "scan-failed");
          assert.notEqual(outcome.detail, "");
        }
      });

      it("re-scans rather than trusting stored state", async () => {
        const paths = makePaths();
        copyFileSync(
          remote.writeKnownHosts([remote.wrongHostKey]),
          paths.knownHosts,
        );
        const outcome = await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.hostKeys[0]!.fingerprint,
        );
        assert.equal(outcome.confirmed, true);
      });

      it("writes nothing to known_hosts across a confirmation and both refusals", async () => {
        const paths = makePaths();
        const before = readFileSync(paths.knownHosts, "utf8");
        await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.hostKeys[0]!.fingerprint,
        );
        await confirmHostKey(
          paths,
          remote.url("fixture.git"),
          remote.wrongHostKey.fingerprint,
        );
        await confirmHostKey(
          paths,
          "ssh://git@127.0.0.1:1/r.git",
          "SHA256:abc",
        );
        assert.equal(readFileSync(paths.knownHosts, "utf8"), before);
      });
    });

    describe("trustHostKey, against the ssh fixture", () => {
      it("writes exactly one line ending in a newline on an empty file", async () => {
        const paths = makePaths();
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        assert.equal(
          readFileSync(paths.knownHosts, "utf8"),
          remote.knownHostsLine(remote.hostKeys[0]!) + "\n",
        );
      });

      it("writes the file at mode 600 and the created parent at mode 700", async () => {
        const dir = newDir();
        const ghost = join(dir, "ghost", "known_hosts");
        const paths = { ...makePaths(), knownHosts: ghost };
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        assert.equal(statSync(ghost).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(ghost)).mode & 0o777, 0o700);
      });

      it("is idempotent: the same key twice holds one line", async () => {
        const paths = makePaths();
        const input = {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        };
        await trustHostKey(paths, input);
        await trustHostKey(paths, input);
        assert.equal(
          readFileSync(paths.knownHosts, "utf8"),
          remote.knownHostsLine(remote.hostKeys[0]!) + "\n",
        );
      });

      it("is additive: the second key appends and the first line is unchanged", async () => {
        const paths = makePaths();
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[1]!,
        });
        assert.equal(
          readFileSync(paths.knownHosts, "utf8"),
          remote.knownHostsLine(remote.hostKeys[0]!) +
            "\n" +
            remote.knownHostsLine(remote.hostKeys[1]!) +
            "\n",
        );
      });

      it("a second host does not unpin the first", async () => {
        const paths = makePaths();
        writeFileSync(
          paths.knownHosts,
          "[other.test]:22 ssh-ed25519 AAAAother\n",
        );
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        const text = readFileSync(paths.knownHosts, "utf8");
        assert.ok(text.includes("[other.test]:22 ssh-ed25519 AAAAother\n"));
        assert.ok(
          text.includes(remote.knownHostsLine(remote.hostKeys[0]!) + "\n"),
        );
      });

      it("creates the parent directory and the file when the parent is absent", async () => {
        const dir = newDir();
        const ghost = join(dir, "deep", "nested", "known_hosts");
        const paths = { ...makePaths(), knownHosts: ghost };
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        assert.equal(
          readFileSync(ghost, "utf8"),
          remote.knownHostsLine(remote.hostKeys[0]!) + "\n",
        );
      });

      it("the pinned file works: an authenticated fetch over the fixture", async () => {
        const paths = makePaths();
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[0]!,
        });
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.hostKeys[1]!,
        });
        const fresh = makePaths();
        copyFileSync(paths.knownHosts, fresh.knownHosts);
        const runner = createGitRunner(fresh);
        await prepareBareHome(runner, fresh, remote.url("fixture.git"));
        const credential: GitCredential = {
          transport: "ssh",
          privateKey: readFileSync(remote.privateKeyPath, "utf8"),
        };
        const outcome = await runAuthenticated(runner, fresh, {
          args: [
            "--git-dir=" + fresh.home,
            "fetch",
            "origin",
            "--prune",
            "--no-tags",
          ],
          credential,
        });
        assert.equal(outcome.code, 0, outcome.stderr);
      });

      it("a wrong pin still fails as host-key-mismatch", async () => {
        const paths = makePaths();
        await trustHostKey(paths, {
          remoteUrl: remote.url("fixture.git"),
          hostKey: remote.wrongHostKey,
        });
        const runner = createGitRunner(paths);
        await prepareBareHome(runner, paths, remote.url("fixture.git"));
        const credential: GitCredential = {
          transport: "ssh",
          privateKey: readFileSync(remote.privateKeyPath, "utf8"),
        };
        const outcome = await runAuthenticated(runner, paths, {
          args: [
            "--git-dir=" + paths.home,
            "fetch",
            "origin",
            "--prune",
            "--no-tags",
          ],
          credential,
          timeoutMs: 15_000,
        });
        assert.notEqual(outcome.code, 0);
        assert.equal(
          classifyFailure({
            code: outcome.code,
            stderr: outcome.stderr,
            eraseObserved: outcome.eraseObserved,
          }),
          "host-key-mismatch",
        );
      });
    });
  });
});
