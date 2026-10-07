import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background, CancellationContext } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { NodeKind, openNativeAgent } from "./native-agent.ts";
import {
  WorkerMethod,
  type ExecutionSetup,
  type HostTools,
} from "./contract.ts";
import { renderWorkPrompt } from "../agent/prompt-composer.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  SETUP_PROMPT,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";

const SECRET = "test_native-scripted-key";
const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PROVIDER_CALL_COUNT = 3;
const TRANSCRIPT_LENGTH_BEFORE = 3;
const SINGLE_TURN_BUDGET = 1;
const SINGLE_CALL_COUNT = 1;
const CONTENT = "written";
const PROJECT_PROMPT = "project prompt text";
const HOME_TEXT = "home file text";
const TOOL_RESULT = "toolResult";
const START_POLLS = 100;
const JUDGED = "judged";
const TRANSCRIPT_MESSAGES = 5;
const WORK = renderWorkPrompt({
  nodeId: NODE,
  revision: 1,
  content: {
    name: "work",
    requirement: "write files",
    criterion: "files exist",
    verifications: [],
  },
});
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture(
  t: TestContext,
  script: Parameters<typeof scriptedProvider>[0],
  overrides: Partial<ExecutionSetup> = {},
  hostTools: HostTools = unusedHostTools,
  options: {
    method?: WorkerMethod;
    prepare?: (workspace: string, hostHome: string) => void;
  } = {},
) {
  const setup = anthropicSetup(overrides);
  const workspace = temporary(t);
  const hostHome = temporary(t);
  options.prepare?.(workspace, hostHome);
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: SECRET,
  }));
  const context = new CancellationContext(background);
  t.after(() => context.cancel());
  const agent = await openNativeAgent({
    hostTools,
    setup,
    claim: {
      executionId: setup.executionId,
      nodeId: NODE,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
    },
    nodeKind: NodeKind.Objective,
    method: options.method ?? WorkerMethod.Steps,
    credentials,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    workspace,
    hostHome,
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context,
  });
  t.after(() => agent.dispose());
  return { agent, provider, workspace, context };
}

test("native software agent writes and runs bounded bash with execution credentials", async (t) => {
  const h = await fixture(t, [
    tool("write", { path: "written.txt", content: CONTENT }),
    tool("bash", { command: "printf shell > shell.txt" }),
    fauxAssistantMessage("done"),
  ]);
  await h.agent.prompt(WORK);
  assert.equal(readFileSync(join(h.workspace, "written.txt"), "utf8"), CONTENT);
  assert.ok(existsSync(join(h.workspace, "shell.txt")));
  assert.equal(h.provider.calls.length, PROVIDER_CALL_COUNT);
  assert.ok(h.provider.calls.every(({ apiKey }) => apiKey === SECRET));
  assert.ok(
    h.provider.calls.every(({ systemPrompt }) =>
      systemPrompt?.includes(SETUP_PROMPT),
    ),
  );
  assert.deepEqual(h.agent.composition, { selected: [], rejected: [] });
});

function repositoryOf(
  workingLayer: Partial<typeof WORKING_LAYER_ALL_ON>,
  projectPrompt: string | null = PROJECT_PROMPT,
) {
  return {
    bindingId: createIdentity("binding"),
    name: "repo",
    address: "git@github.com:owner/repo.git",
    sshIdentity: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_test",
    },
    strategy: { baseBranch: "main" },
    projectPrompt,
    working_layer: { ...WORKING_LAYER_ALL_ON, ...workingLayer },
  };
}

const WORKSPACE_FILES = [
  ["AGENTS.md", "agents text"],
  ["AGENTS.local.md", "agents local text"],
  ["CLAUDE.md", "claude text"],
  ["CLAUDE.local.md", "claude local text"],
] as const;

function writeFiles(workspace: string, hostHome: string) {
  for (const [name, text] of WORKSPACE_FILES)
    writeFileSync(join(workspace, name), text);
  mkdirSync(join(hostHome, ".agents"));
  writeFileSync(join(hostHome, ".agents/AGENTS.md"), HOME_TEXT);
}

