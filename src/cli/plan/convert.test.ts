import { Command } from "commander";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PlanDirectoryDependencies } from "./directory.ts";
import { registerPlanConvert } from "./convert.ts";

const CWD = "/tmp/plan-convert-cwd";
const EPIC_RELATIVE = "source/epics/040-conversion-fixture.md";
const EPIC_PATH = `${CWD}/${EPIC_RELATIVE}`;
const EPIC_SLUG = "040-conversion-fixture";
const STORY_ROOT = `${CWD}/source/stories/${EPIC_SLUG}`;
const FIRST_PATH = `${STORY_ROOT}/01-first-story.md`;
const SECOND_PATH = `${STORY_ROOT}/02-second-story.md`;
const OUTPUT_ROOT = `${CWD}/converted`;

const EPIC = `# EPIC 040 — Conversion fixture

## Goal

Keep the conversion local.

## Stories

1. First story
2. Second story
`;

const FIRST_STORY = `# Story 1 — First story

## Change

Create the first node.

## Constraints

Use the first constraint.

## Verify

Check the first result.
`;

const SECOND_STORY = `# Story 2 — Second story

## Change

Create the second node.

## Constraints

Use the second constraint.

## Verify

Check the second result.
`;

const EXPECTED_DOCUMENTS = [
  {
    path: `plan/${EPIC_SLUG}/01-first-story/01-implement.md`,
    content:
      `---\n` +
      `kind: "task"\n` +
      `title: "Implement Story 1 — First story"\n` +
      `worker: "tdd@1"\n` +
      `---\n` +
      `## Change\n\n` +
      `Create the first node.\n` +
      `## Constraints\n\n` +
      `Use the first constraint.\n` +
      `## Acceptance criteria\n\n` +
      `Check the first result.\n`,
  },
  {
    path: `plan/${EPIC_SLUG}/01-first-story/objective.md`,
    content:
      `---\n` +
      `kind: "objective"\n` +
      `title: "First story"\n` +
      `repo: "atlas"\n` +
      `---\n` +
      `Source story: .agents/plan/stories/${EPIC_SLUG}/01-first-story.md.\n`,
  },
  {
    path: `plan/${EPIC_SLUG}/02-second-story/01-implement.md`,
    content:
      `---\n` +
      `kind: "task"\n` +
      `title: "Implement Story 2 — Second story"\n` +
      `worker: "tdd@1"\n` +
      `---\n` +
      `## Change\n\n` +
      `Create the second node.\n` +
      `## Constraints\n\n` +
      `Use the second constraint.\n` +
      `## Acceptance criteria\n\n` +
      `Check the second result.\n`,
  },
  {
    path: `plan/${EPIC_SLUG}/02-second-story/objective.md`,
    content:
      `---\n` +
      `kind: "objective"\n` +
      `title: "Second story"\n` +
      `depends_on:\n` +
      `  - "../01-first-story/objective.md"\n` +
      `repo: "atlas"\n` +
      `---\n` +
      `Source story: .agents/plan/stories/${EPIC_SLUG}/02-second-story.md.\n`,
  },
  {
    path: `plan/${EPIC_SLUG}/initiative.md`,
    content:
      `---\n` +
      `kind: "initiative"\n` +
      `title: "EPIC 040 — Conversion fixture"\n` +
      `---\n` +
      `Keep the conversion local.\n`,
  },
] as const;

const enotent = (path: string): Error & { code: string } =>
  Object.assign(new Error(`ENOENT: no such file or directory: '${path}'`), {
    code: "ENOENT",
  });

type HarnessOptions = Readonly<{
  files?: ReadonlyMap<string, string>;
  directoryErrors?: ReadonlyMap<string, Error>;
}>;

type Harness = Readonly<{
  program: Command;
  input: {
    program: Command;
    cwd: string;
    fs: PlanDirectoryDependencies;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    fail: () => void;
  };
  reads: readonly string[];
  writes: readonly Readonly<{ path: string; content: string }>[];
  removals: readonly string[];
  stdout(): string;
  stderr(): string;
  failures(): number;
}>;

const sourceFiles = (): Map<string, string> =>
  new Map([
    [EPIC_PATH, EPIC],
    [FIRST_PATH, FIRST_STORY],
    [SECOND_PATH, SECOND_STORY],
  ]);

