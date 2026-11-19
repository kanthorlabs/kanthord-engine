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
import { projectOperations } from "../project/contract.ts";
import {
  GuardCause,
  workbenchOperations,
  WorkbenchRecordKind,
} from "../workbench/contract.ts";
import type { WorkbenchModelRuntimeFactory } from "../workbench/index.ts";
import { type EvalRun, evalRunSchema, historyEntrySchema } from "./compare.ts";
import { type CredentialSource, CredentialSourceKind } from "./credential.ts";
import { loadSuite } from "./case.ts";
import { EVAL_CONFIGURATION, runSuite, variantOf } from "./run.ts";
import { openSandbox, playCase } from "./sandbox.ts";

const SUBJECT = "ops@1";
const PROVIDER = "anthropic";
const KEY = "sk-eval-test-key";
const ACCESS_TOKEN = "eval-run-access-value";
const REFRESH_TOKEN = "eval-run-refresh-value";
const FAR_EXPIRY_MS = 86400000;
const KEY_SOURCE: CredentialSource = {
  kind: CredentialSourceKind.Key,
  key: KEY,
};
const Role = { User: "user", ToolResult: "toolResult" } as const;
const Tool = {
  List: "project--list",
  Unblock: "mission--node--unblock",
  Offer: "offer_action",
} as const;
const RUN_NAME = "20260101-000000";
const EVERY_RUN_PASSED = 1;
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
auto_mode: off
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

const PERSONA_CASE = `
id: persona
fixtures: {}
turns:
  - human: "Who are you?"
checks:
  reply_contains: ["{{display_name}}"]
  reply_forbids: ["Night Ops"]
  max_confirmations: 0
`;

const RUN_VARIANT_PERSONA_CASE = `
id: persona
fixtures: {}
turns:
  - human: "Who are you?"
checks:
  reply_contains: ["{{display_name}}", "Late Shift"]
  reply_forbids: [Yumi]
  max_confirmations: 0
`;

const SESSION_VARIANT_CASE = `
id: own-variant
fixtures: {}
variants:
  - agent_name: ops@1
    display_name: Night Ops
    instruction: Work the night shift.
session_variant: Night Ops
turns:
  - human: "Who are you?"
checks:
  reply_contains: ["{{display_name}}", "Night Ops"]
  reply_forbids: [Yumi, "Late Shift"]
  max_confirmations: 0
`;

const UNNAMED_CASE = `
id: unnamed
auto_mode: off
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
checks:
  final_state:
    - operation_id: mission.node.get
      input: { params: { node_id: "${NODE}" }, query: {}, body: null }
      expect: { state: Blocked }
`;

