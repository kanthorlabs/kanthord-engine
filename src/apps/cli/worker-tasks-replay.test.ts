import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { suite, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import { HostTool } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  type ScriptedProvider,
} from "../../worker/unit/test-support.ts";
import {
  defaultCapabilities,
  RunEndKind,
  TasksErrorCode,
  TasksExit,
} from "../worker/index.ts";
import {
  type CommandRun,
  diagnosticOf,
  readJson,
  runOptions,
  seedFixture,
  type SeedFixture,
  commandRun as sharedCommandRun,
  TEST_TIMEOUT_MS,
  writeGood,
} from "./tasks-test-support.ts";
import { type TasksCommandIo, tasksRun } from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const TURNS_FILE = "turns.jsonl";
const REPLAY_CHECK = 8;
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const NEWLINE = "\n";
const REPLAY_MODE = "replay";
const BASH_OUTPUT = "ran";
const EDITED_TEXT = "good edited";
const TOOL_KIND = "tool";

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

function toolUse(name: string, input: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, input), {
    stopReason: "toolUse",
  });
}

function liveScript() {
  return scriptedProvider([
    toolUse("bash", { command: "printf ran >> ran.txt" }),
    writeGood(),
    fauxAssistantMessage("done"),
  ]);
}

async function liveRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): Promise<string> {
  const run = commandRun(fixture, provider, overrides);
  const code = await tasksRun(
    fixture.seedFolder,
    runOptions(fixture, { verify: true }),
    run.io,
  );
  assert.equal(code, TasksExit.Success, run.stderr.join(""));
  return join(fixture.root, "out", TURNS_FILE);
}

function replayOptions(fixture: SeedFixture, turns: string) {
  return runOptions(fixture, {
    credentialStdin: undefined,
    replay: turns,
    output: join(fixture.root, "replay"),
    verify: true,
  });
}

function checkOf(folder: string, check: number) {
  const result = readJson(folder, "result.json") as {
    checks: { check: number; applies: boolean; passed: boolean }[];
  };
  return result.checks.find((entry) => entry.check === check);
}

function checkoutOf(folder: string): string {
  const context = readJson(folder, "context.json") as {
    input: { checkouts: { directory: string }[] };
  };
  return context.input.checkouts[0]!.directory;
}

interface ToolCounts {
  openWorld: number;
  closedWorld: number;
}

function countedCapabilities(
  counts: ToolCounts,
): TasksCommandIo["capabilities"] {
  const capability: InlineExtension = (pi) => {
    pi.registerTool({
      name: HostTool.LinkUpdateList,
      label: "Open-world test tool",
      description: "Answer a new value at each call.",
      parameters: Type.Object({}),
      annotations: { openWorldHint: true },
      execute: async () => {
        counts.openWorld += 1;
        return {
          content: [{ type: "text", text: `open call ${counts.openWorld}` }],
          details: {},
        };
      },
    });
    pi.registerTool({
      name: HostTool.EvidenceUpload,
      label: "Closed-world test tool",
      description: "Answer a new value at each call.",
      parameters: Type.Object({}),
      annotations: { openWorldHint: false },
      execute: async () => {
        counts.closedWorld += 1;
        return {
          content: [{ type: "text", text: "closed call" }],
          details: {},
        };
      },
    });
  };
  return () => [capability];
}

suite("worker tasks run replay", () => {
  test(
    "a live run writes turns.jsonl, and a replay of it passes check 8 with --verify",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, liveScript());
      const [header] = readFileSync(turns, "utf8").split(NEWLINE);
      assert.deepEqual(JSON.parse(header!), { kind: "header", version: 1 });
      const replay = commandRun(fixture, scriptedProvider([]));
      const code = await tasksRun(
        fixture.seedFolder,
        replayOptions(fixture, turns),
        replay.io,
      );
      assert.equal(code, TasksExit.Success, replay.stderr.join(""));
      const folder = join(fixture.root, "replay");
      assert.equal(readJson(folder, "result.json").mode, REPLAY_MODE);
      assert.deepEqual(checkOf(folder, REPLAY_CHECK), {
        check: REPLAY_CHECK,
        applies: true,
        passed: true,
      });
      assert.equal(
        readFileSync(join(checkoutOf(folder), "ran.txt"), "utf8"),
        BASH_OUTPUT,
      );
    },
  );

  test(
    "a replay with a changed tool set stops with replay_diverged",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, liveScript());
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
    },
  );

  test(
    "replay mode reads no standard input, calls no provider and gives the model runtime the placeholder credential",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(fixture, liveScript());
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
      const turns = await liveRun(
        fixture,
        scriptedProvider([
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
        { capabilities },
      );
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
      const checkout = checkoutOf(join(fixture.root, "replay"));
      assert.equal(
        readFileSync(join(checkout, "ran.txt"), "utf8"),
        BASH_OUTPUT,
      );
      assert.equal(readFileSync(join(checkout, "file"), "utf8"), EDITED_TEXT);
      const tools = readFileSync(
        join(fixture.root, "replay", TURNS_FILE),
        "utf8",
      )
        .split(NEWLINE)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; result?: unknown })
        .filter((line) => line.kind === TOOL_KIND);
      assert.deepEqual(
        tools.map((line) => line.result),
        [{ content: [{ type: "text", text: "open call 1" }], details: {} }],
      );
    },
  );

  test("a --replay file with another version or an invalid line fails with replay_invalid before the output folder exists", async (t) => {
    const fixture = await seedFixture(t);
    const turns = join(fixture.root, TURNS_FILE);
    for (const text of [
      `${JSON.stringify({ kind: "header", version: 2 })}${NEWLINE}`,
      `${JSON.stringify({ kind: "header", version: 1 })}${NEWLINE}not json${NEWLINE}`,
    ]) {
      writeFileSync(turns, text);
      const replay = commandRun(fixture, scriptedProvider([]));
      const failed = await diagnosticOf(
        tasksRun(fixture.seedFolder, replayOptions(fixture, turns), replay.io),
      );
      assert.equal(failed.code, TasksErrorCode.ReplayInvalid);
      assert.ok(!existsSync(join(fixture.root, "replay")));
    }
  });

  test("both modes and an override with --replay fail with mode_invalid before any read", async (t) => {
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
      { unit: ["work"] },
      { skipReleaseGate: true },
    ]) {
      const failed = await diagnosticOf(
        tasksRun(
          fixture.seedFolder,
          { ...replayOptions(fixture, turns), ...options },
          replay.io,
        ),
      );
      assert.equal(failed.code, TasksErrorCode.ModeInvalid);
    }
    assert.equal(reads, NO_CALLS);
    assert.ok(!existsSync(join(fixture.root, "replay")));
  });
});
