import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createRedaction } from "../redaction.ts";
import {
  an,
  j,
  markers,
  openTestSession,
  PASS,
  providerKey,
  redactionOf,
  SESSION_ID,
  TOOL_CALL_EVENT,
  toolResult,
} from "../redaction-test-support.ts";
import { SensitiveRule } from "../sensitive-text.ts";

const NO_FINDING = 0;
const SINGLE_FINDING = 1;
const PAIR_OF_FINDINGS = 2;

interface SessionEntry {
  type: string;
  message?: { role: string };
}

test("message_end redacts every role other than assistant and the system sections", async () => {
  const { end } = redactionOf();
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  for (const message of [
    { role: "user", content: [{ type: "text", text: line }], timestamp: 1 },
    {
      role: "system",
      content: line,
      sections: { project: line },
      toolsAdded: [{ name: "tool", description: line, parameters: {} }],
    },
    toolResult(line),
    {
      role: "custom",
      customType: "x",
      content: line,
      display: false,
      details: { line },
      timestamp: 1,
    },
  ]) {
    const copy = await end(message);
    assert.ok(copy, String(message.role));
    assert.ok(!JSON.stringify(copy).includes(value), String(message.role));
    assert.equal(copy.role, message.role);
  }
  assert.equal(await end(toolResult("plain text")), undefined);
});

test("a value of a later line or string also masks an earlier one", async () => {
  const { end } = redactionOf();
  const userinfo = j("app:", an(16));
  const copy = await end(
    toolResult(
      j(
        "credentials ",
        userinfo,
        "\npostgres://",
        userinfo,
        "@db.example.com/x",
      ),
    ),
  );
  assert.equal(markers(copy).length, PAIR_OF_FINDINGS);
  assert.ok(!JSON.stringify(copy).includes(userinfo));
});

test("a toolResult key outside content and details is redacted", async () => {
  const { end } = redactionOf();
  const value = an(16);
  const copy = await end(
    toolResult("plain", "call-1", {
      structuredContent: { line: j(PASS, '="', value, '"') },
    }),
  );
  assert.ok(!JSON.stringify(copy).includes(value));
  assert.equal(markers(copy).length, SINGLE_FINDING);
});

test("the known secrets refresh at turn start and at each assistant message", async () => {
  const { end, turn, current } = redactionOf();
  const first = j("tok", an(30));
  current.secrets = [first];
  await turn();
  assert.ok(!JSON.stringify(await end(toolResult(first))).includes(first));
  const second = j("tok", an(30));
  current.secrets = [second];
  await end({
    role: "assistant",
    content: [{ type: "text", text: second }],
    api: "anthropic-messages",
    timestamp: 1,
  });
  current.fail = true;
  await turn();
  assert.ok(
    !JSON.stringify(await end(toolResult(j(first, " ", second)))).includes(
      first,
    ),
  );
  assert.ok(!JSON.stringify(await end(toolResult(second))).includes(second));
});

test("counts and text report each finding and a failure fails closed", async () => {
  const { redaction, end } = redactionOf();
  const text = await redaction.text(
    j(PASS, ' = "', an(16), '"', " ", j("AK", "IA", "KANTHORDCANARY01")),
  );
  assert.equal(markers(text).length, PAIR_OF_FINDINGS);
  assert.deepEqual(redaction.counts().redacted, {
    [SensitiveRule.AwsAccessKeyId]: SINGLE_FINDING,
    [SensitiveRule.QuotedAssignment]: SINGLE_FINDING,
  });
  const huge = "a".repeat(8388609);
  const copy = await end(toolResult(huge));
  assert.ok(
    String((copy!.content as { text: string }[])[0]!.text).startsWith(
      "<redacted:scan_failed:a:",
    ),
  );
  assert.equal(redaction.counts().scan_failed, SINGLE_FINDING);
  const failing = toolResult("plain");
  Object.defineProperty(failing, "details", {
    enumerable: true,
    get: () => {
      throw new Error("unreadable");
    },
  });
  const closed = await end(failing);
  assert.deepEqual(closed!.content, [{ type: "text", text: markers(copy)[0] }]);
  assert.equal(redaction.counts().scan_failed, PAIR_OF_FINDINGS);
});

