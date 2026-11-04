import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  InlineExtension,
  SessionManager,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { background } from "../../kernel/context.ts";
import {
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { openSession } from "../agent-session.ts";
import { loadPi } from "../pi.ts";
import {
  SensitiveRule,
  SESSION_MARKER_PATTERN,
  sessionMarker,
  tracerMarker,
} from "../sensitive-text.ts";
import { scriptedProvider } from "../test-support.ts";
import { checkoutConfinement } from "./checkout-confinement.ts";
import { toolApproval } from "./tool-approval.ts";
import {
  credentialSecrets,
  type KnownSecrets,
  mergedSecrets,
  REDACTION_TABLE_MAX,
  RestoreReason,
  sensitiveTextRedaction,
  type SensitiveTextRedaction,
} from "./sensitive-text-redaction.ts";

const j = (...parts: string[]) => parts.join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const an = (n: number) =>
  [...randomBytes(n)].map((byte) => AN[byte % AN.length]).join("");
const PASS = j("pass", "word");
const providerKey = () => j("sk", "-ant-api03-", an(93));
const SESSION_ID = "session-1";
const SINGLE_FINDING = 1;
const PAIR_OF_FINDINGS = 2;
const SIGNED_APIS = 3;
const BLOCKED_CALLS = 3;
const TOOL_CALL_EVENT = "tool_call";
const TOOL_RESULT_ROLE = "toolResult";
const BASH_TOOL = "bash";
const EDIT_TOOL = "edit";

type Handler = (event: unknown, context?: unknown) => unknown;

function installed(redaction: SensitiveTextRedaction) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (redaction.restore as (pi: ExtensionAPI) => void)(api);
  (redaction.hook as (pi: ExtensionAPI) => void)(api);
  const fire = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = await handler(event, {});
    return result;
  };
  return {
    call: (toolName: string, input: Record<string, unknown>, extra = {}) =>
      fire("tool_call", {
        type: "tool_call",
        toolCallId: "call-1",
        toolName,
        input,
        ...extra,
      }) as Promise<{ block: boolean; reason: string } | undefined>,
    end: async (message: Record<string, unknown>) => {
      const result = (await fire("message_end", {
        type: "message_end",
        message,
      })) as { message: Record<string, unknown> } | undefined;
      return result?.message;
    },
    context: (messages: unknown[]) =>
      fire("context", { type: "context", messages }) as Promise<
        { messages: Record<string, unknown>[] } | undefined
      >,
    compact: (entry: { summary: string }) =>
      fire("session_compact", {
        type: "session_compact",
        compactionEntry: entry,
      }),
    turn: () => fire("turn_start", { type: "turn_start" }),
    agentEnd: () => fire("agent_end", { type: "agent_end", messages: [] }),
  };
}

function redactionOf(secrets: readonly string[] = []) {
  const current = { secrets: [...secrets], fail: false };
  const known: KnownSecrets = async () => {
    if (current.fail) throw new Error("holder unavailable");
    return current.secrets;
  };
  const redaction = sensitiveTextRedaction(known, SESSION_ID);
  return { redaction, current, ...installed(redaction) };
}

const toolResult = (text: string, toolCallId = "call-1", extra = {}) => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  details: {},
  isError: false,
  timestamp: 1,
  ...extra,
});

const markers = (value: unknown) =>
  [...JSON.stringify(value).matchAll(SESSION_MARKER_PATTERN)].map(
    (match) => match[0],
  );

async function markerOf(
  end: (message: Record<string, unknown>) => Promise<unknown>,
  text: string,
) {
  const found = markers(await end(toolResult(text)));
  assert.ok(found.length, text);
  return found[0]!;
}

