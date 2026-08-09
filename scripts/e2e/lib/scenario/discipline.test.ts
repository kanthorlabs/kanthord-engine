import { test } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ScenarioContext } from "./context.ts";
import type { CommandSink } from "../command.ts";
import { createLedger } from "../resources.ts";

const FORBIDDEN_TOKENS = [
  "releaseAll",
  "podman rm",
  "podman pod rm",
  "podman network rm",
  "podman volume rm",
];

test("no scenario file contains a forbidden teardown token", async () => {
  const directory = resolve(import.meta.dirname);
  const files: string[] = [];

  for await (const entry of glob("*.ts", { cwd: directory })) {
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    files.push(entry);
  }

  assert.ok(files.length > 0, "expected at least one scenario file to check");

  for (const file of files) {
    const text = await readFile(resolve(directory, file), "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      assert.equal(
        text.includes(token),
        false,
        `${file} contains forbidden token "${token}"`,
      );
    }
  }
});

test("ScenarioContext carries no releaseAll key", () => {
  const ledger = createLedger();
  const sink: CommandSink = {
    print: () => {},
    record: () => {},
  };

  const context: ScenarioContext = {
    tag: "tag",
    scenarioId: "P1-E1",
    bundleDirectory: "/tmp/bundle",
    take: ledger.take,
    sink,
    assert: () => {},
    daemonHost: null,
    clientHost: null,
  };

  assert.equal(Object.hasOwn(context, "releaseAll"), false);
});

test("no scenario file imports from src/", async () => {
  const directory = resolve(import.meta.dirname);
  const sourceRoot = resolve(import.meta.dirname, "../../../../src");
  const files: string[] = [];

  for await (const entry of glob("*.ts", { cwd: directory })) {
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    files.push(entry);
  }

  assert.ok(files.length > 0, "expected at least one scenario file to check");

  for (const file of files) {
    const text = await readFile(resolve(directory, file), "utf8");
    const specifiers = [
      ...text.matchAll(/from\s+"([^"]+)"/g),
      ...text.matchAll(/import\s*\(\s*"([^"]+)"/g),
    ].map((match) => match[1] as string);

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolve(directory, specifier);
      assert.equal(
        resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${sep}`),
        false,
        `${file} imports ${specifier}, which resolves into src/`,
      );
    }
  }
});
