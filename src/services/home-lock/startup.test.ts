import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

import {
  killAll,
  launchDaemon,
  type DaemonExit,
  type DaemonProcess,
} from "../../../test/helpers/daemon.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import {
  FIXTURE_REPOSITORY_ID,
  seedFixtureRepository,
} from "../../../test/helpers/recovery-home.ts";

const mainEntry = fileURLToPath(
  new URL("../../../src/main.ts", import.meta.url),
);

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

function migrateHome(homePath: string): void {
  const result = spawnSync(
    process.execPath,
    [mainEntry, "db", "migrate", "--home", homePath],
    { env: {} },
  );
  assert.equal(result.status, 0, result.stderr?.toString() ?? "");
}

function exitWithin(proc: DaemonProcess, ms = 5000): Promise<DaemonExit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "the daemon did not exit in time; expected the migration gate to refuse it",
        ),
      );
    }, ms);
    proc.exited().then(
      (exit) => {
        clearTimeout(timer);
        resolve(exit);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForPidFile(filePath: string): number {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return Number(fs.readFileSync(filePath, "utf8"));
    } catch {
      // the pid file has not been written yet
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

describe("src/services/home-lock/startup.test", () => {
  it("ordering proof: a second daemon against a held home refuses to start and never binds", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    const second = launchDaemon({ configPath, home: home.path });
    const exit = await second.exited();
    assert.equal(exit.code, 1);
    assert.match(second.stderr(), /home-locked/);

    first.kill("SIGTERM");
    await first.exited();
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/v1/health`),
      (error: unknown) =>
        (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED",
    );
  });

  it("a daemon on a configured loopback port answers over a real fetch with its host check live", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({
      http: { port, allowedHosts: [`127.0.0.1:${port}`] },
    });
    migrateHome(home.path);

    const proc = launchDaemon({ configPath, home: home.path });
    await proc.ready();

    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unauthenticated");

    const authorized = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
      status: "ok",
      dependencies: [{ name: "storage", status: "ok" }],
    });
  });

  it("a daemon whose allow list does not match the bound address answers 403 host-forbidden", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({
      http: { port, allowedHosts: ["kanthord.test"] },
    });
    migrateHome(home.path);

    const proc = launchDaemon({ configPath, home: home.path });
    await proc.ready();

    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "host-forbidden");
  });

  it("ref lock created after readiness survives SIGTERM", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    const lateLock = path.join(
      home.path,
      "repos",
      "a.git",
      "refs",
      "heads",
      "main.lock",
    );
    fs.mkdirSync(path.dirname(lateLock), { recursive: true });
    fs.writeFileSync(lateLock, "");
    assert.ok(fs.existsSync(lateLock));

    first.kill("SIGTERM");
    await first.exited();
    assert.ok(
      fs.existsSync(lateLock),
      "lock created after readiness must survive exit",
    );
  });

  it("ordering proof: a stale ref lock is gone before the daemon reports ready", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const { lockPath } = seedFixtureRepository(home.path);
    fs.writeFileSync(lockPath, "");

    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    assert.equal(
      fs.existsSync(lockPath),
      false,
      "the stale lock must be gone before readiness",
    );
    assert.equal(first.stdout(), "kanthord: ready\n");
    assert.equal(first.stderr(), "");
  });

  it("composed proof: a live recorded child is stopped before its lock is removed", async () => {
    const home = createTemporaryHome();
    let childPid: number | undefined;
    after(async () => {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // the child is already gone
        }
      }
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const { lockPath } = seedFixtureRepository(home.path);
    fs.writeFileSync(lockPath, "");

    const runDirectory = path.join(home.path, "git", "run");
    fs.mkdirSync(runDirectory, { recursive: true });
    const pidPath = path.join(
      runDirectory,
      `seed-${FIXTURE_REPOSITORY_ID}.pid`,
    );
    spawn(
      "/bin/sh",
      ["-c", 'printf "%s" "$$" > "$1"; exec /bin/sleep 30', "sh", pidPath],
      { detached: true },
    );
    childPid = waitForPidFile(pidPath);

    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    assert.equal(
      fs.existsSync(lockPath),
      false,
      "the lock must be removed only after the reap stopped the child",
    );
    assert.throws(
      () => process.kill(childPid as number, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.equal(
      fs.existsSync(pidPath),
      false,
      "the reaped child's pid file must be removed",
    );

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(home.path, "kanthord.db"));
    try {
      const row = database
        .prepare(
          "SELECT subject_id, payload_json FROM event WHERE type = 'recovery.childReaped'",
        )
        .get() as { subject_id: string; payload_json: string } | undefined;
      assert.ok(
        row !== undefined,
        "one recovery.childReaped event row must exist",
      );
      assert.equal(row!.subject_id, FIXTURE_REPOSITORY_ID);
      const payload = JSON.parse(row!.payload_json) as { finding: string };
      assert.equal(payload.finding, "stopped");
    } finally {
      database.close();
    }
  });

  it("two daemons on one home: second exits 1, stderr has home-locked with first pid", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    const identityPath = path.join(home.path, "daemon.lock.identity");
    assert.ok(
      fs.existsSync(identityPath),
      "identity must exist after readiness",
    );
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));

    const second = launchDaemon({ configPath, home: home.path });
    const exit = await second.exited();
    assert.equal(exit.code, 1);
    assert.match(second.stderr(), /^kanthord: home-locked: [^\n]+\n$/);
    assert.match(second.stderr(), new RegExp(String(identity.pid)));
  });

  it("second node:sqlite database at kanthord.db works while first daemon holds lock", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = path.join(home.path, "kanthord.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("INSERT INTO t (v) VALUES ('hello')");
    const row: any = db.prepare("SELECT v FROM t WHERE id = 1").get();
    assert.equal(row.v, "hello");
    db.close();
  });

  it("first daemon SIGKILL: second daemon reaches readiness with no cleanup step", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    first.kill("SIGKILL");
    await first.exited();

    const second = launchDaemon({ configPath, home: home.path });
    await second.ready();

    assert.match(second.stdout(), /^kanthord: ready\n$/);
    assert.equal(second.stderr(), "");
  });

  it("config with http.bind 0.0.0.0 and no token: daemon exits 1, stderr config-refused, port never bound", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({
      http: { bind: "0.0.0.0", token: "", port },
    });
    const proc = launchDaemon({ configPath, home: home.path });
    const exit = await proc.exited();
    assert.equal(exit.code, 1);
    assert.match(proc.stderr(), /^kanthord: config-refused: [^\n]+\n$/);
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/v1/health`),
      (error: unknown) =>
        (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED",
    );
  });

  it("no config found: daemon exits 1, stderr config-not-found names every candidate path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanthord-startup-"));
    after(async () => {
      await killAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    assert.ok(
      !fs.existsSync("/etc/kanthord/config.json"),
      "this test assumes /etc/kanthord/config.json does not exist; if it does, the test must fail with a message naming it",
    );

    const xdgHome = path.join(tmpDir, "xdg-config");
    fs.mkdirSync(xdgHome);

    const proc = launchDaemon({
      env: { HOME: tmpDir, XDG_CONFIG_HOME: xdgHome },
      cwd: tmpDir,
    });
    const exit = await proc.exited();
    assert.equal(exit.code, 1);
    assert.match(proc.stderr(), /^kanthord: config-not-found: [^\n]+\n$/);
    assert.match(proc.stderr(), /kanthord\.config\.json/);
    assert.match(
      proc.stderr(),
      new RegExp(xdgHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(proc.stderr(), /\/etc\/kanthord\/config\.json/);
  });

  it("the daemon refuses an unmigrated database", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const configPath = home.writeConfig();
    const proc = launchDaemon({ configPath, home: home.path });
    const exit = await exitWithin(proc);
    assert.equal(exit.code, 1);
    assert.match(proc.stderr(), /^kanthord: db-migration-pending: [^\n]+\n$/);
    assert.match(proc.stderr(), /kanthord db migrate/);
    assert.ok(!proc.stdout().includes("kanthord: ready"));
  });

  it("the daemon starts after db migrate on the same home", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    assert.ok(
      fs.existsSync(path.join(home.path, "kanthord.db")),
      "kanthord.db must exist after db migrate and before the launch",
    );
    const proc = launchDaemon({ configPath, home: home.path });
    await proc.ready();
    assert.equal(proc.stderr(), "");
  });

  it("a config naming a missing tool refuses startup before ready", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({
      tools: { git: "/nonexistent/git" },
      http: { port },
    });
    migrateHome(home.path);
    const proc = launchDaemon({ configPath, home: home.path });
    const exit = await exitWithin(proc);
    assert.equal(exit.code, 1);
    assert.match(proc.stderr(), /^kanthord: tool-missing: [^\n]+\n$/);
    assert.equal(proc.stdout(), "");
  });
});
