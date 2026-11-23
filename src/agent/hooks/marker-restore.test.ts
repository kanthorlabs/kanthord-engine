import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { temporary } from "../../kernel/test-support.ts";
import {
  createRedaction,
  REDACTION_TABLE_MAX,
  RestoreReason,
} from "../redaction.ts";
import {
  an,
  type Handler,
  j,
  lastResultText,
  markerOf,
  markers,
  openTestSession,
  PASS,
  providerKey,
  redactionOf,
  SESSION_ID,
  TOOL_CALL_EVENT,
  TOOL_RESULT_ROLE,
  toolResult,
} from "../redaction-test-support.ts";
import {
  SensitiveRule,
  sessionMarker,
  tracerMarker,
} from "../sensitive-text.ts";
import { checkoutConfinement } from "./checkout-confinement.ts";
import { markerRestore } from "./marker-restore.ts";

const SINGLE_FINDING = 1;
const BLOCKED_CALLS = 3;
const RAW_BLOCKS = 4;
const BASH_TOOL = "bash";
const EDIT_TOOL = "edit";
const CONSUMER_TOOL = "custody_secret_set";

test("restore puts the value into write and edit and keeps other tools unchanged", async () => {
  const { end, call } = redactionOf();
  const value = an(16);
  const marker = await markerOf(end, j(PASS, ' = "', value, '"'));
  const write = { path: "a.txt", content: j("x=", marker) };
  assert.equal(await call("write", write), undefined);
  assert.equal(write.content, j("x=", value));
  const edit = { path: "a.txt", edits: [{ oldText: "x", newText: marker }] };
  assert.equal(await call("edit", edit), undefined);
  assert.deepEqual(edit.edits, [{ oldText: "x", newText: value }]);
  const nested = { path: "b.txt", content: marker };
  assert.equal(
    await call("write", nested, {
      toolCallId: "call-2/1",
      parentToolCallId: "call-2",
    }),
    undefined,
  );
  assert.equal(nested.content, value);
  for (const tool of ["read", "grep", "custom_tool"]) {
    const input = { path: marker, pattern: marker };
    assert.equal(await call(tool, input), undefined);
    assert.deepEqual(input, { path: marker, pattern: marker });
  }
});

test("restore blocks the LLM credential in every tool", async () => {
  const secret = providerKey();
  const { end, call, current, redaction } = redactionOf([secret]);
  await redaction.text("warm up");
  const marker = await markerOf(end, j("key ", secret));
  assert.ok(marker.startsWith(j("<redacted:", SensitiveRule.LlmCredential)));
  for (const tool of ["read", "write", "bash", "grep"])
    assert.deepEqual(await call(tool, { path: marker, command: marker }), {
      block: true,
      reason: RestoreReason.Credential,
    });
  current.secrets = [providerKey()];
  assert.deepEqual(await call("write", { content: marker }), {
    block: true,
    reason: RestoreReason.Credential,
  });
});

test("a marker with a forged rule that points at an LLM credential entry blocks in every tool", async () => {
  const key = providerKey();
  const { end, call, redaction } = redactionOf([key]);
  await redaction.text("warm up");
  const marker = await markerOf(end, j("key ", key));
  const forged = marker.replace(
    j("<redacted:", SensitiveRule.LlmCredential, ":"),
    j("<redacted:", SensitiveRule.Jwt, ":"),
  );
  assert.notEqual(forged, marker);
  for (const [tool, input] of [
    ["write", { path: "a.txt", content: forged }],
    ["edit", { path: "a.txt", edits: [{ oldText: "x", newText: forged }] }],
    ["bash", { command: forged }],
  ] as const)
    assert.deepEqual(await call(tool, { ...input }), {
      block: true,
      reason: RestoreReason.Credential,
    });
});

test("a blocked nested call keeps the short values of the earlier nested calls", async () => {
  const { end, call } = redactionOf();
  const userinfo = "app:pass";
  const marker = await markerOf(
    end,
    j("postgres://", userinfo, "@db.example.com/x"),
  );
  assert.equal(
    await call(
      "edit",
      { edits: [{ oldText: "x", newText: marker }] },
      { toolCallId: "outer/1", parentToolCallId: "outer" },
    ),
    undefined,
  );
  assert.deepEqual(
    await call(
      "bash",
      { command: marker },
      { toolCallId: "outer/2", parentToolCallId: "outer" },
    ),
    { block: true, reason: RestoreReason.Shell },
  );
  const result = await end(toolResult(j("diff +", userinfo), "outer"));
  assert.ok(!JSON.stringify(result).includes(userinfo));
});

