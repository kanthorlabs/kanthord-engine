import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  authoredEpics,
  shippedEpics,
} from "../../scripts/epic-sequence-range.ts";
import { assertConformance } from "../helpers/sequence-conformance.ts";

type LiveDiagram = Readonly<{
  id: string;
  epicId: string;
  story: string;
  superseded: boolean;
}>;

type PlanRoots = Readonly<{
  epicsRoot: string;
  storiesRoot: string;
}>;

const repositoryRoot = resolve(import.meta.dirname, "../..");
const epicsRoot = resolve(repositoryRoot, ".agents/plan/epics");
const storiesRoot = resolve(repositoryRoot, ".agents/plan/stories");
const scenariosRoot = resolve(import.meta.dirname, "scenarios");
const planRoots: PlanRoots = { epicsRoot, storiesRoot };

function authoredLiveDiagrams(roots = planRoots): readonly LiveDiagram[] {
  const shipped = new Set<string>(shippedEpics);
  const diagrams: LiveDiagram[] = [];
  for (const epicId of authoredEpics) {
    const epicFile = readdirSync(roots.epicsRoot, { withFileTypes: true }).find(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${epicId}-`) &&
        entry.name.endsWith(".md"),
    );
    if (epicFile === undefined)
      throw new Error(`missing epic file for ${epicId}`);
    const epicStem = basename(epicFile.name, ".md");
    const storyRoot = resolve(roots.storiesRoot, epicStem);
    for (const entry of readdirSync(storyRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const story = resolve(storyRoot, entry.name);
      const source = readFileSync(story, "utf8");
      for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^Diagrams:\s*(.+)$/);
        if (match === null) continue;
        for (const id of match[1]?.trim().split(/\s+/) ?? []) {
          if (id.length === 0) continue;
          const heading = `### \`${id}\``;
          const headingIndex = source.indexOf(heading);
          const nextHeading = source.indexOf(
            "\n### ",
            headingIndex + heading.length,
          );
          const section = source.slice(
            headingIndex,
            nextHeading < 0 ? source.length : nextHeading,
          );
          const superseded = [
            ...section.matchAll(/^Superseded by:\s+EPIC\s+(\S+)/gm),
          ].some((supersession) => shipped.has(supersession[1] ?? ""));
          diagrams.push({ id, epicId, story, superseded });
        }
      }
    }
  }
  return diagrams;
}

function liveDiagrams(roots = planRoots): readonly LiveDiagram[] {
  const shipped = new Set<string>(shippedEpics);
  return authoredLiveDiagrams(roots).filter(
    (diagram) => shipped.has(diagram.epicId) && !diagram.superseded,
  );
}

function scenarioFilesById(
  root = scenariosRoot,
): ReadonlyMap<string, readonly string[]> {
  const files = new Map<string, string[]>();
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const id = entry.name.slice(0, -3);
    const paths = files.get(id) ?? [];
    paths.push(resolve(root, entry.name));
    files.set(id, paths);
  }
  return files;
}

function validateScenarioFiles(root = scenariosRoot, roots = planRoots): void {
  const diagrams = authoredLiveDiagrams(roots);
  const liveIds = new Set(diagrams.map((diagram) => diagram.id));
  for (const [id, paths] of scenarioFilesById(root)) {
    const scenarioPath = paths[0] ?? id;
    if (id.startsWith("baseline-")) {
      throw new Error(`scenario ${scenarioPath} is a baseline diagram`);
    }
    const diagram = diagrams.find((candidate) => candidate.id === id);
    if (diagram?.superseded === true) {
      throw new Error(
        `scenario ${scenarioPath} names a superseded live diagram`,
      );
    }
    if (!liveIds.has(id)) {
      throw new Error(`scenario ${scenarioPath} names no live diagram`);
    }
  }
  for (const diagram of liveDiagrams(roots)) {
    const matches = scenarioFilesById(root).get(diagram.id) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `live diagram ${diagram.id} in ${diagram.story} has ${matches.length} scenario files`,
      );
    }
  }
}

