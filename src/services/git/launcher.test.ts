import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
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
  LAUNCHER_SHELL,
  READY_FD,
  spawnSupervised,
} from "./launcher.ts";
import type {
  SupervisedChild,
  SupervisedExit,
  SupervisedSpawn,
} from "./launcher.ts";

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

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

async function spawnSleepingSsh(
  dir: string,
): Promise<Readonly<{ child: SupervisedChild; sshPidPath: string }>> {
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
  await waitForFile(sshPidPath);
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

function spawnGatedLauncher(dir: string): Readonly<{
  child: ChildProcess;
  exited: Promise<SupervisedExit>;
  ready: Readable;
  marker: string;
  pidFile: string;
}> {
  const marker = join(dir, "marker");
  const pidFile = join(dir, "git.pid");
  const child = spawn(
    LAUNCHER_SHELL,
    launcherArgv({
      command: "/bin/sh",
      args: ["-c", `printf x > '${marker}'`],
    }),
    {
      env: {
        ...pinnedGitEnvironment,
        PATH: tools.execPath,
        KANTHORD_PID_FILE: pidFile,
      },
      cwd: dir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<SupervisedExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const ready = child.stdio[READY_FD] as Readable;
  return { child, exited, ready, marker, pidFile };
}

function spawnOrphanedLauncher(dir: string): Readonly<{
  child: ChildProcess;
  exited: Promise<SupervisedExit>;
  marker: string;
  pidFile: string;
}> {
  const launcher = spawnGatedLauncher(dir);
  launcher.child.stdin?.destroy();
  return launcher;
}

function waitForExit(pid: number): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.fail(`timed out waiting for ${pid} to exit`);
}

describe("src/services/git/launcher.test", () => {
  it("launcherArgv pins the exact argument vector", () => {
    assert.deepEqual(
      launcherArgv({ command: tools.paths.git, args: ["--version"] }),
      [
        "-c",
        'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; printf r >&3; exec 3>&-; read -r _ || exit 112; exec 0</dev/null; exec "$@"',
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
    const { child } = await spawnSleepingSsh(dir);
    const recorded = Number(readFileSync(join(dir, "git.pid"), "utf8"));
    assert.equal(recorded, child.pid);
    assert.equal(processName(recorded), "git");
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("the child leads its own process group", async () => {
    const dir = makeDirectory();
    const { child } = await spawnSleepingSsh(dir);
    assert.equal(processGroupId(child.pid), child.pid);
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("the group signal reaches the descendant", async () => {
    const dir = makeDirectory();
    const { child, sshPidPath } = await spawnSleepingSsh(dir);
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
    const { child, sshPidPath } = await spawnSleepingSsh(dir);
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

  it("a clean git --version completes through the handshake", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "git.pid");
    const child = spawnSupervised({
      command: tools.paths.git,
      args: ["--version"],
      env: { ...pinnedGitEnvironment, PATH: tools.execPath },
      cwd: dir,
      pidFile,
    });
    assert.ok(child.pid !== undefined, "the child must have a pid");
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.ok(
      Buffer.concat(stdoutChunks).toString("utf8").startsWith("git version "),
      "stdout must hold the version banner",
    );
  });

  it("git does not inherit the handshake pipe on stdin", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "git.pid");
    const child = spawnSupervised({
      command: tools.paths.git,
      args: ["hash-object", "--stdin"],
      env: { ...pinnedGitEnvironment, PATH: tools.execPath },
      cwd: dir,
      pidFile,
    });
    assert.ok(child.pid !== undefined, "the child must have a pid");
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.equal(
      Buffer.concat(stdoutChunks).toString("utf8").trim(),
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("an orphaned launcher exits 112 and never runs the command", async () => {
    const dir = makeDirectory();
    const { exited, marker, pidFile } = spawnOrphanedLauncher(dir);
    assert.deepEqual(await exited, { code: 112, signal: null });
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(pidFile), true);
  });

  it("the readiness byte reaches the parent only after the pid file exists", async () => {
    const dir = makeDirectory();
    const { child, exited, ready, marker, pidFile } = spawnGatedLauncher(dir);
    const reported = await new Promise<Buffer>((resolve) => {
      ready.once("data", (chunk: Buffer) => resolve(chunk));
    });
    assert.equal(reported.toString("utf8"), "r");
    assert.equal(existsSync(pidFile), true);
    assert.equal(readFileSync(pidFile, "utf8"), String(child.pid));
    assert.equal(existsSync(marker), false);
    child.stdin?.destroy();
    assert.deepEqual(await exited, { code: 112, signal: null });
    assert.equal(existsSync(marker), false);
  });

  it("a launcher held before its pid write runs no command once its daemon dies", () => {
    const dir = makeDirectory();
    const marker = join(dir, "marker");
    const pidFile = join(dir, "git.pid");
    execFileSync("/bin/sh", ["-c", `mkfifo '${pidFile}'`], {
      env: { PATH: "/usr/bin:/bin" },
    });
    const launcherModule = new URL("./launcher.ts", import.meta.url).href;
    const source = [
      `import { spawnSupervised } from ${JSON.stringify(launcherModule)};`,
      `spawnSupervised({`,
      `  command: "/bin/sh",`,
      `  args: ["-c", ${JSON.stringify(`printf x > '${marker}'`)}],`,
      `  env: { PATH: ${JSON.stringify(tools.execPath)} },`,
      `  cwd: ${JSON.stringify(dir)},`,
      `  pidFile: ${JSON.stringify(pidFile)},`,
      `});`,
      `setTimeout(() => process.exit(0), 200);`,
    ].join("\n");
    const daemon = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { encoding: "utf8" },
    );
    assert.equal(daemon.status, 0, daemon.stderr);
    const launcherPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(launcherPid > 1, "the held launcher must report its pid");
    waitForExit(launcherPid);
    assert.equal(existsSync(marker), false);
  });

  it("the pid write precedes the gate", async () => {
    const dir = makeDirectory();
    const { child, exited, pidFile } = spawnOrphanedLauncher(dir);
    assert.deepEqual(await exited, { code: 112, signal: null });
    assert.equal(readFileSync(pidFile, "utf8"), String(child.pid));
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
