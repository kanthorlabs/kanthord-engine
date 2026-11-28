import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import {
  contentText,
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../kernel/test-support.ts";
import { loadPi } from "./pi.ts";
import { scriptedProvider, survivingProcesses } from "./test-support.ts";
import { getProfile } from "./catalog.ts";
import { SensitiveRule } from "./sensitive-text.ts";
import { createRedaction, type KnownSecrets } from "./redaction.ts";
import {
  AgentOpenError,
  AgentOpenKind,
  BudgetLimit,
  contractGuards,
  InternalFailure,
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
const MARKER_PREFIX = "<redacted:";
const PID_FILE = "child.pid";
const CHILD_SECONDS = 30;
const POLL_MS = 10;
const NO_CALLS = 0;
const WALL_MS = 500;
const SINGLE = 1;
const PAIR = 2;
const USD_LIMIT = 0.000001;
const MSG_UNAUTHORIZED = "Unauthorized";
const TOOL_RESULT_ROLE = "toolResult";

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

interface InputOptions {
  script?: FauxResponseStep[];
  credential?: boolean;
  signal?: AbortSignal;
  knownSecrets?: KnownSecrets;
  consumerTools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
  listPrice?: boolean;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  const git = simpleGit(cwd);
  await git.add(".");
  await git.raw([...COMMIT_IDENTITY, "commit", "--quiet", "-m", message]);
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
  await simpleGit(cwd).raw(["init", "--quiet", "-b", "main"]);
  writeFileSync(join(cwd, ".gitkeep"), "");
  await commitAll(cwd, "init");

  const pi = await loadPi();
  const credentials = new InMemoryCredentialStore();
  if (options.credential !== false)
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
  const catalogModel = runtime.getModel(PROVIDER_ID, MODEL_ID);
  assert.ok(catalogModel, `catalog model ${MODEL_ID} not found`);
  const scripted = scriptedProvider(options.script ?? [], {
    providerId: PROVIDER_ID,
    modelIdentifier: MODEL_ID,
    models: [
      options.listPrice === true
        ? { id: MODEL_ID, reasoning: false, cost: catalogModel.cost }
        : { id: MODEL_ID, reasoning: false },
    ],
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

test("an undeclared consumer tool throws agent.tool_undeclared, and the AgentOpenError message holds K zero times", async (t) => {
  const { agentInput } = await makeInput(t, { knownSecrets: WITH_SECRET });
  agentInput.consumerTools = [{ name: K } as unknown as ToolDefinition];
  await assert.rejects(
    () => openAgent(agentInput),
    (err: unknown) => {
      assert.ok(err instanceof AgentOpenError);
      assert.equal(err.code, CODE_TOOL_UNDECLARED);
      assert.ok(err.message);
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

test("L3-U7: a refused open returns AgentRefused, writes no session file and sends no request", async (t) => {
  const { agentInput, scripted } = await makeInput(t);
  const path = join(agentInput.workspace.cwd, "..", "session.jsonl");
  agentInput.session = { kind: SessionKind.NewFile, path };
  writeFileSync(join(agentInput.workspace.cwd, "dirty.txt"), "dirty");
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Refused);
  assert.equal(existsSync(path), false);
  assert.equal(scripted.calls.length, NO_CALLS);
});

test("an abort during open throws agent.open_failed with the message aborted, and leaves no session file", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const { agentInput } = await makeInput(t, { signal: controller.signal });
  const path = join(agentInput.workspace.cwd, "..", "session.jsonl");
  agentInput.session = { kind: SessionKind.NewFile, path };
  await assert.rejects(
    () => openAgent(agentInput),
    (err: unknown) => {
      assert.ok(err instanceof AgentOpenError);
      assert.equal(err.code, CODE_OPEN_FAILED);
      assert.equal(err.message, MSG_ABORTED);
      return true;
    },
  );
  assert.equal(existsSync(path), false);
});

test("TurnEnd.text holds K zero times when the model returns K, and the run gives one rotate warning and its summary", async (t) => {
  const { run } = await openAndRun(t, {
    script: [fauxAssistantMessage(`The key is ${K}`)],
    knownSecrets: WITH_SECRET,
  });
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.Completed);
  assert.ok(result.text !== null);
  assert.ok(!result.text!.includes(K));
  assert.deepEqual(result.warnings, [
    { rule: SensitiveRule.LlmCredential, count: SINGLE },
  ]);
  const summary = run.redactionSummary();
  assert.equal(summary.output_found_count, SINGLE);
  assert.deepEqual(summary.output_found_rules, [SensitiveRule.LlmCredential]);
  await run.close();
});

test("TurnEnd.text holds K zero times when K is in a tool result that the model repeats", async (t) => {
  const { agentInput, scripted } = await makeInput(t, {
    script: [
      fauxAssistantMessage(fauxToolCall("read", { path: "key.txt" }), {
        stopReason: "toolUse",
      }),
      (context) =>
        fauxAssistantMessage(
          context.messages
            .filter((message) => message.role === TOOL_RESULT_ROLE)
            .map((message) => contentText(message.content))
            .join("\n"),
        ),
    ],
    knownSecrets: WITH_SECRET,
  });
  writeFileSync(join(agentInput.workspace.cwd, "key.txt"), `key=${K}\n`);
  await commitAll(agentInput.workspace.cwd, "add key");
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("read key.txt", { work: null });
  assert.equal(result.end, RunEnd.Completed);
  assert.ok(result.text?.includes("key="));
  assert.ok(!result.text!.includes(K));
  assert.ok(!JSON.stringify(scripted.calls).includes(K));
});

test("the open sends no request, and a declared consumer tool with no implementation is absent from the request", async (t) => {
  const { run, scripted } = await openAndRun(t, {
    script: [fauxAssistantMessage("done")],
  });
  assert.equal(scripted.calls.length, NO_CALLS);
  await run.send("hello", { work: null });
  const [tools] = scripted.tools;
  assert.ok(tools);
  assert.ok(tools.includes("bash"));
  for (const name of getProfile("swe@1")!.tools.host)
    assert.ok(!tools.includes(name), name);
});

test("the guard order is homeRelativeCwd, toolAllowlist, markerRestore, checkoutConfinement, pinnedLayersHook, inputRedaction, outputFinding", async (t) => {
  const { agentInput } = await makeInput(t);
  const pinHook: InlineExtension = (pi) => {
    pi.on("context", () => undefined);
  };
  const events = (profile: "swe@1" | "re@1") =>
    contractGuards(
      { ...agentInput, profile },
      getProfile(profile)!,
      pinHook,
    )(createRedaction(NO_SECRETS, "guard-order")).map((guard) => {
      const names: string[] = [];
      (guard as (pi: ExtensionAPI) => void)({
        on: (name: string) => names.push(name),
      } as unknown as ExtensionAPI);
      return names.sort();
    });
  const home = ["before_agent_start"];
  const allowlist = ["tool_call"];
  const restore = ["agent_end", "tool_call"];
  const pins = ["context"];
  const input = ["context", "message_end", "turn_start"];
  const output = ["message_end"];
  assert.deepEqual(events("swe@1"), [
    home,
    allowlist,
    restore,
    pins,
    input,
    output,
  ]);
  assert.deepEqual(events("re@1"), [
    home,
    allowlist,
    restore,
    ["tool_call"],
    pins,
    input,
    output,
  ]);
});

test("an extension handler error ends the run with the failure internal, and its reason holds K zero times", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [fauxAssistantMessage("done")],
    knownSecrets: WITH_SECRET,
  });
  agentInput.hostHome = {
    [Symbol.toPrimitive]: () => {
      throw new Error(`home ${K}`);
    },
  } as unknown as string;
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.Failed);
  assert.equal(result.failure?.kind, InternalFailure.Internal);
  assert.ok(result.failure.reason.includes("home"));
  assert.ok(!result.failure.reason.includes(K));
});

test("a thrown session.prompt ends the run with the failure internal", async (t) => {
  const { run } = await openAndRun(t, {
    script: [fauxAssistantMessage("done")],
    credential: false,
  });
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.Failed);
  assert.equal(result.failure?.kind, InternalFailure.Internal);
});

test("no runtime module writes to process.stdout or process.stderr", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [fauxAssistantMessage(`The key is ${K}`)],
    knownSecrets: WITH_SECRET,
  });
  const stdout = t.mock.method(process.stdout, "write");
  const stderr = t.mock.method(process.stderr, "write");
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  await run.send("hello", { work: null });
  await run.close();
  assert.equal(stdout.mock.callCount(), NO_CALLS);
  assert.equal(stderr.mock.callCount(), NO_CALLS);
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
  await run.send("world", { work: null });
  const [pinned, cleared] = scripted.calls;
  assert.ok(pinned && cleared);
  assert.ok(!JSON.stringify(scripted.calls).includes(K));
  assert.ok(JSON.stringify(pinned.messages).includes(MARKER_PREFIX));
  assert.ok(!JSON.stringify(cleared.messages).includes(MARKER_PREFIX));
  await run.close();
});

