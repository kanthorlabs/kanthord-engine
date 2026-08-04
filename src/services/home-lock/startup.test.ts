import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { launchDaemon, killAll } from "../../../test/helpers/daemon.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";

describe("src/services/home-lock/startup.test", () => {
  it("ordering proof: a second daemon against a held home refuses to start", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const configPath = home.writeConfig();
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    const second = launchDaemon({ configPath, home: home.path });
    const exit = await second.exited();
    assert.equal(exit.code, 1);
    assert.match(second.stderr(), /home-locked/);
  });

  it("ref lock created after readiness survives SIGTERM", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const configPath = home.writeConfig();
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

  it("two daemons on one home: second exits 1, stderr has home-locked with first pid", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const configPath = home.writeConfig();
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

    const configPath = home.writeConfig();
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

    const configPath = home.writeConfig();
    const first = launchDaemon({ configPath, home: home.path });
    await first.ready();

    first.kill("SIGKILL");
    await first.exited();

    const second = launchDaemon({ configPath, home: home.path });
    await second.ready();

    assert.match(second.stdout(), /^kanthord: ready\n$/);
    assert.equal(second.stderr(), "");
  });

  it("config with http.bind 0.0.0.0 and no token: daemon exits 1, stderr config-refused", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const configPath = home.writeConfig({
      http: { bind: "0.0.0.0", token: "" },
    });
    const proc = launchDaemon({ configPath, home: home.path });
    const exit = await proc.exited();
    assert.equal(exit.code, 1);
    assert.match(proc.stderr(), /^kanthord: config-refused: [^\n]+\n$/);
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
});
