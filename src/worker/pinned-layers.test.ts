import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  contentText,
  normalizeContext,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  layerText,
  PromptLayer,
  renderWorkPrompt,
} from "../agent/prompt-composer.ts";
import { framing, PromptConsumer } from "../agent/prompt-render.ts";
import { openSession } from "../agent/agent-session.ts";
import { loadPi } from "../agent/pi.ts";
import { countTurns, pinnedLayers } from "../agent/pinned-layers.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";

function composedPrompt(first: string, second: string) {
  const layer = (text: string) =>
    layerText(
      SHIPPED_TEMPLATES,
      PromptLayer.WorkingLayer,
      "owner",
      "source",
      text,
    );
  return {
    systemPrompt: [
      framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
      getAgentDeclaration("swe@1")!.agent_prompt,
    ].join("\n"),
    layers: { global: layer(first), project: layer(second) },
  };
}

test("pinned prompt layers survive compaction and all model calls retain their obligations", async (t) => {
  const expectedKey = "scripted";
  const cwd = temporary(t);
  const composed = composedPrompt("GLOBAL_MARKER", "PROJECT_MARKER");
  const work = renderWorkPrompt(SHIPPED_TEMPLATES, {
    node_id: "node",
    revision: 1,
    content: {
      name: "WORK_MARKER",
      requirement: "build",
      criterion: "pass",
      verifications: [],
    },
  });
  const pinned = pinnedLayers([
    composed.layers.global,
    composed.layers.project,
  ]);
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
    credential: {
      credential_id: setup.agents[0]!.credential_id,
      provider_id: "anthropic",
      store: credentials,
    },
    agent: setup.agents[0]!,
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
    hostHome: cwd,
    hooks: [pinned.hook],
    context: background,
  });
  t.after(() => session.dispose());
  pinned.pinInference(session, composed.systemPrompt);
  let turns = 0;
  const unsubscribe = countTurns(session, () => {
    turns++;
  });
  t.after(unsubscribe);
  await session.prompt(work.text);
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
    assert.ok(call.systemPrompt?.includes(composed.systemPrompt));
    const userRole = "user";
    for (const pinned of [
      composed.layers.global!.message,
      composed.layers.project!.message,
      work.text,
    ]) {
      assert.deepEqual(
        call.messages
          .filter(
            (entry) =>
              entry.role === userRole && contentText(entry.content) === pinned,
          )
          .map((entry) => contentText(entry.content)),
        [pinned],
      );
    }
    assert.ok(
      call.systemPrompt?.includes(getAgentDeclaration("swe@1")!.agent_prompt),
    );
    assert.equal(call.apiKey, expectedKey);
  }
});