test("message_end redacts every role and the system sections", async () => {
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
    {
      role: "assistant",
      content: [
        { type: "text", text: line },
        {
          type: "toolCall",
          id: "c1",
          name: "write",
          arguments: { content: line },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      errorMessage: line,
      stopReason: "stop",
      timestamp: 1,
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
  const value = an(16);
  const assistant = await end({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "a",
        name: "write",
        arguments: { content: value },
      },
      {
        type: "toolCall",
        id: "b",
        name: "write",
        arguments: { content: j(PASS, '="', value, '"') },
      },
    ],
    api: "anthropic-messages",
    timestamp: 1,
  });
  assert.equal(markers(assistant).length, PAIR_OF_FINDINGS);
  assert.ok(!JSON.stringify(assistant).includes(value));
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

test("a signed thinking block stays whole and its finding masks later text", async () => {
  const { end, redaction } = redactionOf();
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
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
  const later = await end(toolResult(j("value ", value)));
  assert.ok(!JSON.stringify(later).includes(value));
  for (const [api, signature] of [
    ["google-generative-ai", undefined],
    ["bedrock-converse-stream", ""],
    ["openai-completions", "reasoning_content"],
  ] as const) {
    const copy = await end(thinking(api, signature));
    assert.ok(copy, api);
    const block = (copy.content as Record<string, unknown>[])[0]!;
    assert.ok(!String(block.thinking).includes(value), api);
    assert.equal(block.thinkingSignature, signature, api);
  }
  const otherApi = await end({
    ...thinking("anthropic-messages", "reasoning_content"),
  });
  assert.equal(otherApi, undefined);
});

test("structural keys stay and a key of the same name inside arguments is redacted", async () => {
  const { end } = redactionOf();
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
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
  assert.ok(!JSON.stringify(block.arguments).includes(value));
});

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
  const earlier = sensitiveTextRedaction(async () => [], SESSION_ID);
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
  const earlier = sensitiveTextRedaction(async () => [], SESSION_ID);
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
  const foreign = sensitiveTextRedaction(async () => [], "other-session");
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
  assert.ok(marker.includes(":0:"), marker);
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
  assert.ok(marker.includes(":0:"));
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

test("the context handler redacts a resumed summary and a custom message", async () => {
  const { context, compact, redaction } = redactionOf();
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
      "<redacted:scan_failed:0:",
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

test("mergedSecrets returns the secrets of every source", async () => {
  const merged = mergedSecrets([
    async () => ["a", "b"],
    async () => ["b", "c"],
  ]);
  assert.deepEqual(await merged(), ["a", "b", "c"]);
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({ type: "api_key", key: "k1" }));
  await store.modify("openai", async () => ({
    type: "oauth",
    access: "a1",
    refresh: "r1",
    expires: 1,
  }));
  assert.deepEqual(await credentialSecrets(store, "anthropic")(), ["k1"]);
  assert.deepEqual(await credentialSecrets(store, "openai")(), ["a1", "r1"]);
  assert.deepEqual(await credentialSecrets(store, "absent")(), []);
});

test("a later approval holds the unchanged marker of an operation input", async () => {
  const { end, redaction } = redactionOf();
  const value = an(16);
  const marker = await markerOf(end, j(PASS, ' = "', value, '"'));
  const approvals = new Map<string, unknown>();
  const handlers: Handler[] = [];
  const api = {
    on: (name: string, handler: Handler) => {
      if (name === TOOL_CALL_EVENT) handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  (redaction.restore as (pi: ExtensionAPI) => void)(api);
  (
    toolApproval({
      approve: async (call) => {
        if (call.toolName === OPERATION_TOOL)
          approvals.set(call.toolCallId, structuredClone(call.input));
        return true;
      },
      reason: "refused",
    }) as (pi: ExtensionAPI) => void
  )(api);
  const fire = async (
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ) => {
    const event = {
      type: "tool_call",
      toolCallId,
      toolName,
      input,
    } as unknown as ToolCallEvent;
    for (const handler of handlers) await handler(event, {});
    return event.input;
  };
  await fire(OPERATION_TOOL, "op", { secret_value: marker });
  assert.deepEqual(approvals.get("op"), { secret_value: marker });
  assert.deepEqual(await fire("write", "w", { content: marker }), {
    content: value,
  });
  assert.equal(approvals.has("w"), false);
});
const OPERATION_TOOL = "custody_secret_set";

test("a later gate sees the unchanged marker of a read path", async (t) => {
  const { end, redaction } = redactionOf();
  const marker = await markerOf(end, j(PASS, ' = "', an(16), '"'));
  const root = temporary(t);
  mkdirSync(join(root, "src"));
  const handlers: Handler[] = [];
  const api = {
    on: (name: string, handler: Handler) => {
      if (name === TOOL_CALL_EVENT) handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  (redaction.restore as (pi: ExtensionAPI) => void)(api);
  (checkoutConfinement(root) as (pi: ExtensionAPI) => void)(api);
  const event = {
    type: "tool_call",
    toolCallId: "c",
    toolName: "read",
    input: { path: j("src/", marker) },
  } as unknown as ToolCallEvent;
  for (const handler of handlers) await handler(event, {});
  assert.deepEqual(event.input, { path: j("src/", marker) });
});

const SCRIPTED_KEY = "scripted";

async function openTestSession(
  t: TestContext,
  input: {
    script: FauxResponseStep[];
    redaction: SensitiveTextRedaction;
    gates?: InlineExtension[];
    customTools?: ToolDefinition[];
    contextHooks?: InlineExtension[];
  },
) {
  const home = temporary(t);
  overrideEnvironment(t, { HOME: home, XDG_STATE_HOME: join(home, "state") });
  const cwd = join(home, "workspace");
  const sessions = join(home, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const pi = await loadPi();
  const scripted = scriptedProvider(input.script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: SCRIPTED_KEY,
  }));
  const runtime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal: new AbortController().signal,
  });
  runtime.registerNativeProvider(scripted.provider);
  const sessionManager: SessionManager = pi.SessionManager.create(
    cwd,
    sessions,
  );
  const session = await openSession({
    cwd,
    modelRuntime: runtime,
    model: runtime.getModel("anthropic", "claude-sonnet-4-5")!,
    thinkingLevel: "off",
    systemPrompt: "owned system",
    allowlist: [
      "read",
      "write",
      "edit",
      "bash",
      ...(input.customTools ?? []).map((tool) => tool.name),
    ],
    customTools: input.customTools ?? [],
    hostHome: home,
    hooks: [
      input.redaction.restore,
      ...(input.gates ?? []),
      ...(input.contextHooks ?? []),
      input.redaction.hook,
    ],
    context: background,
    sessionManager,
  });
  stopAfter(t, () => session.dispose());
  const persisted = () =>
    readdirSync(sessions, { recursive: true })
      .filter((name) => String(name).endsWith(".jsonl"))
      .map((name) => readFileSync(join(sessions, String(name)), "utf8"))
      .join("\n");
  return { cwd, session, scripted, persisted };
}

function lastResultText(messages: readonly unknown[]): string {
  const result = [...messages]
    .reverse()
    .find(
      (message) => (message as { role?: string }).role === TOOL_RESULT_ROLE,
    );
  return JSON.stringify(result ?? {});
}

test("a restored write keeps the real value and the session file keeps the marker", async (t) => {
  const value = an(16);
  const redaction = sensitiveTextRedaction(async () => [], SESSION_ID);
  let marker = "";
  const seen: unknown[] = [];
  const gate: InlineExtension = (pi) => {
    pi.on("tool_call", (event) => {
      seen.push(structuredClone(event.input));
      return undefined;
    });
  };
  const { cwd, session, scripted, persisted } = await openTestSession(t, {
    redaction,
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
  const redaction = sensitiveTextRedaction(async () => [], SESSION_ID);
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
  const marker = markers(await redaction.text(j(PASS, ' = "', value, '"')))[0]!;
  const { session, scripted } = await openTestSession(t, {
    redaction,
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

test("a custom message of a consumer context handler reaches the model redacted", async (t) => {
  const redaction = sensitiveTextRedaction(async () => [], SESSION_ID);
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
    redaction,
    contextHooks: [layer],
    script: [fauxAssistantMessage("done")],
  });
  await session.prompt("work");
  assert.ok(
    JSON.stringify(scripted.calls).includes("<redacted:quoted_assignment:"),
  );
  assert.ok(!JSON.stringify(scripted.calls).includes(value));
});
