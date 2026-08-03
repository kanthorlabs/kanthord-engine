import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { createTemporaryHome } from "./home.ts";

describe("test/helpers/home.test", () => {
  it("createTemporaryHome returns path that exists and is directory", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const stat = fs.statSync(home.path);
    assert.ok(stat.isDirectory());
  });

  it("writeConfig writes file whose JSON.parse deep-equals base document", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const configPath = home.writeConfig();
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.deepEqual(parsed, {
      home: home.path,
      actor: "ulrich",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: {
        bind: "127.0.0.1",
        port: 7421,
        token: "test-token",
        allowedHosts: ["127.0.0.1:7421"],
      },
      attemptLimit: 3,
    });
  });

  it("writeConfig({ actor: 'someone' }) changes actor, leaves others", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const configPath = home.writeConfig({ actor: "someone" });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(parsed.actor, "someone");
    assert.equal(parsed.home, home.path);
    assert.equal(parsed.masterKey, Buffer.alloc(32, 7).toString("base64"));
    assert.deepEqual(parsed.http, {
      bind: "127.0.0.1",
      port: 7421,
      token: "test-token",
      allowedHosts: ["127.0.0.1:7421"],
    });
    assert.equal(parsed.attemptLimit, 3);
  });

  it("writeConfig({ http: { bind: '0.0.0.0' } }) merges one level deep", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const configPath = home.writeConfig({ http: { bind: "0.0.0.0" } });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(parsed.http.bind, "0.0.0.0");
    assert.equal(parsed.http.port, 7421);
    assert.equal(parsed.http.token, "test-token");
    assert.deepEqual(parsed.http.allowedHosts, ["127.0.0.1:7421"]);
  });

  it("writeConfig({ actor: undefined }) yields no actor key", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    const configPath = home.writeConfig({ actor: undefined });
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(Object.hasOwn(parsed, "actor"), false);
  });

  it("two writeConfig calls: second at base document", () => {
    const home = createTemporaryHome();
    after(() => home.dispose());

    home.writeConfig({ actor: "someone" });
    const configPath = home.writeConfig();
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.deepEqual(parsed, {
      home: home.path,
      actor: "ulrich",
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: {
        bind: "127.0.0.1",
        port: 7421,
        token: "test-token",
        allowedHosts: ["127.0.0.1:7421"],
      },
      attemptLimit: 3,
    });
  });

  it("dispose removes directory, second dispose does not throw", () => {
    const home = createTemporaryHome();
    home.writeConfig();

    home.dispose();
    assert.equal(fs.existsSync(home.path), false);

    assert.doesNotThrow(() => home.dispose());
  });
});