test("restore blocks a marker that this session cannot give back", async () => {
  const { end, call, redaction } = redactionOf();
  const marker = await markerOf(end, j(PASS, ' = "', an(16), '"'));
  const tag = marker.slice(-17, -1);
  const blocked = { block: true, reason: RestoreReason.Unkept };
  assert.deepEqual(
    await call("write", {
      content: sessionMarker(SensitiveRule.QuotedAssignment, 0, tag),
    }),
    blocked,
  );
  assert.deepEqual(
    await call("write", {
      content: sessionMarker(SensitiveRule.QuotedAssignment, 999, tag),
    }),
    blocked,
  );
  const earlier = createRedaction(async () => [], SESSION_ID);
  const old = await earlier.text(j(PASS, ' = "', an(16), '"'));
  assert.deepEqual(
    await call("edit", { edits: [{ oldText: "a", newText: markers(old)[0] }] }),
    {
      block: true,
      reason: RestoreReason.Resume,
    },
  );
  assert.equal(redaction.counts().restore_blocked, BLOCKED_CALLS);
});

test("restore blocks a restored value that holds a known secret", async () => {
  const secret = providerKey();
  const { end, call, current } = redactionOf();
  const marker = await markerOf(end, j("key ", secret));
  assert.ok(marker.startsWith(j("<redacted:", SensitiveRule.LlmProviderKey)));
  const holder = await markerOf(end, j(PASS, ' = "x-', secret, '"'));
  current.secrets = [secret];
  await end({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    timestamp: 1,
  });
  for (const input of [marker, holder])
    assert.deepEqual(await call("write", { content: input }), {
      block: true,
      reason: RestoreReason.Credential,
    });
});

test("restore blocks every command with a marker of this session", async () => {
  const { end, call } = redactionOf();
  const safe = await markerOf(end, j(PASS, ' = "', an(16), '"'));
  const tag = safe.slice(-17, -1);
  const earlier = createRedaction(async () => [], SESSION_ID);
  const resumed = markers(await earlier.text(j(PASS, ' = "', an(16), '"')))[0]!;
  const rsa = j("RSA PRIV", "ATE KEY");
  const pem = await markerOf(
    end,
    j("-----BEG", "IN ", rsa, "-----\n", an(64), "\n-----END ", rsa, "-----"),
  );
  for (const command of [
    j("echo ", safe),
    j("echo ", resumed),
    j("echo ", sessionMarker(SensitiveRule.QuotedAssignment, 0, tag)),
    j("printf '%s' ", pem),
  ]) {
    const result = await call("bash", { command });
    assert.deepEqual(result, { block: true, reason: RestoreReason.Shell });
    assert.ok(result!.reason.includes("write or edit tool"));
  }
  const foreign = createRedaction(async () => [], "other-session");
  const other = markers(await foreign.text(j(PASS, ' = "', an(16), '"')))[0]!;
  for (const literal of [tracerMarker(SensitiveRule.Jwt), other]) {
    for (const tool of ["bash", "write"]) {
      const input = { command: j("echo ", literal), content: literal };
      assert.equal(await call(tool, input), undefined);
      assert.deepEqual(input, {
        command: j("echo ", literal),
        content: literal,
      });
    }
  }
});

test("a short restored value masks only the result of its own call", async () => {
  const { end, call, agentEnd } = redactionOf();
  const userinfo = "app:pass";
  const marker = await markerOf(
    end,
    j("postgres://", userinfo, "@db.example.com/x"),
  );
  assert.equal(
    await call(
      "edit",
      { edits: [{ oldText: "x", newText: marker }] },
      { toolCallId: "outer/1", parentToolCallId: "outer" },
    ),
    undefined,
  );
  const result = await end(toolResult(j("diff +", userinfo), "outer"));
  assert.ok(!JSON.stringify(result).includes(userinfo));
  assert.equal(
    await end(toolResult("npm test: 12 passed", "later")),
    undefined,
  );
  assert.equal(
    await end(toolResult(j("later ", userinfo), "later")),
    undefined,
  );
  await call(
    "edit",
    { edits: [{ oldText: "x", newText: marker }] },
    { toolCallId: "next" },
  );
  await agentEnd();
  assert.equal(await end(toolResult(j("late ", userinfo), "next")), undefined);
  await call(
    "edit",
    {
      path: "a",
      edits: [
        {
          oldText: "x",
          newText: j(
            marker,
            sessionMarker(
              SensitiveRule.QuotedAssignment,
              0,
              marker.slice(-17, -1),
            ),
          ),
        },
      ],
    },
    { toolCallId: "blocked" },
  );
  assert.equal(
    await end(toolResult(j("blocked ", userinfo), "blocked")),
    undefined,
  );
  const low = "aaaabbbbcccc";
  const lowMarker = await markerOf(end, j("DB_", PASS.toUpperCase(), "=", low));
  await call("write", { content: lowMarker }, { toolCallId: "w" });
  const cat = await end(toolResult(j("DB=", low), "cat"));
  assert.ok(!JSON.stringify(cat).includes(low));
});