test("an assistant message keeps its content and gets a redacted errorMessage", async () => {
  const secret = providerKey();
  const { end, redaction } = redactionOf([secret]);
  const failure = an(16);
  const line = j(PASS, ' = "', failure, '" ', secret);
  const content = [
    { type: "text", text: line },
    { type: "thinking", thinking: line, thinkingSignature: "signature-bytes" },
    { type: "toolCall", id: "c1", name: "write", arguments: { content: line } },
  ];
  const message = {
    role: "assistant",
    content,
    api: "anthropic-messages",
    errorMessage: line,
    stopReason: "error",
    timestamp: 1,
  };
  const copy = (await end(message))!;
  assert.deepEqual(copy.content, structuredClone(content));
  assert.ok(!String(copy.errorMessage).includes(failure));
  assert.ok(!String(copy.errorMessage).includes(secret));
  assert.deepEqual(redaction.counts().redacted, {
    [SensitiveRule.LlmCredential]: SINGLE_FINDING,
    [SensitiveRule.QuotedAssignment]: SINGLE_FINDING,
  });
  assert.equal(redaction.counts().thinking_kept, NO_FINDING);
  assert.equal(await end({ ...message, errorMessage: undefined }), undefined);
});

test("the context handler redacts a custom message and keeps a compaction summary", async () => {
  const { context, compact, redaction } = redactionOf();
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  const summary = {
    role: "compactionSummary",
    summary: line,
    tokensBefore: 1,
    timestamp: 1,
  };
  const result = await context([
    summary,
    {
      role: "custom",
      customType: "kanthord.prompt-layer",
      content: line,
      display: false,
      timestamp: 1,
    },
  ]);
  assert.ok(result);
  assert.equal(result.messages[0], summary);
  assert.ok(!JSON.stringify(result.messages[1]).includes(value));
  const entry = { summary: line };
  await compact(entry);
  assert.equal(entry.summary, line);
  assert.equal(redaction.counts().compaction_residual, NO_FINDING);
});

test("a custom message and a steering message reach the session file redacted", async (t) => {
  const state = createRedaction(async () => [], SESSION_ID);
  const custom = an(16);
  const steered = an(16);
  const sent: Promise<unknown>[] = [];
  const sender: InlineExtension = (pi) => {
    pi.on(TOOL_CALL_EVENT, () => {
      pi.sendMessage(
        {
          customType: "kanthord.note",
          content: j(PASS, ' = "', custom, '"'),
          display: false,
        },
        { deliverAs: "steer" },
      );
      sent.push(opened.session.steer(j(PASS, ' = "', steered, '"')));
      return undefined;
    });
  };
  const opened = await openTestSession(t, {
    redaction: state,
    gates: [sender],
    script: [
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "true" }, { id: "c1" }),
      ),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done"),
    ],
  });
  await opened.session.prompt("work");
  await Promise.all(sent);
  const file = opened.persisted();
  const redacted = file
    .split("\n")
    .filter((line) => markers(line).length)
    .map((line) => JSON.parse(line) as SessionEntry)
    .map((entry) => entry.message?.role ?? entry.type);
  assert.deepEqual(redacted, ["custom_message", "user"]);
  for (const value of [custom, steered]) {
    assert.ok(!file.includes(value));
    assert.ok(!JSON.stringify(opened.scripted.calls).includes(value));
  }
});

test("a custom message of a consumer context handler reaches the model redacted", async (t) => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const layer: InlineExtension = (pi) => {
    pi.on("context", (event) => ({
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "kanthord.prompt-layer",
          content: j(PASS, ' = "', value, '"'),
          display: false,
          timestamp: 1,
        },
      ],
    }));
  };
  const { session, scripted } = await openTestSession(t, {
    redaction: state,
    contextHooks: [layer],
    script: [fauxAssistantMessage("done")],
  });
  await session.prompt("work");
  assert.ok(
    JSON.stringify(scripted.calls).includes("<redacted:quoted_assignment:"),
  );
  assert.ok(!JSON.stringify(scripted.calls).includes(value));
});
