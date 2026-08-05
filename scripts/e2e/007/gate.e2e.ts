import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { mintRunId } from "./run.ts";
import { scenarios } from "./index.ts";

const SCENARIO_DIR = import.meta.dirname;
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const E2E_DIR = resolve(import.meta.dirname, "..");
const STORIES_DIR = resolve(
  import.meta.dirname,
  "../../../.agent/plan/stories/007-repository-registration",
);
const GATE_FILE = "gate.e2e.ts";
const HARNESS_FILE = "00-harness.e2e.ts";
const REMOTE_FILE = "remote.ts";

const PUSH_TOKEN = ["pu", "sh"].join("");
const DRY_RUN_TOKEN = ["--", "dry", "-run"].join("");
const PUSH_SCRATCH_REF_TOKEN = ["pus", "hScratch", "Ref"].join("");
const SCRIPTS_E2E = ["scripts", "e2e"].join("/");
const ENV_E2E = [".env", "e2e"].join(".");
const TEST_HELPERS = ["test", "helpers"].join("/");
const ALLOWED_HELPERS = ["daemon.ts", "home.ts", "cli.ts", "remote/tools.ts"];
const STORY_NUMBERS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function walkFiles(directory: string): readonly string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of walkFiles(path)) {
        result[result.length] = nested;
      }
    } else {
      result[result.length] = path;
    }
  }
  return result;
}

function walkTs(directory: string): readonly string[] {
  return walkFiles(directory).filter((file) => file.endsWith(".ts"));
}

function relativeImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    specifiers[specifiers.length] = match[1] ?? "";
  }
  return specifiers;
}

export function declaredSetDiff(
  declared: readonly string[],
  onDisk: readonly string[],
): readonly string[] {
  const declaredSorted = [...new Set(declared)].sort(bytewise);
  const onDiskSorted = [...onDisk].sort(bytewise);
  const missing = declaredSorted.filter((file) => !onDiskSorted.includes(file));
  const extra = onDiskSorted.filter((file) => !declaredSorted.includes(file));
  return [
    ...missing.map((file) => `missing ${file}`),
    ...extra.map((file) => `extra ${file}`),
  ];
}

describe("scripts/e2e/007/gate.e2e", () => {
  it("the declared set equals the delivered set", () => {
    const files = readdirSync(SCENARIO_DIR)
      .filter((file) => file.endsWith(".e2e.ts") && file !== GATE_FILE)
      .sort(bytewise);
    const declared = scenarios.map((scenario) => scenario.file).sort(bytewise);
    assert.deepEqual(declaredSetDiff(declared, files), []);
  });

  it("the declared-set comparison reports a fabricated extra name", () => {
    const diff = declaredSetDiff(
      ["00-harness.e2e.ts"],
      ["00-harness.e2e.ts", "99-fabricated.e2e.ts"],
    );
    assert.deepEqual(diff, ["extra 99-fabricated.e2e.ts"]);
  });

  it("every declared id is asserted in its own file", () => {
    for (const scenario of scenarios) {
      const content = readFileSync(join(SCENARIO_DIR, scenario.file), "utf8");
      assert.ok(
        content.includes(scenario.id),
        `${scenario.file} never names ${scenario.id}`,
      );
    }
  });

  it("every story of the epic has at least one scenario", () => {
    const storyFiles = readdirSync(STORIES_DIR)
      .filter((file) => /^\d\d-.*\.md$/.test(file) && !file.startsWith("13-"))
      .map((file) => file.slice(0, 2))
      .sort(bytewise);
    const declaredStories = [...new Set(scenarios.map((s) => s.story))].sort(
      bytewise,
    );
    assert.deepEqual(declaredStories, storyFiles);
    assert.deepEqual(declaredStories, STORY_NUMBERS);
  });

  it("only remote.ts holds the writer token without a dry run", () => {
    for (const file of walkTs(E2E_DIR)) {
      const content = readFileSync(file, "utf8");
      if (!content.includes(PUSH_TOKEN)) {
        continue;
      }
      if (basename(file) === REMOTE_FILE) {
        continue;
      }
      assert.ok(
        content.includes(DRY_RUN_TOKEN) ||
          content.includes(PUSH_SCRATCH_REF_TOKEN),
        `${file} holds ${PUSH_TOKEN} without a dry run`,
      );
    }
  });

  it("exactly one declaration writes a remote ref, and only its file names it", () => {
    const writers = scenarios
      .filter((scenario) => scenario.writesRemoteRef)
      .map((scenario) => scenario.id);
    assert.deepEqual(writers, ["E7-00b"]);
    for (const file of readdirSync(SCENARIO_DIR).filter((entry) =>
      entry.endsWith(".e2e.ts"),
    )) {
      const content = readFileSync(join(SCENARIO_DIR, file), "utf8");
      const mentions = content.includes(PUSH_SCRATCH_REF_TOKEN);
      assert.equal(
        mentions,
        file === HARNESS_FILE,
        `${file} ${PUSH_SCRATCH_REF_TOKEN} mention mismatch`,
      );
    }
  });

  it("no hermetic file reaches the harness", () => {
    for (const area of ["src", "test"]) {
      for (const file of walkTs(resolve(REPO_ROOT, area))) {
        const content = readFileSync(file, "utf8");
        assert.ok(
          !content.includes(SCRIPTS_E2E),
          `${file} mentions ${SCRIPTS_E2E}`,
        );
        assert.ok(!content.includes(ENV_E2E), `${file} mentions ${ENV_E2E}`);
      }
    }
    for (const file of walkTs(E2E_DIR)) {
      const content = readFileSync(file, "utf8");
      for (const specifier of relativeImportSpecifiers(content)) {
        const index = specifier.indexOf(TEST_HELPERS);
        if (index === -1) {
          continue;
        }
        const helper = specifier.slice(index + TEST_HELPERS.length + 1);
        assert.ok(
          ALLOWED_HELPERS.includes(helper),
          `${file} imports the test helper ${specifier}`,
        );
      }
    }
  });

  it("mintRunId returns a 26-character Crockford base32 string, and two calls differ", () => {
    const first = mintRunId();
    const second = mintRunId();
    assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(first, second);
  });
});
