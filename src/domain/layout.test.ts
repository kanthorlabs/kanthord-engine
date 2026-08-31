import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lintCase } from "../../test/helpers/lint.ts";

function relativeImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  return specifiers;
}

const defaultTestFilePatterns = [
  /\.test\.[cm]?[jt]s$/,
  /-test\.[cm]?[jt]s$/,
  /_test\.[cm]?[jt]s$/,
  /^test-/,
  /^test\.[cm]?[jt]s$/,
] as const;

const harnessPathMention = ["scripts", "e2e"].join("/");
const envFileMention = [".env", "e2e"].join(".");
const harnessScenarioPaths = [
  ["scripts", "e2e", "test", "x.ts"].join("/"),
  ["scripts", "e2e", "x.test.ts"].join("/"),
  ["scripts", "e2e", "test-x.ts"].join("/"),
];

function walkFiles(dir: string): readonly string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path));
    else result.push(path);
  }
  return result;
}

function wouldBeCollectedByDefaultRunner(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.includes("test")) return true;
  const basename = segments[segments.length - 1] ?? "";
  return defaultTestFilePatterns.some((pattern) => pattern.test(basename));
}

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

  it("src/services/ holds exactly the twenty-one capabilities plus home-lock", () => {
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
      "document",
      "event",
      "execution",
      "git",
      "graph",
      "home-lock",
      "ids",
      "lease",
      "model-catalog",
      "plan",
      "provider-auth",
      "readiness",
      "revision",
      "secret",
      "storage",
      "verify",
      "worker-health",
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

  it("agent, verify, lease and worker-health each hold a not-implemented.ts", () => {
    for (const capability of ["agent", "verify", "lease", "worker-health"]) {
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

  it("no file under src/commands/ imports another command module", () => {
    const commandsDir = fileURLToPath(new URL("../commands/", import.meta.url));
    const sharedNodeRefusal = resolve(commandsDir, "node/refusal.ts");
    const offenders: string[] = [];
    for (const file of walkFiles(commandsDir)) {
      if (file.endsWith(".test.ts")) continue;
      const content = fs.readFileSync(file, "utf8");
      for (const specifier of relativeImportSpecifiers(content)) {
        const target = resolve(dirname(file), specifier);
        if (target.startsWith(commandsDir)) {
          if (target === sharedNodeRefusal) continue;
          offenders.push(`${relative(commandsDir, file)} -> ${specifier}`);
        }
      }
    }
    assert.equal(offenders.length, 0, offenders.join(", "));
  });

  it("no file under src/queries/ imports another query module", () => {
    const queriesDir = fileURLToPath(new URL("../queries/", import.meta.url));
    const offenders: string[] = [];
    for (const file of walkFiles(queriesDir)) {
      if (file.endsWith(".test.ts")) continue;
      const content = fs.readFileSync(file, "utf8");
      for (const specifier of relativeImportSpecifiers(content)) {
        const target = resolve(dirname(file), specifier);
        if (target.startsWith(queriesDir)) {
          offenders.push(`${relative(queriesDir, file)} -> ${specifier}`);
        }
      }
    }
    assert.equal(offenders.length, 0, offenders.join(", "));
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

  it("spawn in src/services/git/probe.ts triggers no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/services/git/probe.ts",
      code: 'import { spawn } from "node:child_process";',
    });
    assert.ok(
      rules.includes("no-restricted-imports"),
      `expected no-restricted-imports, got [${rules.join(", ")}]`,
    );
  });

  it("spawn in src/services/git/launcher.ts does not trigger no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/services/git/launcher.ts",
      code: 'import { spawn } from "node:child_process";',
    });
    assert.ok(
      !rules.includes("no-restricted-imports"),
      `unexpected no-restricted-imports`,
    );
  });

  for (const filePath of [
    "src/services/git/probe.ts",
    "src/services/git/launcher.ts",
    "src/services/git/probe.test.ts",
  ]) {
    it(`isomorphic-git in ${filePath} triggers no-restricted-imports`, async () => {
      const rules = await lintCase({
        filePath,
        code: 'import git from "isomorphic-git";',
      });
      assert.ok(
        rules.includes("no-restricted-imports"),
        `expected no-restricted-imports, got [${rules.join(", ")}]`,
      );
    });
  }

  it("spawn in src/services/git/launcher.test.ts does not trigger no-restricted-imports", async () => {
    const rules = await lintCase({
      filePath: "src/services/git/launcher.test.ts",
      code: 'import { spawn } from "node:child_process";',
    });
    assert.ok(
      !rules.includes("no-restricted-imports"),
      `unexpected no-restricted-imports`,
    );
  });

  for (const [filePath, restricted] of [
    ["src/commands/plan/import-plan.ts", true],
    ["src/queries/plan/export-plan.ts", true],
    ["src/domain/plan-document.ts", true],
    ["src/http/contract/openapi.ts", false],
    ["src/services/document/yaml.ts", false],
  ] as const) {
    it(`yaml import in ${filePath} ${
      restricted ? "triggers" : "does not trigger"
    } no-restricted-imports`, async () => {
      const rules = await lintCase({
        filePath,
        code: 'import { parse } from "yaml";',
      });
      if (restricted) {
        assert.ok(
          rules.includes("no-restricted-imports"),
          `expected no-restricted-imports, got [${rules.join(", ")}]`,
        );
      } else {
        assert.ok(
          !rules.includes("no-restricted-imports"),
          `unexpected no-restricted-imports`,
        );
      }
    });
  }

  it("a delete-from-edge literal in src/commands/plan/import-plan.ts triggers no-restricted-syntax", async () => {
    const rules = await lintCase({
      filePath: "src/commands/plan/import-plan.ts",
      code: 'const q = "DELETE FROM ' + 'edge WHERE id = ?";',
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("the same literal in src/services/plan/sqlite.ts triggers nothing", async () => {
    const rules = await lintCase({
      filePath: "src/services/plan/sqlite.ts",
      code: 'const q = "DELETE FROM ' + 'edge WHERE id = ?";',
    });
    assert.ok(
      !rules.includes("no-restricted-syntax"),
      `unexpected no-restricted-syntax`,
    );
  });

  it("a lowercase delete-from-edge literal triggers no-restricted-syntax", async () => {
    const rules = await lintCase({
      filePath: "src/commands/plan/import-plan.ts",
      code: 'const q = "delete from ' + 'edge where id = ?";',
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("an update-edge literal triggers no-restricted-syntax", async () => {
    const rules = await lintCase({
      filePath: "src/commands/plan/import-plan.ts",
      code: 'const q = "UPDATE ' + 'edge SET waived_at = ?";',
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("an update-node template literal triggers no-restricted-syntax", async () => {
    const rules = await lintCase({
      filePath: "src/commands/plan/import-plan.ts",
      code: "const q = `UPDATE " + "node SET state = ${x}`;",
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("an insert-into-node literal triggers no-restricted-syntax", async () => {
    const rules = await lintCase({
      filePath: "src/commands/startup/recover-expired-leases.ts",
      code: 'const q = "INSERT INTO ' + 'node (id) VALUES (?)";',
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("an UPDATE lease literal triggers nothing", async () => {
    const rules = await lintCase({
      filePath: "src/commands/startup/recover-expired-leases.ts",
      code: 'const q = "UPDATE lease SET owner = NULL";',
    });
    assert.ok(
      !rules.includes("no-restricted-syntax"),
      `unexpected no-restricted-syntax`,
    );
  });

  it("a SELECT FROM node literal triggers nothing", async () => {
    const rules = await lintCase({
      filePath: "src/queries/node/list-node.ts",
      code: 'const q = "SELECT id FROM node";',
    });
    assert.ok(
      !rules.includes("no-restricted-syntax"),
      `unexpected no-restricted-syntax`,
    );
  });

  it("a new test file is not exempt from the node and edge write ban", async () => {
    const rules = await lintCase({
      filePath: "src/queries/node/new-thing.test.ts",
      code: 'const q = "INSERT INTO ' + 'node (id) VALUES (?)";',
    });
    assert.ok(
      rules.includes("no-restricted-syntax"),
      `expected no-restricted-syntax, got [${rules.join(", ")}]`,
    );
  });

  it("a listed legacy test file is exempt", async () => {
    const rules = await lintCase({
      filePath: "src/queries/node/list-node.test.ts",
      code: 'const q = "INSERT INTO ' + 'node (id) VALUES (?)";',
    });
    assert.ok(
      !rules.includes("no-restricted-syntax"),
      `unexpected no-restricted-syntax`,
    );
  });

  it("the node and edge write exemption list holds exactly eighteen exact paths", () => {
    const configPath = fileURLToPath(
      new URL("../../eslint.config.js", import.meta.url),
    );
    const source = fs.readFileSync(configPath, "utf8");
    const start = source.indexOf("const nodeEdgeWriteExemptions = [");
    assert.ok(start !== -1, "nodeEdgeWriteExemptions is missing");
    const end = source.indexOf("];", start);
    assert.ok(end !== -1, "nodeEdgeWriteExemptions is unterminated");
    const slice = source.slice(start, end);
    const quoted = slice.match(/"[^"]*"/g) ?? [];
    assert.equal(quoted.length, 18);
    for (const entry of quoted) {
      assert.ok(!entry.includes("*"), `${entry} is a glob, not an exact path`);
    }
  });

  it("the collection predicate reports every default shape", () => {
    for (const path of harnessScenarioPaths) {
      assert.ok(
        wouldBeCollectedByDefaultRunner(path),
        `${path} was not reported`,
      );
    }
  });

  it("no file under scripts/ is collected by the default test runner, except the daemon-backed verify step, the contract-publish script and the EPIC 011 e2e runner's own unit tests", () => {
    const rootDir = fileURLToPath(new URL("../../", import.meta.url));
    const scriptsDir = join(rootDir, "scripts");
    const offenders = walkFiles(scriptsDir)
      .map((file) => relative(scriptsDir, file))
      .filter((file) => wouldBeCollectedByDefaultRunner(file));
    assert.deepEqual(
      offenders,
      [
        "e2e/lib/bundle.test.ts",
        "e2e/lib/command.test.ts",
        "e2e/lib/disclosure.test.ts",
        "e2e/lib/driver/interface.test.ts",
        "e2e/lib/driver/local.test.ts",
        "e2e/lib/driver/origin-probe.test.ts",
        "e2e/lib/driver/podman-issuer.test.ts",
        "e2e/lib/driver/ssh.test.ts",
        "e2e/lib/fixtures.test.ts",
        "e2e/lib/main.test.ts",
        "e2e/lib/podman/image.test.ts",
        "e2e/lib/podman/preflight.test.ts",
        "e2e/lib/podman/provision.test.ts",
        "e2e/lib/podman/readiness.test.ts",
        "e2e/lib/podman/reclaim.test.ts",
        "e2e/lib/podman/topology.test.ts",
        "e2e/lib/profile/profile.test.ts",
        "e2e/lib/record/acceptance.test.ts",
        "e2e/lib/record/manifest.test.ts",
        "e2e/lib/record/verdict.test.ts",
        "e2e/lib/record/verify.test.ts",
        "e2e/lib/redact.test.ts",
        "e2e/lib/remote-refs.test.ts",
        "e2e/lib/resources.test.ts",
        "e2e/lib/scenario/discipline.test.ts",
        "e2e/lib/scenario/harness.test.ts",
        "e2e/lib/scenario/index.test.ts",
        "e2e/lib/scenario/journey.test.ts",
        "e2e/lib/scenario/p1-e4.test.ts",
        "e2e/lib/scenario/p1-e5.test.ts",
        "e2e/lib/scenario/p1b-e1.test.ts",
        "e2e/lib/scenario/p1b-e2.test.ts",
        "e2e/lib/scenario/p1b-e3.test.ts",
        "e2e/lib/scenario/startup-refusal.test.ts",
        "e2e/lib/scenario/transport.test.ts",
        "e2e/lib/secret-file.test.ts",
        "e2e/lib/shim.test.ts",
        "e2e/lib/tag.test.ts",
        "publish-contract.source.test.ts",
        "publish-contract.test.ts",
        "release-facts.test.ts",
        "release-gate.test.ts",
        "verify-db-status.test.ts",
      ],
      `${offenders.join(", ")} match a default test pattern; npm test would run them`,
    );
  });

  it("no file under src/ or test/ mentions the harness or its env file", () => {
    const rootDir = fileURLToPath(new URL("../../", import.meta.url));
    for (const area of ["src", "test"]) {
      const areaDir = join(rootDir, area);
      for (const file of walkFiles(areaDir)) {
        if (!file.endsWith(".ts")) continue;
        const content = fs.readFileSync(file, "utf8");
        assert.ok(
          !content.includes(harnessPathMention),
          `${file} mentions ${harnessPathMention}`,
        );
        assert.ok(
          !content.includes(envFileMention),
          `${file} mentions ${envFileMention}`,
        );
      }
    }
  });
});
