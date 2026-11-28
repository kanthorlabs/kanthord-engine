import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homeRelativeCwd } from "./home-relative-cwd.ts";

type Handler = (event: unknown) => unknown;

const BEFORE_AGENT_START = "before_agent_start";
const HOME = "/Users/agent";
const WORKSPACE = "~/workspace";
const HOME_ONLY = "~";
const OTHER_PATH = "/other/path";

function fire(home: string, cwd: string): string {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (homeRelativeCwd(home) as (pi: ExtensionAPI) => void)(api);
  const event = { systemPromptOptions: { cwd } };
  for (const handler of handlers.get(BEFORE_AGENT_START) ?? []) handler(event);
  return (event as { systemPromptOptions: { cwd: string } }).systemPromptOptions
    .cwd;
}

test("homeRelativeCwd rewrites the cwd relative to home", () => {
  assert.equal(fire(HOME, j(HOME, "/workspace")), WORKSPACE);
  assert.equal(fire(HOME, HOME), HOME_ONLY);
  assert.equal(fire(HOME, OTHER_PATH), OTHER_PATH);
});

test("homeRelativeCwd throws when home is empty", () => {
  assert.throws(() => homeRelativeCwd(""));
});

function j(...parts: string[]) {
  return parts.join("");
}
