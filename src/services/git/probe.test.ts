import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  buildGitPaths,
  compareVersions,
  MINIMUM_GIT_VERSION,
  parseGitVersion,
  parseSshVersion,
  probeTools,
  ToolProbeError,
  type ProbedTools,
  type ProbeInput,
} from "./probe.ts";

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-probe-"));
  directories.push(dir);
  return dir;
}

function writeTool(
  dir: string,
  name: string,
  body: string,
  mode = 0o700,
): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, body, { mode });
  return filePath;
}

function fakeGit(version: string): string {
  return `#!/bin/sh\nprintf 'git version ${version}\\n'\n`;
}

function fakeSsh(version: string): string {
  return `#!/bin/sh\nprintf 'OpenSSH_${version}, LibreSSL 3.3.6\\n' >&2\n`;
}

function probeInput(dir: string, overrides?: Partial<ProbeInput>): ProbeInput {
  const git = writeTool(dir, "git", fakeGit("2.50.1"));
  const ssh = writeTool(dir, "ssh", fakeSsh("10.2p1"));
  const sshKeyscan = writeTool(dir, "ssh-keyscan", "#!/bin/sh\nexit 1\n");
  const runDirectory = join(dir, "run");
  mkdirSync(runDirectory);
  return { tools: { git, ssh, sshKeyscan }, runDirectory, ...overrides };
}

