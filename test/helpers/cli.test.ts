import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

import { runCli } from "./cli.ts";
import { launchDaemon, killAll } from "./daemon.ts";
import { createTemporaryHome } from "./home.ts";
import { reservePort } from "./port.ts";
import { KANTHORD_VERSION } from "../../src/domain/version.ts";
import { migrations } from "../../src/services/storage/migrations.ts";

const expected = migrations
  .map((entry) => `kanthord: applied ${entry.version} ${entry.name}\n`)
  .join("");

describe("test/helpers/cli.test", () => {
  it("--version prints KANTHORD_VERSION and exits 0", async () => {
    const result = await runCli({ args: ["--version"] });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), KANTHORD_VERSION);
  });

  it("db migrate --home applies every migration, prints one line per entry and writes kanthord.db", async () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const result = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, expected);
    assert.equal(fs.existsSync(join(home.path, "kanthord.db")), true);
  });

  it("a second db migrate over the same home prints kanthord: no change", async () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const first = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(first.code, 0);

    const second = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "kanthord: no change\n");
  });

  it("a home that does not exist yet is created by the home lock", async () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const nested = join(home.path, "nested");
    const result = await runCli({ args: ["db", "migrate", "--home", nested] });

    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(nested), true);
  });

  it("a non-loopback --base-url exits 1 and writes no kanthord.db", async () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const result = await runCli({
      args: [
        "db",
        "migrate",
        "--home",
        home.path,
        "--base-url",
        "https://daemon.example.com",
      ],
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith("kanthord: db-remote-base-url:"));
    assert.equal(fs.existsSync(join(home.path, "kanthord.db")), false);
  });

  it("a live daemon holds the home lock; db migrate is refused until it dies", async () => {
    const home = createTemporaryHome();
    const port = await reservePort();
    const configPath = home.writeConfig({ http: { port } });
    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    after(async () => {
      await killAll();
      home.dispose();
    });

    const daemon = launchDaemon({ home: home.path, configPath });
    await daemon.ready();

    const locked = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(locked.code, 1);
    assert.ok(locked.stderr.startsWith("kanthord: home-locked:"));

    daemon.kill();
    await daemon.exited();

    const afterKill = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(afterKill.code, 0);
  });

  it("with no --home the configured home is used", async () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const result = await runCli({
      args: ["db", "migrate"],
      env: { KANTHORD_CONFIG: home.writeConfig() },
    });

    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(join(home.path, "kanthord.db")), true);
  });
});
