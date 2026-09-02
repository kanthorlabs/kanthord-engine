import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { authoredEpics } from "./epic-sequence-range.ts";
import { verifyEpicSequence } from "./verify-epic-sequence.ts";

type FixtureStory = Readonly<{
  epicId: string;
  fileName: string;
  source: string;
}>;

function createFixtureTree(
  stories: readonly FixtureStory[],
  scenarioIds: readonly string[] = [],
): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
  const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
  const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");
  const scenariosRoot = join(fixtureRoot, "test", "sequence", "scenarios");

  mkdirSync(epicsRoot, { recursive: true });
  mkdirSync(storiesRoot, { recursive: true });
  mkdirSync(scenariosRoot, { recursive: true });

  for (const epicId of authoredEpics) {
    writeFileSync(
      join(epicsRoot, `${epicId}-fixture.md`),
      `# EPIC ${epicId} — fixture\n`,
    );
    mkdirSync(join(storiesRoot, `${epicId}-fixture`), { recursive: true });
  }

  for (const story of stories) {
    writeFileSync(
      join(storiesRoot, `${story.epicId}-fixture`, story.fileName),
      story.source,
    );
  }

  for (const scenarioId of scenarioIds) {
    writeFileSync(join(scenariosRoot, `${scenarioId}.ts`), "export {};\n");
  }

  return fixtureRoot;
}

function storyDocument(
  kind: string,
  declarations: readonly string[] = [],
): string {
  return [
    "# Story fixture",
    "",
    `Kind: ${kind}`,
    "",
    "## Verify",
    "",
    "1. fixture",
    "",
    ...declarations,
    "",
  ].join("\n");
}

function diagram(
  id: string,
  steps: readonly string[] = ["1 plan.read"],
  ending = "Command-->>Client: ok",
  reference?: string,
): string {
  return [
    `### \`${id}\``,
    "",
    "```mermaid",
    "sequenceDiagram",
    "participant Client",
    "participant Command",
    ...(steps.length > 0 ? ["participant Plan"] : []),
    ...steps.map((step) => `Command->>Plan: ${step}`),
    ending,
    "```",
    ...(reference === undefined ? [] : [reference]),
    "",
  ].join("\n");
}

