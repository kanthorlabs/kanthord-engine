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
const WRITE_TOOLS = ["edit", "write"];

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

test("(security) an edit and a write with an absolute path, a parent path or a symlink out of the root are blocked", (t) => {
  const f = fixture(t);
  for (const tool of WRITE_TOOLS)
    for (const path of [
      join(f.outside, "secret.txt"),
      "../outside/secret.txt",
      "src/../../outside/new.txt",
      "link/secret.txt",
      "link/new.txt",
      "secret-link",
    ])
      assert.deepEqual(f.call(tool, { path }), {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      });
});

test("(happy path) an edit and a write with a relative path inside the root pass", (t) => {
  const f = fixture(t);
  for (const tool of WRITE_TOOLS)
    for (const path of ["package.json", "src/new.ts", "absent/deep/file.ts"])
      assert.equal(f.call(tool, { path }), undefined);
});

const NORMALIZED_BYPASS_PATHS = [
  "@/etc/passwd",
  "@~/.ssh/id_rsa",
  "file:///etc/passwd",
  "file://remote/etc/passwd",
  "@../outside/secret.txt",
  "@link/secret.txt",
];

test("(security) a path that pi normalizes to a place outside the root is blocked on every file tool", (t) => {
  const f = fixture(t);
  for (const tool of [...FILE_TOOLS, ...WRITE_TOOLS])
    for (const path of NORMALIZED_BYPASS_PATHS)
      assert.deepEqual(f.call(tool, { path }), {
        block: true,
        reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
      });
});

test("(happy path) an at-prefixed relative path inside the root passes", (t) => {
  const f = fixture(t);
  for (const tool of [...FILE_TOOLS, ...WRITE_TOOLS])
    for (const path of ["@package.json", "@src/new.ts"])
      assert.equal(f.call(tool, { path }), undefined);
});

test("(security) a read path whose pi variant is a symlink out of the root is blocked", (t) => {
  const f = fixture(t);
  const secret = join(f.outside, "secret.txt");
  symlinkSync(secret, join(f.root, "a\u2019"));
  symlinkSync(secret, join(f.root, "shot\u202FPM.png"));
  symlinkSync(secret, join(f.root, "e\u0301"));
  for (const path of [
    "a'",
    "a'/",
    "a'//",
    "shot PM.png",
    "shot PM.png/",
    "\u00e9",
  ])
    assert.deepEqual(f.call("read", { path }), {
      block: true,
      reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
    });
});

test("(happy path) a read path whose pi variant is a file inside the root passes", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "it\u2019s.txt"), "inside");
  writeFileSync(join(f.root, "shot\u202FAM.png"), "inside");
  for (const path of ["it's.txt", "shot AM.png"])
    assert.equal(f.call("read", { path }), undefined);
});

test("(security) in a root that holds a quote, a read variant that names a sibling of the root is blocked and a path inside the root passes", (t) => {
  const base = mkdtempSync(join(tmpdir(), "confinement-"));
  stopAfter(t, () => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "it's");
  mkdirSync(root);
  mkdirSync(join(base, "it\u2019s"));
  writeFileSync(join(base, "it\u2019s", "y"), "sibling");
  writeFileSync(join(root, "package.json"), "{}");
  const handlers: Handler[] = [];
  const extension = checkoutConfinement(root) as (pi: ExtensionAPI) => void;
  extension({
    on: (_name: string, handler: Handler) => handlers.push(handler),
  } as unknown as ExtensionAPI);
  assert.deepEqual(
    handlers[0]!({
      type: "tool_call",
      toolCallId: "call",
      toolName: "read",
      input: { path: "y" },
    } as unknown as ToolCallEvent),
    {
      block: true,
      reason:
        "The path y is outside the checkout. Use a relative path inside the checkout.",
    },
  );
  for (const path of ["package.json", "src/new.ts"])
    assert.equal(
      handlers[0]!({
        type: "tool_call",
        toolCallId: "call",
        toolName: "read",
        input: { path },
      } as unknown as ToolCallEvent),
      undefined,
    );
});

test("every other tool name passes unchanged", (t) => {
  const f = fixture(t);
  for (const tool of ["bash", "probe", "environment_write"])
    assert.equal(f.call(tool, { path: "/etc/passwd" }), undefined);
});

function readRootFixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "confinement-"));
  stopAfter(t, () => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "checkouts", "engine");
  const evidence = join(base, "evidence");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(evidence);
  mkdirSync(outside);
  writeFileSync(join(evidence, "round-1-engine.patch"), "patch");
  writeFileSync(join(outside, "secret"), "secret");
  symlinkSync(join(outside, "secret"), join(evidence, "link"));
  const handlers: Handler[] = [];
  const extension = checkoutConfinement(root, [evidence]) as (
    pi: ExtensionAPI,
  ) => void;
  extension({
    on: (_name: string, handler: Handler) => handlers.push(handler),
  } as unknown as ExtensionAPI);
  const call = (toolName: string, input: Record<string, unknown>) =>
    handlers[0]!({
      type: "tool_call",
      toolCallId: "call",
      toolName,
      input,
    } as unknown as ToolCallEvent);
  return { root, evidence, call };
}

const BUNDLE_PATCH = "../../evidence/round-1-engine.patch";

function blocked(path: string) {
  return {
    block: true,
    reason: `The path ${path} is outside the checkout. Use a relative path inside the checkout.`,
  };
}

test("(happy path) a read of a file in a read root passes", (t) => {
  const f = readRootFixture(t);
  assert.equal(f.call("read", { path: BUNDLE_PATCH }), undefined);
});

test("(happy path) grep, find and ls of a read root pass", (t) => {
  const f = readRootFixture(t);
  for (const tool of ["grep", "find", "ls"])
    assert.equal(f.call(tool, { path: "../../evidence" }), undefined);
});

test("(invariant guard) an edit and a write in a read root are blocked", (t) => {
  const f = readRootFixture(t);
  for (const tool of WRITE_TOOLS)
    assert.deepEqual(
      f.call(tool, { path: BUNDLE_PATCH }),
      blocked(BUNDLE_PATCH),
    );
});

test("(edge) a read of a symlink in a read root that points outside it is blocked", (t) => {
  const f = readRootFixture(t);
  const path = "../../evidence/link";
  assert.deepEqual(f.call("read", { path }), blocked(path));
});

test("(invariant guard) an absolute path into a read root is blocked", (t) => {
  const f = readRootFixture(t);
  const path = join(f.evidence, "round-1-engine.patch");
  for (const tool of [...FILE_TOOLS, ...WRITE_TOOLS])
    assert.deepEqual(f.call(tool, { path }), blocked(path));
});

test("(invariant guard) with no read root a read of the bundle path is blocked", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.call("read", { path: BUNDLE_PATCH }),
    blocked(BUNDLE_PATCH),
  );
});

test("(invariant guard) a read beside a read root is blocked", (t) => {
  const f = readRootFixture(t);
  const path = "../outside/secret";
  assert.deepEqual(f.call("read", { path }), blocked(path));
  const deep = "../../outside/secret";
  assert.deepEqual(f.call("read", { path: deep }), blocked(deep));
});
