import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { scenarios } from "./index.ts";

const expectedTable: Readonly<
  Record<string, Readonly<{ mode: string; driver: string; profile: string }>>
> = {
  "P1-E1": { mode: "deterministic", driver: "local", profile: "fixture" },
  "P1-E2": { mode: "deterministic", driver: "local", profile: "fixture" },
  "P1-E3": { mode: "deployment", driver: "ssh", profile: "real" },
  "P1-E4": { mode: "deterministic", driver: "podman", profile: "fixture" },
};

test("scenarios has exactly four entries", () => {
  assert.equal(scenarios.length, 4);
});

test("the ids are P1-E1..P1-E4, bytewise ascending", () => {
  const ids = scenarios.map((scenario) => scenario.id);
  assert.deepEqual(ids, ["P1-E1", "P1-E2", "P1-E3", "P1-E4"]);

  const sorted = [...ids].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  assert.deepEqual(ids, sorted);
});

test("each row's mode, driver and profile match the declared table", () => {
  for (const scenario of scenarios) {
    assert.deepEqual(
      {
        mode: scenario.mode,
        driver: scenario.driver,
        profile: scenario.profile,
      },
      expectedTable[scenario.id],
    );
  }
});

test("exactly one row is mode deployment, and it is P1-E3", () => {
  const deploymentRows = scenarios.filter(
    (scenario) => scenario.mode === "deployment",
  );
  assert.equal(deploymentRows.length, 1);
  assert.equal(deploymentRows[0]?.id, "P1-E3");
});

test("no scenario or profile module file text contains a driver.name equality check", () => {
  const roots = [
    fileURLToPath(new URL("./", import.meta.url)),
    fileURLToPath(new URL("../profile/", import.meta.url)),
  ];

  for (const directory of roots) {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }

      const text = readFileSync(join(directory, entry), "utf8");
      assert.equal(
        text.includes("driver.name ==="),
        false,
        `${entry} contains a driver.name === check`,
      );
    }
  }
});
