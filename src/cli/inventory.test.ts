import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  commandPaths,
  declaredCommands,
  type DeclaredCommand,
} from "./inventory.ts";

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const sortBytewise = (values: readonly string[]): string[] =>
  values.slice().sort(bytewise);

const readP1E1Block = (): string => {
  const markdown = readFileSync(
    resolve(import.meta.dirname, "../../docs/proposal/phase-1/README.md"),
    "utf8",
  );
  const heading = "### P1-E1 — The onboarding journey";
  const start = markdown.indexOf(heading);
  assert.ok(start !== -1, "the P1-E1 heading exists in the proposal");
  const afterHeading = markdown.slice(start + heading.length);
  const end = afterHeading.indexOf("\n### ");
  return end === -1 ? afterHeading : afterHeading.slice(0, end);
};

describe("src/cli/inventory.test", () => {
  it("declares exactly fourteen commands", () => {
    assert.equal(declaredCommands.length, 14);
  });

  it("commandPaths holds fourteen distinct strings", () => {
    const paths = commandPaths();
    assert.equal(paths.length, 14);
    assert.equal(new Set(paths).size, 14);
  });

  it("commandPaths is bytewise sorted", () => {
    assert.deepEqual(commandPaths(), sortBytewise(commandPaths()));
  });

  it("every path is lowercase segments matching the segment grammar", () => {
    for (const entry of declaredCommands) {
      assert.ok(entry.path.length > 0, "path is non-empty");
      for (const segment of entry.path) {
        assert.ok(segment.length > 0, "segment is non-empty");
        assert.match(segment, /^[a-z][a-z-]*$/);
      }
    }
  });

  it("marks db migrate and serve as the two commands that call no route", () => {
    const empty = declaredCommands.filter(
      (entry) => entry.operationIds.length === 0,
    );
    assert.deepEqual(
      empty.map((entry) => entry.path.join(" ")),
      ["db migrate", "serve"],
    );
  });

  it("gives every calling command a non-empty list with no repeated id", () => {
    for (const entry of declaredCommands) {
      if (entry.operationIds.length === 0) {
        continue;
      }
      assert.ok(entry.operationIds.length > 0);
      assert.equal(new Set(entry.operationIds).size, entry.operationIds.length);
    }
  });

  it("flattens to seventeen distinct operation ids", () => {
    const flattened = declaredCommands.flatMap(
      (entry: DeclaredCommand) => entry.operationIds,
    );
    assert.equal(flattened.length, 17);
    assert.equal(new Set(flattened).size, 17);
  });

  it("covers the eight commands the P1-E1 oracle runs", () => {
    const oracle = new Set<string>();
    const pattern = /`kanthord ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*){0,2})/g;
    for (const match of readP1E1Block().matchAll(pattern)) {
      const captured = match[1] ?? "";
      const words = captured.split(" ");
      const last = words[words.length - 1];
      if (last !== undefined && last.startsWith("--")) {
        oracle.add(words.slice(0, -1).join(" "));
      } else {
        oracle.add(captured);
      }
    }

    assert.deepEqual(sortBytewise([...oracle]), [
      "credential register",
      "plan export",
      "plan import",
      "project create",
      "repository register",
      "repository show",
      "run",
      "status",
    ]);
    for (const command of oracle) {
      assert.ok(
        commandPaths().includes(command),
        `${command} is in the inventory`,
      );
    }
  });

  it("pins the six paths the P1-E1 scan never names", () => {
    const oracle = new Set<string>();
    const pattern = /`kanthord ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*){0,2})/g;
    for (const match of readP1E1Block().matchAll(pattern)) {
      const captured = match[1] ?? "";
      const words = captured.split(" ");
      const last = words[words.length - 1];
      if (last !== undefined && last.startsWith("--")) {
        oracle.add(words.slice(0, -1).join(" "));
      } else {
        oracle.add(captured);
      }
    }

    assert.deepEqual(
      commandPaths().filter((path) => !oracle.has(path)),
      [
        "db migrate",
        "db status",
        "project list",
        "project repository",
        "project show",
        "serve",
      ],
    );
  });
});
