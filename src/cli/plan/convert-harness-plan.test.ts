import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ConvertedPlanDocument,
  HarnessPlanSource,
} from "./convert-harness-plan.ts";
import { convertHarnessPlan } from "./convert-harness-plan.ts";

const EPIC_PATH = "/fixtures/.agents/plan/epics/040-harness-conversion.md";
const STORY_ROOT = "/fixtures/.agents/plan/stories/040-harness-conversion";
const STORY_ONE_PATH = `${STORY_ROOT}/01-first-story.md`;
const STORY_TWO_PATH = `${STORY_ROOT}/02-second-story.md`;
const REPOSITORY = "kanthord-main";

const exactDocument = (lines: readonly string[]): string =>
  `${lines.join("\n")}\n`;

const EPIC_CONTENT = exactDocument([
  "# EPIC 040 — Harness conversion",
  "",
  "## Goal",
  "",
  "Convert the harness.",
  "Keep its bytes.",
  "",
  "## Stories",
  "",
  "1. First story",
  "2. Second story",
]);

const STORY_ONE_CONTENT = exactDocument([
  "# Story 1 — First story",
  "",
  "## Change",
  "",
  "Implement first change.",
  "",
  "## Constraints",
  "",
  "Use first constraint.",
  "",
  "## Verify",
  "",
  "First criterion.",
]);

const STORY_TWO_CONTENT = exactDocument([
  "# Story 2 — Second story",
  "",
  "## Change",
  "",
  "Implement second change.",
  "",
  "## Constraints",
  "",
  "Use second constraint.",
  "",
  "## Verify",
  "",
  "Second criterion.",
]);

const STORY_ONE = { path: STORY_ONE_PATH, content: STORY_ONE_CONTENT };
const STORY_TWO = { path: STORY_TWO_PATH, content: STORY_TWO_CONTENT };
const IGNORED_INDEX = {
  path: `${STORY_ROOT}/index.md`,
  content: "ignored index",
};
const IGNORED_NOTES = {
  path: `${STORY_ROOT}/notes.txt`,
  content: "ignored notes",
};

const VALID_STORIES = [STORY_TWO, IGNORED_INDEX, IGNORED_NOTES, STORY_ONE];

const makeInput = (
  overrides: Readonly<{
    epic?: HarnessPlanSource["epic"];
    stories?: HarnessPlanSource["stories"];
    repository?: string;
  }> = {},
): HarnessPlanSource => ({
  epic: overrides.epic ?? { path: EPIC_PATH, content: EPIC_CONTENT },
  stories: overrides.stories ?? VALID_STORIES,
  repository: overrides.repository ?? REPOSITORY,
});

const EXPECTED_DOCUMENTS: readonly ConvertedPlanDocument[] = [
  {
    path: "plan/040-harness-conversion/01-first-story/01-implement.md",
    content: exactDocument([
      "---",
      'kind: "task"',
      'title: "Implement Story 1 — First story"',
      'worker: "tdd@1"',
      "---",
      "## Change",
      "",
      "Implement first change.",
      "## Constraints",
      "",
      "Use first constraint.",
      "## Acceptance criteria",
      "",
      "First criterion.",
    ]),
  },
  {
    path: "plan/040-harness-conversion/01-first-story/objective.md",
    content: exactDocument([
      "---",
      'kind: "objective"',
      'title: "First story"',
      `repo: "${REPOSITORY}"`,
      "---",
      "Source story: .agents/plan/stories/040-harness-conversion/01-first-story.md.",
    ]),
  },
  {
    path: "plan/040-harness-conversion/02-second-story/01-implement.md",
    content: exactDocument([
      "---",
      'kind: "task"',
      'title: "Implement Story 2 — Second story"',
      'worker: "tdd@1"',
      "---",
      "## Change",
      "",
      "Implement second change.",
      "## Constraints",
      "",
      "Use second constraint.",
      "## Acceptance criteria",
      "",
      "Second criterion.",
    ]),
  },
  {
    path: "plan/040-harness-conversion/02-second-story/objective.md",
    content: exactDocument([
      "---",
      'kind: "objective"',
      'title: "Second story"',
      "depends_on:",
      '  - "../01-first-story/objective.md"',
      `repo: "${REPOSITORY}"`,
      "---",
      "Source story: .agents/plan/stories/040-harness-conversion/02-second-story.md.",
    ]),
  },
  {
    path: "plan/040-harness-conversion/initiative.md",
    content: exactDocument([
      "---",
      'kind: "initiative"',
      'title: "EPIC 040 — Harness conversion"',
      "---",
      "Convert the harness.",
      "Keep its bytes.",
    ]),
  },
];

