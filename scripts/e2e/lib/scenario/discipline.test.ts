import { test } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ScenarioContext } from "./context.ts";
import type { CommandSink } from "../command.ts";
import { createLedger } from "../resources.ts";
import { scenarios } from "./index.ts";
import { expectedAssertions } from "./assertions.ts";
import { knownScenarioIds } from "../main.ts";

const FORBIDDEN_TOKENS = [
  "releaseAll",
  "podman rm",
  "podman pod rm",
  "podman network rm",
  "podman volume rm",
];

test("every declared scenario id holds an expectedAssertions entry", () => {
  for (const scenario of scenarios) {
    assert.equal(
      Object.hasOwn(expectedAssertions, scenario.id),
      true,
      `scenario ${scenario.id} has no expectedAssertions entry`,
    );
  }
});

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

test("the proposal declares exactly the known scenario ids, in order", async () => {
  const proposal = await readFile(
    resolve(import.meta.dirname, "../../../../docs/proposal/phase-1/README.md"),
    "utf8",
  );
  const section = proposal.split("\n## End-to-end scenarios\n")[1];
  assert.notEqual(section, undefined, "the proposal has no scenario section");
  const body = (section as string).split("\n## ")[0] as string;
  const declared = [...body.matchAll(/^### (\S+) — /gmu)].map(
    (match) => match[1] as string,
  );

  assert.deepEqual(declared, [...knownScenarioIds]);
});

test("every entry of expectedAssertions pins a non-empty name list", () => {
  for (const id of knownScenarioIds) {
    const entry = expectedAssertions[id];
    assert.equal(
      Array.isArray(entry),
      true,
      `${id} declares no assertion list`,
    );
    assert.equal(
      (entry as readonly string[]).length > 0,
      true,
      `${id} declares an empty assertion list`,
    );
  }
});

test("no expected fragment is imported from its producer", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "assertions.ts"),
    "utf8",
  );
  const specifiers = [
    ...source.matchAll(/^import[^"']*["']([^"']+)["']/gmu),
  ].map((match) => match[1] as string);
  const producers = [
    "./journey.ts",
    "../profile/fixture.ts",
    "./transport.ts",
    "./p1b-e1.ts",
    "./p1b-e2.ts",
    "./p1b-e3.ts",
    "./p1-e4.ts",
    "./p1-e5.ts",
  ];

  for (const specifier of specifiers) {
    assert.equal(
      producers.includes(specifier),
      false,
      `assertions.ts imports its producer ${specifier}`,
    );
  }
});
