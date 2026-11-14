import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { loadPi } from "../agent/pi.ts";
import { scriptedProvider } from "../agent/test-support.ts";
import { createModelRuntime, resolveModel } from "../llm/model-connector.ts";
import type { WorkbenchModelRuntimeFactory } from "../workbench/index.ts";
import { parseCase } from "./case.ts";
import { openSandbox, playCase } from "./sandbox.ts";

const SUBJECT = "ops@1";
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4-5";
const FIXTURE_FILE = "alpha.json";
const KEY = "sk-eval-not-a-key";
const PROJECT_PATTERN = /project_[0-9A-Z]+/;
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: MODEL,
  reasoning_effort: "off",
} as const;
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

const HAPPY_CASE = `
id: happy
fixtures:
  alpha: ${FIXTURE_FILE}
setup:
  - operation_id: project.resume
    input:
      params: { project_id: "{{alpha.project_id}}" }
      query: {}
      body: null
seed:
  - step: job_without_taker
    node: "{{alpha.node.build-1.md}}"
    age_ms: 120000
  - step: execution_refusal
    node: "{{alpha.node.build-1.md}}"
    code: unauthorized
    credential: native-credential
    agent: ${SUBJECT}
turns:
  - human: "List the projects, {{alpha.project_id}}."
checks:
  expect_calls:
    - operation_id: project.list
  max_tool_calls: 1
  max_confirmations: 0
  reply_contains: [listed]
  final_state:
    - operation_id: scheduler.execution.list
      input:
        params: { project_id: "{{alpha.project_id}}" }
        query: {}
        body: null
      expect:
        items: [{ stop: { reason: provider_failed, code: unauthorized } }]
`;

const APPROVAL_CASE = `
id: approval
fixtures:
  alpha: ${FIXTURE_FILE}
turns:
  - human: "Pause {{alpha.project_id}}."
checks:
  max_confirmations: 1
  final_state:
    - operation_id: project.get
      input:
        params: { project_id: "{{alpha.project_id}}" }
        query: {}
        body: null
      expect: { paused_at: null }
`;

function projectIdOf(messages: unknown): string {
  const found = PROJECT_PATTERN.exec(JSON.stringify(messages));
  assert.ok(found);
  return found[0];
}

function scriptedFactory(
  script: FauxResponseStep[],
): WorkbenchModelRuntimeFactory {
  const provider = scriptedProvider(script, {
    providerId: PROVIDER,
    modelIdentifier: MODEL,
  });
  return async (input) => {
    const runtime = await createModelRuntime(await loadPi(), input);
    runtime.registerNativeProvider(provider.provider);
    return { runtime, model: resolveModel(runtime, input.configuration) };
  };
}

function sandboxOf(t: TestContext, script: FauxResponseStep[]) {
  return openSandbox(t, {
    subject: SUBJECT,
    key: KEY,
    configuration: CONFIGURATION,
    runtimeFactory: scriptedFactory(script),
  });
}

function loaded(id: string, text: string) {
  return parseCase({
    id,
    text,
    readFile: () => Buffer.from(FIXTURE),
  });
}

test("happy path: the sandbox seeds a fixture, drives one turn and scores every check", async (t) => {
  const sandbox = await sandboxOf(t, [
    fauxAssistantMessage([fauxToolCall("project--list", {})]),
    fauxAssistantMessage("The projects are listed."),
  ]);
  const played = await playCase(sandbox, loaded("happy", HAPPY_CASE));
  assert.deepEqual(
    played.score.checks.filter((check) => !check.passed),
    [],
  );
  assert.equal(played.score.passed, true);
  assert.deepEqual(
    played.score.checks.map((check) => check.kind),
    [
      "expect_calls",
      "final_state",
      "reply_contains",
      "max_tool_calls",
      "max_confirmations",
      "unexpected_approval",
    ],
  );
});

test("security: authorization - an approval that the turn does not name is rejected and fails the run", async (t) => {
  const sandbox = await sandboxOf(t, [
    (context) =>
      fauxAssistantMessage([
        fauxToolCall("project--pause", {
          params: { project_id: projectIdOf(context.messages) },
        }),
      ]),
    fauxAssistantMessage("The pause was refused."),
  ]);
  const played = await playCase(sandbox, loaded("approval", APPROVAL_CASE));
  assert.equal(played.observation.unexpected_approval, true);
  assert.deepEqual(
    played.observation.confirmations.map((item) => [
      item.operation_id,
      item.answer,
    ]),
    [["project.pause", "reject"]],
  );
  const failed = played.score.checks.filter((check) => !check.passed);
  assert.deepEqual(
    failed.map((check) => check.kind),
    ["unexpected_approval"],
  );
  assert.equal(played.score.passed, false);
});