const callText = (h: Awaited<ReturnType<typeof fixture>>) =>
  JSON.stringify(h.provider.calls.map(({ messages }) => messages));

test("native agent composes only the switched-on workspace files and the project prompt", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    {
      repositories: [
        repositoryOf({ agents_local_md: false, claude_md: false }),
      ],
    },
    unusedHostTools,
    { prepare: writeFiles },
  );
  await h.agent.prompt(WORK);
  const text = callText(h);
  assert.ok(text.includes("agents text"));
  assert.ok(text.includes("claude local text"));
  assert.ok(text.includes(PROJECT_PROMPT));
  assert.ok(!text.includes("agents local text"));
  assert.ok(!text.includes('"claude text'));
  assert.ok(!text.includes(HOME_TEXT));
  assert.ok(
    h.provider.calls.every(
      ({ systemPrompt }) => !systemPrompt?.includes(HOME_TEXT),
    ),
  );
  assert.deepEqual(
    h.agent.composition.selected.map(({ source }) => source),
    [
      `file ${join(h.workspace, "AGENTS.md")}`,
      `file ${join(h.workspace, "CLAUDE.local.md")}`,
      "database project prompt",
    ],
  );
  assert.ok(
    h.agent.composition.selected.every(({ digest }) =>
      /^[a-f0-9]{64}$/.test(digest),
    ),
  );
});

