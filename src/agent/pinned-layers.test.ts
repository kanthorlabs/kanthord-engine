import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentText,
  fauxAssistantMessage,
  getSystemMessageText,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openTestSession, redactionOf } from "./redaction-test-support.ts";
import { loadPi } from "./pi.ts";
import { pinnedLayers } from "./pinned-layers.ts";

const SYSTEM_PROMPT = "owned system";
const WORK_TEXT = "the pinned work text";
const SCRIPTED_KEY = "scripted";
const FAKE_KEY = ["AKIA", "KANTHORDCANARY01"].join("");
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ONE_OCCURRENCE = 2;

function userTexts(messages: Parameters<StreamFn>[1]["messages"]): string[] {
  return messages
    .filter((entry) => entry.role === USER_ROLE)
    .map((entry) => contentText(entry.content));
}

test("each agent-loop request and each compaction summary request holds the system prompt pin and the work pin", async (t) => {
  const { redaction } = redactionOf([]);
  const pins = pinnedLayers();
  pins.setWork({ text: WORK_TEXT });
  const { session, scripted } = await openTestSession(t, {
    script: [
      fauxAssistantMessage("first ".repeat(30000)),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("summary"),
      fauxAssistantMessage("next"),
    ],
    redaction,
    gates: [pins.hook],
  });
  pins.pinInference(session, SYSTEM_PROMPT);

  await session.prompt(WORK_TEXT, { expandPromptTemplates: false });
  await session.prompt("second request", { expandPromptTemplates: false });
  await session.compact();
  await session.prompt("continue", { expandPromptTemplates: false });

  const expectedCalls = 4;
  assert.equal(scripted.calls.length, expectedCalls);
  for (const call of scripted.calls) {
    assert.equal(call.apiKey, SCRIPTED_KEY);
    assert.equal(
      call.systemPrompt?.split(SYSTEM_PROMPT).length,
      ONE_OCCURRENCE,
    );
    assert.deepEqual(
      userTexts(call.messages).filter((text) => text === WORK_TEXT),
      [WORK_TEXT],
    );
  }
});

test("pinInference with a redacted work pin inserts nothing and sends no value", async (t) => {
  const { redaction } = redactionOf([]);
  const pins = pinnedLayers();
  const { session, scripted } = await openTestSession(t, {
    script: [fauxAssistantMessage("done")],
    redaction,
    gates: [pins.hook],
  });
  const work = await redaction.text(`WORK ${FAKE_KEY}`);
  assert.ok(!work.includes(FAKE_KEY));
  pins.setWork({ text: work });
  pins.pinInference(session, SYSTEM_PROMPT);

  await session.prompt(work, { expandPromptTemplates: false });

  const [call] = scripted.calls;
  assert.ok(call);
  assert.deepEqual(
    call.messages.map((entry) => entry.role),
    [SYSTEM_ROLE, USER_ROLE],
  );
  assert.ok(!JSON.stringify(call).includes(FAKE_KEY));
});

test("inference pin preserves stream arguments and later system updates across work changes and repeated calls", () => {
  const calls: Parameters<StreamFn>[] = [];
  const failure = new Error("original stream failure");
  const original: StreamFn = (...args) => {
    calls.push(args);
    throw failure;
  };
  const session = { agent: { streamFunction: original } } as AgentSession;
  const pins = pinnedLayers();
  const systemPrompt = "declared system";
  pins.pinInference(session, systemPrompt);
  const model = {} as Parameters<StreamFn>[0];
  const options = {
    signal: new AbortController().signal,
    apiKey: "test_execution-key",
    temperature: 0.3,
  };
  for (const name of ["first", "second"]) {
    const work = { text: `<work>${name}</work>` };
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

test("setWork(null) clears the work pin of each stream call", () => {
  const calls: Parameters<StreamFn>[] = [];
  const original: StreamFn = (...args) => {
    calls.push(args);
    throw new Error("original stream failure");
  };
  const session = { agent: { streamFunction: original } } as AgentSession;
  const pins = pinnedLayers();
  pins.pinInference(session, SYSTEM_PROMPT);
  pins.setWork({ text: WORK_TEXT });
  pins.setWork(null);
  const context = normalizeContext({
    systemPrompt: "summarize only",
    messages: [{ role: "user", content: "request", timestamp: 1 }],
  });
  assert.throws(() =>
    session.agent.streamFunction({} as Parameters<StreamFn>[0], context, {}),
  );
  assert.deepEqual(
    calls.at(-1)![1].messages.map((entry) => contentText(entry.content)),
    [SYSTEM_PROMPT, "summarize only", "request"],
  );
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
    const historySummary = "history summary result";
    const prefixSummary = "prefix summary result";
    const work = { text: "<work>retain exact content</work>" };
    const { redaction } = redactionOf([]);
    const pins = pinnedLayers();
    pins.setWork(work);
    const { session, scripted } = await openTestSession(t, {
      script: [
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "terminated",
        }),
        fauxAssistantMessage(historySummary),
        ...(isSplitTurn ? [fauxAssistantMessage(prefixSummary)] : []),
      ],
      redaction,
      gates: [pins.hook],
    });
    pins.pinInference(session, SYSTEM_PROMPT);
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
    const model = session.model;
    assert.ok(model);
    const events: unknown[][] = [];
    const result = await pi.compact(
      {
        firstKeptEntryId: "kept-entry",
        isSplitTurn,
        tokensBefore: 1000,
        messagesToSummarize: [
          {
            role: USER_ROLE,
            content: "history request",
            timestamp: INITIAL_ATTEMPT,
          },
          fauxAssistantMessage("history response"),
        ],
        turnPrefixMessages: isSplitTurn
          ? [
              {
                role: USER_ROLE,
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
    assert.equal(scripted.calls.length, expectedCalls);
    assert.equal(requests.length, expectedCalls);
    assert.ok(result.summary.includes(historySummary));
    assert.equal(result.summary.includes(prefixSummary), isSplitTurn);
    const historyRequest = userTexts(
      requests[FIRST_REQUEST_INDEX]!.messages,
    ).join("\n");
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
      const prefixRequest = userTexts(
        requests.at(-NEGATIVE_LAST_OFFSET)!.messages,
      ).join("\n");
      assert.match(
        prefixRequest,
        /Create a concise checkpoint of the user's request/,
      );
      assert.ok(prefixRequest.includes(`prefix request quoting ${work.text}`));
    }
    for (const [index, call] of scripted.calls.entries()) {
      assert.equal(call.apiKey, SCRIPTED_KEY);
      assert.equal(
        call.systemPrompt?.split(SYSTEM_PROMPT).length,
        ONE_OCCURRENCE,
      );
      const original = requests[index]!;
      assert.deepEqual(
        call.messages
          .filter((message) => message.role === SYSTEM_ROLE)
          .map(getSystemMessageText),
        [
          SYSTEM_PROMPT,
          ...original.messages
            .filter((message) => message.role === SYSTEM_ROLE)
            .map(getSystemMessageText),
        ],
      );
      assert.deepEqual(userTexts(call.messages), [
        work.text,
        ...userTexts(original.messages),
      ]);
    }
  });
}
