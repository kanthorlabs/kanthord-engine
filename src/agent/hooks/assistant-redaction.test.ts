import assert from "node:assert/strict";
import { test } from "node:test";
import {
  an,
  j,
  PASS,
  providerKey,
  redactionOf,
  toolResult,
} from "../redaction-test-support.ts";
import { SensitiveRule } from "../sensitive-text.ts";
import { assistantRedaction } from "./assistant-redaction.ts";

const NO_FINDING = 0;
const SINGLE_FINDING = 1;
const PAIR_OF_FINDINGS = 2;
const SIGNED_APIS = 3;

const interimOf = (secrets: readonly string[] = []) =>
  redactionOf(secrets, [assistantRedaction]);

test("assistant content keeps a pattern value and masks a known secret, and errorMessage keeps every rule", async () => {
  const secret = providerKey();
  const { end, redaction } = interimOf([secret]);
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  const failure = an(16);
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: line },
      { type: "thinking", thinking: line },
      {
        type: "toolCall",
        id: "c1",
        name: "write",
        arguments: { content: j(line, "\nkey ", secret) },
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    errorMessage: j(PASS, ' = "', failure, '" ', secret),
    stopReason: "stop",
    timestamp: 1,
  };
  const copy = (await end(message))!;
  const blocks = copy.content as Record<string, unknown>[];
  assert.equal(blocks[0]!.text, line);
  assert.equal(blocks[1]!.thinking, line);
  const written = String(
    (blocks[2]!.arguments as Record<string, unknown>).content,
  );
  assert.ok(written.startsWith(line));
  assert.ok(!written.includes(secret));
  assert.ok(!String(copy.errorMessage).includes(failure));
  assert.ok(!String(copy.errorMessage).includes(secret));
  assert.deepEqual(redaction.counts().redacted, {
    [SensitiveRule.LlmCredential]: PAIR_OF_FINDINGS,
    [SensitiveRule.QuotedAssignment]: SINGLE_FINDING,
  });
  const own = await end({
    role: "assistant",
    content: [{ type: "text", text: line }],
    api: "anthropic-messages",
    timestamp: 1,
  });
  assert.equal(own, undefined);
  const echo = await end(toolResult(j("value ", value)));
  assert.equal(echo, undefined);
});

test("assistant content ignores the table values and a signed thinking block adds none", async () => {
  const { end, redaction } = interimOf();
  const learned = an(16);
  assert.ok(await end(toolResult(j(PASS, ' = "', learned, '"'))));
  const own = await end({
    role: "assistant",
    content: [{ type: "text", text: j("value ", learned) }],
    api: "anthropic-messages",
    timestamp: 1,
  });
  assert.equal(own, undefined);
  const thought = an(16);
  const kept = await end({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: j(PASS, ' = "', thought, '" ', learned),
        thinkingSignature: "signature-bytes",
      },
    ],
    api: "anthropic-messages",
    timestamp: 1,
  });
  assert.equal(kept, undefined);
  assert.equal(redaction.counts().thinking_kept, NO_FINDING);
  assert.equal(await end(toolResult(j("value ", thought))), undefined);
});

test("a signed thinking block stays whole and counts each known secret", async () => {
  const secret = providerKey();
  const { end, redaction } = interimOf([secret]);
  const line = j("key ", secret);
  const thinking = (api: string, signature: string | undefined) => ({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: line,
        ...(signature === undefined ? {} : { thinkingSignature: signature }),
      },
      { type: "text", text: "ok" },
    ],
    api,
    timestamp: 1,
  });
  for (const api of [
    "anthropic-messages",
    "openai-codex-responses",
    "azure-openai-responses",
  ]) {
    const message = thinking(api, "signature-bytes");
    const copy = await end(message);
    assert.equal(copy, undefined, api);
  }
  assert.equal(redaction.counts().thinking_kept, SIGNED_APIS);
  for (const [api, signature] of [
    ["google-generative-ai", undefined],
    ["bedrock-converse-stream", ""],
    ["openai-completions", "reasoning_content"],
  ] as const) {
    const copy = await end(thinking(api, signature));
    assert.ok(copy, api);
    const block = (copy.content as Record<string, unknown>[])[0]!;
    assert.ok(!String(block.thinking).includes(secret), api);
    assert.equal(block.thinkingSignature, signature, api);
  }
  const otherApi = await end({
    ...thinking("anthropic-messages", "reasoning_content"),
  });
  assert.equal(otherApi, undefined);
});

test("structural keys stay and a key of the same name inside arguments is redacted", async () => {
  const secret = providerKey();
  const { end } = interimOf([secret]);
  const line = j("key ", secret);
  const copy = await end({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "c",
        name: "write",
        arguments: { model: line },
        thoughtSignature: line,
      },
    ],
    api: "anthropic-messages",
    model: line,
    timestamp: 1,
  });
  const block = (copy!.content as Record<string, unknown>[])[0]!;
  assert.equal(block.thoughtSignature, line);
  assert.equal(copy!.model, line);
  assert.ok(!JSON.stringify(block.arguments).includes(secret));
});

test("the context handler redacts a resumed summary and a custom message", async () => {
  const { context, compact, redaction } = interimOf();
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  const result = await context([
    { role: "compactionSummary", summary: line, tokensBefore: 1, timestamp: 1 },
    {
      role: "custom",
      customType: "kanthord.prompt-layer",
      content: line,
      display: false,
      timestamp: 1,
    },
    { role: "user", content: line, timestamp: 1 },
  ]);
  assert.ok(result);
  assert.ok(!JSON.stringify(result.messages.slice(0, 2)).includes(value));
  assert.ok(JSON.stringify(result.messages[2]).includes(value));
  const entry = { summary: j("summary ", line) };
  await compact(entry);
  assert.ok(!entry.summary.includes(value));
  assert.equal(redaction.counts().compaction_residual, SINGLE_FINDING);
});