test("native agent rejects a working file that leaves the workspace and records the reason", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    { repositories: [repositoryOf({}, null)] },
    unusedHostTools,
    {
      prepare: (workspace, hostHome) => {
        writeFiles(workspace, hostHome);
        rmSync(join(workspace, "AGENTS.md"));
        symlinkSync(
          join(hostHome, ".agents/AGENTS.md"),
          join(workspace, "AGENTS.md"),
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  assert.deepEqual(
    h.agent.composition.rejected.map(({ reason }) => reason),
    ["outside_workspace"],
  );
  assert.ok(!callText(h).includes(HOME_TEXT));
});

test("an evaluation takes the project prompt only and reads no workspace file", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    { repositories: [repositoryOf({})] },
    unusedHostTools,
    {
      method: WorkerMethod.Evaluation,
      prepare: (workspace, hostHome) => {
        writeFiles(workspace, hostHome);
        rmSync(join(workspace, "CLAUDE.md"));
        symlinkSync(
          join(hostHome, ".agents/AGENTS.md"),
          join(workspace, "CLAUDE.md"),
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  const text = callText(h);
  assert.ok(text.includes(PROJECT_PROMPT));
  for (const [, content] of WORKSPACE_FILES) assert.ok(!text.includes(content));
  assert.deepEqual(
    h.agent.composition.selected.map(({ source }) => source),
    ["database project prompt"],
  );
  assert.deepEqual(h.agent.composition.rejected, []);
});

test("native reviewer refuses a scripted write tool", async (t) => {
  const h = await fixture(
    t,
    [
      tool("write", { path: "forbidden.txt", content: CONTENT }),
      fauxAssistantMessage("done"),
    ],
    { workerName: "reviewer@1", agentName: "re@1" },
  );
  await h.agent.prompt(WORK);
  assert.equal(existsSync(join(h.workspace, "forbidden.txt")), false);
  assert.ok(
    h.provider.calls.some(({ messages }) =>
      messages.some(
        (message) => message.role === TOOL_RESULT && message.isError,
      ),
    ),
  );
});

test("host upload is declared only for the software agent and validates arguments", async (t) => {
  const result = {
    evidenceId: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    assetId: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    uri: "s3://test-bucket/a.txt",
  };
  const paths: string[] = [];
  const hostTools: HostTools = {
    evidenceUpload: async (path) => {
      paths.push(path);
      return result;
    },
  };
  const h = await fixture(
    t,
    [
      tool("evidence-upload", { path: "a.txt" }),
      tool("evidence-upload", { path: "b.txt", extra: true }),
      fauxAssistantMessage("done"),
    ],
    {},
    hostTools,
  );
  await h.agent.prompt(WORK);
  assert.deepEqual(paths, ["a.txt"]);
  const messages = h.agent.transcript() as {
    role: string;
    isError?: boolean;
    details?: unknown;
  }[];
  assert.ok(
    messages.some(
      (message) =>
        message.role === TOOL_RESULT &&
        !message.isError &&
        JSON.stringify(message.details) === JSON.stringify(result),
    ),
  );
  assert.ok(
    messages.some((message) => message.role === TOOL_RESULT && message.isError),
  );
  const reviewer = await fixture(
    t,
    [tool("evidence-upload", { path: "c.txt" }), fauxAssistantMessage("done")],
    { workerName: "reviewer@1", agentName: "re@1" },
    hostTools,
  );
  await reviewer.agent.prompt(WORK);
  assert.deepEqual(paths, ["a.txt"]);
});

test("host upload rejection becomes a tool error without error details", async (t) => {
  const message = "test_upload_refused";
  const h = await fixture(
    t,
    [tool("evidence-upload", { path: "a.txt" }), fauxAssistantMessage("done")],
    {},
    {
      evidenceUpload: async () => {
        throw Object.assign(
          new Diagnostic("worker.evidence_upload.path_refused", message),
          {
            details: { putUrl: "test_private_url" },
          },
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  const records = JSON.stringify(h.agent.transcript());
  assert.ok(records.includes(message));
  assert.ok(!records.includes("test_private_url"));
  assert.ok(records.includes('"isError":true'));
});

test("native turn budget aborts after the first tool turn", async (t) => {
  const h = await fixture(
    t,
    [
      tool("write", { path: "one.txt", content: CONTENT }),
      tool("write", { path: "two.txt", content: CONTENT }),
      fauxAssistantMessage("done"),
    ],
    { resourceBudget: { turns: SINGLE_TURN_BUDGET, wallTimeMs: 60000 } },
  );
  await h.agent.prompt(WORK);
  assert.equal(h.provider.calls.length, SINGLE_CALL_COUNT);
  assert.equal(h.agent.budget.exhausted(), true);
  assert.equal(existsSync(join(h.workspace, "two.txt")), false);
});

test("native parent cancellation aborts an active tool and disposal refuses reuse", async (t) => {
  const h = await fixture(t, [
    tool("bash", { command: "touch started; sleep 30" }),
    fauxAssistantMessage("unexpected"),
  ]);
  const pending = h.agent.prompt(WORK);
  for (
    let attempt = 0;
    attempt < START_POLLS && !existsSync(join(h.workspace, "started"));
    attempt++
  )
    await setTimeout(10);
  assert.ok(existsSync(join(h.workspace, "started")));
  h.context.cancel();
  await pending;
  assert.equal(h.provider.calls.length, SINGLE_CALL_COUNT);
  h.agent.dispose();
  await assert.rejects(h.agent.prompt(WORK));
  await assert.rejects(h.agent.instruct(WORK, "judge"));
});

test("native instructions preserve pinned work and expose copied transcript and last text", async (t) => {
  const h = await fixture(t, [
    fauxAssistantMessage("work done"),
    fauxAssistantMessage(JUDGED),
  ]);
  assert.equal(h.agent.lastText(), undefined);
  await h.agent.prompt(WORK);
  const before = h.agent.transcript();
  await h.agent.instruct(WORK, "judge");
  const call = h.provider.calls.at(-1)!;
  const messages = JSON.stringify(call.messages);
  assert.equal(
    messages.split(JSON.stringify(WORK.text).slice(1, -1)).length - 1,
    SINGLE_CALL_COUNT,
  );
  assert.deepEqual(call.messages.at(-1)?.content, [
    { type: "text", text: "judge" },
  ]);
  assert.equal(h.agent.lastText(), JUDGED);
  assert.equal(before.length, TRANSCRIPT_LENGTH_BEFORE);
  assert.equal(h.agent.transcript().length, TRANSCRIPT_MESSAGES);
  assert.deepEqual(
    h.agent.transcript().map((message) => (message as { role: string }).role),
    ["system", "user", "assistant", "user", "assistant"],
  );
});