function waitForProbePid(runDirectory: string): number {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const entry = readdirSync(runDirectory).find((name) =>
      name.startsWith("probe-"),
    );
    if (entry !== undefined) {
      return Number(readFileSync(join(runDirectory, entry), "utf8"));
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.fail(`timed out waiting for a probe pid file in ${runDirectory}`);
}

describe("src/services/git/probe.test", () => {
  describe("parseGitVersion", () => {
    it("parses the measured git banner and drops the vendor suffix", () => {
      assert.equal(
        parseGitVersion("git version 2.50.1 (Apple Git-155)\n"),
        "2.50.1",
      );
    });

    it("parses the floor version", () => {
      assert.equal(parseGitVersion("git version 2.34.0\n"), "2.34.0");
    });

    it("returns null for an unrecognisable banner", () => {
      assert.equal(parseGitVersion("garbage\n"), null);
    });
  });

  describe("parseSshVersion", () => {
    it("parses the measured ssh banner from stderr", () => {
      assert.equal(
        parseSshVersion("OpenSSH_10.2p1, LibreSSL 3.3.6\n"),
        "10.2p1",
      );
    });

    it("parses a vendor-suffixed banner", () => {
      assert.equal(
        parseSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13\n"),
        "9.6p1",
      );
    });

    it("returns null for an empty string", () => {
      assert.equal(parseSshVersion(""), null);
    });
  });

  describe("compareVersions", () => {
    it("compares the three numeric components left to right", () => {
      assert.equal(compareVersions("2.34.0", "2.34.0"), 0);
      assert.ok(compareVersions("2.33.9", "2.34.0") < 0);
      assert.ok(compareVersions("2.50.1", "2.34.0") > 0);
      assert.ok(
        compareVersions("2.4.0", "2.34.0") < 0,
        "2.4.0 must compare numerically, not lexicographically",
      );
    });
  });

  describe("probeTools", () => {
    it("resolves versions and keeps the three paths unchanged", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const result = await probeTools(input);
      assert.deepEqual(result, {
        git: input.tools.git,
        ssh: input.tools.ssh,
        sshKeyscan: input.tools.sshKeyscan,
        gitVersion: "2.50.1",
        sshVersion: "10.2p1",
      });
    });

    it("a missing tool refuses and names it", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const missing = join(dir, "no-such-ssh");
      const rejection = await probeTools({
        ...input,
        tools: { ...input.tools, ssh: missing },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof ToolProbeError, String(rejection));
      assert.equal(rejection.code, "tool-missing");
      assert.equal(rejection.tool, "ssh");
      assert.ok(rejection.message.includes(missing), rejection.message);
    });

    it("a non-executable tool refuses as unreadable", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const locked = writeTool(dir, "locked-git", fakeGit("2.50.1"), 0o600);
      const rejection = await probeTools({
        ...input,
        tools: { ...input.tools, git: locked },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof ToolProbeError, String(rejection));
      assert.equal(rejection.code, "tool-unreadable");
      assert.equal(rejection.tool, "git");
    });

    it("the probe order is fixed: git before ssh before sshKeyscan", async () => {
      const dir = newDir();
      const runDirectory = join(dir, "run");
      mkdirSync(runDirectory);
      const absent = join(dir, "absent-tool");
      const allAbsent = await probeTools({
        tools: { git: absent, ssh: absent, sshKeyscan: absent },
        runDirectory,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(allAbsent instanceof ToolProbeError, String(allAbsent));
      assert.equal(allAbsent.tool, "git");
      const gitOnly = await probeTools({
        tools: {
          git: writeTool(dir, "only-git", fakeGit("2.50.1")),
          ssh: absent,
          sshKeyscan: absent,
        },
        runDirectory,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(gitOnly instanceof ToolProbeError, String(gitOnly));
      assert.equal(gitOnly.tool, "ssh");
    });

    it("a git below the floor refuses and names both versions", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const old = writeTool(dir, "old-git", fakeGit("2.33.9"));
      const rejection = await probeTools({
        ...input,
        tools: { ...input.tools, git: old },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof ToolProbeError, String(rejection));
      assert.equal(rejection.code, "tool-too-old");
      assert.equal(rejection.tool, "git");
      assert.ok(rejection.message.includes("2.33.9"), rejection.message);
      assert.ok(
        rejection.message.includes(MINIMUM_GIT_VERSION),
        rejection.message,
      );
    });

    it("ssh-keyscan is probed for presence only", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const result = await probeTools(input);
      assert.deepEqual(Object.keys(result).sort(), [
        "git",
        "gitVersion",
        "ssh",
        "sshKeyscan",
        "sshVersion",
      ]);
    });

    it("a hanging tool is killed and the group is signalled", async () => {
      const dir = newDir();
      const runDirectory = join(dir, "run");
      mkdirSync(runDirectory);
      const sleeper = writeTool(
        dir,
        "sleeper-git",
        "#!/bin/sh\n/bin/sleep 30\n",
      );
      const pending = probeTools({
        tools: { git: sleeper, ssh: sleeper, sshKeyscan: sleeper },
        runDirectory,
        timeoutMs: 1500,
      });
      const pid = waitForProbePid(runDirectory);
      const rejection = await pending.then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof ToolProbeError, String(rejection));
      assert.equal(rejection.code, "tool-unreadable");
      assert.equal(rejection.tool, "git");
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

    it("the probe leaves no pid file after a resolved probe", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      await probeTools(input);
      assert.deepEqual(readdirSync(input.runDirectory), []);
    });

    it("the probe leaves no pid file after a rejected probe", async () => {
      const dir = newDir();
      const input = probeInput(dir);
      const garbage = writeTool(
        dir,
        "garbage-git",
        "#!/bin/sh\nprintf 'garbage\\n'\n",
      );
      const rejection = await probeTools({
        ...input,
        tools: { ...input.tools, git: garbage },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(rejection instanceof ToolProbeError, String(rejection));
      assert.equal(rejection.code, "tool-unreadable");
      assert.deepEqual(
        readdirSync(input.runDirectory).filter((name) =>
          name.startsWith("probe-"),
        ),
        [],
      );
    });
  });

  describe("buildGitPaths", () => {
    function probed(dir: string): ProbedTools {
      return {
        git: join(dir, "git"),
        ssh: join(dir, "ssh"),
        sshKeyscan: join(dir, "ssh-keyscan"),
        gitVersion: "2.50.1",
        sshVersion: "10.2p1",
      };
    }

    it("returns exactly the seven members with absolute values", () => {
      const dir = newDir();
      const paths = buildGitPaths({ probed: probed(dir), home: dir });
      assert.deepEqual(Object.keys(paths).sort(), [
        "git",
        "home",
        "keyDirectory",
        "knownHosts",
        "runDirectory",
        "ssh",
        "sshKeyscan",
      ]);
      for (const value of Object.values(paths)) {
        assert.ok(isAbsolute(value), `${value} is not absolute`);
      }
    });

    it("names the three members from probed and derives the four from home", () => {
      const dir = newDir();
      const paths = buildGitPaths({ probed: probed(dir), home: dir });
      assert.equal(paths.git, join(dir, "git"));
      assert.equal(paths.ssh, join(dir, "ssh"));
      assert.equal(paths.sshKeyscan, join(dir, "ssh-keyscan"));
      assert.equal(paths.home, join(dir, "git", "home"));
      assert.equal(paths.keyDirectory, join(dir, "git", "keys"));
      assert.equal(paths.knownHosts, join(dir, "git", "known_hosts"));
      assert.equal(paths.runDirectory, join(dir, "git", "run"));
    });

    it("creates the three directories at 0700 and known_hosts at 0600", () => {
      const dir = newDir();
      const paths = buildGitPaths({ probed: probed(dir), home: dir });
      for (const p of [paths.home, paths.keyDirectory, paths.runDirectory]) {
        assert.equal((statSync(p).mode & 0o777).toString(8), "700", p);
      }
      assert.equal(
        (statSync(paths.knownHosts).mode & 0o777).toString(8),
        "600",
      );
    });

    it("never truncates an existing known_hosts", () => {
      const dir = newDir();
      const paths = buildGitPaths({ probed: probed(dir), home: dir });
      writeFileSync(paths.knownHosts, "pinned\n");
      const again = buildGitPaths({ probed: probed(dir), home: dir });
      assert.equal(again.knownHosts, paths.knownHosts);
      assert.equal(readFileSync(again.knownHosts, "utf8"), "pinned\n");
    });
  });
});
