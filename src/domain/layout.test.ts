import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { lintCase } from "../../test/helpers/lint.ts";

const domainDir = new URL("./", import.meta.url);
const productionFiles = fs
  .readdirSync(domainDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("src/domain/layout.test", () => {
  for (const file of productionFiles) {
    it(`${file} contains no Date.now, new Date, or Math.random`, () => {
      const content = fs.readFileSync(new URL(file, domainDir), "utf8");
      assert.ok(!content.includes("Date.now("), `${file} contains Date.now(`);
      assert.ok(!content.includes("new Date("), `${file} contains new Date(`);
      assert.ok(
        !content.includes("Math.random("),
        `${file} contains Math.random(`,
      );
    });
  }

  it("import ulid in src/domain/probe.ts triggers no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/domain/probe.ts",
      code: 'import { ulid } from "ulid";',
    });
    assert.ok(
      rules.includes("no-restricted-imports"),
      `expected no-restricted-imports, got [${rules.join(", ")}]`,
    );
  });

  it("import ulid in src/services/ids/ulid.ts does not trigger no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/services/ids/ulid.ts",
      code: 'import { ulid } from "ulid";',
    });
    assert.ok(
      !rules.includes("no-restricted-imports"),
      `unexpected no-restricted-imports`,
    );
  });

  it("import ulid in src/main.ts does not trigger no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/main.ts",
      code: 'import { ulid } from "ulid";',
    });
    assert.ok(
      !rules.includes("no-restricted-imports"),
      `unexpected no-restricted-imports`,
    );
  });

  it("src/services/ holds exactly the eleven capabilities plus home-lock", () => {
    const servicesDir = new URL("../services/", import.meta.url);
    const entries = fs.readdirSync(servicesDir, { withFileTypes: true });
    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(directoryNames, [
      "agent",
      "blob",
      "clock",
      "config",
      "crypto",
      "event",
      "git",
      "graph",
      "home-lock",
      "ids",
      "lease",
      "storage",
      "verify",
    ]);
  });

  it("every service directory holds an index.ts", () => {
    const servicesDir = new URL("../services/", import.meta.url);
    const entries = fs.readdirSync(servicesDir, { withFileTypes: true });
    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const directoryName of directoryNames) {
      const indexPath = fileURLToPath(
        new URL(`../services/${directoryName}/index.ts`, import.meta.url),
      );
      assert.ok(
        fs.existsSync(indexPath),
        `${directoryName} is missing index.ts`,
      );
    }
  });

  it("agent, verify and lease each hold a not-implemented.ts", () => {
    for (const capability of ["agent", "verify", "lease"]) {
      const path = fileURLToPath(
        new URL(
          `../services/${capability}/not-implemented.ts`,
          import.meta.url,
        ),
      );
      assert.ok(
        fs.existsSync(path),
        `${capability}/not-implemented.ts is missing`,
      );
    }
  });

  it("no src/services/*/index.ts contains an implementation", () => {
    const servicesDir = new URL("../services/", import.meta.url);
    const directoryNames = fs
      .readdirSync(servicesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const directoryName of directoryNames) {
      const indexPath = fileURLToPath(
        new URL(`../services/${directoryName}/index.ts`, import.meta.url),
      );
      const content = fs.readFileSync(indexPath, "utf8");
      assert.ok(
        !content.includes("implements "),
        `${directoryName}/index.ts contains an implementation`,
      );
    }
  });

  it("src/services/event/index.ts importing Transaction from ../storage/index.ts is not a boundary violation", async () => {
    const rules = await lintCase({
      filePath: "src/services/event/index.ts",
      code: 'import type { Transaction } from "../storage/index.ts";',
    });
    assert.ok(
      !rules.includes("boundaries/dependencies"),
      `unexpected boundaries/dependencies, got [${rules.join(", ")}]`,
    );
  });

  it("one capability's implementation importing another's implementation is a boundary violation", async () => {
    const rules = await lintCase({
      filePath: "src/services/event/sqlite.ts",
      code: 'import { SqliteHomeLock } from "../home-lock/sqlite.ts";',
    });
    assert.ok(
      rules.includes("boundaries/dependencies"),
      `expected boundaries/dependencies, got [${rules.join(", ")}]`,
    );
  });
});
