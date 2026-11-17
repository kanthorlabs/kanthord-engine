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
import { stopAfter } from "../../kernel/stop-test-support.ts";

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
  const extension = checkoutConfinement({ cwd: root, roots: [root] }) as (
    pi: ExtensionAPI,
  ) => void;
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

test("a tool with no location field passes, a tool with no catalog entry is blocked and a path field of another tool is checked", (t) => {
  const f = fixture(t);
  for (const tool of ["probe", "environment_write", "link_update_list"])
    assert.equal(f.call(tool, { path: "/etc/passwd" }), undefined);
  for (const tool of ["bash", "browser"])
    assert.deepEqual(f.call(tool, { path: "package.json" }), {
      block: true,
      reason: `The tool ${tool} has no location rule in this session.`,
    });
  for (const tool of ["edit", "write", "evidence-upload"]) {
    assert.equal(f.call(tool, { path: "package.json" }), undefined);
    assert.deepEqual(f.call(tool, { path: "/etc/passwd" }), {
      block: true,
      reason:
        "The path /etc/passwd is outside the checkout. Use a relative path inside the checkout.",
    });
  }
});

test("path_refused: a reference prefix, a file URL, a Unicode space and a spelling variant that leave the checkout are blocked", (t) => {
  const f = fixture(t);
  symlinkSync(f.outside, join(f.root, "it\u2019s"));
  symlinkSync(f.outside, join(f.root, "spaced link"));
  for (const tool of FILE_TOOLS)
    for (const path of [
      `@${join(f.outside, "secret.txt")}`,
      "@link/secret.txt",
      `file://${join(f.outside, "secret.txt")}`,
      "file://%zz",
      "spaced\u00a0link/secret.txt",
      "it's/secret.txt",
      7,
    ])
      assert.equal(
        (f.call(tool, { path }) as { block?: boolean } | undefined)?.block,
        true,
        `${tool} ${String(path)}`,
      );
});

test("an absolute path, a reference prefix and a file URL inside a root pass, also inside a second root", (t) => {
  const f = fixture(t);
  const second = checkoutConfinement({
    cwd: f.root,
    roots: [f.root, f.outside],
  }) as (pi: ExtensionAPI) => void;
  const handlers: Handler[] = [];
  second({
    on: (_name: string, handler: Handler) => handlers.push(handler),
  } as unknown as ExtensionAPI);
  const call = (path: string) =>
    handlers[0]!({
      type: "tool_call",
      toolCallId: "call",
      toolName: "read",
      input: { path },
    } as unknown as ToolCallEvent);
  for (const path of [
    join(f.root, "package.json"),
    "@package.json",
    `file://${join(f.root, "package.json")}`,
  ])
    assert.equal(f.call("read", { path }), undefined, path);
  for (const path of ["../outside/secret.txt", "link/secret.txt", f.outside])
    assert.equal(call(path), undefined, path);
  assert.equal(
    (call("/etc/passwd") as { block?: boolean } | undefined)?.block,
    true,
  );
});
