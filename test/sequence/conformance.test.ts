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

type FixtureStory = Readonly<{
  epicId: string;
  fileName: string;
  source: string;
}>;

type FixtureTree = Readonly<{
  root: string;
  roots: PlanRoots;
  scenariosRoot: string;
}>;

const repositoryRoot = resolve(import.meta.dirname, "../..");
const epicsRoot = resolve(repositoryRoot, ".agents/plan/epics");
const storiesRoot = resolve(repositoryRoot, ".agents/plan/stories");
const scenariosRoot = resolve(import.meta.dirname, "scenarios");
const planRoots: PlanRoots = { epicsRoot, storiesRoot };
const epic0502ScenarioCases = [
  {
    id: "renew-success",
    story: resolve(
      storiesRoot,
      "050.2-the-run-renew-release-and-report/03-the-renew.md",
    ),
  },
  {
    id: "renew-refusal-lifetime-exceeded",
    story: resolve(
      storiesRoot,
      "050.2-the-run-renew-release-and-report/04-the-lifetime-refusal.md",
    ),
  },
  {
    id: "release-success",
    story: resolve(
      storiesRoot,
      "050.2-the-run-renew-release-and-report/05-the-release.md",
    ),
  },
  {
    id: "report-authority-prelude",
    story: resolve(
      storiesRoot,
      "050.2-the-run-renew-release-and-report/06-the-report-prelude.md",
    ),
  },
] as const;

function createFixtureTree(
  stories: readonly FixtureStory[],
  scenarioIds: readonly string[] = [],
): FixtureTree {
  const root = mkdtempSync(join(tmpdir(), "kanthord-sequence-"));
  const roots = {
    epicsRoot: join(root, "epics"),
    storiesRoot: join(root, "stories"),
  };
  const fixtureScenariosRoot = join(root, "scenarios");
  mkdirSync(roots.epicsRoot, { recursive: true });
  mkdirSync(roots.storiesRoot, { recursive: true });
  mkdirSync(fixtureScenariosRoot, { recursive: true });

  for (const epicId of authoredEpics) {
    writeFileSync(join(roots.epicsRoot, `${epicId}-fixture.md`), "");
    mkdirSync(join(roots.storiesRoot, `${epicId}-fixture`), {
      recursive: true,
    });
  }
  for (const story of stories) {
    writeFileSync(
      join(roots.storiesRoot, `${story.epicId}-fixture`, story.fileName),
      story.source,
    );
  }
  for (const scenarioId of scenarioIds) {
    writeFileSync(join(fixtureScenariosRoot, `${scenarioId}.ts`), "");
  }

  return { root, roots, scenariosRoot: fixtureScenariosRoot };
}

function authoredLiveDiagrams(
  roots = planRoots,
  root = scenariosRoot,
): readonly LiveDiagram[] {
  const authored = new Set<string>(authoredEpics);
  const scenarioIds = scenarioFilesById(root);
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
            ...section.matchAll(/^Superseded by:\s+EPIC\s+(\S+)\s+(\S+)/gm),
          ].some(
            (supersession) =>
              authored.has(supersession[1] ?? "") &&
              (scenarioIds.has(supersession[2] ?? "") || !scenarioIds.has(id)),
          );
          diagrams.push({ id, epicId, story, superseded });
        }
      }
    }
  }
  return diagrams;
}

