import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  type Context,
  fauxAssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { FORK_SUMMARY_PROMPT } from "../agent/prompt-assets.ts";
import { FORK_SUMMARY_MAX_TOKENS } from "./contract.ts";
import { forkSummaryRequest, summarize, visibleText } from "./fork-summary.ts";

const model = {} as Model<Api>;
const UNASSIGNED = String.fromCodePoint(0x378);
const NO_TOOLS = 0;
const ONE_CALL = 1;
const VISIBLE = "ac";
const KEPT = "line1\n\tline2";

test("(security: argument guard) visibleText removes hidden characters and keeps newline and tab", () => {
  const hidden = [
    String.fromCodePoint(0xe0041),
    "\u202e",
    "\u2066",
    "\ufe0f",
    String.fromCodePoint(0xe0100),
    "\ue000",
    UNASSIGNED,
    "\u0007",
  ];
  assert.equal(visibleText(`a${hidden.join("")}c`), VISIBLE);
  assert.equal(visibleText(KEPT), KEPT);
});

test("(security: authorization) summarize offers the model no tool", async () => {
  const contexts: Context[] = [];
  const options: unknown[] = [];
  const runtime = {
    completeSimple: async (
      _model: unknown,
      context: Context,
      option: unknown,
    ) => {
      contexts.push(context);
      options.push(option);
      return fauxAssistantMessage("Goal: none.");
    },
  } as never;
  const result = await summarize({
    runtime,
    model,
    request: forkSummaryRequest("material", "carry the ids"),
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: true, summary: "Goal: none." });
  assert.equal(contexts.length, ONE_CALL);
  assert.equal(contexts[0]?.tools?.length ?? NO_TOOLS, NO_TOOLS);
  assert.equal(contexts[0]?.systemPrompt, FORK_SUMMARY_PROMPT);
  assert.equal(
    (options[0] as { maxTokens: number }).maxTokens,
    FORK_SUMMARY_MAX_TOKENS,
  );
  assert.equal("reasoning" in (options[0] as object), false);
});

test("forkSummaryRequest puts the text only in the field instruction", () => {
  const request = forkSummaryRequest("material", "carry the ids");
  assert.deepEqual(JSON.parse(request.content), {
    instruction: "carry the ids",
    conversation: "material",
  });
});

test("summarize answers failure for a throw, a non-stop reason, an empty text and an oversize text", async () => {
  const failing = async (reply: () => Promise<unknown>) =>
    summarize({
      runtime: { completeSimple: reply } as never,
      model,
      request: forkSummaryRequest("m", "t"),
      signal: new AbortController().signal,
    });
  const expected = { ok: false };
  assert.deepEqual(
    await failing(async () => {
      throw new Error("secret provider text");
    }),
    expected,
  );
  assert.deepEqual(
    await failing(async () =>
      fauxAssistantMessage("cut", { stopReason: "length" }),
    ),
    expected,
  );
  assert.deepEqual(
    await failing(async () => fauxAssistantMessage(" \u202e\n ")),
    expected,
  );
  assert.deepEqual(
    await failing(async () => fauxAssistantMessage("a".repeat(8193))),
    expected,
  );
});