describe("test/sequence/conformance", () => {
  it("every due live diagram has exactly one scenario file", () => {
    const diagrams = liveDiagrams();
    assert.notEqual(
      diagrams.length,
      0,
      "the sequence range has no live diagrams",
    );

    const scenarios = scenarioFilesById();
    for (const diagram of diagrams) {
      const matches = scenarios.get(diagram.id) ?? [];
      assert.equal(
        matches.length,
        1,
        `live diagram ${diagram.id} in ${diagram.story} has ${matches.length} scenario files`,
      );
    }
  });

  it("every scenario file names a live diagram", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-sequence-"));
    try {
      for (const entry of readdirSync(scenariosRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        writeFileSync(join(fixtureRoot, entry.name), "");
      }
      writeFileSync(join(fixtureRoot, "orphan-scenario.ts"), "");

      assert.throws(
        () => validateScenarioFiles(fixtureRoot),
        new Error(
          `scenario ${join(fixtureRoot, "orphan-scenario.ts")} names no live diagram`,
        ),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a baseline id holding a scenario file fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-sequence-"));
    try {
      writeFileSync(join(fixtureRoot, "baseline-claim-task.ts"), "");

      assert.throws(
        () => validateScenarioFiles(fixtureRoot),
        new Error(
          `scenario ${join(fixtureRoot, "baseline-claim-task.ts")} is a baseline diagram`,
        ),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a live diagram superseded by a shipped epic holding a scenario file fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-sequence-"));
    const fixtureEpicsRoot = join(fixtureRoot, "epics");
    const fixtureStoriesRoot = join(fixtureRoot, "stories");
    const fixtureScenariosRoot = join(fixtureRoot, "scenarios");
    mkdirSync(fixtureEpicsRoot, { recursive: true });
    mkdirSync(fixtureStoriesRoot, { recursive: true });
    mkdirSync(fixtureScenariosRoot, { recursive: true });
    try {
      for (const epicId of authoredEpics) {
        writeFileSync(join(fixtureEpicsRoot, `${epicId}-fixture.md`), "");
        mkdirSync(join(fixtureStoriesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }
      writeFileSync(
        join(fixtureStoriesRoot, "050-fixture", "story.md"),
        "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 050.1\n",
      );
      const scenarioPath = join(fixtureScenariosRoot, "superseded-live.ts");
      writeFileSync(scenarioPath, "");

      assert.throws(
        () =>
          validateScenarioFiles(fixtureScenariosRoot, {
            epicsRoot: fixtureEpicsRoot,
            storiesRoot: fixtureStoriesRoot,
          }),
        new Error(`scenario ${scenarioPath} names a superseded live diagram`),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a live diagram of an unshipped epic needs no scenario file", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-sequence-"));
    const fixtureEpicsRoot = join(fixtureRoot, "epics");
    const fixtureStoriesRoot = join(fixtureRoot, "stories");
    const fixtureScenariosRoot = join(fixtureRoot, "scenarios");
    mkdirSync(fixtureEpicsRoot, { recursive: true });
    mkdirSync(fixtureStoriesRoot, { recursive: true });
    mkdirSync(fixtureScenariosRoot, { recursive: true });
    try {
      for (const epicId of authoredEpics) {
        writeFileSync(join(fixtureEpicsRoot, `${epicId}-fixture.md`), "");
        mkdirSync(join(fixtureStoriesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }
      writeFileSync(
        join(fixtureStoriesRoot, "050.2-fixture", "story.md"),
        "Diagrams: unshipped-live\n\n### `unshipped-live`\n",
      );

      assert.doesNotThrow(() =>
        validateScenarioFiles(fixtureScenariosRoot, {
          epicsRoot: fixtureEpicsRoot,
          storiesRoot: fixtureStoriesRoot,
        }),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("shippedEpics is a prefix of authoredEpics", () => {
    assert.deepEqual(authoredEpics, [
      "050",
      "050.1",
      "050.2",
      "050.3",
      "050.4",
      "050.5",
      "051",
      "051.2",
      "051.3",
    ]);
    assert.deepEqual(shippedEpics, ["050", "050.1"]);
    assert.deepEqual(authoredEpics.slice(0, shippedEpics.length), shippedEpics);
  });

  it("every due scenario conforms", async () => {
    validateScenarioFiles();
    for (const diagram of liveDiagrams()) {
      const scenarioPath = scenarioFilesById().get(diagram.id)?.[0];
      if (scenarioPath === undefined) {
        throw new Error(`missing scenario for due diagram ${diagram.id}`);
      }
      const scenarioModule = await import(scenarioPath);
      const scenario = scenarioModule.default as () => Readonly<{
        recorder: Readonly<{ tokens: readonly string[] }>;
        result: unknown;
      }>;
      const { recorder, result } = scenario();
      assertConformance({
        story: diagram.story,
        diagram: diagram.id,
        recorder,
        result,
      });
    }
  });
});
