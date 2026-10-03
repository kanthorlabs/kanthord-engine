import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  openSession,
  RUNTIME_SETUP_DEADLINE_MS,
  withDeadline,
} from "./agent-session.ts";
import { piAgentDirectory } from "./pi.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";

test("native session isolates filesystem discovery, settings and session persistence", async (t) => {
  const emptySettings = "{}";
  const home = temporary(t);
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  Object.assign(process.env, {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
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
    credentials,
    setup,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    signal: new AbortController().signal,
  });
  const session = await openSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "owned system",
    allowlist: [],
    customTools: [],
    extensions: [],
    context: background,
  });
  t.after(() => session.dispose());
  await session.prompt("work");
  assert.ok(
    provider.calls[0]?.systemPrompt?.startsWith("owned system"),
    JSON.stringify(provider.calls),
  );
  assert.ok(!JSON.stringify(provider.calls).includes(hostile));
  assert.deepEqual(session.resourceLoader.getSkills().skills, []);
  assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
  assert.deepEqual(session.resourceLoader.getExtensions().extensions, []);
  assert.equal(readFileSync(hostSettings, "utf8"), emptySettings);
  assert.deepEqual(readdirSync(join(home, ".pi"), { recursive: true }), [
    "agent",
    "agent/settings.json",
  ]);
  assert.equal(existsSync(piAgentDirectory()), false);
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
