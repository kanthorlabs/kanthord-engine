import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../../kernel/context.ts";
import {
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import {
  openSession,
  RUNTIME_SETUP_DEADLINE_MS,
  withDeadline,
} from "../../agent/agent-session.ts";
import { sensitiveTextRedaction } from "../../agent/hooks/sensitive-text-redaction.ts";
import { SESSION_MARKER_PATTERN } from "../../agent/sensitive-text.ts";
import { piAgentDirectory } from "../../agent/pi.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";

const INLINE_SOURCE = "inline";
const RELATIVE_CWD_SECTION = "<cwd>\n~/workspace\n</cwd>";

test("native session isolates filesystem discovery, settings and session persistence, and writes its cwd with ~", async (t) => {
  const emptySettings = "{}";
  const home = temporary(t);
  overrideEnvironment(t, { HOME: home, XDG_STATE_HOME: join(home, "state") });
  const cwd = join(home, "workspace");
  const hostile = "HOSTILE_DISCOVERY_TEXT";
  const files = [
    "AGENTS.md",
    ".pi/settings.json",
    ".pi/extensions/x.ts",
    ".pi/skills/s/SKILL.md",
  ];
  for (const file of files) {
    const path = join(cwd, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      file.endsWith(".json")
        ? JSON.stringify({ systemPrompt: hostile })
        : hostile,
    );
  }
  const hostSettings = join(home, ".pi/agent/settings.json");
  mkdirSync(join(hostSettings, ".."), { recursive: true });
  writeFileSync(hostSettings, "{}");
  const provider = scriptedProvider([fauxAssistantMessage("done")]);
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
  const { session } = await openSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "owned system",
    allowlist: [],
    customTools: [],
    hostHome: home,
    hooks: [],
    context: background,
    knownSecrets: async () => [],
  });
  stopAfter(t, () => session.dispose());
  await session.prompt("work");
  assert.ok(
    provider.calls[0]?.systemPrompt?.startsWith("owned system"),
    JSON.stringify(provider.calls),
  );
  assert.ok(!JSON.stringify(provider.calls).includes(hostile));
  assert.ok(provider.calls[0]?.systemPrompt?.includes(RELATIVE_CWD_SECTION));
  assert.ok(!provider.calls[0]?.systemPrompt?.includes(home));
  assert.deepEqual(session.resourceLoader.getSkills().skills, []);
  assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
  assert.deepEqual(
    session.resourceLoader
      .getExtensions()
      .extensions.map((extension) => extension.sourceInfo.source),
    [INLINE_SOURCE, INLINE_SOURCE, INLINE_SOURCE],
  );
  assert.equal(readFileSync(hostSettings, "utf8"), emptySettings);
  assert.deepEqual(readdirSync(join(home, ".pi"), { recursive: true }), [
    "agent",
    "agent/settings.json",
  ]);
  assert.equal(existsSync(piAgentDirectory()), false);
});

const FAKE_KEY = ["AKIA", "KANTHORDCANARY01"].join("");
const CONSUMER_EVENT = "input";
const RESTORE_EVENTS = ["agent_end", "tool_call"];
const HOOK_EVENTS = ["context", "message_end", "session_compact", "turn_start"];
const HOME_EVENTS = ["before_agent_start"];

async function redactedSessionSetup(t: TestContext) {
  const home = temporary(t);
  overrideEnvironment(t, { HOME: home, XDG_STATE_HOME: join(home, "state") });
  const cwd = join(home, "workspace");
  mkdirSync(cwd, { recursive: true });
  const provider = scriptedProvider([
    fauxAssistantMessage("done"),
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
  return {
    provider,
    input: {
      cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off" as const,
      systemPrompt: `owned system ${FAKE_KEY}`,
      allowlist: [],
      customTools: [],
      hostHome: home,
      context: background,
    },
  };
}

function markerTags(text: string): string[] {
  return [...text.matchAll(SESSION_MARKER_PATTERN)].map(
    (match) => match.groups!.tag!,
  );
}

test("openSession installs the restore after the cwd hook and the redaction hook last, and returns the redacted system prompt", async (t) => {
  const { provider, input } = await redactedSessionSetup(t);
  const opened = await openSession({
    ...input,
    hooks: [
      (pi) => {
        pi.on(CONSUMER_EVENT, () => undefined);
      },
    ],
    knownSecrets: async () => [],
  });
  stopAfter(t, () => opened.session.dispose());
  assert.deepEqual(
    opened.session.resourceLoader
      .getExtensions()
      .extensions.map((extension) => [...extension.handlers.keys()].sort()),
    [HOME_EVENTS, RESTORE_EVENTS, [CONSUMER_EVENT], HOOK_EVENTS],
  );
  assert.ok(!opened.systemPrompt.includes(FAKE_KEY));
  const [systemTag] = markerTags(opened.systemPrompt);
  assert.ok(systemTag);
  await opened.session.prompt(`work ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(provider.calls).includes(FAKE_KEY));
  const userTags = markerTags(JSON.stringify(opened.session.messages));
  assert.ok(userTags.length);
  for (const tag of userTags) assert.equal(tag, systemTag);
});

test("openSession uses a passed redaction and creates none", async (t) => {
  const { input } = await redactedSessionSetup(t);
  const redaction = sensitiveTextRedaction(async () => [], "passed_session");
  const expected = await redaction.text(input.systemPrompt);
  const opened = await openSession({ ...input, hooks: [], redaction });
  stopAfter(t, () => opened.session.dispose());
  assert.equal(opened.redaction, redaction);
  assert.equal(opened.systemPrompt, expected);
});

test("runtime setup deadline rejects unresolved setup and disposes a late resource", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pending = Promise.withResolvers<{ dispose: () => void }>();
  let disposed = false;
  const result = withDeadline(pending.promise, background, (value) =>
    value.dispose(),
  );
  const refusal = assert.rejects(result, {
    code: "system.context.deadline_exceeded",
  });
  t.mock.timers.tick(RUNTIME_SETUP_DEADLINE_MS);
  await refusal;
  pending.resolve({
    dispose: () => {
      disposed = true;
    },
  });
  await Promise.resolve();
  assert.equal(disposed, true);
});