test("two tool calls produce three counted turns with no absent project message", async (t) => {
  const cwd = temporary(t);
  writeFileSync(join(cwd, "file"), "content");
  const pins = pinnedLayers([]);
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
    credential: {
      credential_id: setup.agents[0]!.credential_id,
      provider_id: "anthropic",
      store: credentials,
    },
    agent: setup.agents[0]!,
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
    hostHome: cwd,
    hooks: [pins.hook],
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

test("inference pin preserves stream arguments and later system updates across work changes and repeated calls", () => {
  const calls: Parameters<StreamFn>[] = [];
  const failure = new Error("original stream failure");
  const original: StreamFn = (...args) => {
    calls.push(args);
    throw failure;
  };
  const session = { agent: { streamFunction: original } } as AgentSession;
  const pins = pinnedLayers([]);
  const systemPrompt = "declared system";
  pins.pinInference(session, systemPrompt);
  const model = {} as Parameters<StreamFn>[0];
  const options = {
    signal: new AbortController().signal,
    apiKey: "test_execution-key",
    temperature: 0.3,
  };
  for (const name of ["first", "second"]) {
    const work = { text: `<work>${name}</work>`, digest: name };
    pins.setWork(work);
    const context = normalizeContext({
      systemPrompt: "summarize only",
      messages: [
        { role: "user", content: `quoted ${work.text}`, timestamp: 1 },
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
          work.text,
          `quoted ${work.text}`,
          "later patch",
        ],
      );
      assert.deepEqual(
        context.messages.map((entry) => contentText(entry.content)),
        ["summarize only", `quoted ${work.text}`, "later patch"],
      );
    }
  }
});

for (const isSplitTurn of [false, true]) {
  test(`SDK ${isSplitTurn ? "split-prefix" : "history"} compaction retains complete prompts and original requests through SDK retry`, async (t) => {
    const FIRST_REQUEST_INDEX = 0;
    const INITIAL_ATTEMPT = 1;
    const SINGLE_RETRY = 1;
    const SECOND_REQUEST_INDEX = 1;
    const NEGATIVE_LAST_OFFSET = 1;
    const HISTORY_CALLS = 2;
    const SPLIT_CALLS = 3;
    const SYSTEM = "system";
    const USER = "user";
    const key = "test_compaction-retry-key";
    const historySummary = "history summary result";
    const prefixSummary = "prefix summary result";
    const cwd = temporary(t);
    const composed = composedPrompt(
      "complete global source",
      "complete project source",
    );
    const work = renderWorkPrompt(SHIPPED_TEMPLATES, {
      node_id: "node",
      revision: INITIAL_ATTEMPT,
      content: {
        name: "current work",
        requirement: "retain exact content",
        criterion: "summary retains layers",
        verifications: [],
      },
    });
    const pins = pinnedLayers([
      composed.layers.global,
      composed.layers.project,
    ]);
    pins.setWork(work);
    const provider = scriptedProvider([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "terminated",
      }),
      fauxAssistantMessage(historySummary),
      ...(isSplitTurn ? [fauxAssistantMessage(prefixSummary)] : []),
    ]);
    const setup = anthropicSetup();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key,
    }));
    const reads = t.mock.method(credentials, "read");
    const { runtime, model } = await scriptedModelRuntime(provider)({
      credential: {
        credential_id: setup.agents[0]!.credential_id,
        provider_id: "anthropic",
        store: credentials,
      },
      agent: setup.agents[0]!,
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
      hostHome: cwd,
      hooks: [pins.hook],
      context: background,
    });
    t.after(() => session.dispose());
    pins.pinInference(session, composed.systemPrompt);
    const decorated = session.agent.streamFunction;
    const requests: Parameters<StreamFn>[1][] = [];
    session.agent.streamFunction = (selected, context, options) => {
      const original = structuredClone(context);
      requests.push(original);
      const result = decorated(selected, context, options);
      assert.deepEqual(context, original);
      return result;
    };
    const pi = await loadPi();
    const events: unknown[][] = [];
    const result = await pi.compact(
      {
        firstKeptEntryId: "kept-entry",
        isSplitTurn,
        tokensBefore: 1000,
        messagesToSummarize: [
          {
            role: USER,
            content: "history request",
            timestamp: INITIAL_ATTEMPT,
          },
          fauxAssistantMessage("history response"),
        ],
        turnPrefixMessages: isSplitTurn
          ? [
              {
                role: USER,
                content: `prefix request quoting ${work.text}`,
                timestamp: INITIAL_ATTEMPT,
              },
              fauxAssistantMessage("prefix response"),
            ]
          : [],
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
      },
      model,
      undefined,
      undefined,
      "retain the original summary focus",
      new AbortController().signal,
      "off",
      session.agent.streamFunction,
      undefined,
      {
        enabled: true,
        maxRetries: SINGLE_RETRY,
        baseDelayMs: SINGLE_RETRY,
        maxAgentDelayMs: SINGLE_RETRY,
      },
      {
        onRetryScheduled: (attempt, maxAttempts, _delay, message) => {
          events.push(["scheduled", attempt, maxAttempts, message]);
        },
        onRetryAttemptStart: () => {
          events.push(["started"]);
        },
        onRetryFinished: (success, attempt) => {
          events.push(["finished", success, attempt]);
        },
      },
    );
    assert.deepEqual(events, [
      ["scheduled", INITIAL_ATTEMPT, INITIAL_ATTEMPT, "terminated"],
      ["started"],
      ["finished", true, INITIAL_ATTEMPT],
    ]);
    const expectedCalls = isSplitTurn ? SPLIT_CALLS : HISTORY_CALLS;
    assert.equal(provider.calls.length, expectedCalls);
    assert.equal(requests.length, expectedCalls);
    assert.ok(reads.mock.callCount() >= expectedCalls);
    assert.ok(result.summary.includes(historySummary));
    assert.equal(result.summary.includes(prefixSummary), isSplitTurn);
    const historyRequest = requests[FIRST_REQUEST_INDEX]!.messages.filter(
      (message) => message.role === USER,
    )
      .map((message) => contentText(message.content))
      .join("\n");
    assert.match(
      historyRequest,
      /Create a structured context checkpoint summary/,
    );
    assert.match(
      historyRequest,
      /Additional focus: retain the original summary focus/,
    );
    assert.match(historyRequest, /history request/);
    assert.deepEqual(
      requests[FIRST_REQUEST_INDEX],
      requests[SECOND_REQUEST_INDEX],
    );
    if (isSplitTurn) {
      const prefixRequest = requests
        .at(-NEGATIVE_LAST_OFFSET)!
        .messages.filter((message) => message.role === USER)
        .map((message) => contentText(message.content))
        .join("\n");
      assert.match(
        prefixRequest,
        /Create a concise checkpoint of the user's request/,
      );
      assert.ok(prefixRequest.includes(`prefix request quoting ${work.text}`));
    }
    for (const [index, call] of provider.calls.entries()) {
      assert.equal(call.apiKey, key);
      assert.ok(call.systemPrompt);
      assert.ok(call.systemPrompt.includes(composed.systemPrompt));
      assert.equal(
        call.systemPrompt.split(composed.systemPrompt).length,
        HISTORY_CALLS,
      );
      const original = requests[index]!;
      assert.deepEqual(
        call.messages
          .filter((message) => message.role === SYSTEM)
          .map(getSystemMessageText),
        [
          composed.systemPrompt,
          ...original.messages
            .filter((message) => message.role === SYSTEM)
            .map(getSystemMessageText),
        ],
      );
      assert.deepEqual(
        call.messages
          .filter((message) => message.role === USER)
          .map((message) => contentText(message.content)),
        [
          composed.layers.global!.message,
          composed.layers.project!.message,
          work.text,
          ...original.messages
            .filter((message) => message.role === USER)
            .map((message) => contentText(message.content)),
        ],
      );
    }
  });
}