test("a value whose escaped view differs from its source keeps index 0", async () => {
  const { end, call, redaction } = redactionOf();
  const copy = await end(
    toolResult(
      j('{"tail":"x\\nDB_', PASS.toUpperCase(), "=ab\\u0063", an(10), '"}'),
    ),
  );
  const marker = markers(copy)[0]!;
  assert.ok(marker.includes(":a:"), marker);
  assert.ok(redaction.counts().unkept >= SINGLE_FINDING);
  assert.deepEqual(await call("write", { content: marker }), {
    block: true,
    reason: RestoreReason.Unkept,
  });
});

test("each merged span enters the table and restores its exact source text", async () => {
  const { end, call } = redactionOf();
  const value = an(20);
  await end(toolResult(j(PASS, ' = "', value, '"')));
  const prefix = an(6);
  const merged = markers(
    await end(toolResult(j("DB_", PASS.toUpperCase(), "=", prefix, value))),
  )[0]!;
  const write = { content: merged };
  await call("write", write);
  assert.equal(write.content, j(prefix, value));
  const long = an(40);
  await end(toolResult(j(PASS, ' = "', long, '"')));
  const shared = j(long.slice(0, 32), "-", an(10));
  const extended = markers(await end(toolResult(j("seen ", shared))))[0]!;
  const second = { content: extended };
  await call("write", second);
  assert.equal(second.content, shared.slice(0, 40));
});

test("a full table gives index 0 and its restore blocks", async () => {
  const { redaction, call } = redactionOf();
  for (let index = 0; index < REDACTION_TABLE_MAX; index++)
    await redaction.text(j(PASS, ' = "', String(index).padStart(8, "x"), '"'));
  const marker = markers(
    await redaction.text(j(PASS, ' = "', an(16), '"')),
  )[0]!;
  assert.ok(marker.includes(":a:"));
  assert.deepEqual(await call("write", { content: marker }), {
    block: true,
    reason: RestoreReason.Unkept,
  });
});

test("a provider key in a prompt before the first refresh blocks its command", async () => {
  const { redaction, call } = redactionOf();
  const prompt = await redaction.text(j("use ", providerKey()));
  const marker = markers(prompt)[0]!;
  assert.ok(marker.startsWith(j("<redacted:", SensitiveRule.LlmProviderKey)));
  assert.deepEqual(await call("bash", { command: j("curl -H ", marker) }), {
    block: true,
    reason: RestoreReason.Shell,
  });
});

test("a known secret as raw text blocks the call in every tool", async () => {
  const secret = providerKey();
  const { call, redaction } = redactionOf([secret]);
  await redaction.text("warm up");
  for (const [tool, input] of [
    [BASH_TOOL, { command: j("curl -H 'x-api-key: ", secret, "'") }],
    ["write", { path: "a.txt", content: j("KEY=", secret) }],
    ["read", { path: secret }],
    [CONSUMER_TOOL, { name: "key", values: [{ secret_value: secret }] }],
  ] as const)
    assert.deepEqual(
      await call(tool, structuredClone(input)),
      { block: true, reason: RestoreReason.KnownCredential },
      tool,
    );
  assert.equal(redaction.counts().restore_blocked, RAW_BLOCKS);
  assert.equal(await call(BASH_TOOL, { command: "ls" }), undefined);
  assert.equal(redaction.counts().restore_blocked, RAW_BLOCKS);
});

test("regression: a known secret under a structural key of a tool input blocks the call", async () => {
  const secret = providerKey();
  const { call, redaction } = redactionOf([secret]);
  await redaction.text("warm up");
  for (const input of [
    { id: secret },
    { type: secret },
    { model: secret },
    { type: "image", data: secret },
  ])
    assert.deepEqual(await call(CONSUMER_TOOL, input), {
      block: true,
      reason: RestoreReason.KnownCredential,
    });
});

test("a tool input that the scan cannot read blocks the call", async () => {
  const { call, redaction } = redactionOf();
  const input = {};
  Object.defineProperty(input, "command", {
    enumerable: true,
    get: () => {
      throw new Error("unreadable");
    },
  });
  assert.deepEqual(await call(BASH_TOOL, input), {
    block: true,
    reason: RestoreReason.Unkept,
  });
  assert.equal(redaction.counts().restore_blocked, SINGLE_FINDING);
});

