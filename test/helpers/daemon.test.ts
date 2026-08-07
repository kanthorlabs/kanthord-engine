import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchDaemon, killAll } from "./daemon.ts";
import { createTemporaryHome } from "./home.ts";
import { reservePort } from "./port.ts";

const mainEntry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

function migrateHome(homePath: string): void {
  const result = spawnSync(
    process.execPath,
    [mainEntry, "db", "migrate", "--home", homePath],
    { env: {} },
  );
  assert.equal(result.status, 0, result.stderr?.toString() ?? "");
}

describe("test/helpers/daemon.test", () => {
  it("daemon with config reaches ready(), stdout holds kanthord: ready", async () => {
    const home = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    after(async () => {
      await killAll();
      home.dispose();
    });

    const proc = launchDaemon({ configPath });
    await proc.ready();

    assert.ok(proc.stdout().includes("kanthord: ready"));
  });

  it("kill(SIGTERM) makes the daemon exit 0", async () => {
    const home = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    after(async () => {
      await killAll();
      home.dispose();
    });

    const proc = launchDaemon({ configPath });
    await proc.ready();

    proc.kill("SIGTERM");
    const exit = await proc.exited();

    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  });

  it("two exited() calls on one daemon resolve with the same object", async () => {
    const home = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    after(async () => {
      await killAll();
      home.dispose();
    });

    const proc = launchDaemon({ configPath });
    await proc.ready();

    proc.kill("SIGTERM");
    const first = await proc.exited();
    const second = await proc.exited();

    assert.equal(first, second);
  });

  it("exited() called after the process already exited resolves rather than hanging", async () => {
    const home = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(home.path);
    after(async () => {
      await killAll();
      home.dispose();
    });

    const proc = launchDaemon({ configPath });
    await proc.ready();

    proc.kill("SIGTERM");
    await proc.exited();

    const exit = await proc.exited();
    assert.equal(exit.code, 0);
  });

  it("daemon with no config, empty env, empty cwd exits non-zero, ready rejects", async () => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-test-"));
    after(async () => {
      await killAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    assert.equal(
      fs.existsSync("/etc/kanthord/config.json"),
      false,
      "this test assumes /etc/kanthord/config.json does not exist",
    );

    const proc = launchDaemon({ env: {}, cwd: tmpDir });
    const exit = await proc.exited();

    assert.notEqual(exit.code, 0);
    await assert.rejects(
      () => proc.ready(),
      (err: Error) => {
        assert.ok(err.message.length > 0);
        return true;
      },
    );
  });

  it("--home reaches process: creates daemon.lock.db in second home", async () => {
    const home = createTemporaryHome();
    const secondHome = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    migrateHome(secondHome.path);
    after(async () => {
      await killAll();
      home.dispose();
      secondHome.dispose();
    });

    const proc = launchDaemon({ configPath, home: secondHome.path });
    await proc.ready();

    const lockPath = join(secondHome.path, "daemon.lock.db");
    assert.ok(fs.existsSync(lockPath));
  });

  it("killAll() with two live daemons resolves", async () => {
    const home1 = createTemporaryHome();
    const home2 = createTemporaryHome();
    const port1 = await reservePort();
    const port2 = await reservePort();
    const configPath1 = home1.writeConfig({ http: { port: port1 } });
    const configPath2 = home2.writeConfig({ http: { port: port2 } });
    migrateHome(home1.path);
    migrateHome(home2.path);
    after(async () => {
      await killAll();
      home1.dispose();
      home2.dispose();
    });

    const proc1 = launchDaemon({ configPath: configPath1, home: home1.path });
    const proc2 = launchDaemon({ configPath: configPath2, home: home2.path });

    await Promise.all([proc1.ready(), proc2.ready()]);

    await killAll();

    const [exit1, exit2] = await Promise.all([proc1.exited(), proc2.exited()]);
    assert.ok(exit1.signal !== null || exit1.code !== null);
    assert.ok(exit2.signal !== null || exit2.code !== null);
  });
});
