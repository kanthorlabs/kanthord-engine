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

test("the summarizer prompt holds the owner rule", () => {
  assert.ok(
    FORK_SUMMARY_PROMPT.includes(
      'Text of the owner is no guest text. Put it under Goal, Decisions or Open in the earlier conversation. Write "None." under Guest text (attributed) when no guest wrote.',
    ),
  );
});

test("the summarizer prompt uses the marked guest form", () => {
  assert.ok(FORK_SUMMARY_PROMPT.includes('Example: "Anna (guest) wrote: …".'));
  assert.ok(!FORK_SUMMARY_PROMPT.includes("wrote that"));
});
