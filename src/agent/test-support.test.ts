import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNestedRefusal,
  NESTED_SANDBOX_SKIP,
  nestedSandboxSkip,
} from "./test-support.ts";

const DARWIN_OUTPUT = "sandbox-exec: sandbox_apply: Operation not permitted\n";
const DARWIN_START_MESSAGE =
  "the bash sandbox is not available: listen EPERM: operation not permitted /tmp/srt-mux-98753-0.sock";
const LINUX_OUTPUT = "bwrap: No permissions to create new namespace\n";

function failure(message: string, stderr?: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(new Error(message), { stderr }));
}

test("(happy path) a probe that runs answers no skip reason", async () => {
  assert.equal(await nestedSandboxSkip(async () => "ran", "darwin"), false);
});

test("(happy path) a refusal of the nested sandbox answers the skip reason", async () => {
  assert.equal(
    await nestedSandboxSkip(failure("failed", DARWIN_OUTPUT), "darwin"),
    NESTED_SANDBOX_SKIP,
  );
  assert.equal(
    await nestedSandboxSkip(failure("failed", LINUX_OUTPUT), "linux"),
    NESTED_SANDBOX_SKIP,
  );
});

test("(edge) a sandbox that fails to start on its mux socket answers the skip reason on darwin only", async () => {
  assert.equal(
    await nestedSandboxSkip(failure(DARWIN_START_MESSAGE), "darwin"),
    NESTED_SANDBOX_SKIP,
  );
  await assert.rejects(
    nestedSandboxSkip(failure(DARWIN_START_MESSAGE), "linux"),
    /srt-mux/,
  );
});

test("(invariant guard) a probe error that is not a refusal fails and names the error", async () => {
  await assert.rejects(
    nestedSandboxSkip(failure("module not found: sandbox-runtime", "boom"), "darwin"),
    /module not found: sandbox-runtime/,
  );
  await assert.rejects(
    nestedSandboxSkip(failure("timed out"), "linux"),
    /timed out/,
  );
});

test("(edge) a refusal text of another platform or line is no refusal", () => {
  assert.equal(isNestedRefusal(DARWIN_OUTPUT, "linux"), false);
  assert.equal(isNestedRefusal(LINUX_OUTPUT, "darwin"), false);
  assert.equal(isNestedRefusal(`note\n${LINUX_OUTPUT}`, "linux"), false);
  assert.equal(isNestedRefusal(DARWIN_OUTPUT, "win32"), false);
});
