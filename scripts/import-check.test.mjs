import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const AGENT_SRC = join(import.meta.dirname, "../src/agent");
const DISALLOWED_PATHS = [
  "src/worker/",
  "src/project/",
  "src/mission/",
  "src/tracking/",
];
const DISALLOWED_IDENTIFIERS = ["setGlobalDispatcher", "EnvHttpProxyAgent"];

function agentRuntimeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return agentRuntimeFiles(join(dir, entry.name));
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return [];
    if (entry.name.includes("test-support")) return [];
    return [join(dir, entry.name)];
  });
}

test("no runtime module in src/agent imports a disallowed module", () => {
  const files = agentRuntimeFiles(AGENT_SRC);
  const violations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const disallowed of DISALLOWED_PATHS) {
      if (new RegExp(`from ["'][^"']*${disallowed}[^"']*["']`).test(content)) {
        violations.push(`${file}: imports from ${disallowed}`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join(", "));
});

test("no runtime module in src/agent references setGlobalDispatcher or EnvHttpProxyAgent", () => {
  const files = agentRuntimeFiles(AGENT_SRC);
  const violations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const id of DISALLOWED_IDENTIFIERS) {
      if (content.includes(id)) {
        violations.push(`${file}: references ${id}`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join(", "));
});