test("a later gate sees the unchanged marker of a read path", async (t) => {
  const { end, redaction } = redactionOf();
  const marker = await markerOf(end, j(PASS, ' = "', an(16), '"'));
  const root = temporary(t);
  mkdirSync(join(root, "src"));
  const gateHandlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      gateHandlers.set(name, [...(gateHandlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (markerRestore(redaction) as (pi: ExtensionAPI) => void)(api);
  (
    checkoutConfinement({ cwd: root, roots: [root] }) as (
      pi: ExtensionAPI,
    ) => void
  )(api);
  const event = {
    type: TOOL_CALL_EVENT,
    toolCallId: "c",
    toolName: "read",
    input: { path: j("src/", marker) },
  };
  for (const handler of gateHandlers.get(TOOL_CALL_EVENT) ?? [])
    await handler(event, {});
  assert.deepEqual((event as { input: unknown }).input, {
    path: j("src/", marker),
  });
});

test("a restored write keeps the real value and the session file keeps the marker", async (t) => {
  const value = an(16);
  const state = createRedaction(async () => [], SESSION_ID);
  let marker = "";
  const seen: unknown[] = [];
  const gate: InlineExtension = (pi) => {
    pi.on("tool_call", (event) => {
      seen.push(structuredClone(event.input));
      return undefined;
    });
  };
  const { cwd, session, scripted, persisted } = await openTestSession(t, {
    redaction: state,
    gates: [gate],
    script: [
      fauxAssistantMessage(
        fauxToolCall("read", { path: "config.txt" }, { id: "c1" }),
      ),
      (context) => {
        marker = markers(lastResultText(context.messages))[0]!;
        return fauxAssistantMessage(
          fauxToolCall(
            "write",
            { path: "out.txt", content: j("v=", marker, "\n") },
            { id: "c2" },
          ),
        );
      },
      fauxAssistantMessage(
        fauxToolCall(
          "edit",
          { path: "out.txt", edits: [{ oldText: "v=", newText: j("w=", "") }] },
          { id: "c3" },
        ),
      ),
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "cat out.txt" }, { id: "c4" }),
      ),
      fauxAssistantMessage("done"),
    ],
  });
  writeFileSync(join(cwd, "config.txt"), j(PASS, ' = "', value, '"\n'));
  await session.prompt("work");
  assert.equal(
    readFileSync(join(cwd, "out.txt"), "utf8"),
    j("w=", value, "\n"),
  );
  assert.ok(JSON.stringify(seen).includes(value));
  const file = persisted();
  assert.ok(!file.includes(value));
  assert.ok(!JSON.stringify(scripted.calls).includes(value));
  const entries = file
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message?: Record<string, unknown> });
  const write = entries.find((entry) =>
    JSON.stringify(entry.message?.content ?? "").includes('"c2"'),
  );
  assert.ok(JSON.stringify(write).includes(marker));
  const bash = entries.find(
    (entry) =>
      entry.message?.role === TOOL_RESULT_ROLE &&
      entry.message.toolName === BASH_TOOL,
  )!;
  const persistedKeys = new Set([
    "role",
    "toolCallId",
    "toolName",
    "content",
    "details",
    "usage",
    "isError",
    "durationMs",
    "timestamp",
  ]);
  for (const key of Object.keys(bash.message!))
    assert.ok(persistedKeys.has(key), key);
  assert.ok(JSON.stringify(bash.message).includes(marker));
  const edit = entries.find(
    (entry) =>
      entry.message?.role === TOOL_RESULT_ROLE &&
      entry.message.toolName === EDIT_TOOL,
  )!;
  assert.ok(JSON.stringify(edit.message!.details).includes(marker));
});

test("a tool parameter pattern refuses a marker before the restore", async (t) => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  let received: unknown;
  const tool: ToolDefinition = {
    name: "lookup",
    label: "lookup",
    description: "lookup",
    parameters: Type.Object({
      key: Type.String({ pattern: "^[A-Za-z0-9]+$" }),
    }),
    execute: async (_id, params) => {
      received = params;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
  const marker = markers(await state.text(j(PASS, ' = "', value, '"')))[0]!;
  const { session, scripted } = await openTestSession(t, {
    redaction: state,
    customTools: [tool],
    script: [
      fauxAssistantMessage(
        fauxToolCall("lookup", { key: marker }, { id: "c1" }),
      ),
      fauxAssistantMessage("done"),
    ],
  });
  await session.prompt("work");
  assert.equal(received, undefined);
  assert.ok(
    lastResultText(scripted.calls.at(-1)!.messages).includes("pattern"),
  );
});
