import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../kernel/test-support.ts";
import { loadPi } from "./pi.ts";
import { scriptedProvider } from "./test-support.ts";
import type { KnownSecrets } from "./redaction.ts";
import {
  AgentOpenError,
  AgentOpenKind,
  openAgent,
  RunEnd,
  SessionKind,
} from "./agent-contract.ts";
import type { AgentInput, AgentOpened } from "./agent-contract.ts";

const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";
const SCRIPTED_KEY = "scripted";
const K = "sk-ant-api03-" + "AbCdEf1234567890".repeat(6);
const SYSTEM_PROMPT = "test system prompt";
const NO_SECRETS: KnownSecrets = async () => [];
const WITH_SECRET: KnownSecrets = async () => [K];
const CODE_TOOL_UNDECLARED = "agent.tool_undeclared";
const CODE_LEVEL_UNSUPPORTED = "agent.level_unsupported";
const CODE_OPEN_FAILED = "agent.open_failed";
const MSG_ABORTED = "aborted";

interface InputOptions {
  script?: FauxResponseStep[];
  signal?: AbortSignal;
  knownSecrets?: KnownSecrets;
  consumerTools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
}

async function makeInput(
  t: TestContext,
  options: InputOptions = {},
): Promise<{
  agentInput: AgentInput;
  scripted: ReturnType<typeof scriptedProvider>;
}> {
  const home = temporary(t);
  overrideEnvironment(t, { HOME: home, XDG_STATE_HOME: join(home, "state") });
  const cwd = join(home, "workspace");
  mkdirSync(cwd, { recursive: true });

  const pi = await loadPi();
  const scripted = scriptedProvider(options.script ?? []);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER_ID, async () => ({
    type: "api_key",
    key: SCRIPTED_KEY,
  }));
  const runtime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal: new AbortController().signal,
  });
  runtime.registerNativeProvider(scripted.provider);
  const model = runtime.getModel(PROVIDER_ID, MODEL_ID)!;
  assert.ok(model, `model ${MODEL_ID} not found`);

  const agentInput: AgentInput = {
    profile: "swe@1",
    model: {
      runtime,
      model,
      thinkingLevel: options.thinkingLevel ?? "off",
    },
    systemPrompt: SYSTEM_PROMPT,
    workspace: { cwd, roots: [cwd] },
    budget: { deadline: null, usd: null },
    session: { kind: SessionKind.Memory },
    knownSecrets: options.knownSecrets ?? NO_SECRETS,
    childEnvironment: {},
    hostHome: home,
    consumerTools: options.consumerTools ?? [],
    signal: options.signal ?? new AbortController().signal,
  };

  return { agentInput, scripted };
}

async function openAndRun(
  t: TestContext,
  options: InputOptions = {},
): Promise<{
  run: AgentOpened["run"];
  scripted: ReturnType<typeof scriptedProvider>;
}> {
  const { agentInput, scripted } = await makeInput(t, options);
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  return { run, scripted };
}

test("an undeclared consumer tool throws agent.tool_undeclared", async (t) => {
  const { agentInput } = await makeInput(t);
  agentInput.consumerTools = [
    { name: "undeclared_tool" } as unknown as ToolDefinition,
  ];
  await assert.rejects(
    () => openAgent(agentInput),
    (err: unknown) => {
      assert.ok(err instanceof AgentOpenError);
      assert.equal(err.code, CODE_TOOL_UNDECLARED);
      assert.ok(!err.message.includes(K));
      return true;
    },
  );
});

test("an unsupported thinking level throws agent.level_unsupported", async (t) => {
  const { agentInput } = await makeInput(t, {
    thinkingLevel: "not_a_valid_level" as unknown as ThinkingLevel,
  });
  await assert.rejects(
    () => openAgent(agentInput),
    (err: unknown) => {
      assert.ok(err instanceof AgentOpenError);
      assert.equal(err.code, CODE_LEVEL_UNSUPPORTED);
      return true;
    },
  );
});

test("an abort during open throws agent.open_failed with the message aborted, and the message holds K zero times", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const { agentInput } = await makeInput(t, { signal: controller.signal });
  await assert.rejects(
    () => openAgent(agentInput),
    (err: unknown) => {
      assert.ok(err instanceof AgentOpenError);
      assert.equal(err.code, CODE_OPEN_FAILED);
      assert.equal(err.message, MSG_ABORTED);
      assert.ok(!err.message.includes(K));
      return true;
    },
  );
});

test("TurnEnd.text holds K zero times when the model returns K", async (t) => {
  const { run } = await openAndRun(t, {
    script: [fauxAssistantMessage(K)],
    knownSecrets: WITH_SECRET,
  });
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.Completed);
  assert.ok(result.text !== null);
  assert.ok(!result.text!.includes(K));
  await run.close();
});

test("RunFailure.reason holds K zero times when the provider returns an error containing K", async (t) => {
  const { run } = await openAndRun(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `error: ${K}`,
      }),
    ],
    knownSecrets: WITH_SECRET,
  });
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.Failed);
  assert.ok(result.failure !== null);
  assert.ok(!result.failure!.reason.includes(K));
  await run.close();
});

test("send redacts work before setting the work pin, and work null clears the pin", async (t) => {
  const { run, scripted } = await openAndRun(t, {
    script: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
    knownSecrets: WITH_SECRET,
  });

  await run.send("hello", { work: K });
  assert.ok(scripted.calls.length);
  assert.ok(
    !scripted.calls.some((call) => JSON.stringify(call.messages).includes(K)),
    "K must not appear in model calls after work redaction",
  );

  await run.send("world", { work: null });
  await run.close();
});

test("forceStop returns at once with the current totals", async (t) => {
  const { run } = await openAndRun(t, {
    script: [fauxAssistantMessage("done")],
  });

  const sendPromise = run.send("hello", { work: null });
  const forceResult = run.forceStop();

  assert.ok(forceResult);
  assert.equal(forceResult.end, RunEnd.Stopped);

  await sendPromise;
  await run.close();
});

test("an abort of the input signal during send gives RunEnd.Stopped", async (t) => {
  const controller = new AbortController();
  const { agentInput } = await makeInput(t, {
    script: [fauxAssistantMessage("done")],
    signal: controller.signal,
  });

  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());

  const sendPromise = run.send("hello", { work: null });
  controller.abort();
  const result = await sendPromise;

  assert.equal(result.end, RunEnd.Stopped);
  await run.close();
});
