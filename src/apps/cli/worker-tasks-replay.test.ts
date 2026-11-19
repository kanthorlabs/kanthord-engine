import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { suite, test } from "node:test";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import { HostTool } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  scriptedModelRuntime,
  scriptedProvider,
  type ScriptedProvider,
  task,
} from "../../worker/unit/test-support.ts";
import {
  defaultCapabilities,
  RunEndKind,
  TasksErrorCode,
  TasksExit,
} from "../worker/index.ts";
import {
  checkOf,
  checkoutOf,
  type CommandRun,
  countedCapabilities,
  diagnosticOf,
  readJson,
  replayOptions,
  runOptions,
  type SeedFixture,
  seedFixture,
  commandRun as sharedCommandRun,
  TEST_TIMEOUT_MS,
  type ToolCounts,
  toolUse,
  turnLines,
  TURNS_FILE,
  writeGood,
} from "./tasks-test-support.ts";
import {
  type TasksCommandIo,
  tasksRun,
  type TasksRunOptions,
} from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const REPLAY_CHECK = 8;
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const THREE_CALLS = 3;
const FIRST_TOOL_RESULT_INDEX = 3;
const SECOND_TOOL_RESULT_INDEX = 5;
const CLOCK_COMMAND = "node -e 'console.log(process.hrtime.bigint())'";
const NEWLINE = "\n";
const REPLAY_MODE = "replay";
const BASH_OUTPUT = "ran";
const EDITED_TEXT = "good edited";
const TOOL_KIND = "tool";
const HEADER_KIND = "header";
const RELEASE_STEP = "base.fetch";
const RELEASE_GATE_LOOP = "release_gate";
const PROMPT_TEXT = "Local system prompt marker.";
const TEMPLATE_TEXT = "Local work template marker.";
const OPEN_FAILURE = "open-world failure";
const VALID_HEADER = JSON.stringify({
  kind: HEADER_KIND,
  version: 1,
  seed_digest: "digest",
  overrides: {},
});

function commandRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): CommandRun {
  return sharedCommandRun(fixture, provider, {
    piDirectory: PI_DIRECTORY,
    ...overrides,
  });
}

function liveScript() {
  return scriptedProvider([
    toolUse("bash", { command: "printf ran >> ran.txt" }),
    writeGood(),
    fauxAssistantMessage("done"),
  ]);
}

interface LiveRun {
  provider: ScriptedProvider;
  options?: Partial<TasksRunOptions>;
  io?: Partial<TasksCommandIo>;
}

async function liveRun(fixture: SeedFixture, live: LiveRun): Promise<string> {
  const run = commandRun(fixture, live.provider, live.io);
  const code = await tasksRun(
    fixture.seedFolder,
    runOptions(fixture, { verify: true, ...live.options }),
    run.io,
  );
  assert.equal(code, TasksExit.Success, run.stderr.join(""));
  return join(fixture.root, "out", TURNS_FILE);
}

async function replayed(
  fixture: SeedFixture,
  turns: string,
  options: Partial<TasksRunOptions> = {},
): Promise<TasksExit> {
  const replay = commandRun(fixture, scriptedProvider([]));
  return tasksRun(
    fixture.seedFolder,
    replayOptions(fixture, turns, options),
    replay.io,
  );
}

async function replayCode(
  fixture: SeedFixture,
  turns: string,
  options: Partial<TasksRunOptions> = {},
): Promise<{ code: string; fields: unknown }> {
  return diagnosticOf(replayed(fixture, turns, options));
}

function writeFileOptions(fixture: SeedFixture): void {
  writeFileSync(join(fixture.root, "system.md"), PROMPT_TEXT);
  mkdirSync(join(fixture.root, "templates"));
  writeFileSync(join(fixture.root, "templates", "work.md"), TEMPLATE_TEXT);
}

const FILE_OPTIONS = { systemPrompt: "system.md", templates: "templates" };

