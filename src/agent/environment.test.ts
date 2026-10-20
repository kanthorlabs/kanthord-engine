import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnvironment } from "./environment.ts";

test("the child environment holds no SSH agent of the host user", () => {
  const env = childEnvironment({
    PATH: "/bin",
    HOME: "/home/server",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SSH_AGENT_PID: "4242",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/server" });
});

test("the child environment holds no instance configuration, token or endpoint", () => {
  const env = childEnvironment({
    PATH: "/bin",
    KANTHORD_WORKER_CONFIG: "eyJuYW1lIjoibGFwdG9wIn0",
    KANTHORD_TOKEN: "token",
    KANTHORD_ENDPOINT: "http://127.0.0.1:31415",
  });
  assert.deepEqual(env, { PATH: "/bin" });
});
