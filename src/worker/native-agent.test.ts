import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background, CancellationContext } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { temporary } from "../kernel/test-support.ts";
import { NodeKind, openNativeAgent } from "./native-agent.ts";
import {
  WorkerMethod,
  type ExecutionSetup,
  type HostTools,
} from "./contract.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";

const SECRET = "test_native-scripted-key";
const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const THREE = 3;
const ONE = 1;
const CONTENT = "written";
const OPERATOR_PATH = "operator";
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
) {
  const setup = anthropicSetup(overrides);
  const workspace = temporary(t);
  const hostHome = temporary(t);
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
    method: WorkerMethod.Steps,
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
  const h = await fixture(
    t,
    [
      tool("write", { path: "written.txt", content: CONTENT }),
      tool("bash", { command: "printf shell > shell.txt" }),
      fauxAssistantMessage("done"),
    ],
    {
      globalPrompt: {
        state: "present",
        path: "operator",
        text: "global instruction",
      },
    },
  );
  await h.agent.prompt(WORK);
  assert.equal(readFileSync(join(h.workspace, "written.txt"), "utf8"), CONTENT);
  assert.ok(existsSync(join(h.workspace, "shell.txt")));
  assert.equal(h.provider.calls.length, THREE);
  assert.ok(h.provider.calls.every(({ apiKey }) => apiKey === SECRET));
  assert.ok(
    h.agent.composition.selected.some(({ path }) => path === OPERATOR_PATH),
  );
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
    { resourceBudget: { turns: ONE, wallTimeMs: 60000 } },
  );
  await h.agent.prompt(WORK);
  assert.equal(h.provider.calls.length, ONE);
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
  assert.equal(h.provider.calls.length, ONE);
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
    messages.split(JSON.stringify(WORK.marked).slice(1, -1)).length - 1,
    ONE,
  );
  assert.deepEqual(call.messages.at(-1)?.content, [
    { type: "text", text: "judge" },
  ]);
  assert.equal(h.agent.lastText(), JUDGED);
  assert.equal(before.length, THREE);
  assert.equal(h.agent.transcript().length, TRANSCRIPT_MESSAGES);
  assert.deepEqual(
    h.agent.transcript().map((message) => (message as { role: string }).role),
    ["system", "user", "assistant", "user", "assistant"],
  );
});
