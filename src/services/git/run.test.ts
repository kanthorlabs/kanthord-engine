import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  seedRepositories,
  type SeedRoot,
} from "../../../test/helpers/remote/seed.ts";

import { GitError, type GitPaths } from "./index.ts";
import {
  createGitRunner,
  systemSchedule,
  TERMINATION_GRACE_MS,
  type GitRunner,
  type Schedule,
  type ScheduledTimer,
} from "./run.ts";

const tools: Tools = resolveTools();

const directories: string[] = [];

after(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-run-"));
  directories.push(dir);
  const home = join(dir, "home");
  const keyDirectory = join(dir, "keys");
  const knownHosts = join(dir, "known_hosts");
  const runDirectory = join(dir, "run");
  for (const sub of [home, keyDirectory, knownHosts, runDirectory]) {
    mkdirSync(sub);
  }
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

async function waitForFile(filePath: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

type FakeSchedule = Readonly<{
  schedule: Schedule;
  fire(delayMs: number): void;
  pending(): number[];
}>;

function createFakeSchedule(): FakeSchedule {
  let nextId = 0;
  const timers = new Map<number, { delayMs: number; callback: () => void }>();
  return {
    schedule: (callback: () => void, delayMs: number): ScheduledTimer => {
      const id = nextId++;
      timers.set(id, { delayMs, callback });
      return { cancel: () => timers.delete(id) };
    },
    fire(delayMs: number): void {
      const matches = [...timers.entries()].filter(
        ([, timer]) => timer.delayMs === delayMs,
      );
      assert.equal(matches.length, 1, `expected one timer at ${delayMs}ms`);
      const match = matches[0];
      assert.ok(match !== undefined);
      timers.delete(match[0]);
      match[1].callback();
    },
    pending(): number[] {
      return [...timers.values()]
        .map((timer) => timer.delayMs)
        .sort((a, b) => a - b);
    },
  };
}

let seeded: SeedRoot;

before(() => {
  seeded = seedRepositories(tools);
});

after(() => {
  seeded?.dispose();
});

describe("src/services/git/run.test", () => {
  it("git --version resolves with code 0 and the version banner", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const result = await runGit({ args: ["--version"] });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith("git version "), result.stdout);
  });

  it("systemSchedule is the default and both forms resolve git --version", async () => {
    const paths = makePaths();
    const implicit = createGitRunner(paths);
    const explicit = createGitRunner(paths, systemSchedule);
    const [fromDefault, fromExplicit] = await Promise.all([
      implicit({ args: ["--version"] }),
      explicit({ args: ["--version"] }),
    ]);
    assert.equal(fromDefault.code, 0);
    assert.equal(fromExplicit.code, 0);
    assert.ok(
      fromDefault.stdout.startsWith("git version "),
      fromDefault.stdout,
    );
    assert.ok(
      fromExplicit.stdout.startsWith("git version "),
      fromExplicit.stdout,
    );
  });

  it("the child sees the pinned environment and the config pins", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const vars = await runGit({ args: ["var", "-l"] });
    assert.ok(
      vars.stdout.split("\n").includes("GIT_CONFIG_GLOBAL=/dev/null"),
      vars.stdout,
    );
    const hooks = await runGit({ args: ["config", "--get", "core.hooksPath"] });
    assert.equal(hooks.stdout.trim(), "/dev/null");
    const maintenance = await runGit({
      args: ["config", "--get", "maintenance.auto"],
    });
    assert.equal(maintenance.stdout.trim(), "false");
    const gc = await runGit({ args: ["config", "--get", "gc.auto"] });
    assert.equal(gc.stdout.trim(), "0");
  });

  it("an operator config does not reach the child", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const hostileHome = mkdtempSync(join(tmpdir(), "kanthord-hostile-"));
    directories.push(hostileHome);
    writeFileSync(
      join(hostileHome, ".gitconfig"),
      "[user]\n\tname = hostile\n[core]\n\thooksPath = /tmp/evil\n",
    );
    const previousHome = process.env.HOME;
    process.env.HOME = hostileHome;
    try {
      const name = await runGit({ args: ["config", "--get", "user.name"] });
      assert.notEqual(name.code, 0);
      assert.equal(name.stdout, "");
      const hooks = await runGit({
        args: ["config", "--get", "core.hooksPath"],
      });
      assert.equal(hooks.stdout.trim(), "/dev/null");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("result.args is what the caller passed, never the vector", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const result = await runGit({ args: ["--version"] });
    assert.deepEqual(result.args, ["--version"]);
    assert.equal(result.args.includes("-c"), false);
  });

  it("a non-zero exit resolves and does not throw", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const result = await runGit({
      args: [
        "--git-dir=" + join(paths.home, "absent.git"),
        "rev-parse",
        "HEAD",
      ],
    });
    assert.notEqual(result.code, 0);
    assert.notEqual(result.stderr, "");
  });

  it("the timeout signals the group and no descendant survives", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const sshPidPath = join(paths.home, "ssh.pid");
    const scriptPath = join(paths.home, "ssh-sleeper.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s' "$$" > '${sshPidPath}'\n/bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const pending = runGit({
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      extraEnv: { GIT_SSH_COMMAND: `'${scriptPath}'` },
      timeoutMs: 4242,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForFile(sshPidPath, 4000);
    const sshPid = Number(readFileSync(sshPidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(sshPid, 0));
    fake.fire(4242);
    const rejection = await pending;
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "timed-out");
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

  it("the grace timer is registered with TERMINATION_GRACE_MS", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const sshPidPath = join(paths.home, "ssh.pid");
    const scriptPath = join(paths.home, "ssh-sleeper.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s' "$$" > '${sshPidPath}'\ntrap '' TERM\n/bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const pending = runGit({
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      extraEnv: { GIT_SSH_COMMAND: `'${scriptPath}'` },
      timeoutMs: 4242,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForFile(sshPidPath, 4000);
    const sshPid = Number(readFileSync(sshPidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(sshPid, 0));
    fake.fire(4242);
    assert.deepEqual(fake.pending(), [TERMINATION_GRACE_MS]);
    fake.fire(TERMINATION_GRACE_MS);
    const rejection = await pending;
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "timed-out");
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

  it("the timeout error carries neither environment nor key directory", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const scriptPath = join(paths.home, "ssh-sleeper.sh");
    writeFileSync(scriptPath, `#!/bin/sh\n/bin/sleep 30\n`, { mode: 0o700 });
    const pending = runGit({
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      extraEnv: { GIT_SSH_COMMAND: `'${scriptPath}'` },
      timeoutMs: 4242,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    fake.fire(4242);
    const rejection = await pending;
    assert.ok(rejection instanceof GitError, String(rejection));
    const serialized = JSON.stringify({
      message: rejection.message,
      detail: rejection.detail,
    });
    assert.ok(!serialized.includes("GIT_CONFIG_GLOBAL"), serialized);
    assert.ok(!serialized.includes(paths.keyDirectory), serialized);
    assert.deepEqual(Object.keys(rejection).sort(), [
      "detail",
      "failure",
      "name",
    ]);
  });

  it("the output bound kills rather than truncates", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const fixture = seeded.repositories["fixture.git"];
    assert.ok(fixture !== undefined);
    const fixtureHome = fixture.path;
    const rejection = await runGit({
      args: ["--git-dir=" + fixtureHome, "log", "--format=%H%n%s"],
      outputLimitBytes: 64,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "output-exceeded");
    assert.deepEqual(Object.keys(rejection).sort(), [
      "detail",
      "failure",
      "name",
    ]);
    const serialized = JSON.stringify({
      message: rejection.message,
      detail: rejection.detail,
    });
    assert.ok(!serialized.includes("GIT_CONFIG_GLOBAL"), serialized);
    assert.ok(!serialized.includes(paths.keyDirectory), serialized);
  });

  it("the bound outranks the timeout", async () => {
    const paths = makePaths();
    const fakeGit = join(paths.home, "fake-git.mjs");
    writeFileSync(
      fakeGit,
      [
        `#!${process.execPath}`,
        'import process from "node:process";',
        'if (process.argv.includes("--version")) process.exit(0);',
        "process.stdout.write(Buffer.alloc(4096, 0x78));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o700 },
    );
    const fake = createFakeSchedule();
    const runner = createGitRunner({ ...paths, git: fakeGit }, fake.schedule);
    await runner({ args: ["--version"] });
    const rejection = await runner({
      args: ["log"],
      outputLimitBytes: 64,
      timeoutMs: 1500,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "output-exceeded");
    assert.deepEqual(fake.pending(), []);
  });

  it("a cancelled operation ends even when a descendant holds the pipe", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const scriptPath = join(paths.home, "ssh-spewer.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nhead -c 524288 /dev/zero >&2\n/bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const startedAt = Date.now();
    const pending = runGit({
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      extraEnv: { GIT_SSH_COMMAND: `'${scriptPath}'` },
      timeoutMs: 4242,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    fake.fire(4242);
    const rejection = await pending;
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "timed-out");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  });

  it("a minted pid file is removed; a supplied one is not", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const minted = await runGit({ args: ["--version"] });
    assert.equal(minted.code, 0);
    assert.deepEqual(readdirSync(paths.runDirectory), []);
    const keptPath = join(paths.home, "kept.pid");
    const supplied = await runGit({
      args: ["--version"],
      pidFile: keptPath,
    });
    assert.equal(supplied.code, 0);
    assert.equal(existsSync(keptPath), true);
    const recorded = Number(readFileSync(keptPath, "utf8"));
    assert.ok(Number.isInteger(recorded) && recorded > 1, String(recorded));
  });

  it("the timeout is registered with the caller's timeoutMs", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const pending = runGit({ args: ["--version"], timeoutMs: 4242 });
    assert.deepEqual(fake.pending(), [4242]);
    const result = await pending;
    assert.equal(result.code, 0);
    assert.deepEqual(fake.pending(), []);
  });

  it("a settled run cancels both timers", async () => {
    const paths = makePaths();
    const fake = createFakeSchedule();
    const runGit: GitRunner = createGitRunner(paths, fake.schedule);
    const clean = await runGit({ args: ["--version"], timeoutMs: 4242 });
    assert.equal(clean.code, 0);
    assert.deepEqual(fake.pending(), []);
    const scriptPath = join(paths.home, "ssh-sleeper.sh");
    writeFileSync(scriptPath, `#!/bin/sh\n/bin/sleep 30\n`, { mode: 0o700 });
    const pending = runGit({
      args: ["ls-remote", "ssh://kanthord.invalid/r.git"],
      extraEnv: { GIT_SSH_COMMAND: `'${scriptPath}'` },
      timeoutMs: 4242,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    fake.fire(4242);
    fake.fire(TERMINATION_GRACE_MS);
    const rejection = await pending;
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "timed-out");
    assert.deepEqual(fake.pending(), []);
  });

  it("a launcher pid-file failure is classified as unknown", async () => {
    const paths = makePaths();
    const runGit: GitRunner = createGitRunner(paths);
    const takenPath = join(paths.home, "taken.pid");
    writeFileSync(takenPath, "4321");
    const rejection = await runGit({
      args: ["--version"],
      pidFile: takenPath,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "unknown");
    assert.equal(
      rejection.message,
      "the launcher could not create the pid file",
    );
  });

  it("an orphaned launcher exit is classified as unknown", async () => {
    const paths = makePaths();
    const fakeGit = join(paths.home, "orphaned-git.mjs");
    writeFileSync(
      fakeGit,
      [`#!${process.execPath}`, "process.exit(112);"].join("\n"),
      { mode: 0o700 },
    );
    const runner = createGitRunner({ ...paths, git: fakeGit });
    const rejection = await runner({ args: ["--version"] }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof GitError, String(rejection));
    assert.equal(rejection.failure, "unknown");
    assert.equal(
      rejection.message,
      "the launcher was orphaned before it started git",
    );
  });
});