function liveDiagrams(
  roots = planRoots,
  root = scenariosRoot,
): readonly LiveDiagram[] {
  const shipped = new Set<string>(shippedEpics);
  const scenarioIds = scenarioFilesById(root);
  return authoredLiveDiagrams(roots, root).filter(
    (diagram) =>
      (shipped.has(diagram.epicId) || scenarioIds.has(diagram.id)) &&
      !diagram.superseded,
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
  const diagrams = authoredLiveDiagrams(roots, root);
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
  for (const diagram of liveDiagrams(roots, root)) {
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

  for (const scenarioCase of epic0502ScenarioCases) {
    it(`${scenarioCase.id} replays its real command`, async () => {
      const scenarioPath = resolve(scenariosRoot, `${scenarioCase.id}.ts`);
      const scenarioModule = await import(scenarioPath);
      const scenario = scenarioModule.default as () => Readonly<{
        recorder: Readonly<{ tokens: readonly string[] }>;
        result: unknown;
      }>;
      const { recorder, result } = scenario();
      assertConformance({
        story: scenarioCase.story,
        diagram: scenarioCase.id,
        recorder,
        result,
      });
    });
  }

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
    const fixture = createFixtureTree(
      [
        {
          epicId: "050",
          fileName: "story.md",
          source:
            "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 050.1 replacement-live\n",
        },
        {
          epicId: "050.1",
          fileName: "story.md",
          source: "Diagrams: replacement-live\n\n### `replacement-live`\n",
        },
      ],
      ["superseded-live", "replacement-live"],
    );
    const scenarioPath = join(fixture.scenariosRoot, "superseded-live.ts");
    try {
      assert.throws(
        () => validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
        new Error(`scenario ${scenarioPath} names a superseded live diagram`),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a live diagram of an unshipped epic needs no scenario file", () => {
    const fixture = createFixtureTree([
      {
        epicId: "050.3",
        fileName: "story.md",
        source: "Diagrams: unshipped-live\n\n### `unshipped-live`\n",
      },
    ]);
    try {
      assert.doesNotThrow(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a diagram superseded by an authored epic is due while the superseding scenario is absent", () => {
    const fixture = createFixtureTree(
      [
        {
          epicId: "050",
          fileName: "predecessor.md",
          source:
            "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 050.4 replacement-live\n",
        },
        {
          epicId: "050.4",
          fileName: "replacement.md",
          source: "Diagrams: replacement-live\n\n### `replacement-live`\n",
        },
      ],
      ["superseded-live"],
    );
    try {
      assert.doesNotThrow(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        ["superseded-live"],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a diagram is superseded once the superseding scenario file exists", () => {
    const fixture = createFixtureTree(
      [
        {
          epicId: "050",
          fileName: "predecessor.md",
          source:
            "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 050.4 replacement-live\n",
        },
        {
          epicId: "050.4",
          fileName: "replacement.md",
          source: "Diagrams: replacement-live\n\n### `replacement-live`\n",
        },
      ],
      ["replacement-live"],
    );
    try {
      assert.doesNotThrow(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        ["replacement-live"],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a diagram whose own scenario is gone is superseded with no replacement on disk", () => {
    const fixture = createFixtureTree([
      {
        epicId: "050",
        fileName: "predecessor.md",
        source:
          "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 050.4 replacement-live\n",
      },
      {
        epicId: "050.4",
        fileName: "replacement.md",
        source: "Diagrams: replacement-live\n\n### `replacement-live`\n",
      },
    ]);
    try {
      assert.doesNotThrow(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        [],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a diagram of an unshipped epic is due once its own scenario file exists", () => {
    const fixture = createFixtureTree(
      [
        {
          epicId: "050.4",
          fileName: "story.md",
          source: "Diagrams: unshipped-live\n\n### `unshipped-live`\n",
        },
      ],
      ["unshipped-live"],
    );
    const scenarioPath = join(fixture.scenariosRoot, "unshipped-live.ts");
    try {
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        ["unshipped-live"],
      );
      rmSync(scenarioPath);
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        [],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a Superseded by naming an unauthored epic supersedes nothing", () => {
    const fixture = createFixtureTree(
      [
        {
          epicId: "050",
          fileName: "story.md",
          source:
            "Diagrams: superseded-live\n\n### `superseded-live`\nSuperseded by: EPIC 099 replacement-live\n",
        },
      ],
      ["superseded-live", "replacement-live"],
    );
    try {
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        ["superseded-live"],
      );
      assert.throws(
        () => validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
        new Error(
          `scenario ${join(fixture.scenariosRoot, "replacement-live.ts")} names no live diagram`,
        ),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a diagram with no Superseded by line keeps the shipped behaviour", () => {
    const fixture = createFixtureTree([
      {
        epicId: "050",
        fileName: "story.md",
        source: "Diagrams: plain-live\n\n### `plain-live`\n",
      },
    ]);
    try {
      assert.deepEqual(
        liveDiagrams(fixture.roots, fixture.scenariosRoot).map(
          (diagram) => diagram.id,
        ),
        ["plain-live"],
      );
      assert.throws(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
      writeFileSync(join(fixture.scenariosRoot, "plain-live.ts"), "");
      assert.doesNotThrow(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("the scenario swap is green at every boundary EPIC 050.4 passes through", () => {
    const predecessorIds = Array.from(
      { length: 6 },
      (_, index) => `pred-${index + 1}`,
    );
    const replacementIds = Array.from(
      { length: 6 },
      (_, index) => `rep-${index + 1}`,
    );
    const predecessorSource = [
      `Diagrams: ${[...predecessorIds, "plain-7"].join(" ")}`,
      "",
      ...predecessorIds.flatMap((id, index) => [
        `### \`${id}\``,
        `Superseded by: EPIC 050.4 ${replacementIds[index]}`,
        "",
      ]),
      "### `plain-7`",
      "",
    ].join("\n");
    const replacementSource = [
      `Diagrams: ${replacementIds.join(" ")}`,
      "",
      ...replacementIds.flatMap((id) => [`### \`${id}\``, ""]),
    ].join("\n");
    const fixture = createFixtureTree(
      [
        {
          epicId: "050",
          fileName: "predecessors.md",
          source: predecessorSource,
        },
        {
          epicId: "050.4",
          fileName: "replacements.md",
          source: replacementSource,
        },
      ],
      [...predecessorIds, "plain-7"],
    );
    try {
      let stateCount = 0;
      for (let index = 0; index < predecessorIds.length; index += 1) {
        rmSync(join(fixture.scenariosRoot, `${predecessorIds[index]}.ts`));
        writeFileSync(
          join(fixture.scenariosRoot, `${replacementIds[index]}.ts`),
          "",
        );
        assert.doesNotThrow(() =>
          validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
        );
        stateCount += 1;
      }
      assert.equal(stateCount, 6);
      const files = scenarioFilesById(fixture.scenariosRoot);
      for (const id of predecessorIds) assert.equal(files.has(id), false);
      for (const id of replacementIds) assert.equal(files.get(id)?.length, 1);

      rmSync(join(fixture.scenariosRoot, "plain-7.ts"));
      assert.throws(() =>
        validateScenarioFiles(fixture.scenariosRoot, fixture.roots),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
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
      "050.6",
      "051",
      "051.1",
      "051.2",
      "051.3",
      "051.4",
      "051.5",
      "051.6",
      "052",
      "052.1",
      "052.2",
    ]);
    assert.deepEqual(shippedEpics, ["050", "050.1", "050.2"]);
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
