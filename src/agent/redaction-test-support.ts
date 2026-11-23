import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, type TestContext } from "node:test";
import {
  type FauxResponseStep,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  InlineExtension,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { background } from "../kernel/context.ts";
import {
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../kernel/test-support.ts";
import { openSession } from "./agent-session.ts";
import { inputRedaction } from "./hooks/input-redaction.ts";
import { markerRestore } from "./hooks/marker-restore.ts";
import { loadPi } from "./pi.ts";
import {
  createRedaction,
  type KnownSecrets,
  type SessionRedaction,
} from "./redaction.ts";
import { SESSION_MARKER_PATTERN } from "./sensitive-text.ts";
import { seededText } from "./sensitive-text-test-support.ts";
import { scriptedProvider } from "./test-support.ts";

export const j = (...parts: string[]) => parts.join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let { bytes } = seededText();
beforeEach(() => {
  ({ bytes } = seededText());
});
export const an = (n: number) =>
  [...bytes(n)].map((byte) => AN[byte % AN.length]).join("");
export const PASS = j("pass", "word");
export const providerKey = () => j("sk", "-ant-api03-", an(93));
export const SESSION_ID = "session-1";
export const TOOL_CALL_EVENT = "tool_call";
export const TOOL_RESULT_ROLE = "toolResult";
const MESSAGE_END_EVENT = "message_end";
const CONTEXT_EVENT = "context";
const SCRIPTED_KEY = "scripted";

export type Handler = (event: unknown, context?: unknown) => unknown;
export type RedactionHook = (state: SessionRedaction) => InlineExtension;
type Message = Record<string, unknown>;

interface Block {
  block: boolean;
  reason: string;
}

interface Replaced {
  message?: Message;
}

interface Listed {
  messages?: Message[];
}

export function installed(extensions: readonly InlineExtension[]) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  for (const extension of extensions)
    (extension as (pi: ExtensionAPI) => void)(api);
  const fire = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, {});
  };
  return {
    call: async (toolName: string, input: Message, extra = {}) => {
      const event = {
        type: TOOL_CALL_EVENT,
        toolCallId: "call-1",
        toolName,
        input,
        ...extra,
      };
      for (const handler of handlers.get(TOOL_CALL_EVENT) ?? []) {
        const result = (await handler(event, {})) as Block | undefined;
        if (result?.block) return result;
      }
      return undefined;
    },
    end: async (message: Message) => {
      let current = message;
      for (const handler of handlers.get(MESSAGE_END_EVENT) ?? []) {
        const result = (await handler(
          { type: MESSAGE_END_EVENT, message: current },
          {},
        )) as Replaced | undefined;
        current = result?.message ?? current;
      }
      return current === message ? undefined : current;
    },
    context: async (messages: Message[]) => {
      let current = messages;
      for (const handler of handlers.get(CONTEXT_EVENT) ?? []) {
        const result = (await handler(
          { type: CONTEXT_EVENT, messages: current },
          {},
        )) as Listed | undefined;
        current = result?.messages ?? current;
      }
      return current === messages ? undefined : { messages: current };
    },
    compact: (entry: { summary: string }) =>
      fire("session_compact", {
        type: "session_compact",
        compactionEntry: entry,
      }),
    turn: () => fire("turn_start", { type: "turn_start" }),
    agentEnd: () => fire("agent_end", { type: "agent_end", messages: [] }),
  };
}

export function redactionOf(
  secrets: readonly string[] = [],
  later: readonly RedactionHook[] = [],
) {
  const current = { secrets: [...secrets], fail: false };
  const known: KnownSecrets = async () => {
    if (current.fail) throw new Error("holder unavailable");
    return current.secrets;
  };
  const redaction = createRedaction(known, SESSION_ID);
  return {
    redaction,
    current,
    ...installed([
      markerRestore(redaction),
      inputRedaction(redaction),
      ...later.map((hook) => hook(redaction)),
    ]),
  };
}

export const toolResult = (
  text: string,
  toolCallId = "call-1",
  extra = {},
) => ({
  role: TOOL_RESULT_ROLE,
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  details: {},
  isError: false,
  timestamp: 1,
  ...extra,
});

export const markers = (value: unknown) =>
  [...JSON.stringify(value).matchAll(SESSION_MARKER_PATTERN)].map(
    (match) => match[0],
  );

export async function markerOf(
  end: (message: Message) => Promise<unknown>,
  text: string,
) {
  const found = markers(await end(toolResult(text)));
  assert.ok(found.length, text);
  return found[0]!;
}

export interface TestSessionInput {
  script: FauxResponseStep[];
  redaction: SessionRedaction;
  gates?: InlineExtension[];
  customTools?: ToolDefinition[];
  contextHooks?: InlineExtension[];
}

export async function openTestSession(t: TestContext, input: TestSessionInput) {
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
  const { session } = await openSession({
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
    hooks: [...(input.gates ?? []), ...(input.contextHooks ?? [])],
    redaction: input.redaction,
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

export function lastResultText(messages: readonly unknown[]): string {
  const result = [...messages]
    .reverse()
    .find(
      (message) => (message as { role?: string }).role === TOOL_RESULT_ROLE,
    );
  return JSON.stringify(result ?? {});
}