const makeFileSystem = (
  options: HarnessOptions,
): {
  files: Map<string, string>;
  reads: string[];
  writes: Array<Readonly<{ path: string; content: string }>>;
  removals: string[];
  dependencies: PlanDirectoryDependencies;
} => {
  const files = new Map(options.files ?? sourceFiles());
  const reads: string[] = [];
  const writes: Array<Readonly<{ path: string; content: string }>> = [];
  const removals: string[] = [];
  const directoryErrors = options.directoryErrors ?? new Map();

  const readDirectory = (path: string): readonly string[] => {
    reads.push(`readDirectory ${path}`);
    const error = directoryErrors.get(path);
    if (error !== undefined) throw error;
    if (path === STORY_ROOT) {
      return [
        "02-second-story.md",
        "index.md",
        "notes.txt",
        "nested/",
        "01-first-story.md",
      ];
    }

    const prefix = `${path}/`;
    const names = new Map<string, boolean>();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      names.set(name, slash !== -1 || (names.get(name) ?? false));
    }
    if (names.size === 0) throw enotent(path);
    return [...names.entries()].map(([name, isDirectory]) =>
      isDirectory ? `${name}/` : name,
    );
  };

  const readFile = (path: string): string => {
    reads.push(`readFile ${path}`);
    const content = files.get(path);
    if (content === undefined) throw enotent(path);
    return content;
  };

  const writeFile = (path: string, content: string): void => {
    writes.push({ path, content });
    files.set(path, content);
  };

  const makeDirectory = (path: string): void => {
    reads.push(`makeDirectory ${path}`);
  };

  const removeFile = (path: string): void => {
    removals.push(path);
    files.delete(path);
  };

  return {
    files,
    reads,
    writes,
    removals,
    dependencies: {
      readDirectory,
      readFile,
      writeFile,
      makeDirectory,
      removeFile,
    },
  };
};

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const program = new Command();
  const fileSystem = makeFileSystem(options);
  let stdoutText = "";
  let stderrText = "";
  let failures = 0;
  const input = {
    program,
    cwd: CWD,
    fs: fileSystem.dependencies,
    stdout: (text: string): void => {
      stdoutText += text;
    },
    stderr: (text: string): void => {
      stderrText += text;
    },
    fail: (): void => {
      failures += 1;
    },
  };
  registerPlanConvert(input);
  return {
    program,
    input,
    reads: fileSystem.reads,
    writes: fileSystem.writes,
    removals: fileSystem.removals,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    failures: () => failures,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

const successArgs = [
  "plan",
  "convert",
  "--from",
  EPIC_RELATIVE,
  "--repo",
  "atlas",
  "--to",
  "converted",
] as const;

describe("src/cli/plan/convert.test", () => {
  it("reads the source in order, writes five exact documents once, and prints the conversion", async () => {
    const harness = makeHarness();

    await run(harness.program, successArgs);

    assert.deepEqual(harness.reads.slice(0, 4), [
      `readFile ${EPIC_PATH}`,
      `readDirectory ${STORY_ROOT}`,
      `readFile ${FIRST_PATH}`,
      `readFile ${SECOND_PATH}`,
    ]);
    assert.deepEqual(
      harness.writes.map((document) => ({
        path: document.path.slice(OUTPUT_ROOT.length + 1),
        content: document.content,
      })),
      EXPECTED_DOCUMENTS,
    );
    assert.deepEqual(harness.removals, []);
    assert.equal(
      harness.stdout(),
      `kanthord: converted 2 story into 5 document under ${OUTPUT_ROOT}/plan\n`,
    );
    assert.equal(harness.stderr(), "");
    assert.equal(harness.failures(), 0);
  });

  it("validates missing options in order without reading or writing", async () => {
    const cases = [
      { args: [], option: "from" },
      { args: ["--from", EPIC_RELATIVE], option: "repo" },
      {
        args: ["--from", EPIC_RELATIVE, "--repo", "atlas"],
        option: "to",
      },
    ] as const;

    for (const entry of cases) {
      const harness = makeHarness();

      await run(harness.program, ["plan", "convert", ...entry.args]);

      assert.equal(
        harness.stderr(),
        `kanthord: invalid-request: --${entry.option} is required\n`,
      );
      assert.equal(harness.failures(), 1);
      assert.deepEqual(harness.reads, []);
      assert.deepEqual(harness.writes, []);
      assert.deepEqual(harness.removals, []);
    }
  });

  it("refuses a source ENOENT without writing or removing", async () => {
    const harness = makeHarness({ files: new Map() });
    const args = [
      "plan",
      "convert",
      "--from",
      "missing/040-missing.md",
      "--repo",
      "atlas",
      "--to",
      "converted",
    ];

    await run(harness.program, args);

    assert.equal(
      harness.stderr(),
      `kanthord: invalid-request: cannot read ${CWD}/missing/040-missing.md\n`,
    );
    assert.equal(harness.failures(), 1);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.removals, []);
  });

  it("refuses an output inspection failure without writing or removing", async () => {
    const outputError = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const harness = makeHarness({
      directoryErrors: new Map([[`${OUTPUT_ROOT}/plan`, outputError]]),
    });

    await run(harness.program, successArgs);

    assert.equal(
      harness.stderr(),
      `kanthord: invalid-request: cannot read ${OUTPUT_ROOT}/plan\n`,
    );
    assert.equal(harness.failures(), 1);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.removals, []);
  });

  it("refuses pure-mapper validation failure before output inspection or writing", async () => {
    const invalidFirstStory = FIRST_STORY.replace(
      "## Verify\n\nCheck the first result.\n",
      "",
    );
    const files = sourceFiles();
    files.set(FIRST_PATH, invalidFirstStory);
    const harness = makeHarness({ files });

    await run(harness.program, successArgs);

    assert.equal(
      harness.stderr(),
      `kanthord: invalid-request: ${FIRST_PATH} has no non-empty ## Verify section\n`,
    );
    assert.equal(harness.failures(), 1);
    assert.equal(
      harness.reads.some(
        (entry) => entry === `readDirectory ${OUTPUT_ROOT}/plan`,
      ),
      false,
    );
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.removals, []);
  });

  it("refuses a non-empty output before writing or removing", async () => {
    const files = sourceFiles();
    files.set(`${OUTPUT_ROOT}/plan/existing.md`, "existing\n");
    const harness = makeHarness({ files });

    await run(harness.program, successArgs);

    assert.equal(
      harness.stderr(),
      `kanthord: invalid-request: ${OUTPUT_ROOT}/plan is not empty\n`,
    );
    assert.equal(harness.failures(), 1);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.removals, []);
  });

  it("duplicate registration leaves one convert leaf", () => {
    const harness = makeHarness();

    registerPlanConvert(harness.input);

    const group = harness.program.commands.find(
      (command) => command.name() === "plan",
    );
    assert.ok(group);
    assert.deepEqual(
      group.commands.map((command) => command.name()),
      ["convert"],
    );
  });
});