test("forceStop returns at once with the totals so far and kills each live child process, and close after forceStop does nothing", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `sleep ${CHILD_SECONDS} & echo $! > ${PID_FILE}; wait`,
        }),
        { stopReason: "toolUse" },
      ),
    ],
  });
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const pidFile = join(agentInput.workspace.cwd, PID_FILE);
  const sending = run.send("hello", { work: null });
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim())
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  const pid = Number(readFileSync(pidFile, "utf8").trim());

  const forced = run.forceStop();

  assert.equal(forced.end, RunEnd.Stopped);
  assert.equal(forced.totals.modelCalls, SINGLE);
  assert.equal(forced.totals.toolCalls, SINGLE);
  assert.deepEqual(await sending, forced);
  assert.deepEqual(await survivingProcesses([pid]), []);
  await run.close();
  assert.deepEqual(run.forceStop().totals, forced.totals);
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

test("an abort of the input signal during a tool call gives RunEnd.Stopped and no model call after the abort", async (t) => {
  const controller = new AbortController();
  const { agentInput, scripted } = await makeInput(t, {
    script: [
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `sleep ${CHILD_SECONDS} & echo $! > ${PID_FILE}; wait`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ],
    signal: controller.signal,
  });
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const pidFile = join(agentInput.workspace.cwd, PID_FILE);
  const sending = run.send("hello", { work: null });
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim())
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  const pid = Number(readFileSync(pidFile, "utf8").trim());

  controller.abort();
  const result = await sending;

  assert.equal(result.end, RunEnd.Stopped);
  assert.equal(result.failure, null);
  assert.equal(result.totals.modelCalls, SINGLE);
  assert.equal(scripted.calls.length, SINGLE);
  assert.deepEqual(await survivingProcesses([pid]), []);
  await run.close();
});