suite("worker tasks run replay", () => {
  test(
    "a live run writes turns.jsonl, and a replay of it passes check 8 with --verify",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([
          toolUse("bash", { command: "printf ran >> ran.txt" }),
          writeGood(),
          toolUse(HostTool.EvidenceUpload, { path: "file" }),
          fauxAssistantMessage("done"),
        ]),
      });
      const [header] = readFileSync(turns, "utf8").split(NEWLINE);
      assert.deepEqual(JSON.parse(header!), {
        kind: HEADER_KIND,
        version: 1,
        seed_digest: readJson(join(fixture.root, "out"), "result.json")
          .seed_digest,
        overrides: {},
      });
      const code = await replayed(fixture, turns);
      assert.equal(code, TasksExit.Success);
      const folder = join(fixture.root, "replay");
      assert.equal(readJson(folder, "result.json").mode, REPLAY_MODE);
      assert.deepEqual(checkOf(folder, REPLAY_CHECK), {
        check: REPLAY_CHECK,
        applies: true,
        passed: true,
      });
      const outbox = JSON.parse(
        readFileSync(join(folder, "outbox.json"), "utf8"),
      ) as unknown[];
      assert.equal(outbox.length, ONE_CALL);
      assert.equal(
        readFileSync(join(checkoutOf(folder), "ran.txt"), "utf8"),
        BASH_OUTPUT,
      );
    },
  );

  test(
    "a replay continues past bash result texts that differ and records one drift entry for each tool call in result.json",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([
          toolUse("bash", { command: CLOCK_COMMAND }),
          toolUse("bash", { command: CLOCK_COMMAND }),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
      });
      assert.equal(
        readJson(join(fixture.root, "out"), "result.json").drift,
        null,
      );
      const code = await replayed(fixture, turns);
      assert.equal(code, TasksExit.Success);
      const folder = join(fixture.root, "replay");
      const drift = readJson(folder, "result.json").drift as {
        turn: number;
        step: string;
        message_index: number;
        tool_call_id: string;
        tool_name: string;
      }[];
      assert.deepEqual(
        drift.map(({ turn, step, message_index, tool_name }) => ({
          turn,
          step,
          message_index,
          tool_name,
        })),
        [
          {
            turn: TWO_CALLS,
            step: "unit.turn",
            message_index: FIRST_TOOL_RESULT_INDEX,
            tool_name: "bash",
          },
          {
            turn: THREE_CALLS,
            step: "unit.turn",
            message_index: SECOND_TOOL_RESULT_INDEX,
            tool_name: "bash",
          },
        ],
      );
      assert.notEqual(drift[0]!.tool_call_id, drift[1]!.tool_call_id);
      assert.deepEqual(checkOf(folder, REPLAY_CHECK), {
        check: REPLAY_CHECK,
        applies: true,
        passed: true,
      });
    },
  );

  test(
    "a replay whose bash result changes its error state stops with replay_diverged, reason request_differs",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const once = join(fixture.root, "once");
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([
          toolUse("bash", { command: `mkdir '${once}'` }),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
      });
      const failed = await replayCode(fixture, turns);
      assert.equal(failed.code, TasksErrorCode.ReplayDiverged);
      assert.deepEqual(failed.fields, [
        ["turn", String(TWO_CALLS)],
        ["reason", "request_differs"],
        ["step", "unit.turn"],
      ]);
      assert.deepEqual(
        readJson(join(fixture.root, "replay"), "result.json").drift,
        [],
      );
    },
  );

  test(
    "a replay with a changed tool set stops with replay_diverged, reason request_differs, turn 1",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, { provider: liveScript() });
      const replay = commandRun(fixture, scriptedProvider([]), {
        capabilities: (tools) => defaultCapabilities(tools).slice(0, ONE_CALL),
      });
      const failed = await diagnosticOf(
        tasksRun(fixture.seedFolder, replayOptions(fixture, turns), replay.io),
      );
      assert.equal(failed.code, TasksErrorCode.ReplayDiverged);
      const result = readJson(join(fixture.root, "replay"), "result.json");
      assert.equal(result.end, RunEndKind.Diagnostic);
      assert.equal(result.code, TasksErrorCode.ReplayDiverged);
      assert.deepEqual(result.fields, {
        turn: "1",
        reason: "request_differs",
        step: "unit.turn",
      });
    },
  );

  test(
    "replay mode reads no standard input, calls no provider and gives the model runtime the placeholder credential",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, { provider: liveScript() });
      const provider = scriptedProvider([]);
      const scripted = scriptedModelRuntime(provider);
      let reads = NO_CALLS;
      const stored: unknown[] = [];
      const replay = commandRun(fixture, provider, {
        stdinTerminal: true,
        readStdin: () => {
          reads += 1;
          return Buffer.alloc(NO_CALLS);
        },
        modelRuntimeFactory: async (input) => {
          stored.push(await input.credential.store.read("anthropic"));
          return scripted(input);
        },
      });
      const code = await tasksRun(
        fixture.seedFolder,
        replayOptions(fixture, turns),
        replay.io,
      );
      assert.equal(code, TasksExit.Success, replay.stderr.join(""));
      assert.equal(reads, NO_CALLS);
      assert.equal(provider.calls.length, NO_CALLS);
      assert.ok(stored.length > NO_CALLS);
      for (const credential of stored)
        assert.deepEqual(credential, { type: "api_key", key: "replay" });
    },
  );

  test(
    "a replay answers the recorded result of an open-world capability tool and runs bash, edit, write and a closed-world capability tool again",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const counts: ToolCounts = { openWorld: NO_CALLS, closedWorld: NO_CALLS };
      const capabilities = countedCapabilities(counts);
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([
          toolUse("bash", { command: "printf ran >> ran.txt" }),
          writeGood(),
          toolUse("edit", {
            path: "file",
            edits: [{ oldText: "good", newText: EDITED_TEXT }],
          }),
          toolUse(HostTool.LinkUpdateList, {}),
          toolUse(HostTool.EvidenceUpload, {}),
          fauxAssistantMessage("done"),
        ]),
        io: { capabilities },
      });
      assert.deepEqual(counts, { openWorld: ONE_CALL, closedWorld: ONE_CALL });
      const replay = commandRun(fixture, scriptedProvider([]), {
        capabilities,
      });
      const code = await tasksRun(
        fixture.seedFolder,
        replayOptions(fixture, turns),
        replay.io,
      );
      assert.equal(code, TasksExit.Success, replay.stderr.join(""));
      assert.deepEqual(counts, { openWorld: ONE_CALL, closedWorld: TWO_CALLS });
      const folder = join(fixture.root, "replay");
      const checkout = checkoutOf(folder);
      assert.equal(
        readFileSync(join(checkout, "ran.txt"), "utf8"),
        BASH_OUTPUT,
      );
      assert.equal(readFileSync(join(checkout, "file"), "utf8"), EDITED_TEXT);
      const tools = turnLines(folder).filter((line) => line.kind === TOOL_KIND);
      assert.deepEqual(
        tools.map((line) => line.result),
        [{ content: [{ type: "text", text: "open call 1" }] }],
      );
    },
  );

  test(
    "a replay answers the recorded error of an open-world capability tool and does not call the tool",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const counts: ToolCounts = { openWorld: NO_CALLS, closedWorld: NO_CALLS };
      const capabilities = countedCapabilities(counts, () => {
        throw new Error(OPEN_FAILURE);
      });
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([
          toolUse(HostTool.LinkUpdateList, {}),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
        io: { capabilities },
      });
      const replay = commandRun(fixture, scriptedProvider([]), {
        capabilities,
      });
      const code = await tasksRun(
        fixture.seedFolder,
        replayOptions(fixture, turns),
        replay.io,
      );
      assert.equal(code, TasksExit.Success, replay.stderr.join(""));
      assert.equal(counts.openWorld, ONE_CALL);
      for (const folder of ["out", "replay"])
        assert.deepEqual(
          turnLines(join(fixture.root, folder))
            .filter((line) => line.kind === TOOL_KIND)
            .map((line) => line.error),
          [OPEN_FAILURE],
        );
    },
  );

  test(
    "a replay of a --skip-release-gate run takes the override from the header, runs no release step and passes check 8",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, {
        provider: liveScript(),
        options: { skipReleaseGate: true },
      });
      assert.equal(await replayed(fixture, turns), TasksExit.Success);
      const folder = join(fixture.root, "replay");
      const metrics = readJson(folder, "metrics.json") as {
        steps: { step: string }[];
      };
      assert.ok(!metrics.steps.some((entry) => entry.step === RELEASE_STEP));
      const context = readJson(folder, "context.json") as {
        input: { until: string | null };
      };
      assert.equal(context.input.until, RELEASE_GATE_LOOP);
      assert.equal(checkOf(folder, REPLAY_CHECK)?.passed, true);
    },
  );

  test(
    "a replay of a --unit run runs the same unit with no divergence",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const first = task("first", "grep -q good file");
      const second = task("second", "true");
      const fixture = await seedFixture(t, (seed) => {
        (seed.revision as { tasks: unknown[] }).tasks = [first, second];
        seed.plan = {
          pending: [
            { unit_id: first.id, instruction: null },
            { unit_id: second.id, instruction: null },
          ],
          node: null,
        };
      });
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
        options: { unit: [first.id] },
      });
      assert.equal(await replayed(fixture, turns), TasksExit.Success);
      const progress = readJson(join(fixture.root, "replay"), "progress.json");
      assert.deepEqual(progress.completed_units, [first.id]);
    },
  );

  test(
    "a hand-written seed recorded with --system-prompt and --templates replays with the same files, and a file or seed that differs fails with replay_invalid",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t, (seed) => {
        const setup = seed.setup as {
          templates?: unknown;
          agents: { prompt: { final?: string } }[];
        };
        delete setup.templates;
        delete setup.agents[0]!.prompt.final;
      });
      writeFileOptions(fixture);
      const turns = await liveRun(fixture, {
        provider: scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
        options: FILE_OPTIONS,
      });
      assert.equal(
        await replayed(fixture, turns, FILE_OPTIONS),
        TasksExit.Success,
      );
      const missing = await replayCode(fixture, turns, {
        templates: FILE_OPTIONS.templates,
      });
      assert.deepEqual(
        [missing.code, missing.fields],
        [TasksErrorCode.ReplayInvalid, [["field", "system_prompt"]]],
      );
      writeFileSync(
        join(fixture.root, "templates", "work.md"),
        `${TEMPLATE_TEXT} changed`,
      );
      const changed = await replayCode(fixture, turns, FILE_OPTIONS);
      assert.deepEqual(
        [changed.code, changed.fields],
        [TasksErrorCode.ReplayInvalid, [["field", "templates"]]],
      );
    },
  );

  test(
    "a replay with an extra file option or another seed fails with replay_invalid before the output folder exists",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      writeFileOptions(fixture);
      const turns = await liveRun(fixture, { provider: liveScript() });
      const extra = await replayCode(fixture, turns, {
        templates: FILE_OPTIONS.templates,
      });
      assert.deepEqual(
        [extra.code, extra.fields],
        [TasksErrorCode.ReplayInvalid, [["field", "templates"]]],
      );
      const seedFile = join(fixture.seedFolder, "seed.json");
      writeFileSync(
        seedFile,
        JSON.stringify({ ...fixture.seed, elapsed_ms: ONE_CALL }),
      );
      const seed = await replayCode(fixture, turns);
      assert.deepEqual(
        [seed.code, seed.fields],
        [TasksErrorCode.ReplayInvalid, [["field", "seed_digest"]]],
      );
      assert.ok(!existsSync(join(fixture.root, "replay")));
    },
  );

  test("a --replay file that is absent, has another version or holds an invalid line fails with replay_invalid before the output folder exists", async (t) => {
    const fixture = await seedFixture(t);
    const turns = join(fixture.root, TURNS_FILE);
    const request = JSON.stringify({
      kind: "request",
      model: { provider: "anthropic", id: "model" },
      messages: [],
    });
    const answer = JSON.stringify({
      kind: "answer",
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    const tool = (line: Record<string, unknown>) =>
      JSON.stringify({ kind: TOOL_KIND, name: "tool", call_id: "a", ...line });
    const result = { content: [] };
    const cases: [string[], [string, string]][] = [
      [
        [JSON.stringify({ kind: HEADER_KIND, version: 2 })],
        ["field", "version"],
      ],
      [
        [VALID_HEADER, "not json"],
        ["line", "2"],
      ],
      [
        [VALID_HEADER, request],
        ["line", "2"],
      ],
      [
        [VALID_HEADER, tool({ result }), tool({ result })],
        ["line", "3"],
      ],
      [
        [VALID_HEADER, tool({ result, error: "failure" })],
        ["line", "2"],
      ],
      [
        [VALID_HEADER, tool({})],
        ["line", "2"],
      ],
      [
        [VALID_HEADER, answer],
        ["line", "2"],
      ],
    ];
    for (const [lines, field] of cases) {
      writeFileSync(turns, `${lines.join(NEWLINE)}${NEWLINE}`);
      const failed = await replayCode(fixture, turns);
      assert.deepEqual(
        [failed.code, failed.fields],
        [TasksErrorCode.ReplayInvalid, [field]],
      );
    }
    rmSync(turns);
    const absent = await replayCode(fixture, turns);
    assert.deepEqual(
      [absent.code, absent.fields],
      [TasksErrorCode.ReplayInvalid, [["option", "--replay"]]],
    );
    assert.ok(!existsSync(join(fixture.root, "replay")));
  });

  test("both modes and each recorded override with --replay fail with mode_invalid before any read", async (t) => {
    const fixture = await seedFixture(t);
    const turns = join(fixture.root, TURNS_FILE);
    let reads = NO_CALLS;
    const replay = commandRun(fixture, scriptedProvider([]), {
      readStdin: () => {
        reads += 1;
        return Buffer.alloc(NO_CALLS);
      },
    });
    for (const options of [
      { credentialStdin: true },
      { model: "anthropic/claude-sonnet-4-5" },
      { reasoning: "low" },
      { unit: ["work"] },
      { budgetTurns: "3" },
      { budgetWall: "5m" },
      { skipReleaseGate: true },
    ]) {
      const failed = await diagnosticOf(
        tasksRun(
          fixture.seedFolder,
          replayOptions(fixture, turns, options),
          replay.io,
        ),
      );
      assert.equal(failed.code, TasksErrorCode.ModeInvalid);
    }
    assert.equal(reads, NO_CALLS);
    assert.ok(!existsSync(join(fixture.root, "replay")));
  });
});