function assertFixtureRefusal(
  stories: readonly FixtureStory[],
  expected: string | RegExp,
): void {
  const fixtureRoot = createFixtureTree(stories);
  try {
    assert.throws(
      () => verifyEpicSequence(fixtureRoot),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        if (typeof expected === "string") {
          assert.equal((error as Error).message, expected);
        } else {
          assert.match((error as Error).message, expected);
        }
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("scripts/verify-epic-sequence", () => {
  it("an epic holding a mermaid block fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
    const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
    const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");
    const scenariosRoot = join(fixtureRoot, "test", "sequence", "scenarios");

    mkdirSync(epicsRoot, { recursive: true });
    mkdirSync(storiesRoot, { recursive: true });
    mkdirSync(scenariosRoot, { recursive: true });

    try {
      for (const epicId of authoredEpics) {
        writeFileSync(
          join(epicsRoot, `${epicId}-fixture.md`),
          epicId === "050"
            ? "# EPIC 050 — fixture\n\n```mermaid\nflowchart TD\n```\n"
            : `# EPIC ${epicId} — fixture\n`,
        );
        mkdirSync(join(storiesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }

      assert.throws(
        () => verifyEpicSequence(fixtureRoot),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          assert.match((error as Error).message, /mermaid/);
          assert.match((error as Error).message, /050-fixture\.md/);
          return true;
        },
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a story owning two live diagrams fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
    const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
    const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");
    const scenariosRoot = join(fixtureRoot, "test", "sequence", "scenarios");

    mkdirSync(epicsRoot, { recursive: true });
    mkdirSync(storiesRoot, { recursive: true });
    mkdirSync(scenariosRoot, { recursive: true });

    try {
      for (const epicId of authoredEpics) {
        writeFileSync(
          join(epicsRoot, `${epicId}-fixture.md`),
          `# EPIC ${epicId} — fixture\n`,
        );
        const storyRoot = join(storiesRoot, `${epicId}-fixture`);
        mkdirSync(storyRoot, { recursive: true });
        if (epicId === "050") {
          writeFileSync(
            join(storyRoot, "01-fixture.md"),
            [
              "# Story fixture",
              "",
              "Kind: story-implement",
              "",
              "## Verify",
              "",
              "1. fixture",
              "",
              "Diagrams: first-path second-path",
              "",
              "### `first-path`",
              "",
              "```mermaid",
              "sequenceDiagram",
              "participant Client",
              "participant Command",
              "Client->>Command: request",
              "Command-->>Client: ok",
              "```",
              "",
              "### `second-path`",
              "",
              "```mermaid",
              "sequenceDiagram",
              "participant Client",
              "participant Command",
              "Client->>Command: request",
              "Command-->>Client: ok",
              "```",
              "",
            ].join("\n"),
          );
        }
      }

      assert.throws(
        () => verifyEpicSequence(fixtureRoot),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          assert.match((error as Error).message, /owns two live diagrams/);
          assert.match((error as Error).message, /01-fixture\.md/);
          return true;
        },
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a story of an unshipped epic needs no scenario file", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
    const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
    const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");

    mkdirSync(epicsRoot, { recursive: true });
    mkdirSync(storiesRoot, { recursive: true });

    try {
      for (const epicId of authoredEpics) {
        writeFileSync(
          join(epicsRoot, `${epicId}-fixture.md`),
          `# EPIC ${epicId} — fixture\n`,
        );
        mkdirSync(join(storiesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }

      writeFileSync(
        join(storiesRoot, "050.2-fixture", "01-unshipped.md"),
        [
          "# Story fixture",
          "",
          "Kind: story-implement",
          "",
          "## Verify",
          "",
          "1. fixture",
          "",
          "Diagrams: unshipped-live",
          "",
          "### `unshipped-live`",
          "",
          "```mermaid",
          "sequenceDiagram",
          "participant Client",
          "participant Command",
          "Command-->>Client: ok",
          "```",
          "",
        ].join("\n"),
      );

      assert.doesNotThrow(() => verifyEpicSequence(fixtureRoot));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a story of a shipped epic missing its scenario file", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
    const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
    const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");
    const scenariosRoot = join(fixtureRoot, "test", "sequence", "scenarios");

    mkdirSync(epicsRoot, { recursive: true });
    mkdirSync(storiesRoot, { recursive: true });
    mkdirSync(scenariosRoot, { recursive: true });

    try {
      for (const epicId of authoredEpics) {
        writeFileSync(
          join(epicsRoot, `${epicId}-fixture.md`),
          `# EPIC ${epicId} — fixture\n`,
        );
        mkdirSync(join(storiesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }

      writeFileSync(
        join(storiesRoot, "050-fixture", "01-shipped.md"),
        [
          "# Story fixture",
          "",
          "Kind: story-implement",
          "",
          "## Verify",
          "",
          "1. fixture",
          "",
          "Diagrams: shipped-live",
          "",
          "### `shipped-live`",
          "",
          "```mermaid",
          "sequenceDiagram",
          "participant Client",
          "participant Command",
          "Client->>Command: request",
          "Command-->>Client: ok",
          "```",
          "",
        ].join("\n"),
      );

      assert.throws(
        () => verifyEpicSequence(fixtureRoot),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          assert.equal(
            (error as Error).message,
            "due live diagram shipped-live lacks test/sequence/scenarios/shipped-live.ts",
          );
          return true;
        },
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a baseline id holding a scenario file", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kanthord-epic-sequence-"));
    const epicsRoot = join(fixtureRoot, ".agents", "plan", "epics");
    const storiesRoot = join(fixtureRoot, ".agents", "plan", "stories");
    const scenariosRoot = join(fixtureRoot, "test", "sequence", "scenarios");

    mkdirSync(epicsRoot, { recursive: true });
    mkdirSync(storiesRoot, { recursive: true });
    mkdirSync(scenariosRoot, { recursive: true });

    try {
      for (const epicId of authoredEpics) {
        writeFileSync(
          join(epicsRoot, `${epicId}-fixture.md`),
          `# EPIC ${epicId} — fixture\n`,
        );
        mkdirSync(join(storiesRoot, `${epicId}-fixture`), {
          recursive: true,
        });
      }

      writeFileSync(
        join(storiesRoot, "050.2-fixture", "01-baseline.md"),
        [
          "# Story fixture",
          "",
          "Kind: story-implement",
          "",
          "## Verify",
          "",
          "1. fixture",
          "",
          "Diagrams: live-fixture",
          "",
          "Baselines: live-fixture <- baseline-fixture",
          "",
          "### `baseline-fixture`",
          "",
          "Superseded by: EPIC 050.2 live-fixture",
          "",
          "```mermaid",
          "sequenceDiagram",
          "participant Client",
          "participant Command",
          "Client->>Command: request",
          "Command-->>Client: ok",
          "```",
          "",
          "### `live-fixture`",
          "",
          "```mermaid",
          "sequenceDiagram",
          "participant Client",
          "participant Command",
          "Client->>Command: request",
          "Command-->>Client: ok",
          "```",
          "",
        ].join("\n"),
      );
      writeFileSync(join(scenariosRoot, "baseline-fixture.ts"), "export {};\n");

      assert.throws(
        () => verifyEpicSequence(fixtureRoot),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          assert.match((error as Error).message, /baseline/);
          assert.match((error as Error).message, /scenario/);
          assert.match((error as Error).message, /baseline-fixture/);
          return true;
        },
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("a diagram with an invalid message fails the parser", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-parser.md",
          source: storyDocument("story-implement", [
            "Diagrams: malformed",
            diagram("malformed", [], "Command-->>Client: invalid"),
          ]),
        },
      ],
      "invalid message in diagram malformed",
    );
  });

  it("duplicate live diagram ids fail", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-first.md",
          source: storyDocument("story-implement", [
            "Diagrams: repeated",
            diagram("repeated"),
          ]),
        },
        {
          epicId: "050.2",
          fileName: "02-second.md",
          source: storyDocument("story-implement", [
            "Diagrams: repeated",
            diagram("repeated"),
          ]),
        },
      ],
      "diagram id repeats across diagrams: repeated",
    );
  });

  it("a Supersedes line naming an undeclared diagram fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-supersedes.md",
          source: storyDocument("story-implement", [
            "Diagrams: replacement",
            diagram("replacement"),
            "Supersedes: EPIC 050.2 undeclared",
          ]),
        },
      ],
      "supersession names no declared diagram undeclared",
    );
  });

  it("an unpinned tail naming an outside epic fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-tail.md",
          source: storyDocument("story-implement", [
            "Diagrams: tail-invalid",
            diagram(
              "tail-invalid",
              [],
              "Note over Command: tail unchanged by EPIC 999",
            ),
          ]),
        },
      ],
      "diagram tail-invalid names an epic outside the authored set",
    );
  });

  it("a live diagram named by no Diagrams line fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-orphan.md",
          source: storyDocument("story-foundation", [diagram("orphan-live")]),
        },
      ],
      "live diagram orphan-live is named by no Diagrams line",
    );
  });

  it("a story with no valid kind fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-kind.md",
          source: storyDocument("story-unknown"),
        },
      ],
      /story .*01-kind\.md has no valid kind/,
    );
  });

  it("a story-foundation carrying path declarations fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-foundation.md",
          source: storyDocument("story-foundation", [
            "Diagrams: foundation-path",
            diagram("foundation-path"),
          ]),
        },
      ],
      /story-foundation .*01-foundation\.md carries a path declaration/,
    );
  });

  it("a story-implement with no Diagrams line fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-implement.md",
          source: storyDocument("story-implement"),
        },
      ],
      /story-implement .*01-implement\.md declares no Diagrams line/,
    );
  });

  it("a baseline without a Superseded by line fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-baseline.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            diagram("live-path"),
            diagram("baseline-path"),
          ]),
        },
      ],
      "baseline baseline-path carries no Superseded by line",
    );
  });

  it("a Baselines pair naming no baseline diagram fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-baseline-pair.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            "Baselines: live-path <- not-a-baseline",
            diagram("live-path"),
          ]),
        },
      ],
      "Baselines pair names no baseline diagram: not-a-baseline",
    );
  });

  it("a Baselines pair naming a live diagram the story does not own fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-owner.md",
          source: storyDocument("story-implement", [
            "Diagrams: owned-path",
            diagram("owned-path"),
          ]),
        },
        {
          epicId: "050.2",
          fileName: "02-pair.md",
          source: storyDocument("story-implement", [
            "Diagrams: other-path",
            "Baselines: owned-path <- baseline-path",
            diagram("other-path"),
            diagram(
              "baseline-path",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 owned-path",
            ),
          ]),
        },
      ],
      "Baselines pair names a diagram the story does not own: owned-path",
    );
  });

  it("a Seams line naming a diagram another story owns fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-owner.md",
          source: storyDocument("story-implement", [
            "Diagrams: owned-path",
            diagram("owned-path"),
          ]),
        },
        {
          epicId: "050.2",
          fileName: "02-seams.md",
          source: storyDocument("story-implement", [
            "Diagrams: other-path",
            "Seams: owned-path: +plan.read",
            diagram("other-path"),
          ]),
        },
      ],
      "Seams line names a diagram the story does not own: owned-path",
    );
  });

  it("a seam token with no sign fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-sign.md",
          source: storyDocument("story-implement", [
            "Diagrams: sign-path",
            "Seams: sign-path: plan.read",
            diagram("sign-path"),
          ]),
        },
      ],
      /seam token carries no sign .*plan\.read/,
    );
  });

  it("two signs for one seam token fail", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-two-signs.md",
          source: storyDocument("story-implement", [
            "Diagrams: sign-path",
            "Seams: sign-path: +plan.read, ~plan.read",
            diagram("sign-path"),
          ]),
        },
      ],
      /two signs for one diagram .*plan\.read/,
    );
  });

  it("a tilde token absent from its diagram fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-current.md",
          source: storyDocument("story-implement", [
            "Diagrams: current-path",
            "Seams: current-path: ~plan.read",
            diagram("current-path", []),
          ]),
        },
      ],
      "~ token appears in no diagram: plan.read",
    );
  });

  it("a plus token present in its baseline fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-plus-baseline.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            "Baselines: live-path <- baseline-path",
            "Seams: live-path: +plan.read",
            diagram("live-path"),
            diagram(
              "baseline-path",
              ["1 plan.read"],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 live-path",
            ),
          ]),
        },
      ],
      "+ token appears in its baseline: plan.read",
    );
  });

  it("a minus token present in its diagram fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-minus-current.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            "Baselines: live-path <- baseline-path",
            "Seams: live-path: -plan.read @src/file.ts:1",
            diagram("live-path"),
            diagram(
              "baseline-path",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 live-path",
            ),
          ]),
        },
      ],
      "- token appears in its diagram: plan.read",
    );
  });

  it("a minus token without baseline or citation fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-minus-evidence.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            "Baselines: live-path <- baseline-path",
            "Seams: live-path: -plan.read",
            diagram("live-path", []),
            diagram(
              "baseline-path",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 live-path",
            ),
          ]),
        },
      ],
      "- token appears in neither baseline nor citation: plan.read",
    );
  });

  it("an invalid seam citation fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-citation.md",
          source: storyDocument("story-implement", [
            "Diagrams: live-path",
            "Baselines: live-path <- baseline-path",
            "Seams: live-path: -plan.read @src/file.ts",
            diagram("live-path", []),
            diagram(
              "baseline-path",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 live-path",
            ),
          ]),
        },
      ],
      /invalid seam citation .*@src\/file\.ts/,
    );
  });

  it("an epic with more than ten stories fails", () => {
    const stories = Array.from({ length: 11 }, (_, index) => ({
      epicId: "050.2",
      fileName: `${String(index + 1).padStart(2, "0")}-foundation.md`,
      source: storyDocument("story-foundation"),
    }));
    assertFixtureRefusal(
      stories,
      /epic .*050\.2-fixture\.md holds more than ten stories/,
    );
  });

  it("a story without a numbered Verify list fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-verify.md",
          source: [
            "# Story fixture",
            "",
            "Kind: story-foundation",
            "",
            "## Verify",
            "",
            "No numbered cases",
            "",
          ].join("\n"),
        },
      ],
      /story .*01-verify\.md has no numbered case list/,
    );
  });

  it("a changed token without a sign owner fails", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-unowned.md",
          source: storyDocument("story-implement", [
            "Diagrams: unowned-path",
            "Baselines: unowned-path <- baseline-path",
            diagram("unowned-path"),
            diagram(
              "baseline-path",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 unowned-path",
            ),
          ]),
        },
      ],
      "changed token plan.read in unowned-path has 0 sign owners",
    );
  });

  it("duplicate fallback sign ownership fails while local repeated tokens pass", () => {
    assertFixtureRefusal(
      [
        {
          epicId: "050.2",
          fileName: "01-owner-a.md",
          source: storyDocument("story-implement", [
            "Diagrams: owner-a",
            "Seams: owner-a: +plan.read",
            diagram("owner-a"),
          ]),
        },
        {
          epicId: "050.2",
          fileName: "02-owner-b.md",
          source: storyDocument("story-implement", [
            "Diagrams: owner-b",
            "Seams: owner-b: +plan.read",
            diagram("owner-b"),
          ]),
        },
        {
          epicId: "050.2",
          fileName: "03-target.md",
          source: storyDocument("story-implement", [
            "Diagrams: target",
            "Baselines: target <- baseline-target",
            diagram("target"),
            diagram(
              "baseline-target",
              [],
              "Command-->>Client: ok",
              "Superseded by: EPIC 050.2 target",
            ),
          ]),
        },
      ],
      "changed token plan.read in target has 2 sign owners",
    );
  });

  it("the real plan tree passes the range gate", () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    assert.doesNotThrow(() => verifyEpicSequence(repositoryRoot));
  });
});