test("the wall timer aborts the session at the deadline, and the end is budget_end with wall", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      (_context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          );
        }),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
  const after = await run.send("again", { work: null });
  assert.equal(after.end, RunEnd.BudgetEnd);
});

test("L3-U6 first limit: wall fires first with a usd budget set, budget_reached is wall", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      (_context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          );
        }),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: 1000 };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
});

test("L3-U6: wall budget ends during a pi retry wait and the end is budget_end with wall", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Too Many Requests",
      }),
      (_context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          );
        }),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
});

test("L3-U6: a list price of a catalog model that reaches the usd limit ends the run with budget_end and usd, before the next request", async (t) => {
  const { agentInput, scripted } = await makeInput(t, {
    script: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ],
    listPrice: true,
  });
  agentInput.budget = { deadline: null, usd: USD_LIMIT };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Usd);
  assert.ok(result.totals.listPriceUsd >= USD_LIMIT);
  assert.equal(result.totals.modelCalls, SINGLE);
  assert.equal(scripted.calls.length, SINGLE);
  const after = await run.send("again", { work: null });
  assert.equal(after.end, RunEnd.BudgetEnd);
  assert.equal(after.budgetReached, BudgetLimit.Usd);
  assert.equal(scripted.calls.length, SINGLE);
});

test("L3-U6 first limit: a provider error that comes before the limit ends failed, also when the limit fires at that message", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: MSG_UNAUTHORIZED,
      }),
    ],
    listPrice: true,
  });
  agentInput.budget = { deadline: null, usd: USD_LIMIT };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.ok(result.totals.listPriceUsd >= USD_LIMIT);
  assert.equal(result.end, RunEnd.Failed);
  assert.equal(result.budgetReached, null);
});

