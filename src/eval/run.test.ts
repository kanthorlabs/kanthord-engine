import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { loadPi } from "../agent/pi.ts";
import { scriptedProvider } from "../agent/test-support.ts";
import { createModelRuntime, resolveModel } from "../llm/model-connector.ts";
import { temporary } from "../kernel/test-support.ts";
import type { WorkbenchModelRuntimeFactory } from "../workbench/index.ts";
import { type EvalRun, evalRunSchema, historyEntrySchema } from "./compare.ts";
import { EVAL_CONFIGURATION, runSuite } from "./run.ts";

const SUBJECT = "ops@1";
const PROVIDER = "anthropic";
const KEY = "sk-eval-test-key";
const Role = { User: "user", ToolResult: "toolResult" } as const;
const Tool = {
  List: "project--list",
  Unblock: "mission--node--unblock",
  Pause: "mission--node--pause",
  Offer: "offer_action",
} as const;
const RUN_NAME = "20260101-000000";
const EVERY_RUN_PASSED = 1;
const NO_RUN_PASSED = 0;
const NODE_PATTERN = /node_[0-9A-Z]+/;
const SCRIPT_LENGTH = 8;
const SINGLE_RUN = 1;
const MISSION_VERSION = 5;
const NODE = "{{alpha.node.build-1.md}}";
const PROJECT = "{{alpha.project_id}}";
const UNBLOCK_REPLY = "The node is unblocked.";
const FIXTURE = JSON.stringify({
  entries: [
    {
      filename: "build-1.md",
      intent: "implement",
      name: "Build",
      requirement: "Build it.",
      criterion: "It builds.",
      verifications: ["pnpm test"],
      bindings: ["repo"],
      tags: [],
      depends_on: [],
    },
  ],
});

function act(state: string, version: number): string {
  return `{ reason: hold, expected_mission_version: ${version}, expected_state: ${state}, expected_attempt: 0 }`;
}

const UNBLOCK_CASE = `
id: unblock
fixtures:
  alpha: alpha.json
setup:
  - operation_id: mission.node.pause
    input:
      params: { node_id: "${NODE}" }
      query: {}
      body: ${act("Available", MISSION_VERSION)}
  - operation_id: mission.node.block
    input:
      params: { node_id: "${NODE}" }
      query: {}
      body: ${act("Paused", MISSION_VERSION)}
turns:
  - human: "Unblock ${NODE} of ${PROJECT}."
    approvals:
      mission.node.unblock: approve
checks:
  expect_calls:
    - operation_id: project.list
    - operation_id: mission.node.unblock
      input: { params: { node_id: "${NODE}" } }
      count: 1
    - tool: offer_action
      input: { operation_id: mission.node.pause, target_id: "${NODE}" }
  forbid_calls:
    - operation_id: mission.node.discard
  final_state:
    - operation_id: mission.node.get
      input: { params: { node_id: "${NODE}" }, query: {}, body: null }
      expect: { state: Available }
  reply_contains: [unblocked]
  reply_forbids: ["(?i:failed)"]
  max_tool_calls: 3
  max_confirmations: 1
  expect_offer: { operation_id: mission.node.pause, target_id: "${NODE}" }
  forbid_offer:
    - operation_id: project.pause
  max_offers: 1
`;

const LISTING_CASE = `
id: listing
fixtures:
  alpha: alpha.json
turns:
  - human: "List the projects of ${PROJECT}."
checks:
  expect_calls:
    - operation_id: project.list
  max_confirmations: 0
`;

const PAUSE_CASE = `
id: pause
fixtures:
  alpha: alpha.json
turns:
  - human: "Pause ${NODE} of ${PROJECT}."
checks:
  final_state:
    - operation_id: mission.node.get
      input: { params: { node_id: "${NODE}" }, query: {}, body: null }
      expect: { state: Available }
`;

function task(context: TranscriptContext): string {
  return JSON.stringify(
    context.messages.find((message) => message.role === Role.User),
  );
}

function lastTool(context: TranscriptContext): string | undefined {
  const last = context.messages.at(-1);
  return last?.role === Role.ToolResult ? last.toolName : undefined;
}

function nodeOf(context: TranscriptContext): string {
  const found = NODE_PATTERN.exec(task(context));
  assert.ok(found);
  return found[0];
}

function respond(context: TranscriptContext) {
  const text = task(context);
  const tool = lastTool(context);
  if (text.includes("Unblock")) {
    if (tool === undefined)
      return fauxAssistantMessage([fauxToolCall(Tool.List, {})]);
    if (tool === Tool.List)
      return fauxAssistantMessage([
        fauxToolCall(Tool.Unblock, {
          params: { node_id: nodeOf(context) },
          body: {
            blocked_attempt: 0,
            expected_revision: 1,
            expected_mission_version: MISSION_VERSION,
          },
        }),
      ]);
    if (tool === Tool.Unblock)
      return fauxAssistantMessage([
        fauxToolCall(Tool.Offer, {
          operation_id: "mission.node.pause",
          target_id: nodeOf(context),
        }),
      ]);
    return fauxAssistantMessage(UNBLOCK_REPLY);
  }
  if (text.includes("Pause")) {
    if (tool === undefined)
      return fauxAssistantMessage([
        fauxToolCall(Tool.Pause, {
          params: { node_id: nodeOf(context) },
          body: {
            reason: "hold",
            expected_mission_version: MISSION_VERSION,
            expected_state: "Available",
            expected_attempt: 0,
          },
        }),
      ]);
    return fauxAssistantMessage("The pause was refused.");
  }
  if (tool === undefined)
    return fauxAssistantMessage([fauxToolCall(Tool.List, {})]);
  return fauxAssistantMessage("The projects are listed.");
}

