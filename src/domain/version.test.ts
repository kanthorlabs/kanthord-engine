import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { KANTHORD_VERSION } from "./version.ts";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("src/domain/version.test", () => {
  it("KANTHORD_VERSION equals the version field of package.json", () => {
    assert.equal(KANTHORD_VERSION, pkg.version);
  });

  it("bin holds exactly one key kanthord with value ./dist/main.js", () => {
    const keys = Object.keys(pkg.bin);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], "kanthord");
    assert.equal(pkg.bin.kanthord, "./dist/main.js");
  });

  it("src/main.ts, which tsconfig.build.json compiles to dist/main.js, exists, has executable bit, first line is the shebang", () => {
    const target = new URL("../../src/main.ts", import.meta.url);
    assert.ok(fs.existsSync(target), `target does not exist: ${target}`);

    const stat = fs.statSync(target);
    assert.ok(
      (stat.mode & 0o111) !== 0,
      `executable bit not set on ${target} (mode: ${(stat.mode & 0o777).toString(8)})`,
    );

    const content = fs.readFileSync(target, "utf-8");
    const firstLine = content.split("\n")[0];
    assert.equal(firstLine, "#!/usr/bin/env node");
  });
});
