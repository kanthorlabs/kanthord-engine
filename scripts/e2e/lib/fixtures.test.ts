import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { planFrontmatter } from "../../../src/domain/plan-document.ts";
import { createPlanReader } from "../../../test/helpers/plan.ts";

type FixtureExpectation = Readonly<{
  name: string;
  root: string;
  files: readonly string[];
  counts: Readonly<{ initiative: number; objective: number; task: number }>;
}>;

const fixtures: readonly FixtureExpectation[] = [
  {
    name: "two-objective",
    root: join(import.meta.dirname, "../../../test/e2e/fixtures/two-objective"),
    files: [
      "README.md",
      "plan/journey/initiative.md",
      "plan/journey/alpha/objective.md",
      "plan/journey/alpha/01-first.md",
      "plan/journey/alpha/02-second.md",
      "plan/journey/beta/objective.md",
      "plan/journey/beta/01-first.md",
      "plan/journey/beta/02-second.md",
    ].sort(),
    counts: { initiative: 1, objective: 2, task: 4 },
  },
  {
    name: "three-objective",
    root: join(
      import.meta.dirname,
      "../../../test/e2e/fixtures/three-objective",
    ),
    files: [
      "README.md",
      "plan/journey/initiative.md",
      "plan/journey/alpha/objective.md",
      "plan/journey/alpha/01-first.md",
      "plan/journey/alpha/02-second.md",
      "plan/journey/beta/objective.md",
      "plan/journey/beta/01-first.md",
      "plan/journey/beta/02-second.md",
      "plan/journey/gamma/objective.md",
      "plan/journey/gamma/01-first.md",
    ].sort(),
    counts: { initiative: 1, objective: 3, task: 5 },
  },
];

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

function planPaths(root: string): readonly string[] {
  return walk(root, "plan");
}

const ulidPattern = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
const identityPattern = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

for (const fixture of fixtures) {
  test(`the ${fixture.name} fixture directory holds exactly its named files`, () => {
    const files = walk(fixture.root, "").sort();
    assert.deepEqual(files, fixture.files);
  });

  test(`parsing ${fixture.name} plan/** yields its declared node counts`, () => {
    const reader = createPlanReader();
    const counts = { initiative: 0, objective: 0, task: 0 };

    for (const path of planPaths(fixture.root)) {
      const text = readFileSync(join(fixture.root, path), "utf8");
      const { frontmatter } = reader.read(text);
      const parsed = planFrontmatter.parse(frontmatter);
      counts[parsed.kind] += 1;
    }

    assert.deepEqual(counts, fixture.counts);
  });

  test(`no document under ${fixture.name} contains a string matching a baked-in ULID`, () => {
    for (const path of walk(fixture.root, "")) {
      const text = readFileSync(join(fixture.root, path), "utf8");
      assert.equal(
        ulidPattern.test(text),
        false,
        `${path} contains what looks like a ULID`,
      );
    }
  });

  test(`every ${fixture.name} depends_on entry is a relative path, never an identity`, () => {
    const reader = createPlanReader();
    let sawDependsOn = false;

    for (const path of planPaths(fixture.root)) {
      const text = readFileSync(join(fixture.root, path), "utf8");
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

  test(`${fixture.name} README.md sits outside plan/ and is excluded from the parsed set`, () => {
    const files = walk(fixture.root, "");
    assert.equal(files.includes("README.md"), true);
    assert.equal(
      planPaths(fixture.root).some((path) => path.endsWith("README.md")),
      false,
    );
  });
}

test("the three-objective gamma objective depends on both sibling objectives, in document order", () => {
  const fixture = fixtures[1] as FixtureExpectation;
  const reader = createPlanReader();
  const text = readFileSync(
    join(fixture.root, "plan/journey/gamma/objective.md"),
    "utf8",
  );
  const { frontmatter } = reader.read(text);
  const parsed = planFrontmatter.parse(frontmatter);

  assert.deepEqual(parsed.depends_on, [
    "../alpha/objective.md",
    "../beta/objective.md",
  ]);
});

test("no three-objective task declares a cross-parent depends_on", () => {
  const fixture = fixtures[1] as FixtureExpectation;
  const reader = createPlanReader();

  for (const path of planPaths(fixture.root)) {
    const text = readFileSync(join(fixture.root, path), "utf8");
    const { frontmatter } = reader.read(text);
    const parsed = planFrontmatter.parse(frontmatter);
    if (parsed.kind !== "task") {
      continue;
    }
    for (const entry of parsed.depends_on ?? []) {
      assert.equal(
        entry.startsWith("./"),
        true,
        `${path} depends on ${entry}, which leaves its parent`,
      );
    }
  }
});
