import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { compareBytewise } from "./bytewise.ts";

const FIXTURES = ["a", "aa", "\u00e9", "\uE000", "\u{1F600}"] as const;

const BYTEWISE_ORDER = ["a", "aa", "\u00e9", "\uE000", "\u{1F600}"];

const JAVASCRIPT_ORDER = ["a", "aa", "\u00e9", "\u{1F600}", "\uE000"];

function productionTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(path);
      }
    }
  };
  walk("src/http/server");
  return files.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

describe("src/http/server/bytewise.test", () => {
  it("sorts the fixture set into the exact bytewise order", () => {
    assert.deepEqual([...FIXTURES].reverse().sort(compareBytewise), [
      ...BYTEWISE_ORDER,
    ]);
  });

  it("agrees with Buffer.compare on the sign of every fixture pair", () => {
    for (const left of FIXTURES) {
      for (const right of FIXTURES) {
        assert.equal(
          Math.sign(compareBytewise(left, right)),
          Math.sign(Buffer.compare(Buffer.from(left), Buffer.from(right))),
        );
        if (left === right) {
          assert.equal(compareBytewise(left, right), 0);
        }
      }
    }
  });

  it("orders the private-use character before the emoji while JavaScript orders the reverse", () => {
    assert.deepEqual([...FIXTURES].sort(), [...JAVASCRIPT_ORDER]);
    assert.ok(
      Buffer.compare(Buffer.from("\uE000"), Buffer.from("\u{1F600}")) < 0,
    );
    assert.ok(compareBytewise("\uE000", "\u{1F600}") < 0);
  });

  it("calls Buffer.compare in no production file under src/http/server", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const offenders = productionTypeScriptFiles(root).filter((path) =>
      readFileSync(join(root, path), "utf8").includes("Buffer.compare"),
    );
    assert.deepEqual(offenders, []);
  });

  it("imports node:buffer in no production file under src/http/server", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const offenders = productionTypeScriptFiles(root).filter((path) =>
      readFileSync(join(root, path), "utf8").includes("node:buffer"),
    );
    assert.deepEqual(offenders, []);
  });
});
