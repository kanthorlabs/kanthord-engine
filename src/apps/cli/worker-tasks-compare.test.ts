import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import {
  fauxAssistantMessage,
  scriptedProvider,
  type ScriptedProvider,
} from "../../worker/unit/test-support.ts";
import { TasksErrorCode, TasksExit } from "../worker/index.ts";
import {
  commandRun,
  diagnosticOf,
  runOptions,
  seedFixture,
  type SeedFixture,
  TEST_TIMEOUT_MS,
  writeGood,
} from "./tasks-test-support.ts";
import { tasksCompare } from "./worker-tasks-compare.ts";
import { tasksRun, type TasksRunOptions } from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const SECTIONS = ["route", "end", "commits", "units", "metrics"];
const ONE_TURN = "1";
const CONTEXT_FILE = "context.json";

interface ContextFile {
  input: {
    checkouts: { binding_id: string; name: string }[];
    heads: Record<string, string>;
  };
  result: { heads: Record<string, string> };
}

function copied(
  folder: string,
  name: string,
  change: (context: ContextFile, copy: string) => void,
): string {
  const copy = join(folder, "..", name);
  cpSync(folder, copy, { recursive: true });
  const path = join(copy, CONTEXT_FILE);
  const context = JSON.parse(readFileSync(path, "utf8")) as ContextFile;
  change(context, copy);
  writeFileSync(path, JSON.stringify(context));
  return copy;
}

async function recorded(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  options: Partial<TasksRunOptions>,
): Promise<string> {
  const run = commandRun(fixture, provider, { piDirectory: PI_DIRECTORY });
  const code = await tasksRun(
    fixture.seedFolder,
    runOptions(fixture, options),
    run.io,
  );
  assert.equal(code, TasksExit.Success, run.stderr.join(""));
  return options.output!;
}

async function compared(outputs: [string, string]) {
  const lines: string[] = [];
  await tasksCompare(outputs, {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => void lines.push(text),
  });
  return JSON.parse(lines.join("")) as {
    seed_digest: string;
    differences: { section: string; a: unknown; b: unknown }[];
  };
}

test(
  "worker tasks compare shows each section of difference of two runs of one seed and refuses two runs of different seeds",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await seedFixture(t);
    const completed = await recorded(
      fixture,
      scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      { output: join(fixture.root, "completed") },
    );
    const ended = await recorded(
      fixture,
      scriptedProvider([fauxAssistantMessage("not yet")]),
      { output: join(fixture.root, "ended"), budgetTurns: ONE_TURN },
    );
    const same = await compared([completed, completed]);
    assert.deepEqual(same.differences, []);
    const differ = await compared([completed, ended]);
    assert.equal(differ.seed_digest, same.seed_digest);
    assert.deepEqual(
      differ.differences.map(({ section }) => section),
      SECTIONS,
    );
    const other = await seedFixture(t, (seed) => {
      seed.elapsed_ms = 1;
    });
    const foreign = await recorded(
      other,
      scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      { output: join(other.root, "foreign") },
    );
    const refused = await diagnosticOf(compared([completed, foreign]));
    assert.equal(refused.code, TasksErrorCode.SeedMismatch);
  },
);

test(
  "worker tasks compare refuses a head that is not a commit id and a run folder with no checkout, and git log writes no file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await seedFixture(t);
    const completed = await recorded(
      fixture,
      scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      { output: join(fixture.root, "completed") },
    );
    const written = join(fixture.root, "written");
    const injected = copied(completed, "injected", (context) => {
      const [first] = context.input.checkouts;
      context.input.heads[first!.binding_id] = `--output=${written}`;
    });
    const refused = await diagnosticOf(compared([completed, injected]));
    assert.equal(refused.code, TasksErrorCode.OptionInvalid);
    assert.deepEqual(refused.fields, [["option", "<output-b>"]]);
    assert.equal(existsSync(written), false);
    const absent = copied(completed, "absent", (context, copy) => {
      rmSync(
        join(copy, "state", "checkouts", context.input.checkouts[0]!.name),
        {
          recursive: true,
        },
      );
    });
    const missing = await diagnosticOf(compared([absent, completed]));
    assert.equal(missing.code, TasksErrorCode.OptionInvalid);
    assert.deepEqual(missing.fields, [["option", "<output-a>"]]);
  },
);
