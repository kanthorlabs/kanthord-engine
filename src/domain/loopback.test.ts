import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { isLoopbackHost, isLoopbackUrl } from "./loopback.ts";

const loopbackHostTrue = [
  "localhost",
  "::1",
  "127.0.0.1",
  "127.0.0.2",
  "127.1.2.3",
  "127.0.0.0",
  "127.255.255.255",
];

const loopbackHostFalse = [
  "0.0.0.0",
  "192.168.1.10",
  "128.0.0.1",
  "127.0.0.256",
  "127.00.0.1",
  "127.0.0",
  "127.0.0.1.1",
  "[::1]",
  "LOCALHOST",
  "",
  "example.test",
];

const loopbackUrlTrue = [
  "http://127.0.0.1:7421",
  "http://localhost:7421",
  "http://[::1]:7421",
  "https://127.0.0.1",
  "http://127.1:7421",
  "http://127.0.0.01",
];

const loopbackUrlFalse = [
  "http://example.test",
  "https://10.0.0.5:7421",
  "ftp://127.0.0.1",
  "file:///tmp/x",
  "not a url",
  "",
  "http://127.999.0.1:7421",
  "127.0.0.1:7421",
];

describe("src/domain/loopback.test", () => {
  it("isLoopbackHost accepts the loopback table", () => {
    for (const value of loopbackHostTrue) {
      assert.equal(isLoopbackHost(value), true, value);
    }
  });

  it("isLoopbackHost refuses the non-loopback table", () => {
    for (const value of loopbackHostFalse) {
      assert.equal(isLoopbackHost(value), false, value);
    }
  });

  it("isLoopbackUrl accepts the loopback table", () => {
    for (const value of loopbackUrlTrue) {
      assert.equal(isLoopbackUrl(value), true, value);
    }
  });

  it("isLoopbackUrl refuses the non-loopback table", () => {
    for (const value of loopbackUrlFalse) {
      assert.equal(isLoopbackUrl(value), false, value);
    }
  });

  it("src/domain/loopback.ts imports nothing", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./loopback.ts"),
      "utf-8",
    );
    assert.equal(source.includes("import"), false);
  });

  it("no second loopback classifier exists", () => {
    const srcRoot = resolve(import.meta.dirname, "..");
    const holders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        if (entry.name.endsWith(".d.ts")) continue;
        const text = readFileSync(path, "utf-8");
        if (text.includes("127.") || text.includes("localhost")) {
          holders.push(relative(srcRoot, path));
        }
      }
    };
    walk(srcRoot);

    const sorted = [...holders].sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    );
    assert.deepEqual(sorted, [
      "domain/loopback.ts",
      "services/config/convict.ts",
    ]);

    const convictSource = readFileSync(
      resolve(srcRoot, "services/config/convict.ts"),
      "utf-8",
    );
    const holdingLines = convictSource
      .split("\n")
      .filter((line) => line.includes("127.") || line.includes("localhost"));
    assert.equal(holdingLines.length, 1);
    assert.ok(holdingLines[0]!.includes('default: "127.0.0.1"'));
  });
});
