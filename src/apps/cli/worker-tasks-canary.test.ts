import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { hostEnvironment } from "../../kernel/test-support.ts";
import { missionOperations } from "../../mission/contract.ts";
import { HostTool } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import {
  defaultCapabilities,
  TasksErrorCode,
  TasksExit,
} from "../worker/index.ts";
import {
  commandRun,
  type CommandRun,
  CREDENTIAL_CANARY,
  diagnosticOf,
  filesOf,
  keysOf,
  OUTPUT_FILES,
  PASS_NAME,
  PASS_VALUE,
  readJson,
  REFUSED_KEYS,
  runOptions,
  seedFixture,
  TEST_TIMEOUT_MS,
  toolUse,
  turnLines,
  TURNS_FILE,
} from "./tasks-test-support.ts";
import { type TasksCommandIo, tasksRun } from "./worker-tasks.ts";

const UPLOAD_COUNT = 2;
const FIRST_CALL = 1;
const PI_FILES = ["auth.json", "settings.json"];
const CANARIES = [CREDENTIAL_CANARY, PASS_VALUE];
const ENVIRONMENT_CANARIES = {
  container: "tasks-container-canary-0123456789",
  remote: "tasks-remote-canary-0123456789",
  build: "tasks-build-canary-0123456789",
};
const CANARY_TEXT = [
  ...CANARIES,
  ...CANARIES.map((canary) => Buffer.from(canary).toString("base64")),
].join(" ");
const TOOL_KIND = "tool";
const REQUEST_DIFFERS = "request_differs";
const KNOWN_VALUE_TURN = 5;

const canaryCapability: InlineExtension = (pi) => {
  let calls = 0;
  pi.registerTool({
    name: HostTool.LinkUpdateList,
    label: "Open-world canary tool",
    description: "Answer the canary values.",
    parameters: Type.Object({}),
    annotations: { openWorldHint: true },
    execute: async () => {
      calls += 1;
      if (calls > FIRST_CALL) throw new Error(`failure ${CANARY_TEXT}`);
      return {
        content: [{ type: "text", text: `result ${CANARY_TEXT}` }],
        details: {},
      };
    },
  });
};

const capabilities: TasksCommandIo["capabilities"] = (tools) => [
  ...defaultCapabilities(tools).filter(
    (_capability, index) => index < FIRST_CALL,
  ),
  canaryCapability,
];

function uploadOf(path: string) {
  return fauxAssistantMessage(fauxToolCall(HostTool.EvidenceUpload, { path }), {
    stopReason: "toolUse",
  });
}

function assertNoCanary(output: string, run: CommandRun): void {
  const uploads = existsSync(join(output, "uploads"))
    ? filesOf(join(output, "uploads"))
    : [];
  const forms = CANARIES.flatMap((canary) => [
    canary,
    Buffer.from(canary).toString("base64"),
  ]);
  const texts = [
    ...[...OUTPUT_FILES.map((name) => join(output, name)), ...uploads]
      .filter((file) => existsSync(file))
      .map((file) => [file, readFileSync(file, "utf8")]),
    ["stdout", run.stdout.join("")],
    ["stderr", run.stderr.join("")],
  ];
  for (const canary of forms)
    for (const [name, text] of texts)
      assert.ok(!text!.includes(canary), `${name}: ${canary}`);
  for (const file of filesOf(join(output, "state")))
    assert.ok(
      !readFileSync(file).includes(Buffer.from(CREDENTIAL_CANARY)),
      file,
    );
  for (const name of PI_FILES)
    assert.ok(!existsSync(join(output, "state", "pi", name)), name);
}

test(
  "the canary values of the credential and of --pass-env reach no output file, no state file, no standard stream and no replay output, also from an open-world tool result, a tool error and an errorMessage",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await seedFixture(t, (seed) => {
      const setup = seed.setup as { repositories: Record<string, unknown>[] };
      setup.repositories = setup.repositories.map((repository) => ({
        ...repository,
        environment: {
          source: "detected",
          document: {
            build: {
              dockerfile: "Dockerfile",
              args: { CANARY: ENVIRONMENT_CANARIES.build },
            },
            containerEnv: { CANARY: ENVIRONMENT_CANARIES.container },
            remoteEnv: { CANARY: ENVIRONMENT_CANARIES.remote },
          },
        },
      }));
    });
    const provider = scriptedProvider([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `echo "$${PASS_NAME}" > evidence.txt; printf %s "$${PASS_NAME}" | base64 > evidence64.txt; cat evidence.txt`,
        }),
        { stopReason: "toolUse" },
      ),
      uploadOf("evidence.txt"),
      uploadOf("evidence64.txt"),
      toolUse(HostTool.LinkUpdateList, {}),
      toolUse(HostTool.LinkUpdateList, {}),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "file", content: "good" }),
        { stopReason: "toolUse", errorMessage: `error ${CANARY_TEXT}` },
      ),
      fauxAssistantMessage(`done ${CREDENTIAL_CANARY} ${PASS_VALUE}`),
    ]);
    const run = commandRun(fixture, provider, {
      shellEnv: { ...hostEnvironment(), [PASS_NAME]: PASS_VALUE },
      capabilities,
    });
    const output = join(fixture.root, "out");
    const code = await tasksRun(
      fixture.seedFolder,
      runOptions(fixture, { passEnv: [PASS_NAME] }),
      run.io,
    );
    assert.equal(code, TasksExit.Success, run.stderr.join(""));
    const outbox = readJson(output, "outbox.json") as unknown as {
      operation: string;
    }[];
    assert.equal(
      outbox.filter(
        (entry) => entry.operation === missionOperations["evidence.submit"].id,
      ).length,
      UPLOAD_COUNT,
    );
    assert.equal(filesOf(join(output, "uploads")).length, UPLOAD_COUNT);
    assert.deepEqual(
      turnLines(output)
        .filter((line) => line.kind === TOOL_KIND)
        .map((line) => [line.name, line.error !== undefined]),
      [
        [HostTool.LinkUpdateList, false],
        [HostTool.LinkUpdateList, true],
      ],
    );
    assertNoCanary(output, run);
    const replay = commandRun(fixture, scriptedProvider([]), {
      shellEnv: { ...hostEnvironment(), [PASS_NAME]: PASS_VALUE },
      piDirectory: join(output, "state", "pi"),
      capabilities,
    });
    const replayOutput = join(fixture.root, "replay");
    const replayed = await diagnosticOf(
      tasksRun(
        fixture.seedFolder,
        runOptions(fixture, {
          credentialStdin: undefined,
          replay: join(output, TURNS_FILE),
          passEnv: [PASS_NAME],
          output: replayOutput,
        }),
        replay.io,
      ),
    );
    assert.equal(replayed.code, TasksErrorCode.ReplayDiverged);
    assert.deepEqual(replayed.fields, [
      ["turn", String(KNOWN_VALUE_TURN)],
      ["reason", REQUEST_DIFFERS],
      ["step", "unit.turn"],
    ]);
    assertNoCanary(replayOutput, replay);
    for (const name of PI_FILES)
      assert.ok(!existsSync(join(output, "state", "pi", name)), name);
    const context = readFileSync(join(output, "context.json"), "utf8");
    for (const canary of Object.values(ENVIRONMENT_CANARIES))
      assert.equal(context.includes(canary), false, canary);
    const keys = keysOf(readJson(output, "context.json"));
    for (const key of REFUSED_KEYS) assert.ok(!keys.includes(key), key);
  },
);