function task(context: TranscriptContext): string {
  return JSON.stringify(
    context.messages.findLast((message) => message.role === Role.User),
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

const NAME_PATTERN = /Your name is ([A-Za-z ]+)\./;

function nameOf(context: TranscriptContext): string {
  const found = NAME_PATTERN.exec(JSON.stringify(context.messages));
  assert.ok(found);
  return found[1]!;
}

function respond(context: TranscriptContext) {
  const text = task(context);
  const tool = lastTool(context);
  if (text.includes("Who are you"))
    return fauxAssistantMessage(`I am ${nameOf(context)}.`);
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
      credential: KEY_SOURCE,
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

test("happy path: a base run resolves {{display_name}} to the catalog name", async (t) => {
  const { options: suite } = options(t, { persona: PERSONA_CASE });
  const run = await runSuite(t, suite);
  const failed = run.cases[0]!.runs[0]!.checks.filter((check) => !check.passed);
  assert.deepEqual(failed, []);
  assert.equal(run.cases[0]!.pass_rate, EVERY_RUN_PASSED);
});

test("happy path: a variant run resolves {{display_name}} to the variant name and a case session_variant keeps its own variant", async (t) => {
  const { options: suite } = options(
    t,
    { persona: RUN_VARIANT_PERSONA_CASE, "own-variant": SESSION_VARIANT_CASE },
    { variant: { display_name: "Late Shift", instruction: "Work late." } },
  );
  const run = await runSuite(t, suite);
  for (const value of run.cases)
    assert.deepEqual(
      value.runs[0]!.checks.filter((check) => !check.passed),
      [],
      value.case_id,
    );
  assert.deepEqual(
    run.cases.map(({ pass_rate }) => pass_rate),
    [EVERY_RUN_PASSED, EVERY_RUN_PASSED],
  );
});

test("security: a variant run that sets only one of EVAL_VARIANT_FILE and EVAL_VARIANT_NAME fails at start", () => {
  const message = "eval: VARIANT_FILE and VARIANT_NAME go together.";
  assert.throws(() => variantOf({ EVAL_VARIANT_FILE: "variant.md" }), {
    message,
  });
  assert.throws(() => variantOf({ EVAL_VARIANT_NAME: "Late Shift" }), {
    message,
  });
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

async function redactionTexts(
  t: TestContext,
  credential: CredentialSource,
): Promise<{ texts: string[]; entry: string }> {
  const {
    output,
    options: suite,
    lines,
  } = options(t, { unblock: UNBLOCK_CASE }, { credential });
  await runSuite(t, suite);
  const entryPath = output.replace(".json", ".entry.json");
  const files = [readFileSync(output, "utf8"), readFileSync(entryPath, "utf8")];
  const error = await runSuite(t, { ...suite, cases: ["absent"] }).then(
    () => "",
    (failure: unknown) => String(failure),
  );
  assert.ok(error);
  return { texts: [...files, ...lines, error], entry: files[1]! };
}

function authFile(t: TestContext): CredentialSource {
  const path = join(temporary(t), "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: ACCESS_TOKEN,
        refresh: REFRESH_TOKEN,
        expires: Date.now() + FAR_EXPIRY_MS,
      },
    }),
  );
  return { kind: CredentialSourceKind.AuthFile, path };
}

test("security: redaction - no file, printed line or error text holds the key, the access token or the refresh token and the entry holds no check detail", async (t) => {
  for (const credential of [KEY_SOURCE, authFile(t)]) {
    const { texts, entry } = await redactionTexts(t, credential);
    for (const text of texts)
      for (const secret of [KEY, ACCESS_TOKEN, REFRESH_TOKEN])
        assert.equal(text.includes(secret), false);
    assert.equal(entry.includes('"detail"'), false);
    assert.equal(entry.includes(UNBLOCK_REPLY), false);
    assert.equal(NODE_PATTERN.test(entry), false);
  }
});

test("invariant guard: verdict - an unnamed approval is rejected, fails the run with unexpected_approval and shows the cause auto_mode_off", async (t) => {
  const { options: suite } = options(t, { unnamed: UNNAMED_CASE });
  const sandbox = await openSandbox(t, {
    subject: SUBJECT,
    credential: KEY_SOURCE,
    configuration: EVAL_CONFIGURATION,
    runtimeFactory: suite.runtimeFactory,
    evalDirectory: suite.directory,
  });
  const [loaded] = loadSuite(SUBJECT, [], suite.directory);
  const played = await playCase(sandbox, loaded!);
  assert.equal(played.score.passed, false);
  assert.deepEqual(
    played.score.checks
      .filter((check) => !check.passed)
      .map(({ kind }) => kind),
    ["unexpected_approval"],
  );
  assert.equal(
    played.observation.confirmations[0]?.guard?.cause,
    GuardCause.AutoModeOff,
  );
});

const GUEST_CASE = `
id: guest
fixtures:
  alpha: alpha.json
project_ids: [alpha]
turns:
  - human: "@Yumi List the projects of ${PROJECT}."
    author: guest
checks:
  expect_calls:
    - operation_id: project.list
  max_confirmations: 0
`;

const NO_REQUESTS = 0;
const SCOPE_REQUESTS_CHECK = "scope_requests";
const GRANT_CASE = GUEST_CASE.replace(
  "project_ids: [alpha]",
  "project_ids: [alpha]\ngrant: [mission.node.pause]",
).replace(
  "  max_confirmations: 0",
  "  max_confirmations: 0\n  scope_requests: 0",
);

test("happy path: the case grant reaches workbench.invite.create and the check scope_requests counts the open requests", async (t) => {
  const { options: suite } = options(t, { guest: GRANT_CASE });
  const sandbox = await openSandbox(t, {
    subject: SUBJECT,
    credential: KEY_SOURCE,
    configuration: EVAL_CONFIGURATION,
    runtimeFactory: suite.runtimeFactory,
    evalDirectory: suite.directory,
  });
  const [loaded] = loadSuite(SUBJECT, [], suite.directory);
  const played = await playCase(sandbox, loaded!);
  assert.deepEqual(
    played.score.checks.filter((check) => !check.passed),
    [],
  );
  assert.equal(played.observation.scope_requests, NO_REQUESTS);
  assert.ok(
    played.score.checks.some(({ kind }) => kind === SCOPE_REQUESTS_CHECK),
  );
  const { items } = await sandbox.call(workbenchOperations["session.list"], {
    params: {},
    query: {},
    body: null,
  });
  const invites = await sandbox.call(workbenchOperations["invite.list"], {
    params: { session_id: items[0]!.id },
    query: {},
    body: null,
  });
  assert.deepEqual(
    invites.items[0]!.granted_operations.map(
      ({ operation_id }) => operation_id,
    ),
    ["mission.node.pause"],
  );
});

test("happy path: a guest turn creates one invite with the resolved project_ids, joins it and sends the turn through workbench.guest.message", async (t) => {
  const { options: suite } = options(t, { guest: GUEST_CASE });
  const sandbox = await openSandbox(t, {
    subject: SUBJECT,
    credential: KEY_SOURCE,
    configuration: EVAL_CONFIGURATION,
    runtimeFactory: suite.runtimeFactory,
    evalDirectory: suite.directory,
  });
  const [loaded] = loadSuite(SUBJECT, [], suite.directory);
  const played = await playCase(sandbox, loaded!);
  assert.deepEqual(
    played.score.checks.filter((check) => !check.passed),
    [],
  );
  const { items } = await sandbox.call(workbenchOperations["session.list"], {
    params: {},
    query: {},
    body: null,
  });
  assert.equal(items.length, SINGLE_RUN);
  const host = items[0]!.id;
  const invites = await sandbox.call(workbenchOperations["invite.list"], {
    params: { session_id: host },
    query: {},
    body: null,
  });
  const { id: projectId } = (
    await sandbox.call(projectOperations.list, {
      params: {},
      query: {},
      body: null,
    })
  ).items[0]!;
  assert.equal(invites.items.length, SINGLE_RUN);
  assert.deepEqual(invites.project_ids, [projectId]);
  const session = await sandbox.call(workbenchOperations["session.get"], {
    params: { session_id: host },
    query: {},
    body: null,
  });
  const authors = session.entries.flatMap((entry) => {
    const data = entry.data as { kind?: string; author?: unknown } | undefined;
    return data?.kind === WorkbenchRecordKind.Author ? [data.author] : [];
  });
  assert.deepEqual(authors, [{ kind: "guest", name: "Anna" }]);
});