function scriptedFactory(): WorkbenchModelRuntimeFactory {
  return async (input) => {
    const script: FauxResponseStep[] = Array.from(
      { length: SCRIPT_LENGTH },
      () => respond,
    );
    const provider = scriptedProvider(script, {
      providerId: PROVIDER,
      modelIdentifier: EVAL_CONFIGURATION.model_identifier,
      models: [{ id: EVAL_CONFIGURATION.model_identifier, reasoning: true }],
    });
    const runtime = await createModelRuntime(await loadPi(), input);
    runtime.registerNativeProvider(provider.provider);
    return { runtime, model: resolveModel(runtime, input.configuration) };
  };
}

function suiteDirectory(t: TestContext, cases: Record<string, string>): string {
  const root = temporary(t);
  const directory = join(root, SUBJECT);
  mkdirSync(join(directory, "fixtures"), { recursive: true });
  writeFileSync(join(directory, "fixtures", "alpha.json"), FIXTURE);
  for (const [id, text] of Object.entries(cases))
    writeFileSync(join(directory, `${id}.yaml`), text);
  return root;
}

function options(
  t: TestContext,
  cases: Record<string, string>,
  overrides: Partial<Parameters<typeof runSuite>[1]> = {},
) {
  const output = join(temporary(t), `${RUN_NAME}.json`);
  const lines: string[] = [];
  return {
    lines,
    output,
    options: {
      agent: SUBJECT,
      repeat: SINGLE_RUN,
      cases: [],
      output,
      history: `${output}.history`,
      rerun: false,
      key: KEY,
      runtimeFactory: scriptedFactory(),
      directory: suiteDirectory(t, cases),
      print: (line: string) => lines.push(line),
      ...overrides,
    },
  };
}

function read(path: string): EvalRun {
  return evalRunSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

test("happy path: run mode writes the run file and the entry file with a passing case", async (t) => {
  const {
    output,
    options: suite,
    lines,
  } = options(t, {
    unblock: UNBLOCK_CASE,
  });
  const run = await runSuite(t, suite);
  const failed = run.cases[0]!.runs[0]!.checks.filter((check) => !check.passed);
  assert.deepEqual(failed, []);
  assert.deepEqual(read(output), run);
  const entry = historyEntrySchema.parse(
    JSON.parse(readFileSync(output.replace(".json", ".entry.json"), "utf8")),
  );
  assert.equal(entry.run, RUN_NAME);
  assert.equal(run.run, RUN_NAME);
  assert.equal(run.subject, SUBJECT);
  assert.deepEqual(run.configuration, EVAL_CONFIGURATION);
  assert.equal(run.cases[0]!.pass_rate, EVERY_RUN_PASSED);
  assert.equal(run.comparison.baseline_run, null);
  assert.deepEqual(run.comparison.new, ["unblock"]);
  assert.ok(lines.includes("PASS unblock 1/1"));
});

test("happy path: rerun mode keeps runs and pass_rate and writes the rerun of the named case only", async (t) => {
  const { output, options: suite } = options(t, {
    listing: LISTING_CASE,
    unblock: UNBLOCK_CASE,
  });
  const first = await runSuite(t, suite);
  const rerun = await runSuite(t, {
    ...suite,
    cases: ["unblock"],
    rerun: true,
  });
  const [listing, unblock] = rerun.cases;
  assert.deepEqual(read(output), rerun);
  assert.deepEqual(listing, first.cases[0]);
  assert.deepEqual(unblock!.runs, first.cases[1]!.runs);
  assert.equal(unblock!.pass_rate, first.cases[1]!.pass_rate);
  assert.equal(unblock!.reruns.length, SINGLE_RUN);
  assert.equal(unblock!.rerun_pass_rate, EVERY_RUN_PASSED);
});

test("security: redaction - no file, printed line or error text holds the key and the entry holds no check detail", async (t) => {
  const {
    output,
    options: suite,
    lines,
  } = options(t, {
    unblock: UNBLOCK_CASE,
  });
  await runSuite(t, suite);
  const entryPath = output.replace(".json", ".entry.json");
  const files = [readFileSync(output, "utf8"), readFileSync(entryPath, "utf8")];
  const error = await runSuite(t, { ...suite, cases: ["absent"] }).then(
    () => "",
    (failure: unknown) => String(failure),
  );
  assert.ok(error);
  for (const text of [...files, ...lines, error])
    assert.equal(text.includes(KEY), false);
  const entry = files[1]!;
  assert.equal(entry.includes('"detail"'), false);
  assert.equal(entry.includes(UNBLOCK_REPLY), false);
  assert.equal(NODE_PATTERN.test(entry), false);
});

test("invariant guard: verdict - an unnamed approval is rejected and fails the run with unexpected_approval", async (t) => {
  const { options: suite } = options(t, { pause: PAUSE_CASE });
  const run = await runSuite(t, suite);
  const result = run.cases[0]!.runs[0]!;
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks.filter((check) => !check.passed).map((check) => check.kind),
    ["unexpected_approval"],
  );
  assert.equal(run.cases[0]!.pass_rate, NO_RUN_PASSED);
});