const assertMessage = (input: HarnessPlanSource, message: string): void => {
  assert.throws(
    () => convertHarnessPlan(input),
    (error: unknown) => error instanceof Error && error.message === message,
  );
};

describe("src/cli/plan/convert-harness-plan.test", () => {
  it("converts two Stories into five exact documents in canonical path order", () => {
    const documents = convertHarnessPlan(makeInput());

    assert.deepStrictEqual(documents, EXPECTED_DOCUMENTS);
    assert.deepStrictEqual(
      documents.map((document) => document.path),
      EXPECTED_DOCUMENTS.map((document) => document.path),
    );
    for (const document of documents) {
      assert.equal(document.content.endsWith("\n\n"), false);
      assert.equal(document.content.includes("\r"), false);
      assert.equal(/^.*\nid:\s/m.test(document.content), false);
    }
  });

  it("sorting the Story records produces byte-identical output", () => {
    const documents = convertHarnessPlan(makeInput());
    const reversed = convertHarnessPlan(
      makeInput({ stories: [...VALID_STORIES].reverse() }),
    );

    assert.deepStrictEqual(reversed, documents);
    assert.deepStrictEqual(reversed, EXPECTED_DOCUMENTS);
  });

  it("returns frozen documents that stay independent from mutable source records", () => {
    const epic = { path: EPIC_PATH, content: EPIC_CONTENT };
    const stories = [{ ...STORY_TWO }, { ...STORY_ONE }];
    const documents = convertHarnessPlan({
      epic,
      stories,
      repository: REPOSITORY,
    });

    epic.content = "changed";
    stories[0]!.content = "changed";

    assert.deepStrictEqual(documents, EXPECTED_DOCUMENTS);
    assert.equal(Object.isFrozen(documents), true);
    for (const document of documents) {
      assert.equal(Object.isFrozen(document), true);
    }
  });

  it("normalizes CRLF and lone CR input and JSON-stringifies quoted and backslash titles", () => {
    const quotedEpicPath =
      "/fixtures/.agents/plan/epics/007-quoted-conversion.md";
    const quotedStoryPath =
      "/fixtures/.agents/plan/stories/007-quoted-conversion/01-quoted-story.md";
    const quotedEpic = exactDocument([
      String.raw`# EPIC 007 — A "quoted" \ title`,
      "",
      "## Goal",
      "",
      "Quoted goal.",
      "",
      "## Stories",
      "",
      "1. Quoted story",
    ]);
    const quotedStory = exactDocument([
      String.raw`# Story 1 — A "story" \ path`,
      "",
      "## Change",
      "",
      "Quoted change.",
      "",
      "## Constraints",
      "",
      "Quoted constraint.",
      "",
      "## Verify",
      "",
      "Quoted verify.",
    ]).replace("Quoted change.\n", "Quoted change.\r");
    const documents = convertHarnessPlan({
      epic: {
        path: quotedEpicPath,
        content: quotedEpic.replaceAll("\n", "\r\n"),
      },
      stories: [
        {
          path: quotedStoryPath,
          content: quotedStory.replaceAll("\n", "\r\n"),
        },
      ],
      repository: REPOSITORY,
    });

    const initiative = documents.find((document) =>
      document.path.endsWith("/initiative.md"),
    );
    const objective = documents.find((document) =>
      document.path.endsWith("/objective.md"),
    );
    const task = documents.find((document) =>
      document.path.endsWith("/01-implement.md"),
    );
    assert.ok(initiative !== undefined);
    assert.ok(objective !== undefined);
    assert.ok(task !== undefined);
    assert.ok(
      initiative.content.includes(
        String.raw`title: "EPIC 007 — A \"quoted\" \\ title"`,
      ),
    );
    assert.ok(
      objective.content.includes(String.raw`title: "A \"story\" \\ path"`),
    );
    assert.ok(
      task.content.includes(
        String.raw`title: "Implement Story 1 — A \"story\" \\ path"`,
      ),
    );
    for (const document of documents) {
      assert.equal(document.content.includes("\r"), false);
      assert.equal(document.content.endsWith("\n\n"), false);
    }
  });

  it("refuses each invalid EPIC and expanded Story shape with the exact error", () => {
    const invalidEpicCases: readonly (readonly [string, HarnessPlanSource])[] =
      [
        [
          "the EPIC path must end in .md",
          makeInput({
            epic: {
              path: EPIC_PATH.replace(".md", ".markdown"),
              content: EPIC_CONTENT,
            },
          }),
        ],
        [
          "the EPIC heading is invalid",
          makeInput({
            epic: {
              path: EPIC_PATH,
              content: EPIC_CONTENT.replace(
                "# EPIC 040 — Harness conversion",
                "# Epic 040 — Harness conversion",
              ),
            },
          }),
        ],
        ["the repository name is empty", makeInput({ repository: "" })],
        [
          "the EPIC Goal is missing",
          makeInput({
            epic: {
              path: EPIC_PATH,
              content: EPIC_CONTENT.replace(
                "Convert the harness.\nKeep its bytes.\n",
                "",
              ),
            },
          }),
        ],
        [
          "the EPIC Stories list is empty",
          makeInput({
            epic: {
              path: EPIC_PATH,
              content: EPIC_CONTENT.replace(
                "1. First story\n2. Second story\n",
                "",
              ),
            },
          }),
        ],
        [
          "the EPIC Stories list is not contiguous",
          makeInput({
            epic: {
              path: EPIC_PATH,
              content: EPIC_CONTENT.replace(
                "2. Second story",
                "3. Second story",
              ),
            },
          }),
        ],
      ];
    for (const [message, input] of invalidEpicCases) {
      assertMessage(input, message);
    }

    assertMessage(
      makeInput({ stories: [STORY_ONE] }),
      "expected 2 expanded Story files; found 1",
    );

    const duplicateStory = {
      path: `${STORY_ROOT}/01-second-story.md`,
      content: STORY_TWO_CONTENT,
    };
    assertMessage(
      makeInput({ stories: [STORY_ONE, duplicateStory] }),
      "expected Story file 02; found 01-second-story.md",
    );

    const skippedStory = {
      path: `${STORY_ROOT}/03-second-story.md`,
      content: STORY_TWO_CONTENT,
    };
    assertMessage(
      makeInput({ stories: [STORY_ONE, skippedStory] }),
      "expected Story file 02; found 03-second-story.md",
    );

    assertMessage(
      makeInput({
        stories: [
          {
            path: STORY_ONE_PATH,
            content: STORY_ONE_CONTENT.replace(
              "# Story 1 — First story",
              "# Story 2 — First story",
            ),
          },
          STORY_TWO,
        ],
      }),
      `${STORY_ONE_PATH} heading does not name Story 1`,
    );

    const requiredSections: readonly (readonly [string, string])[] = [
      ["Change", "## Change\n\nImplement first change.\n"],
      ["Constraints", "## Constraints\n\nUse first constraint.\n"],
      ["Verify", "## Verify\n\nFirst criterion.\n"],
    ];
    for (const [section, source] of requiredSections) {
      assertMessage(
        makeInput({
          stories: [
            {
              path: STORY_ONE_PATH,
              content: STORY_ONE_CONTENT.replace(source, `## ${section}\n\n`),
            },
            STORY_TWO,
          ],
        }),
        `${STORY_ONE_PATH} has no non-empty ## ${section} section`,
      );
    }
  });
});