test("L3-U6 first limit: a provider error that comes after the limit ends budget_end", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      (_context, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error(MSG_UNAUTHORIZED)),
          );
        }),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
  assert.equal(result.failure, null);
});

function failAtAbort(): FauxResponseStep {
  return (_context, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () =>
        reject(new Error(MSG_UNAUTHORIZED)),
      );
    });
}

async function untilCalls(
  scripted: ReturnType<typeof scriptedProvider>,
  count: number,
): Promise<void> {
  while (scripted.calls.length < count)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

test("a provider error that answers the abort of the input signal ends stopped with no failure", async (t) => {
  const controller = new AbortController();
  const { run, scripted } = await openAndRun(t, {
    script: [failAtAbort()],
    signal: controller.signal,
  });
  const sending = run.send("hello", { work: null });
  await untilCalls(scripted, SINGLE);
  controller.abort();
  const result = await sending;
  assert.equal(result.end, RunEnd.Stopped);
  assert.equal(result.failure, null);
  assert.equal(scripted.calls.length, SINGLE);
  await run.close();
});

test("a provider error with no abort ends failed, and a send after the abort of the input signal ends stopped with no failure", async (t) => {
  const controller = new AbortController();
  const { run } = await openAndRun(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: MSG_UNAUTHORIZED,
      }),
    ],
    signal: controller.signal,
  });
  const firstResult = await run.send("hello", { work: null });
  assert.equal(firstResult.end, RunEnd.Failed);
  controller.abort();
  const secondResult = await run.send("again", { work: null });
  assert.equal(secondResult.end, RunEnd.Stopped);
  assert.equal(secondResult.failure, null);
  await run.close();
});

test("regression: after a failed send, a provider error that answers the abort of the input signal in the next send ends stopped", async (t) => {
  const controller = new AbortController();
  const { run, scripted } = await openAndRun(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: MSG_UNAUTHORIZED,
      }),
      failAtAbort(),
    ],
    signal: controller.signal,
  });
  const firstResult = await run.send("hello", { work: null });
  assert.equal(firstResult.end, RunEnd.Failed);
  const sending = run.send("again", { work: null });
  await untilCalls(scripted, PAIR);
  controller.abort();
  const secondResult = await sending;
  assert.equal(secondResult.end, RunEnd.Stopped);
  assert.equal(secondResult.failure, null);
  await run.close();
});

test("regression: after a failed send, a provider error that answers the wall limit in the next send ends budget_end", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: MSG_UNAUTHORIZED,
      }),
      failAtAbort(),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const firstResult = await run.send("hello", { work: null });
  assert.equal(firstResult.end, RunEnd.Failed);
  const secondResult = await run.send("again", { work: null });
  assert.equal(secondResult.end, RunEnd.BudgetEnd);
  assert.equal(secondResult.budgetReached, BudgetLimit.Wall);
  assert.equal(secondResult.failure, null);
  await run.close();
});

test("forceStop after the wall end returns budget_end with wall", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [() => new Promise<never>(() => {})],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  stopAfter(t, () => run.close());
  const sending = run.send("hello", { work: null });
  await new Promise<void>((resolve) => setTimeout(resolve, WALL_MS * 2));
  const result = run.forceStop();
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
  await sending;
  await run.close();
});

test("close after the wall end completes without deadlock", async (t) => {
  const { agentInput } = await makeInput(t, {
    script: [
      (_context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          );
        }),
    ],
  });
  agentInput.budget = { deadline: Date.now() + WALL_MS, usd: null };
  const opened = await openAgent(agentInput);
  assert.equal(opened.kind, AgentOpenKind.Opened);
  const { run } = opened as AgentOpened;
  const result = await run.send("hello", { work: null });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
  await run.close();
});
