import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { searchOrder } from "./search-order.ts";

describe("src/services/config/search-order.test", () => {
  it("empty env, etcDir /fixture-etc → three paths in order", () => {
    const cwd = "/project";
    const homeDir = "/home/user";
    const result = searchOrder({
      env: {},
      cwd,
      homeDir,
      etcDir: "/fixture-etc",
    });

    assert.deepEqual(result, [
      path.join(cwd, "kanthord.config.json"),
      path.join(homeDir, ".config/kanthord/config.json"),
      "/fixture-etc/kanthord/config.json",
    ]);
  });

  it("KANTHORD_CONFIG=/tmp/a.json prepends that path giving four entries", () => {
    const cwd = "/project";
    const homeDir = "/home/user";
    const result = searchOrder({
      env: { KANTHORD_CONFIG: "/tmp/a.json" },
      cwd,
      homeDir,
      etcDir: "/fixture-etc",
    });

    assert.equal(result.length, 4);
    assert.equal(result[0], "/tmp/a.json");
    assert.deepEqual(result.slice(1), [
      path.join(cwd, "kanthord.config.json"),
      path.join(homeDir, ".config/kanthord/config.json"),
      "/fixture-etc/kanthord/config.json",
    ]);
  });

  it("KANTHORD_CONFIG=rel.json resolves against cwd", () => {
    const cwd = "/project";
    const homeDir = "/home/user";
    const result = searchOrder({
      env: { KANTHORD_CONFIG: "rel.json" },
      cwd,
      homeDir,
      etcDir: "/fixture-etc",
    });

    assert.equal(result[0], path.join(cwd, "rel.json"));
  });

  it("XDG_CONFIG_HOME=/xdg replaces the third entry", () => {
    const cwd = "/project";
    const homeDir = "/home/user";
    const result = searchOrder({
      env: { XDG_CONFIG_HOME: "/xdg" },
      cwd,
      homeDir,
      etcDir: "/fixture-etc",
    });

    assert.deepEqual(result, [
      path.join(cwd, "kanthord.config.json"),
      "/xdg/kanthord/config.json",
      "/fixture-etc/kanthord/config.json",
    ]);
  });

  it("KANTHORD_CONFIG='' is treated as unset", () => {
    const cwd = "/project";
    const homeDir = "/home/user";
    const result = searchOrder({
      env: { KANTHORD_CONFIG: "" },
      cwd,
      homeDir,
      etcDir: "/fixture-etc",
    });

    assert.deepEqual(result, [
      path.join(cwd, "kanthord.config.json"),
      path.join(homeDir, ".config/kanthord/config.json"),
      "/fixture-etc/kanthord/config.json",
    ]);
  });
});
