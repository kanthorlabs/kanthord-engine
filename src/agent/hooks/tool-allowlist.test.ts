import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolAllowlist } from "./tool-allowlist.ts";

type Handler = (event: unknown) => unknown;

const TOOL_CALL = "tool_call";
const BASH = "bash";
const READ = "read";
const WRITE = "write";
const UNDECLARED_REASON = "The tool bash is not declared for this agent.";

function fire(
  declared: readonly string[],
  toolName: string,
): { block: boolean; reason: string } | undefined {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (toolAllowlist(declared) as (pi: ExtensionAPI) => void)(api);
  let result: { block: boolean; reason: string } | undefined;
  for (const handler of handlers.get(TOOL_CALL) ?? []) {
    const r = handler({
      type: TOOL_CALL,
      toolCallId: "c",
      toolName,
      input: {},
    }) as typeof result;
    if (r !== undefined) result = r;
  }
  return result;
}

test("toolAllowlist passes a declared tool and blocks an undeclared one", () => {
  assert.equal(fire([READ, WRITE], READ), undefined);
  assert.equal(fire([READ, WRITE], WRITE), undefined);
  assert.deepEqual(fire([READ], BASH), {
    block: true,
    reason: UNDECLARED_REASON,
  });
});
