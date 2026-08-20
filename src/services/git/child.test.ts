import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import { pinnedGitEnvironment } from "../../../test/helpers/remote/seed.ts";

import { spawnSupervised } from "./launcher.ts";
import type { SupervisedChild } from "./launcher.ts";
import { inspectChild, parseLstart, resolvePs, stopChild } from "./child.ts";
import type { ChildInspection } from "./index.ts";
import { RecoveryError } from "../../domain/recovery.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-child-"));
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

function waitPastSecondBoundary(mtimeMs: number): void {
  const target = (Math.floor(mtimeMs / 1000) + 1) * 1000;
  while (Date.now() < target) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function pollEsrch(pid: number): void {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } catch {
      return;
    }
  }
  assert.fail(`process ${String(pid)} did not exit`);
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

describe("src/services/git/child.test", () => {
  it("parseLstart turns a padded single-space line into epoch seconds", () => {
    assert.equal(
      parseLstart("Tue Aug  5 10:23:41 2026"),
      Date.UTC(2026, 7, 5, 10, 23, 41) / 1000,
    );
    assert.equal(
      parseLstart("Wed Jan 15 00:00:00 2025"),
      Date.UTC(2025, 0, 15, 0, 0, 0) / 1000,
    );
  });

  it("parseLstart returns null for anything that is not a full lstart line", () => {
    assert.equal(parseLstart(""), null);
    assert.equal(parseLstart("not a date"), null);
    assert.equal(parseLstart("Tue Aug 5 10:23:41"), null);
  });

  it("resolvePs refuses an unsupported platform and finds a real ps on this one", () => {
    assert.throws(
      () => resolvePs("win32"),
      (error: unknown) =>
        error instanceof RecoveryError &&
        error.code === "platform-unsupported" &&
        error.message.includes("win32"),
    );
    const ps = resolvePs(process.platform);
    assert.doesNotThrow(() => accessSync(ps, constants.X_OK));
  });

  it("inspectChild on a missing path finds no pid file", async () => {
    const dir = makeDirectory();
    assert.deepEqual(await inspectChild({ pidFile: join(dir, "none.pid") }), {
      finding: "no-pid-file",
    });
  });

  it("inspectChild on a directory reports an unreadable pid file", async () => {
    const dir = makeDirectory();
    const inspection = await inspectChild({ pidFile: dir });
    assert.equal(inspection.finding, "pid-file-unreadable");
  });

  it("inspectChild on a file that is not a signallable pid reports unreadable", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "bad.pid");
    writeFileSync(pidFile, "1");
    assert.equal(
      (await inspectChild({ pidFile })).finding,
      "pid-file-unreadable",
    );
    writeFileSync(pidFile, "abc");
    assert.equal(
      (await inspectChild({ pidFile })).finding,
      "pid-file-unreadable",
    );
  });

  it("inspectChild on a pid that has already exited finds no process", async () => {
    const dir = makeDirectory();
    const child = spawnSupervised({
      command: "/bin/sh",
      args: ["-c", "exit 0"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      pidFile: join(dir, "dead.pid"),
    });
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    assert.ok(child.pid !== undefined, "the exited child must have a pid");
    const pidFile = join(dir, "exited.pid");
    writeFileSync(pidFile, String(child.pid));
    assert.deepEqual(await inspectChild({ pidFile }), {
      finding: "process-absent",
      pid: child.pid,
    });
  });

  it("inspectChild on a live child finds it alive", async () => {
    const dir = makeDirectory();
    const { child } = await spawnSleepingSsh(dir);
    const pidFile = join(dir, "git.pid");
    assert.deepEqual(await inspectChild({ pidFile }), {
      finding: "alive",
      pid: child.pid,
      pidFile,
    });
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("inspectChild on a pid file older than its process reports a reused pid", async () => {
    const dir = makeDirectory();
    const pidFile = join(dir, "reused.pid");
    writeFileSync(pidFile, "2");
    const recorded = statSync(pidFile);
    waitPastSecondBoundary(recorded.mtimeMs);
    const { child } = await spawnSleepingSsh(dir);
    writeFileSync(pidFile, String(child.pid));
    utimesSync(pidFile, recorded.atime, recorded.mtime);
    const ps = resolvePs(process.platform);
    const startLine = execFileSync(
      ps,
      ["-o", "lstart=", "-p", String(child.pid)],
      {
        encoding: "utf8",
      },
    );
    const startSeconds = parseLstart(startLine);
    assert.ok(startSeconds !== null, "the child start time must parse");
    assert.ok(
      startSeconds > Math.floor(recorded.mtimeMs / 1000),
      "the process must start after the recorded time",
    );
    const inspection = await inspectChild({ pidFile });
    assert.equal(inspection.finding, "started-later");
    assert.equal(inspection.pid, child.pid);
    assert.ok(inspection.startedAt > inspection.recordedAt);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("inspectChild reports liveness-unknown when the start time cannot be read", async () => {
    const dir = makeDirectory();
    const { child } = await spawnSleepingSsh(dir);
    const pidFile = join(dir, "git.pid");
    chmodSync(dir, 0o500);
    let inspection: ChildInspection;
    try {
      inspection = await inspectChild({ pidFile });
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(inspection.finding, "liveness-unknown");
    assert.equal(inspection.pid, child.pid);
    child.signalGroup("SIGTERM");
    await child.exited;
  });

  it("stopChild ends the whole group, descendant included", async () => {
    const dir = makeDirectory();
    const { child, sshPidPath } = await spawnSleepingSsh(dir);
    const sshPid = Number(readFileSync(sshPidPath, "utf8"));
    assert.equal(await stopChild({ pid: child.pid, graceMs: 2000 }), true);
    assert.throws(
      () => process.kill(child.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.throws(
      () => process.kill(-child.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    pollEsrch(sshPid);
  });

  it("stopChild on a pid that does not exist returns true", async () => {
    assert.equal(await stopChild({ pid: 999999999, graceMs: 50 }), true);
  });

  it("stopChild escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const dir = makeDirectory();
    const trappedPath = join(dir, "trapped");
    const scriptPath = join(dir, "ignore-term.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\ntrap "" TERM\n: > '${trappedPath}'\nexec /bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const child = spawnSupervised({
      command: scriptPath,
      args: [],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      pidFile: join(dir, "git.pid"),
    });
    assert.ok(child.pid !== undefined, "the child must have a pid");
    await child.released;
    await waitForFile(trappedPath);
    assert.equal(
      groupAlive(child.pid),
      true,
      "the child group must run before the signal",
    );

    process.kill(-child.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      groupAlive(child.pid),
      true,
      "the child must survive SIGTERM, otherwise the escalation is untested",
    );

    assert.equal(await stopChild({ pid: child.pid, graceMs: 50 }), true);
    assert.equal(
      groupAlive(child.pid),
      false,
      "the SIGKILL path must remove the group",
    );
  });

  it("stopChild keeps polling after the leader exits while a descendant survives", async () => {
    const dir = makeDirectory();
    const descPidPath = join(dir, "desc.pid");
    const scriptPath = join(dir, "leader-exits.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\ntrap "" TERM\n/bin/sleep 30 &\nprintf '%s' "$!" > '${descPidPath}'\nexec /bin/sleep 0.1\n`,
      { mode: 0o700 },
    );
    const child = spawnSupervised({
      command: scriptPath,
      args: [],
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      pidFile: join(dir, "git.pid"),
    });
    assert.ok(child.pid !== undefined, "the child must have a pid");
    await child.released;
    await waitForFile(descPidPath);
    const descPid = Number(readFileSync(descPidPath, "utf8"));
    assert.equal(
      processAlive(descPid),
      true,
      "the descendant must run before the signal",
    );

    assert.equal(await stopChild({ pid: child.pid, graceMs: 200 }), true);
    assert.equal(
      processAlive(descPid),
      false,
      "the group poll must not answer while the descendant survives",
    );
  });

  it("stopChild refuses a pid that cannot name a group", async () => {
    await assert.rejects(() => stopChild({ pid: 1, graceMs: 50 }), {
      message: "a supervised pid must be greater than 1",
    });
  });
});
