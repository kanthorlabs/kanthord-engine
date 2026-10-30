import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { checkoutConfinement } from "./checkout-confinement.ts";
import { stopAfter } from "../../kernel/test-support.ts";

type Handler = (event: ToolCallEvent) => unknown;

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "confinement-"));
  stopAfter(t, () => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
  const handlers: Handler[] = [];
  const extension = checkoutConfinement(root) as (pi: ExtensionAPI) => void;
  extension({
    on: (_name: string, handler: Handler) => handlers.push(handler),
  } as unknown as ExtensionAPI);
  assert.ok(handlers.length);
  const call = (toolName: string, input: Record<string, unknown>) =>
    handlers[0]!({
      type: "tool_call",
      toolCallId: "call",
      toolName,
      input,
    } as unknown as ToolCallEvent);
  return { root, outside, call };
}

const FILE_TOOLS = ["read", "grep", "find", "ls"];

test("a path that leaves the checkout is blocked with a reason that names the path", (t) => {
  const f = fixture(t);
  for (const tool of FILE_TOOLS)
    for (const path of [
      "/etc/passwd",
      "~/.ssh/id_ed25519",
      "~",
      "../outside/secret.txt",
      "src/../../outside",
      "link",
      "link/secret.txt",
      "link/absent.txt",
      "secret-link",
      f.outside,
    ])
      assert.deepEqual(f.call(tool, { path }), {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      });
});

test("a relative path inside the checkout, no path and an absent path pass", (t) => {
  const f = fixture(t);
  for (const tool of FILE_TOOLS)
    for (const input of [
      { path: "package.json" },
      { path: "src" },
      { path: "." },
      { path: "src/absent.ts" },
      { path: "absent/deep/file.ts" },
      { pattern: "x" },
    ])
      assert.equal(f.call(tool, input), undefined);
});

test("every other tool name passes unchanged", (t) => {
  const f = fixture(t);
  for (const tool of ["bash", "probe", "environment_write", "edit"])
    assert.equal(f.call(tool, { path: "/etc/passwd" }), undefined);
});
