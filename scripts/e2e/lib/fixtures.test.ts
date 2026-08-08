import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { planFrontmatter } from "../../../src/domain/plan-document.ts";
import { createPlanReader } from "../../../test/helpers/plan.ts";

const fixtureRoot = join(
  import.meta.dirname,
  "../../../test/e2e/fixtures/two-objective",
);

const expectedFiles = [
  "README.md",
  "plan/journey/initiative.md",
  "plan/journey/alpha/objective.md",
  "plan/journey/alpha/01-first.md",
  "plan/journey/alpha/02-second.md",
  "plan/journey/beta/objective.md",
  "plan/journey/beta/01-first.md",
  "plan/journey/beta/02-second.md",
].sort();

function walk(root: string, directory: string): string[] {
  const absolute = directory === "" ? root : join(root, directory);
  const entries = readdirSync(absolute, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relativePath =
      directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walk(root, relativePath));
    } else if (entry.isFile()) {
      found.push(relativePath);
    }
  }
  return found;
}

function planPaths(): readonly string[] {
  return walk(fixtureRoot, "plan");
}

const ulidPattern = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
const identityPattern = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

test("the fixture directory holds exactly the eight named files", () => {
  const files = walk(fixtureRoot, "").sort();
  assert.deepEqual(files, expectedFiles);
});

test("parsing plan/** yields one initiative, two objectives, four tasks", () => {
  const reader = createPlanReader();
  const counts = { initiative: 0, objective: 0, task: 0 };

  for (const path of planPaths()) {
    const text = readFileSync(join(fixtureRoot, path), "utf8");
    const { frontmatter } = reader.read(text);
    const parsed = planFrontmatter.parse(frontmatter);
    counts[parsed.kind] += 1;
  }

  assert.deepEqual(counts, { initiative: 1, objective: 2, task: 4 });
});

test("no document under the fixture contains a string matching a baked-in ULID", () => {
  for (const path of walk(fixtureRoot, "")) {
    const text = readFileSync(join(fixtureRoot, path), "utf8");
    assert.equal(
      ulidPattern.test(text),
      false,
      `${path} contains what looks like a ULID`,
    );
  }
});

test("every depends_on entry is a relative path, never an identity", () => {
  const reader = createPlanReader();
  let sawDependsOn = false;

  for (const path of planPaths()) {
    const text = readFileSync(join(fixtureRoot, path), "utf8");
    const { frontmatter } = reader.read(text);
    const parsed = planFrontmatter.parse(frontmatter);
    for (const entry of parsed.depends_on ?? []) {
      sawDependsOn = true;
      assert.equal(
        entry.startsWith("./") || entry.startsWith("../"),
        true,
        entry,
      );
      assert.equal(identityPattern.test(entry), false, entry);
    }
  }

  assert.equal(sawDependsOn, true);
});

test("README.md sits outside plan/ and is excluded from the parsed set", () => {
  const files = walk(fixtureRoot, "");
  assert.equal(files.includes("README.md"), true);
  assert.equal(
    planPaths().some((path) => path.endsWith("README.md")),
    false,
  );
});
