import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { pinnedGitEnvironment } from "../../../test/helpers/remote/seed.ts";

import {
  assertSignallable,
  launcherArgv,
  spawnSupervised,
} from "./launcher.ts";
import type { SupervisedChild, SupervisedSpawn } from "./launcher.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-launcher-"));
  directories.push(dir);
  return dir;
}

function waitForFile(filePath: string): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

function spawnSleepingSsh(
  dir: string,
): Readonly<{ child: SupervisedChild; sshPidPath: string }> {
  const scriptPath = join(dir, "ssh-sleeper.sh");
  const sshPidPath = join(dir, "ssh.pid");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\nprintf '%s' "$$" > '${sshPidPath}'\n/bin/sleep 30\n`,
    { mode: 0o700 },
  );
  const child = spawnSupervised({
    command: tools.paths.git,
    args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
    env: {
      ...pinnedGitEnvironment,
      PATH: tools.execPath,
      GIT_SSH_COMMAND: `'${scriptPath}'`,
    },
    cwd: dir,
    pidFile: join(dir, "git.pid"),
  });
  assert.ok(child.pid !== undefined, "the sleeping ssh child must have a pid");
  waitForFile(sshPidPath);
  return { child, sshPidPath };
}

function processName(pid: number): string {
  const output = execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return basename(output.trim());
}

function processGroupId(pid: number): number {
  const output = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return Number(output.trim());
}

describe("src/services/git/launcher.test", () => {
  it("launcherArgv pins the exact argument vector", () => {
    assert.deepEqual(
      launcherArgv({ command: tools.paths.git, args: ["--version"] }),
      [
        "-c",
        'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; exec "$@"',
        "sh",
        tools.paths.git,
        "--version",
      ],
    );
  });

  it("launcherArgv with no args yields the four pinned elements", () => {
    assert.equal(
      launcherArgv({ command: tools.paths.git, args: [] }).length,
      4,
    );
  });

  it("the pid file names git, not the launcher", async () => {
    const dir = makeDirectory();
    const { child } = spawnSleepingSsh(dir);
    const recorded = Number(readFileSync(join(dir, "git.pid"), "utf8"));
    assert.equal(recorded, child.pid);
    assert.equal(processName(recorded), "git");
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("the child leads its own process group", async () => {
    const dir = makeDirectory();
    const { child } = spawnSleepingSsh(dir);
    assert.equal(processGroupId(child.pid), child.pid);
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("the group signal reaches the descendant", async () => {
    const dir = makeDirectory();
    const { child, sshPidPath } = spawnSleepingSsh(dir);
    const sshPid = Number(readFileSync(sshPidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(sshPid, 0));
    child.signalGroup("SIGTERM");
    assert.deepEqual(await child.exited, { code: null, signal: "SIGTERM" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(sshPid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        break;
      }
    }
    assert.throws(
      () => process.kill(sshPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("a process-only signal leaves the descendant alive", async () => {
    const dir = makeDirectory();
    const { child, sshPidPath } = spawnSleepingSsh(dir);
    const sshPid = Number(readFileSync(sshPidPath, "utf8"));
    process.kill(child.pid, "SIGTERM");
    await child.exited;
    assert.doesNotThrow(() => process.kill(sshPid, 0));
    child.signalGroup("SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(sshPid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        break;
      }
    }
    assert.throws(
      () => process.kill(sshPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("a pre-existing pid file stops the launcher with 111", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "git.pid");
    writeFileSync(pidFile, "4321");
    const child = spawnSupervised({
      command: tools.paths.git,
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      env: {
        ...pinnedGitEnvironment,
        PATH: tools.execPath,
        GIT_SSH_COMMAND: `'${join(dir, "ssh-sleeper.sh")}'`,
      },
      cwd: dir,
      pidFile,
    });
    assert.deepEqual(await child.exited, { code: 111, signal: null });
    assert.equal(existsSync(join(dir, "ssh.pid")), false);
    assert.equal(readFileSync(pidFile, "utf8"), "4321");
  });

  it("a pid file under a missing directory stops the launcher with 111", async () => {
    const dir = makeDirectory();
    const child = spawnSupervised({
      command: tools.paths.git,
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      env: {
        ...pinnedGitEnvironment,
        PATH: tools.execPath,
        GIT_SSH_COMMAND: `'${join(dir, "ssh-sleeper.sh")}'`,
      },
      cwd: dir,
      pidFile: join(dir, "missing", "git.pid"),
    });
    assert.deepEqual(await child.exited, { code: 111, signal: null });
    assert.equal(existsSync(join(dir, "ssh.pid")), false);
  });

  it("a clean spawn leaves the pid file in place", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "git.pid");
    const child = spawnSupervised({
      command: tools.paths.git,
      args: ["--version"],
      env: { ...pinnedGitEnvironment, PATH: tools.execPath },
      cwd: dir,
      pidFile,
    });
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.equal(existsSync(pidFile), true);
  });

  it("assertSignallable refuses a pid that cannot name a group", () => {
    for (const pid of [undefined, 0, 1, -1, 1.5]) {
      assert.throws(
        () => assertSignallable(pid),
        { message: "a supervised pid must be greater than 1" },
        `pid ${String(pid)}`,
      );
    }
    assert.doesNotThrow(() => assertSignallable(2));
    assert.doesNotThrow(() => assertSignallable(99999));
  });

  it("a spawn error is surfaced as ENOENT, never a crash", async () => {
    const dir = makeDirectory();
    let child: SupervisedSpawn | undefined;
    let thrown: unknown;
    try {
      child = spawnSupervised({
        command: tools.paths.git,
        args: ["--version"],
        env: { ...pinnedGitEnvironment, PATH: tools.execPath },
        cwd: join(dir, "missing-cwd"),
        pidFile: join(dir, "git.pid"),
      });
    } catch (error) {
      thrown = error;
    }
    if (child === undefined) {
      assert.equal((thrown as NodeJS.ErrnoException).code, "ENOENT");
      return;
    }
    await assert.rejects(
      child.exited,
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
