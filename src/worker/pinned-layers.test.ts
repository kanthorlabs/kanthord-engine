import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  contentText,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration, WorkerMethod } from "./catalog.ts";
import { composePrompt, renderWorkPrompt } from "./prompt-composer.ts";
import { openSession } from "./agent-session.ts";
import { countTurns, pinnedLayers } from "./pinned-layers.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";

test("pinned prompt layers survive compaction and all model calls retain their obligations", async (t) => {
  const expectedKey = "scripted";
  const cwd = temporary(t);
  const composed = await composePrompt(
    {
      workerName: "general@1",
      agent: getAgentDeclaration("swe@1")!,
      method: WorkerMethod.Steps,
      hostHome: cwd,
      workspace: cwd,
      globalPrompt: {
        state: "present",
        path: "operator",
        text: "GLOBAL_MARKER",
      },
      repository: { name: "repository", projectPrompt: "PROJECT_MARKER" },
    },
    background,
  );
  const work = renderWorkPrompt({
    nodeId: "node",
    revision: 1,
    content: {
      name: "WORK_MARKER",
      requirement: "build",
      criterion: "pass",
      verifications: [],
    },
  });
  const pinned = pinnedLayers(composed.layers);
  pinned.setWork(work);
  const provider = scriptedProvider([
    fauxAssistantMessage("first ".repeat(30000)),
    fauxAssistantMessage("second"),
    fauxAssistantMessage("summary"),
    fauxAssistantMessage("next"),
  ]);
  const setup = anthropicSetup();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "scripted",
  }));
  const { runtime, model } = await scriptedModelRuntime(provider)({
    credentials,
    setup,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    signal: new AbortController().signal,
  });
  const session = await openSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: composed.systemPrompt,
    allowlist: [],
    customTools: [],
    extensions: [pinned.extension],
    context: background,
  });
  t.after(() => session.dispose());
  pinned.pinInference(session, composed.systemPrompt);
  let turns = 0;
  const unsubscribe = countTurns(session, () => {
    turns++;
  });
  t.after(unsubscribe);
  await session.prompt(work.marked);
  await session.prompt("second request");
  await session.compact();
  await session.prompt("continue");
  const expectedTurns = 3;
  assert.equal(turns, expectedTurns);
  for (const call of provider.calls) {
    const text = JSON.stringify(call.messages);
    assert.match(text, /GLOBAL_MARKER/);
    assert.match(text, /PROJECT_MARKER/);
    assert.match(text, /WORK_MARKER/);
    assert.ok(
      call.systemPrompt?.includes("You are a senior software engineer."),
    );
    const userRole = "user";
    for (const marked of [
      composed.layers.global!.marked,
      composed.layers.project!.marked,
      work.marked,
    ]) {
      assert.deepEqual(
        call.messages
          .filter(
            (entry) =>
              entry.role === userRole && contentText(entry.content) === marked,
          )
          .map((entry) => contentText(entry.content)),
        [marked],
      );
    }
    assert.ok(
      call.systemPrompt?.includes(getAgentDeclaration("swe@1")!.agentPrompt),
    );
    assert.equal(call.apiKey, expectedKey);
  }
});

test("two tool calls produce three counted turns with no absent project message", async (t) => {
  const cwd = temporary(t);
  writeFileSync(join(cwd, "file"), "content");
  const pins = pinnedLayers({ global: null, project: null });
  const provider = scriptedProvider([
    fauxAssistantMessage(fauxToolCall("read", { path: "file" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("read", { path: "file" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const setup = anthropicSetup();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "scripted",
  }));
  const { runtime, model } = await scriptedModelRuntime(provider)({
    credentials,
    setup,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    signal: new AbortController().signal,
  });
  const session = await openSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "owned system",
    allowlist: ["read"],
    customTools: [],
    extensions: [pins.extension],
    context: background,
  });
  t.after(() => session.dispose());
  pins.pinInference(session, "owned system");
  let turns = 0;
  t.after(
    countTurns(session, () => {
      turns++;
    }),
  );
  await session.prompt("read twice");
  const expectedTurns = 3;
  assert.equal(turns, expectedTurns);
  assert.doesNotMatch(JSON.stringify(provider.calls), /project prompt/);
});

test("inference pin preserves stream arguments and later system updates across work changes and retries", () => {
  const calls: Parameters<StreamFn>[] = [];
  const failure = new Error("original stream failure");
  const original: StreamFn = (...args) => {
    calls.push(args);
    throw failure;
  };
  const session = { agent: { streamFunction: original } } as AgentSession;
  const pins = pinnedLayers({ global: null, project: null });
  const systemPrompt = "declared system";
  pins.pinInference(session, systemPrompt);
  const model = {} as Parameters<StreamFn>[0];
  const options = {
    signal: new AbortController().signal,
    apiKey: "execution-key",
    temperature: 0.3,
  };
  for (const name of ["first", "second"]) {
    const work = { text: name, marked: `<work>${name}</work>`, digest: name };
    pins.setWork(work);
    const context = normalizeContext({
      systemPrompt: "summarize only",
      messages: [
        { role: "user", content: `quoted ${work.marked}`, timestamp: 1 },
        { role: "system", content: "later patch", timestamp: 2 },
      ],
    });
    for (const attempt of [1, 2]) {
      assert.ok(attempt);
      assert.throws(
        () => session.agent.streamFunction(model, context, options),
        (error) => error === failure,
      );
      const [seenModel, seenContext, seenOptions] = calls.at(-1)!;
      assert.equal(seenModel, model);
      assert.equal(seenOptions, options);
      assert.deepEqual(
        seenContext.messages.map((entry) => contentText(entry.content)),
        [
          systemPrompt,
          "summarize only",
          work.marked,
          `quoted ${work.marked}`,
          "later patch",
        ],
      );
      assert.deepEqual(
        context.messages.map((entry) => contentText(entry.content)),
        ["summarize only", `quoted ${work.marked}`, "later patch"],
      );
    }
  }
});
